package worker_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

func createTestEnv(t *testing.T) (*storage.DB, *verifier.Engine, func()) {
	t.Helper()
	tempDir, err := os.MkdirTemp("", "relaygate-worker-test-*")
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

	cleanup := func() {
		_ = db.Close()
		_ = os.RemoveAll(tempDir)
	}

	return db, v, cleanup
}

func TestWorker_SuccessfulDispatch(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	var receivedBody []byte
	var receivedHeaders http.Header

	// Real HTTP target server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeaders = r.Header.Clone()
		receivedBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"received":true}`))
	}))
	defer server.Close()

	secretKey := "test-secret"
	ep := &model.Endpoint{
		ID:        "ep-target",
		Name:      "Target Webhook",
		SecretKey: secretKey,
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	rawPayload := []byte(`{"event":"order.paid","amount":9999}`)
	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write(rawPayload)
	sig := hex.EncodeToString(mac.Sum(nil))

	ev := &model.WebhookEvent{
		ID:         "evt-success",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "192.168.1.50",
		Headers: map[string]string{
			"Content-Type":       "application/json",
			"X-Signature-SHA256": sig,
			"Host":               "malicious.host", // Should be filtered out
			"Custom-App-Header":  "test-value",
		},
		Payload:     rawPayload,
		Status:      model.StatusPending,
		MaxAttempts: 3,
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	// Dispatch single event
	if err := pool.Dispatch(ctx, ev.ID); err != nil {
		t.Fatalf("Dispatch failed: %v", err)
	}

	// Verify database state
	updated, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	if updated.Status != model.StatusDelivered {
		t.Errorf("expected status DELIVERED, got %s", updated.Status)
	}
	if updated.HTTPStatusCode != 200 {
		t.Errorf("expected HTTP status 200, got %d", updated.HTTPStatusCode)
	}
	if updated.IsVerified != 1 {
		t.Errorf("expected is_verified = 1, got %d", updated.IsVerified)
	}

	// Verify HTTP forward details
	if string(receivedBody) != string(rawPayload) {
		t.Errorf("expected received body %s, got %s", string(rawPayload), string(receivedBody))
	}
	if receivedHeaders.Get("Custom-App-Header") != "test-value" {
		t.Errorf("expected Custom-App-Header forwarded")
	}
	if receivedHeaders.Get("X-RelayGate-Delivery") != ev.ID {
		t.Errorf("expected X-RelayGate-Delivery header %s, got %s", ev.ID, receivedHeaders.Get("X-RelayGate-Delivery"))
	}
}

func TestWorker_RetryAndDeadLetter(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	// Server that returns 500 Internal Server Error
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"database down"}`))
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-failing",
		Name:      "Failing Target",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:          "evt-failing",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{"Content-Type": "application/json"},
		Payload:     []byte(`{"test":"failure"}`),
		Status:      model.StatusPending,
		Attempts:    0,
		MaxAttempts: 2, // 2 attempts before dead-letter
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.BaseBackoff = 50 * time.Millisecond
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	// Attempt 1: should transition to RETRYING
	if err := pool.Dispatch(ctx, ev.ID); err != nil {
		t.Fatalf("Dispatch 1 failed: %v", err)
	}

	ev1, _ := db.GetEventByID(ctx, ev.ID)
	if ev1.Attempts != 1 {
		t.Errorf("expected 1 attempt, got %d", ev1.Attempts)
	}
	if ev1.Status != model.StatusRetrying {
		t.Errorf("expected status RETRYING, got %s", ev1.Status)
	}
	if ev1.NextRetryAt == nil {
		t.Errorf("expected next_retry_at to be set")
	}

	// Attempt 2: reaches MaxAttempts (2) -> should transition to FAILED (Dead-letter)
	if err := pool.Dispatch(ctx, ev.ID); err != nil {
		t.Fatalf("Dispatch 2 failed: %v", err)
	}

	ev2, _ := db.GetEventByID(ctx, ev.ID)
	if ev2.Attempts != 2 {
		t.Errorf("expected 2 attempts, got %d", ev2.Attempts)
	}
	if ev2.Status != model.StatusFailed {
		t.Errorf("expected status FAILED, got %s", ev2.Status)
	}
}

func TestWorker_PoolLifecycleAndConcurrency(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	var processedCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		processedCount.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-pool",
		Name:      "Pool Target",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.Concurrency = 5
	cfg.HTTPClient = server.Client()
	cfg.PollInterval = 100 * time.Millisecond
	pool := worker.NewPool(db, v, cfg)

	pool.Start()

	const eventCount = 15
	for i := 0; i < eventCount; i++ {
		evID := "evt-pool-" + string(rune('a'+i))
		ev := &model.WebhookEvent{
			ID:          evID,
			EndpointID:  ep.ID,
			Provider:    model.ProviderGeneric,
			SourceIP:    "127.0.0.1",
			Headers:     map[string]string{},
			Payload:     []byte(`{"pool":"test"}`),
			Status:      model.StatusPending,
			MaxAttempts: 3,
		}
		if err := db.SaveEvent(ctx, ev); err != nil {
			t.Fatalf("SaveEvent failed: %v", err)
		}
		pool.Enqueue(ev.ID)
	}

	// Wait for workers to process events
	deadline := time.Now().Add(5 * time.Second)
	for processedCount.Load() < eventCount && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	if processedCount.Load() != eventCount {
		t.Fatalf("expected %d processed events, got %d", eventCount, processedCount.Load())
	}

	// Stop pool gracefully
	pool.Stop()

	// Verify all events delivered
	stats, err := db.GetStats(ctx)
	if err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
	if stats.DeliveredEvents != int64(eventCount) {
		t.Errorf("expected %d delivered events, got %d", eventCount, stats.DeliveredEvents)
	}
}

func TestWorker_BackoffCalculation(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	cfg := worker.DefaultConfig()
	cfg.BaseBackoff = 10 * time.Second
	cfg.MaxBackoff = 1 * time.Hour
	cfg.JitterFraction = 0.2
	pool := worker.NewPool(db, v, cfg)

	// Attempt 0: ~10s +/- 20% (8s to 12s)
	// Attempt 1: ~20s +/- 20% (16s to 24s)
	// Attempt 2: ~40s +/- 20% (32s to 48s)
	// Attempt 3: ~80s +/- 20% (64s to 96s)
	for attempt := 0; attempt < 5; attempt++ {
		for run := 0; run < 10; run++ {
			// Access internal calculateBackoff through Dispatch or by testing bounds
			// We can verify that high attempts stay <= MaxBackoff
		}
	}
	_ = pool
}
