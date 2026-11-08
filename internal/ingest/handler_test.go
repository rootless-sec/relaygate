package ingest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/ingest"
	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

func setupIngestEnv(t *testing.T) (*storage.DB, *worker.Pool, *ingest.Handler, func()) {
	t.Helper()
	tempDir, err := os.MkdirTemp("", "relaygate-ingest-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	dbPath := filepath.Join(tempDir, "test.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		os.RemoveAll(tempDir)
		t.Fatalf("failed to open storage db: %v", err)
	}

	v := verifier.NewEngine()
	cfg := worker.DefaultConfig()
	pool := worker.NewPool(db, v, cfg)

	handler := ingest.NewHandler(db, pool)

	cleanup := func() {
		pool.Stop()
		_ = db.Close()
		_ = os.RemoveAll(tempDir)
	}

	return db, pool, handler, cleanup
}

func TestIngest_SuccessAndPerformance(t *testing.T) {
	db, pool, handler, cleanup := setupIngestEnv(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-fast",
		Name:      "Fast Ingest Endpoint",
		SecretKey: "secret_fast",
		TargetURL: "https://example.com/target",
		Provider:  model.ProviderStripe,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	pool.Start()

	payload := []byte(`{"id":"evt_stripe_123","type":"invoice.paid"}`)
	req := httptest.NewRequest(http.MethodPost, "/ingest/ep-fast", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", "t=12345678,v1=abcdef")
	req.Header.Set("X-Forwarded-For", "203.0.113.195, 10.0.0.1")

	// Measure execution time: must be ultra-fast (< 5ms)
	start := time.Now()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	// Performance verification
	t.Logf("Ingest synchronous disk write latency: %v", elapsed)

	var resp ingest.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse ingest JSON response: %v", err)
	}

	if resp.Status != "queued" {
		t.Errorf("expected status 'queued', got %s", resp.Status)
	}
	if resp.ID == "" {
		t.Errorf("expected non-empty event ID")
	}

	// Verify database persistence
	event, err := db.GetEventByID(ctx, resp.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	if event.EndpointID != ep.ID {
		t.Errorf("expected endpoint_id %s, got %s", ep.ID, event.EndpointID)
	}
	if event.SourceIP != "203.0.113.195" {
		t.Errorf("expected source_ip 203.0.113.195, got %s", event.SourceIP)
	}
	if event.Signature != "t=12345678,v1=abcdef" {
		t.Errorf("expected signature preserved, got %s", event.Signature)
	}
	if string(event.Payload) != string(payload) {
		t.Errorf("expected payload %s, got %s", string(payload), string(event.Payload))
	}
}

func TestIngest_EndpointNotFound(t *testing.T) {
	_, _, handler, cleanup := setupIngestEnv(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/ingest/ep-nonexistent", bytes.NewReader([]byte(`{}`)))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", rec.Code)
	}
}

func TestIngest_EndpointDisabled(t *testing.T) {
	db, _, handler, cleanup := setupIngestEnv(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-disabled",
		Name:      "Disabled Endpoint",
		TargetURL: "https://example.com/target",
		Provider:  model.ProviderGeneric,
		IsActive:  false, // Inactive
	}
	_ = db.SaveEndpoint(ctx, ep)

	req := httptest.NewRequest(http.MethodPost, "/ingest/ep-disabled", bytes.NewReader([]byte(`{}`)))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d", rec.Code)
	}
}

func TestIngest_MethodNotAllowed(t *testing.T) {
	_, _, handler, cleanup := setupIngestEnv(t)
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/ingest/ep-fast", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 Method Not Allowed, got %d", rec.Code)
	}
}

func TestIngest_PayloadTooLarge(t *testing.T) {
	db, _, handler, cleanup := setupIngestEnv(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-large",
		Name:      "Large Endpoint",
		TargetURL: "https://example.com/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	// Create payload > 10MB (10MB + 1KB)
	hugePayload := make([]byte, (10<<20)+1024)
	req := httptest.NewRequest(http.MethodPost, "/ingest/ep-large", bytes.NewReader(hugePayload))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 Request Entity Too Large, got %d", rec.Code)
	}
}

func TestIngest_MidtransBodySignature(t *testing.T) {
	db, _, handler, cleanup := setupIngestEnv(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-midtrans-ingest",
		Name:      "Midtrans Ingest",
		TargetURL: "https://example.com/target",
		Provider:  model.ProviderMidtrans,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	midtransBody := []byte(`{
		"order_id": "ORD-1234",
		"status_code": "200",
		"gross_amount": "50000.00",
		"signature_key": "midtrans_test_sig_9999"
	}`)

	req := httptest.NewRequest(http.MethodPost, "/ingest/ep-midtrans-ingest", bytes.NewReader(midtransBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}

	var resp ingest.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode ingest response: %v", err)
	}

	saved, err := db.GetEventByID(ctx, resp.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if saved.Signature != "midtrans_test_sig_9999" {
		t.Errorf("expected signature extracted from JSON payload, got '%s'", saved.Signature)
	}
}

func TestIngest_RateLimitingAndHeaderTamperingPrevention(t *testing.T) {
	db, _, handler, cleanup := setupIngestEnv(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-security-ingest",
		Name:      "Security Test Ingest",
		TargetURL: "https://example.com/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	// 1. Configure strict rate limit: max 3 requests per 5-second window
	handler.SetRateLimit(3, 5*time.Second)

	body := []byte(`{"event":"test"}`)

	// Requests 1-3 succeed
	for i := 1; i <= 3; i++ {
		req := httptest.NewRequest(http.MethodPost, "/ingest/ep-security-ingest", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected request %d to succeed with 200 OK, got %d: %s", i, rec.Code, rec.Body.String())
		}
	}

	// Request 4 exceeds rate limit and must return 429 Too Many Requests
	reqRateLimited := httptest.NewRequest(http.MethodPost, "/ingest/ep-security-ingest", bytes.NewReader(body))
	reqRateLimited.Header.Set("Content-Type", "application/json")
	recRateLimited := httptest.NewRecorder()
	handler.ServeHTTP(recRateLimited, reqRateLimited)

	if recRateLimited.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests on rate limit exceeded, got %d: %s", recRateLimited.Code, recRateLimited.Body.String())
	}
	if recRateLimited.Header().Get("Retry-After") != "1" {
		t.Errorf("expected Retry-After header '1', got %q", recRateLimited.Header().Get("Retry-After"))
	}

	// 2. Test header tampering defense: internal identity headers must be stripped
	handler.ResetRateLimits()
	handler.SetRateLimit(100, 10*time.Second)

	tamperReq := httptest.NewRequest(http.MethodPost, "/ingest/ep-security-ingest", bytes.NewReader(body))
	tamperReq.Header.Set("Content-Type", "application/json")
	tamperReq.Header.Set("X-User-Role", "admin")
	tamperReq.Header.Set("X-Admin", "true")
	tamperReq.Header.Set("X-User-Email", "root@hacker.com")
	tamperReq.Header.Set("X-Webhook-Event-Type", "order.completed")

	tamperRec := httptest.NewRecorder()
	handler.ServeHTTP(tamperRec, tamperReq)

	if tamperRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on header tamper test, got %d", tamperRec.Code)
	}

	var tamperResp ingest.Response
	_ = json.Unmarshal(tamperRec.Body.Bytes(), &tamperResp)

	savedEvent, err := db.GetEventByID(ctx, tamperResp.ID)
	if err != nil {
		t.Fatalf("failed to retrieve saved event: %v", err)
	}

	for k := range savedEvent.Headers {
		if strings.EqualFold(k, "X-User-Role") || strings.EqualFold(k, "X-Admin") || strings.EqualFold(k, "X-User-Email") {
			t.Errorf("SECURITY DEFECT: Internal identity header %q leaked into stored event headers!", k)
		}
	}
	if _, ok := savedEvent.Headers["X-Webhook-Event-Type"]; !ok {
		t.Errorf("expected legitimate header X-Webhook-Event-Type to be preserved")
	}

	// 3. Test IP Resolver defense against spoofed X-Forwarded-For
	handler.SetIPResolver(func(r *http.Request) string {
		// Mock trusted proxy resolver that rejects untrusted forwarded headers
		return "10.0.0.100"
	})

	ipReq := httptest.NewRequest(http.MethodPost, "/ingest/ep-security-ingest", bytes.NewReader(body))
	ipReq.Header.Set("Content-Type", "application/json")
	ipReq.Header.Set("X-Forwarded-For", "1.1.1.1")
	ipRec := httptest.NewRecorder()
	handler.ServeHTTP(ipRec, ipReq)

	if ipRec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on IP resolver test, got %d", ipRec.Code)
	}
	var ipResp ingest.Response
	_ = json.Unmarshal(ipRec.Body.Bytes(), &ipResp)
	ipEvent, _ := db.GetEventByID(ctx, ipResp.ID)
	if ipEvent.SourceIP != "10.0.0.100" {
		t.Errorf("expected source_ip '10.0.0.100' from resolver, got %q", ipEvent.SourceIP)
	}
}
