package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

var hopByHopForwardHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailers":            true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"host":                true,
	"content-length":      true,
}

var reconnectBackoffs = []time.Duration{
	100 * time.Millisecond,
	500 * time.Millisecond,
	1 * time.Second,
	2 * time.Second,
	5 * time.Second,
}

// ClientConfig configures a local relaygate-agent outbound tunnel worker.
type ClientConfig struct {
	ServerURL    string
	Token        string
	ForwardURL   string
	Timeout      time.Duration
	MaxInFlight  int
	PingInterval time.Duration
	PongWait     time.Duration
	Logger       *slog.Logger
	OnWelcome    func(WelcomePayload)
	OnDispatch   func(DispatchRequest, DispatchResponse)
}

// Client connects outbound to RelayGate Server and forwards webhook payloads to local targets.
type Client struct {
	cfg        ClientConfig
	httpClient *http.Client

	ackMu       sync.Mutex
	pendingAcks []*DispatchResponse
}

// NewClient initializes a relaygate-agent Client with redirect blocking and sensible defaults.
func NewClient(cfg ClientConfig) *Client {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 15 * time.Second
	}
	if cfg.MaxInFlight <= 0 {
		cfg.MaxInFlight = 32
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = defaultPingInterval
	}
	if cfg.PongWait <= 0 {
		cfg.PongWait = defaultPongWait
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}

	httpClient := &http.Client{
		Timeout: cfg.Timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	return &Client{
		cfg:        cfg,
		httpClient: httpClient,
	}
}

// Run continuously maintains the outbound tunnel connection with bounded exponential backoff.
func (c *Client) Run(ctx context.Context) error {
	if strings.TrimSpace(c.cfg.ServerURL) == "" {
		return errors.New("server url is required")
	}
	if strings.TrimSpace(c.cfg.Token) == "" {
		return errors.New("agent token is required")
	}

	attempt := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		connectedAt := time.Now()
		err := c.dialAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Reset backoff whenever a connection stayed healthy for more than a few seconds.
		if time.Since(connectedAt) >= 3*time.Second {
			attempt = 0
		}

		delay := reconnectBackoffs[len(reconnectBackoffs)-1]
		if attempt < len(reconnectBackoffs) {
			delay = reconnectBackoffs[attempt]
		}
		attempt++

		c.cfg.Logger.Warn("tunnel disconnected, reconnecting", "error", err, "retry_in", delay.String())
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func buildConnectURL(serverURL string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(serverURL), "/")
	if strings.HasSuffix(trimmed, "/api/v1/agent/connect") {
		return trimmed
	}
	return trimmed + "/api/v1/agent/connect"
}

func (c *Client) dialAndServe(ctx context.Context) error {
	connectURL := buildConnectURL(c.cfg.ServerURL)
	conn, err := DialWS(ctx, connectURL, map[string]string{
		"X-RelayGate-Agent-Token": c.cfg.Token,
	})
	if err != nil {
		return err
	}
	defer conn.Close()

	// Cancel dial-scoped goroutines cleanly when the read loop returns or ctx is cancelled.
	sessCtx, cancelSess := context.WithCancel(ctx)
	defer cancelSess()

	go func() {
		<-sessCtx.Done()
		_ = conn.WriteClose(1000, "agent shutdown")
	}()

	go func() {
		ticker := time.NewTicker(c.cfg.PingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-sessCtx.Done():
				return
			case <-ticker.C:
				if err := conn.WritePing([]byte("hb")); err != nil {
					cancelSess()
					return
				}
			}
		}
	}()

	// Flush any ACKs completed right before a previous WebSocket drop.
	c.flushPendingAcks(conn)

	sem := make(chan struct{}, c.cfg.MaxInFlight)
	var wg sync.WaitGroup
	defer wg.Wait()

	conn.SetReadIdleTimeout(c.cfg.PongWait)
	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			cancelSess()
			return err
		}

		var frame WireFrame
		if err := json.Unmarshal(payload, &frame); err != nil {
			continue
		}

		switch frame.Type {
		case FrameWelcome:
			if frame.Welcome != nil && c.cfg.OnWelcome != nil {
				c.cfg.OnWelcome(*frame.Welcome)
			}
		case FrameDispatch:
			if frame.Dispatch == nil {
				continue
			}
			req := *frame.Dispatch
			select {
			case sem <- struct{}{}:
			case <-sessCtx.Done():
				return sessCtx.Err()
			}
			wg.Add(1)
			go func(dReq DispatchRequest) {
				defer wg.Done()
				defer func() { <-sem }()

				ack := c.executeDispatch(ctx, dReq)
				if c.cfg.OnDispatch != nil {
					c.cfg.OnDispatch(dReq, ack)
				}
				if sendErr := sendAckFrame(conn, &ack); sendErr != nil {
					c.enqueuePendingAck(&ack)
				}
			}(req)
		case FramePing:
			pongBytes, _ := json.Marshal(WireFrame{
				Type:      FramePong,
				Timestamp: frame.Timestamp,
			})
			_ = conn.WriteText(pongBytes)
		}
	}
}

func sendAckFrame(conn *WSConn, ack *DispatchResponse) error {
	bytesOut, err := json.Marshal(WireFrame{
		Type: FrameAck,
		Ack:  ack,
	})
	if err != nil {
		return err
	}
	return conn.WriteText(bytesOut)
}

func (c *Client) enqueuePendingAck(ack *DispatchResponse) {
	c.ackMu.Lock()
	defer c.ackMu.Unlock()
	if len(c.pendingAcks) < 1000 {
		c.pendingAcks = append(c.pendingAcks, ack)
	}
}

func (c *Client) flushPendingAcks(conn *WSConn) {
	c.ackMu.Lock()
	if len(c.pendingAcks) == 0 {
		c.ackMu.Unlock()
		return
	}
	queue := c.pendingAcks
	c.pendingAcks = nil
	c.ackMu.Unlock()

	for i, ack := range queue {
		if err := sendAckFrame(conn, ack); err != nil {
			c.ackMu.Lock()
			c.pendingAcks = append(queue[i:], c.pendingAcks...)
			c.ackMu.Unlock()
			return
		}
	}
}

func (c *Client) executeDispatch(parentCtx context.Context, req DispatchRequest) DispatchResponse {
	timeout := c.cfg.Timeout
	if req.TimeoutMs > 0 {
		reqDur := time.Duration(req.TimeoutMs) * time.Millisecond
		if reqDur < timeout {
			timeout = reqDur
		}
	}
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()

	rawBody, err := base64.StdEncoding.DecodeString(req.PayloadBase64)
	if err != nil {
		return DispatchResponse{
			RequestID: req.RequestID,
			EventID:   req.EventID,
			Error:     fmt.Sprintf("invalid payload encoding: %v", err),
		}
	}

	destURL := strings.TrimSpace(c.cfg.ForwardURL)
	if destURL == "" {
		destURL = strings.TrimSpace(req.TargetURL)
	}
	parsedDest, err := url.ParseRequestURI(destURL)
	if err != nil || (parsedDest.Scheme != "http" && parsedDest.Scheme != "https") || parsedDest.Host == "" {
		return DispatchResponse{
			RequestID: req.RequestID,
			EventID:   req.EventID,
			Error:     fmt.Sprintf("invalid target url %q", destURL),
		}
	}

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodPost
	}

	httpReq, err := http.NewRequestWithContext(ctx, method, destURL, bytes.NewReader(rawBody))
	if err != nil {
		return DispatchResponse{
			RequestID: req.RequestID,
			EventID:   req.EventID,
			Error:     fmt.Sprintf("failed to build local request: %v", err),
		}
	}
	// Preserve destination Host explicitly so virtual-hosted local servers receive the expected Host header.
	httpReq.Host = parsedDest.Host

	for k, v := range req.Headers {
		if !hopByHopForwardHeaders[strings.ToLower(k)] {
			httpReq.Header.Set(k, v)
		}
	}

	start := time.Now()
	resp, err := c.httpClient.Do(httpReq)
	durationMs := time.Since(start).Milliseconds()
	if err != nil {
		return DispatchResponse{
			RequestID:  req.RequestID,
			EventID:    req.EventID,
			DurationMs: durationMs,
			Error:      err.Error(),
		}
	}
	defer resp.Body.Close()

	var snippet string
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		snippet = strings.TrimSpace(string(b))
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	}

	return DispatchResponse{
		RequestID:   req.RequestID,
		EventID:     req.EventID,
		StatusCode:  resp.StatusCode,
		RetryAfter:  resp.Header.Get("Retry-After"),
		BodySnippet: snippet,
		DurationMs:  durationMs,
	}
}

// RunCLI runs the outbound forwarder agent loop with standard operator console logging.
func RunCLI(ctx context.Context, cfg ClientConfig) error {
	if strings.TrimSpace(cfg.ServerURL) == "" {
		return errors.New("server url is required (-server or RELAYGATE_SERVER_URL)")
	}
	if strings.TrimSpace(cfg.Token) == "" {
		return errors.New("agent token is required (-token or RELAYGATE_AGENT_TOKEN)")
	}

	userOnWelcome := cfg.OnWelcome
	userOnDispatch := cfg.OnDispatch

	cfg.OnWelcome = func(w WelcomePayload) {
		dest := strings.TrimSpace(cfg.ForwardURL)
		if dest == "" {
			dest = w.TargetURL
		}
		log.Printf("[RelayGate Agent] Tunnel ONLINE | endpoint=%s (%s) | forward=%s", w.EndpointName, w.EndpointID, dest)
		if userOnWelcome != nil {
			userOnWelcome(w)
		}
	}
	cfg.OnDispatch = func(req DispatchRequest, ack DispatchResponse) {
		dest := strings.TrimSpace(cfg.ForwardURL)
		if dest == "" {
			dest = req.TargetURL
		}
		if ack.Error != "" {
			log.Printf("[RelayGate Agent] POST %s | event=%s | ERROR=%s (%dms)", dest, req.EventID, ack.Error, ack.DurationMs)
		} else {
			log.Printf("[RelayGate Agent] POST %s | event=%s | HTTP %d (%dms)", dest, req.EventID, ack.StatusCode, ack.DurationMs)
		}
		if userOnDispatch != nil {
			userOnDispatch(req, ack)
		}
	}

	log.Printf("[RelayGate Agent] Connecting to RelayGate server %s ...", cfg.ServerURL)
	return NewClient(cfg).Run(ctx)
}
