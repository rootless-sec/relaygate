package agent_test

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/agent"
	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
)

func openTestRepo(t *testing.T) (storage.Repository, *model.Endpoint, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "relaygate-agent-test-*")
	if err != nil {
		t.Fatalf("mkdir temp failed: %v", err)
	}
	db, err := storage.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		_ = os.RemoveAll(dir)
		t.Fatalf("storage.Open failed: %v", err)
	}
	ep := &model.Endpoint{
		ID:        "ep_agent_1",
		Name:      "Local Dev Service",
		SecretKey: "whsec_secret_123456",
		TargetURL: "http://127.0.0.1:9999/webhook",
		Provider:  model.ProviderStripe,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(context.Background(), ep); err != nil {
		_ = db.Close()
		_ = os.RemoveAll(dir)
		t.Fatalf("SaveEndpoint failed: %v", err)
	}
	return db, ep, func() {
		_ = db.Close()
		_ = os.RemoveAll(dir)
	}
}

func TestAgent_AuthAndTokenRotation(t *testing.T) {
	repo, ep, cleanup := openTestRepo(t)
	defer cleanup()

	if !strings.HasPrefix(ep.AgentToken, "agt_") || len(ep.AgentToken) < 20 {
		t.Fatalf("expected generated agt_ token, got %q", ep.AgentToken)
	}

	hub := agent.NewHub(repo, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/agent/connect", hub.ServeConnect)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Invalid token must fail handshake with HTTP 401
	_, err := agent.DialWS(context.Background(), srv.URL+"/api/v1/agent/connect", map[string]string{
		"X-RelayGate-Agent-Token": "agt_invalid_token",
	})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected 401 error for invalid token, got %v", err)
	}

	// Missing token must fail handshake
	_, err = agent.DialWS(context.Background(), srv.URL+"/api/v1/agent/connect", nil)
	if err == nil {
		t.Fatalf("expected error for missing agent token")
	}

	// Connect with valid token
	conn, err := agent.DialWS(context.Background(), srv.URL+"/api/v1/agent/connect", map[string]string{
		"X-RelayGate-Agent-Token": ep.AgentToken,
	})
	if err != nil {
		t.Fatalf("expected valid token connect to succeed, got %v", err)
	}
	defer conn.Close()

	// Wait briefly for server registration
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !hub.HasAgent(ep.ID) {
		time.Sleep(10 * time.Millisecond)
	}
	if !hub.HasAgent(ep.ID) {
		t.Fatalf("expected hub.HasAgent(%s) to be true", ep.ID)
	}

	// Rotate token and disconnect active tunnel
	newToken, err := repo.RotateEndpointAgentToken(context.Background(), ep.ID)
	if err != nil {
		t.Fatalf("RotateEndpointAgentToken failed: %v", err)
	}
	if newToken == ep.AgentToken || !strings.HasPrefix(newToken, "agt_") {
		t.Fatalf("expected fresh rotated token, got %q", newToken)
	}
	hub.DisconnectEndpoint(ep.ID)
	if hub.HasAgent(ep.ID) {
		t.Fatalf("expected hub.HasAgent to be false after DisconnectEndpoint")
	}

	// Old token must now be rejected
	_, err = agent.DialWS(context.Background(), srv.URL+"/api/v1/agent/connect", map[string]string{
		"X-RelayGate-Agent-Token": ep.AgentToken,
	})
	if err == nil {
		t.Fatalf("expected rotated-out token to be rejected")
	}

	// New token must connect cleanly
	conn2, err := agent.DialWS(context.Background(), srv.URL+"/api/v1/agent/connect", map[string]string{
		"X-RelayGate-Agent-Token": newToken,
	})
	if err != nil {
		t.Fatalf("expected new rotated token to connect, got %v", err)
	}
	_ = conn2.Close()
}

func TestAgent_DispatchRawBytesHeadersRedirectAndLargePayload(t *testing.T) {
	repo, ep, cleanup := openTestRepo(t)
	defer cleanup()

	var (
		mu              sync.Mutex
		receivedBody    []byte
		receivedHeaders http.Header
		receivedHost    string
		callCount       atomic.Int32
		returnMode      atomic.Int32 // 0=200 OK, 1=429 Retry-After, 2=302 Redirect
	)

	localTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		receivedBody = b
		receivedHeaders = r.Header.Clone()
		receivedHost = r.Host
		mu.Unlock()

		switch returnMode.Load() {
		case 1:
			w.Header().Set("Retry-After", "45")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte("slow down downstream"))
		case 2:
			w.Header().Set("Location", "/should-not-follow")
			w.WriteHeader(http.StatusFound)
		default:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer localTarget.Close()

	statusEvents := make(chan bool, 4)
	hub := agent.NewHub(repo, func(endpointID string, connected bool) {
		if endpointID == ep.ID {
			statusEvents <- connected
		}
	})
	hub.SetKeepalive(50*time.Millisecond, 500*time.Millisecond)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/agent/connect", hub.ServeConnect)
	relayServer := httptest.NewServer(mux)
	defer relayServer.Close()

	welcomeCh := make(chan agent.WelcomePayload, 1)
	client := agent.NewClient(agent.ClientConfig{
		ServerURL:    relayServer.URL,
		Token:        ep.AgentToken,
		ForwardURL:   localTarget.URL + "/hooks/stripe",
		Timeout:      5 * time.Second,
		PingInterval: 50 * time.Millisecond,
		PongWait:     500 * time.Millisecond,
		OnWelcome: func(w agent.WelcomePayload) {
			select {
			case welcomeCh <- w:
			default:
			}
		},
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	select {
	case w := <-welcomeCh:
		if w.EndpointID != ep.ID {
			t.Fatalf("expected endpoint ID %s in welcome, got %s", ep.ID, w.EndpointID)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for agent welcome handshake")
	}

	select {
	case connected := <-statusEvents:
		if !connected {
			t.Fatalf("expected status callback connected=true")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for onStatus(true)")
	}

	// 1. Exact raw whitespace preservation + >64KB frame handling (tests 16-bit RFC 6455 frame length)
	rawPayload := []byte("{\n  \"event\": \"invoice.paid\",\n  \"pad\": \"" + strings.Repeat("A", 70000) + "\"\n}")
	resp, err := hub.Dispatch(context.Background(), ep.ID, agent.DispatchRequest{
		RequestID:  "req_1",
		EventID:    "evt_1",
		EndpointID: ep.ID,
		TargetURL:  "https://unreachable.example.internal/webhook",
		Method:     http.MethodPost,
		Headers: map[string]string{
			"Content-Type":         "application/json",
			"Stripe-Signature":     "t=1700000000,v1=deadbeef",
			"X-RelayGate-Delivery": "evt_1",
		},
		PayloadBase64: base64.StdEncoding.EncodeToString(rawPayload),
		TimeoutMs:     5000,
	})
	if err != nil {
		t.Fatalf("Dispatch #1 failed: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected HTTP 201, got %d (err=%s)", resp.StatusCode, resp.Error)
	}

	mu.Lock()
	if string(receivedBody) != string(rawPayload) {
		t.Fatalf("payload bytes altered across tunnel: len got %d vs want %d", len(receivedBody), len(rawPayload))
	}
	if receivedHeaders.Get("Stripe-Signature") != "t=1700000000,v1=deadbeef" {
		t.Fatalf("expected Stripe-Signature preserved, got %q", receivedHeaders.Get("Stripe-Signature"))
	}
	if receivedHost == "" {
		t.Fatalf("expected non-empty Host header on forwarded request")
	}
	mu.Unlock()

	// 2. HTTP 429 Retry-After propagation
	returnMode.Store(1)
	resp429, err := hub.Dispatch(context.Background(), ep.ID, agent.DispatchRequest{
		RequestID:     "req_2",
		EventID:       "evt_2",
		EndpointID:    ep.ID,
		TargetURL:     localTarget.URL,
		Method:        http.MethodPost,
		PayloadBase64: base64.StdEncoding.EncodeToString([]byte(`{}`)),
	})
	if err != nil {
		t.Fatalf("Dispatch #2 failed: %v", err)
	}
	if resp429.StatusCode != http.StatusTooManyRequests || resp429.RetryAfter != "45" || resp429.BodySnippet != "slow down downstream" {
		t.Fatalf("unexpected 429 response: %+v", resp429)
	}

	// 3. HTTP 302 Redirect must NOT be followed automatically
	returnMode.Store(2)
	callsBeforeRedirect := callCount.Load()
	resp302, err := hub.Dispatch(context.Background(), ep.ID, agent.DispatchRequest{
		RequestID:     "req_3",
		EventID:       "evt_3",
		EndpointID:    ep.ID,
		TargetURL:     localTarget.URL,
		Method:        http.MethodPost,
		PayloadBase64: base64.StdEncoding.EncodeToString([]byte(`{}`)),
	})
	if err != nil {
		t.Fatalf("Dispatch #3 failed: %v", err)
	}
	if resp302.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 without following redirect, got %d", resp302.StatusCode)
	}
	if callCount.Load() != callsBeforeRedirect+1 {
		t.Fatalf("redirect was followed unexpectedly: calls before %d after %d", callsBeforeRedirect, callCount.Load())
	}
}
