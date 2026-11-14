package notifier

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/model"
)

func TestManager_NotifyIncident_CooldownAndMultiChannel(t *testing.T) {
	var hitCount atomic.Int32
	var lastPayload map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hitCount.Add(1)
		_ = json.NewDecoder(r.Body).Decode(&lastPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	mgr := NewManager(200 * time.Millisecond)

	ep := &model.Endpoint{
		ID:              "ep_test_notif",
		Name:            "Billing Webhook",
		Provider:        model.ProviderStripe,
		TargetURL:       "https://example.com/webhooks",
		NotificationURL: srv.URL,
	}

	// First alert fires immediately
	mgr.NotifyIncident(context.Background(), ep, "evt_001", "all retries exhausted")
	if hitCount.Load() != 1 {
		t.Fatalf("expected 1 webhook call, got %d", hitCount.Load())
	}
	if lastPayload["endpoint_id"] != "ep_test_notif" {
		t.Errorf("expected endpoint_id ep_test_notif, got %v", lastPayload["endpoint_id"])
	}

	// Second alert within cooldown window is suppressed
	mgr.NotifyIncident(context.Background(), ep, "evt_002", "all retries exhausted")
	if hitCount.Load() != 1 {
		t.Fatalf("expected webhook call count to remain 1 during cooldown, got %d", hitCount.Load())
	}

	// After cooldown window expires, next alert fires
	time.Sleep(250 * time.Millisecond)
	mgr.NotifyIncident(context.Background(), ep, "evt_003", "circuit breaker tripped")
	if hitCount.Load() != 2 {
		t.Fatalf("expected webhook call count 2 after cooldown, got %d", hitCount.Load())
	}
}

func TestManager_NotifyIncident_SMTPEmailChannel(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen on local TCP port: %v", err)
	}
	defer ln.Close()

	var receivedMu sync.Mutex
	var receivedData string
	doneCh := make(chan struct{}, 1)

	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		_, _ = conn.Write([]byte("220 localhost ESMTP RelayGateTest\r\n"))

		inData := false
		var dataBuf strings.Builder
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				break
			}
			if inData {
				if strings.TrimRight(line, "\r\n") == "." {
					inData = false
					_, _ = conn.Write([]byte("250 2.0.0 OK: queued\r\n"))
					receivedMu.Lock()
					receivedData = dataBuf.String()
					receivedMu.Unlock()
					select {
					case doneCh <- struct{}{}:
					default:
					}
					continue
				}
				dataBuf.WriteString(line)
				continue
			}

			upper := strings.ToUpper(strings.TrimSpace(line))
			switch {
			case strings.HasPrefix(upper, "EHLO") || strings.HasPrefix(upper, "HELO"):
				_, _ = conn.Write([]byte("250-localhost\r\n250 OK\r\n"))
			case strings.HasPrefix(upper, "MAIL FROM:"):
				_, _ = conn.Write([]byte("250 2.1.0 OK\r\n"))
			case strings.HasPrefix(upper, "RCPT TO:"):
				_, _ = conn.Write([]byte("250 2.1.5 OK\r\n"))
			case strings.HasPrefix(upper, "DATA"):
				inData = true
				_, _ = conn.Write([]byte("354 End data with <CR><LF>.<CR><LF>\r\n"))
			case strings.HasPrefix(upper, "QUIT"):
				_, _ = conn.Write([]byte("221 2.0.0 Bye\r\n"))
				return
			default:
				_, _ = conn.Write([]byte("250 OK\r\n"))
			}
		}
	}()

	mgr := NewManager(200 * time.Millisecond)
	mgr.SetSMTPConfig(ln.Addr().String(), "alerts@relaygate.local")

	ep := &model.Endpoint{
		ID:                "ep_smtp_notif",
		Name:              "SMTP Alert Endpoint",
		Provider:          model.ProviderStripe,
		TargetURL:         "https://example.com/webhooks",
		NotificationEmail: "ops@company.local",
	}

	if !HasChannels(ep) {
		t.Fatalf("expected HasChannels to return true when NotificationEmail is configured")
	}

	mgr.NotifyIncident(context.Background(), ep, "evt_smtp_01", "DLQ entered after 5 attempts")

	select {
	case <-doneCh:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for SMTP incident email delivery")
	}

	receivedMu.Lock()
	body := receivedData
	receivedMu.Unlock()

	if !strings.Contains(body, "To: ops@company.local") {
		t.Errorf("expected SMTP message to contain To: ops@company.local, got:\n%s", body)
	}
	if !strings.Contains(body, "ep_smtp_notif") || !strings.Contains(body, "evt_smtp_01") {
		t.Errorf("expected SMTP message to contain endpoint and event IDs, got:\n%s", body)
	}
}
