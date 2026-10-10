package ingest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
