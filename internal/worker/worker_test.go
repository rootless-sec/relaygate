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
	"sync"
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

	// Wait for workers to process and deliver events
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		stats, err := db.GetStats(ctx)
		if err == nil && stats.DeliveredEvents == int64(eventCount) {
			break
		}
		time.Sleep(20 * time.Millisecond)
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
		multiplier := float64(int64(1) << attempt)
		expectedBase := 10.0 * multiplier
		minExpected := time.Duration(expectedBase * 0.79 * float64(time.Second))
		maxExpected := time.Duration(expectedBase * 1.21 * float64(time.Second))

		for run := 0; run < 20; run++ {
			b := pool.CalculateBackoff(attempt)
			if b < minExpected || b > maxExpected {
				t.Fatalf("attempt %d run %d: backoff %v outside expected window [%v, %v]", attempt, run, b, minExpected, maxExpected)
			}
		}
	}

	// Verify capping at MaxBackoff
	for run := 0; run < 10; run++ {
		b := pool.CalculateBackoff(20)
		if b > cfg.MaxBackoff {
			t.Fatalf("backoff for large attempt %v exceeded MaxBackoff %v", b, cfg.MaxBackoff)
		}
	}
}

func TestWorker_InvalidSignatureRejected(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	var targetHitCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetHitCount.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-strict-verif",
		Name:      "Strict Verif Endpoint",
		SecretKey: "secret-key-xyz",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:         "evt-forged",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "10.0.0.99",
		Headers: map[string]string{
			"Content-Type":       "application/json",
			"X-Signature-SHA256": "completely_invalid_forged_signature",
		},
		Payload:     []byte(`{"hacked": true}`),
		Status:      model.StatusPending,
		MaxAttempts: 3,
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	// Attempt dispatch
	_ = pool.Dispatch(ctx, ev.ID)

	// Downstream target MUST NOT have been called!
	if targetHitCount.Load() != 0 {
		t.Fatalf("SECURITY VIOLATION: downstream target was called %d times for forged signature!", targetHitCount.Load())
	}

	// Event in database must be marked FAILED with IsVerified = -1
	updated, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if updated.Status != model.StatusFailed {
		t.Errorf("expected status FAILED, got %s", updated.Status)
	}
	if updated.IsVerified != -1 {
		t.Errorf("expected is_verified = -1, got %d", updated.IsVerified)
	}
	if updated.LastError == "" {
		t.Errorf("expected last_error to record signature verification failure")
	}
}

func TestWorker_InFlightDeduplication(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		time.Sleep(50 * time.Millisecond) // Slow downstream
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-slow",
		Name:      "Slow Endpoint",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:          "evt-slow",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{},
		Payload:     []byte(`{}`),
		Status:      model.StatusPending,
		MaxAttempts: 3,
	}
	_ = db.SaveEvent(ctx, ev)

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	// Launch two simultaneous dispatches of the same event
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = pool.Dispatch(ctx, ev.ID)
	}()
	go func() {
		defer wg.Done()
		_ = pool.Dispatch(ctx, ev.ID)
	}()
	wg.Wait()

	// Exactly 1 request must have hit the downstream server!
	if requestCount.Load() != 1 {
		t.Fatalf("expected exactly 1 dispatch, but received %d duplicate requests", requestCount.Load())
	}
}

// TestWorker_ReplayHTTP504_ResetsAttemptsToZeroAndRetries verifies requirement E.1:
// After replay of a 504 event, attempts must be reset to 0 and the event must receive
// full retry attempts (up to max_attempts) rather than immediately failing back to DLQ.
func TestWorker_ReplayHTTP504_ResetsAttemptsToZeroAndRetries(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	var attemptsReceived atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attemptsReceived.Add(1)
		w.WriteHeader(http.StatusGatewayTimeout) // Downstream 504 Gateway Timeout
		w.Write([]byte(`{"error":"gateway timeout"}`))
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-504",
		Name:      "504 Test Endpoint",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	// Simulate event that already failed 5 attempts in DLQ
	ev := &model.WebhookEvent{
		ID:             "evt-504-exhausted",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"test":"504"}`),
		Status:         model.StatusFailed,
		HTTPStatusCode: 504,
		Attempts:       5,
		MaxAttempts:    5,
		LastError:      "downstream returned HTTP 504: gateway timeout",
		FailureCode:    string(model.ErrCodeHTTP5xx),
	}
	_ = db.SaveEvent(ctx, ev)

	// Step 1: User replays the event. Status is set to PENDING.
	if err := db.UpdateEventStatus(ctx, ev.ID, model.StatusPending, 0, ""); err != nil {
		t.Fatalf("UpdateEventStatus to PENDING failed: %v", err)
	}

	// Verify that attempts in DB is immediately reset to 0!
	replayedEv, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if replayedEv.Attempts != 0 {
		t.Fatalf("E.1 Assertion Failed: expected attempts reset to 0 after replay, got %d", replayedEv.Attempts)
	}
	if replayedEv.Status != model.StatusPending {
		t.Fatalf("expected status PENDING after replay, got %s", replayedEv.Status)
	}

	// Step 2: Worker processes the replayed event (1st attempt of new cycle).
	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	_ = pool.Dispatch(ctx, ev.ID)

	after1stAttempt, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	// It should NOT be FAILED (not returning directly to DLQ)!
	// Since max_attempts=5 and this is attempt 1, status must be RETRYING with attempts=1.
	if after1stAttempt.Attempts != 1 {
		t.Errorf("expected attempts to be 1 after first failure, got %d", after1stAttempt.Attempts)
	}
	if after1stAttempt.Status != model.StatusRetrying {
		t.Errorf("expected status RETRYING (not immediately DLQ FAILED), got %s", after1stAttempt.Status)
	}
	if after1stAttempt.NextRetryAt == nil {
		t.Errorf("expected NextRetryAt to be scheduled")
	}
}

// TestWorker_E2E_SignatureMismatch_ReverifyFlow verifies requirement E.2:
// Wrong secret -> verifikasi ulang -> kembali ke DLQ dengan failed_at baru dan penyebab sama.
// Betulkan secret -> verifikasi ulang -> lolos dan keluar dari DLQ (DELIVERED).
func TestWorker_E2E_SignatureMismatch_ReverifyFlow(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()

	// 1. Initial setup with WRONG secret
	ep := &model.Endpoint{
		ID:        "ep-xendit-test",
		Name:      "Xendit Endpoint",
		TargetURL: server.URL,
		SecretKey: "wrong-token-abc",
		Provider:  model.ProviderXendit,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	// The webhook arrives with "correct-token-xyz"
	correctToken := "correct-token-xyz"
	ev := &model.WebhookEvent{
		ID:          "evt-xendit-mismatch",
		EndpointID:  ep.ID,
		Provider:    model.ProviderXendit,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{"X-Callback-Token": correctToken},
		Payload:     []byte(`{"id":"xendit-123","status":"COMPLETED"}`),
		Status:      model.StatusPending,
		IsVerified:  0,
		MaxAttempts: 5,
	}
	_ = db.SaveEvent(ctx, ev)

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	// First dispatch: verification fails because endpoint has wrong secret
	_ = pool.Dispatch(ctx, ev.ID)

	evFailed1, _ := db.GetEventByID(ctx, ev.ID)
	if evFailed1.Status != model.StatusFailed {
		t.Fatalf("expected status FAILED after first mismatch, got %s", evFailed1.Status)
	}
	if evFailed1.IsVerified != -1 {
		t.Fatalf("expected IsVerified -1, got %d", evFailed1.IsVerified)
	}
	if evFailed1.FailureCode != string(model.ErrCodeSignatureMismatch) {
		t.Fatalf("expected failure code SIGNATURE_MISMATCH, got %s", evFailed1.FailureCode)
	}
	if evFailed1.FailedAt == nil {
		t.Fatalf("expected FailedAt to be set")
	}
	t1 := *evFailed1.FailedAt

	// Sleep slightly to ensure distinct timestamp
	time.Sleep(1050 * time.Millisecond)

	// Step 2: Replay WITHOUT fixing secret (still "wrong-token-abc")
	_ = db.UpdateEventVerification(ctx, ev.ID, 0)
	_ = db.UpdateEventStatus(ctx, ev.ID, model.StatusPending, 0, "")

	_ = pool.Dispatch(ctx, ev.ID)

	evFailed2, _ := db.GetEventByID(ctx, ev.ID)
	if evFailed2.Status != model.StatusFailed {
		t.Fatalf("expected status FAILED again when secret is still wrong, got %s", evFailed2.Status)
	}
	if evFailed2.FailureCode != string(model.ErrCodeSignatureMismatch) {
		t.Fatalf("expected same failure code SIGNATURE_MISMATCH, got %s", evFailed2.FailureCode)
	}
	if evFailed2.FailedAt == nil {
		t.Fatalf("expected FailedAt to be set again")
	}
	t2 := *evFailed2.FailedAt
	if !t2.After(t1) {
		t.Fatalf("E.2 Assertion Failed: expected new failed_at (%v) to be strictly after t1 (%v)", t2, t1)
	}

	// Step 3: FIX the secret in endpoint
	ep.SecretKey = correctToken
	_ = db.SaveEndpoint(ctx, ep)

	// Replay again with fixed secret
	_ = db.UpdateEventVerification(ctx, ev.ID, 0)
	_ = db.UpdateEventStatus(ctx, ev.ID, model.StatusPending, 0, "")

	_ = pool.Dispatch(ctx, ev.ID)

	evDelivered, _ := db.GetEventByID(ctx, ev.ID)
	if evDelivered.Status != model.StatusDelivered {
		t.Fatalf("E.2 Assertion Failed: expected status DELIVERED after fixing secret, got %s (err: %s)", evDelivered.Status, evDelivered.LastError)
	}
	if evDelivered.IsVerified != 1 {
		t.Fatalf("expected IsVerified = 1, got %d", evDelivered.IsVerified)
	}
	if evDelivered.HTTPStatusCode != http.StatusOK {
		t.Fatalf("expected HTTP 200 OK, got %d", evDelivered.HTTPStatusCode)
	}
}

// TestWorker_HTTP4xx_DeliveryFailure verifies requirement E.4:
// 4xx downstream refusal classification, failure code, and replay eligibility.
func TestWorker_HTTP4xx_DeliveryFailure(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity) // 422 Unprocessable Entity
		w.Write([]byte(`{"error":"validation failed: invalid order_id"}`))
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-4xx",
		Name:      "4xx Downstream",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:          "evt-422",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{},
		Payload:     []byte(`{"order_id":""}`),
		Status:      model.StatusPending,
		MaxAttempts: 1, // Fail directly to DLQ
	}
	_ = db.SaveEvent(ctx, ev)

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	_ = pool.Dispatch(ctx, ev.ID)

	after, _ := db.GetEventByID(ctx, ev.ID)
	if after.Status != model.StatusFailed {
		t.Fatalf("expected status FAILED, got %s", after.Status)
	}
	if after.HTTPStatusCode != 422 {
		t.Fatalf("expected HTTPStatusCode 422, got %d", after.HTTPStatusCode)
	}
	if after.FailureCode != string(model.ErrCodeHTTP4xx) {
		t.Fatalf("expected FailureCode HTTP_4XX, got %s", after.FailureCode)
	}
	if !after.IsEligibleForReplay() {
		t.Fatalf("expected 4xx delivery failure to be eligible for replay")
	}
}

// TestWorker_ConnectionTimeout_DeliveryFailure verifies requirement E.4:
// Timeout/network connection failure classification and replay eligibility.
func TestWorker_ConnectionTimeout_DeliveryFailure(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	// Non-routable / closed IP to provoke connection refused / network error
	ep := &model.Endpoint{
		ID:        "ep-conn-refused",
		Name:      "Unreachable Downstream",
		TargetURL: "http://127.0.0.1:54321/non-existent",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:          "evt-network-err",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{},
		Payload:     []byte(`{}`),
		Status:      model.StatusPending,
		MaxAttempts: 1,
	}
	_ = db.SaveEvent(ctx, ev)

	cfg := worker.DefaultConfig()
	cfg.HTTPTimeout = 500 * time.Millisecond
	pool := worker.NewPool(db, v, cfg)

	_ = pool.Dispatch(ctx, ev.ID)

	after, _ := db.GetEventByID(ctx, ev.ID)
	if after.Status != model.StatusFailed {
		t.Fatalf("expected status FAILED, got %s", after.Status)
	}
	if after.FailureCode != string(model.ErrCodeNetworkError) && after.FailureCode != string(model.ErrCodeTimeout) {
		t.Fatalf("expected NETWORK_ERROR or TIMEOUT failure code, got %s", after.FailureCode)
	}
	if !after.IsEligibleForReplay() {
		t.Fatalf("expected connection failure to be eligible for replay")
	}
}

func TestWorker_ReplayDeliveredOnFirstAttempt_IncrementsAttemptsToOne(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	// 1. Mock downstream endpoint returning 200 OK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"received":true}`))
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-replay-success",
		Name:      "Replay Success Endpoint",
		TargetURL: server.URL,
		SecretKey: "secret",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 2. Event previously in DLQ with attempts=5, now replayed (reset to PENDING and attempts=0)
	ev := &model.WebhookEvent{
		ID:          "evt-replay-dlq-delivered",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{"Content-Type": "application/json"},
		Payload:     []byte(`{"test":true}`),
		Status:      model.StatusPending, // Replayed state
		Attempts:    0,                   // Reset to 0 on replay
		MaxAttempts: 5,
		IsVerified:  1,
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	// 3. Dispatch the replayed event
	if err := pool.Dispatch(ctx, ev.ID); err != nil {
		t.Fatalf("Dispatch failed: %v", err)
	}

	// 4. Verify in database: status must be DELIVERED and attempts must be exactly 1 (not 0)
	after, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	if after.Status != model.StatusDelivered {
		t.Errorf("expected status DELIVERED, got %s", after.Status)
	}
	if after.Attempts != 1 {
		t.Errorf("expected attempts = 1 upon successful replay dispatch, got %d", after.Attempts)
	}
	if after.FailedAt != nil {
		t.Errorf("expected failed_at to be nil upon DELIVERED, got %v", after.FailedAt)
	}
}

func TestWorker_ConfigEnvOverridesFallback(t *testing.T) {
	// Case 1: Empty environment variables must preserve production defaults (10s, 3s)
	t.Setenv("RELAYGATE_WORKER_BASE_BACKOFF", "")
	t.Setenv("RELAYGATE_WORKER_POLL_INTERVAL", "")
	cfg1 := worker.DefaultConfig()
	cfg1.ApplyEnvOverrides()
	if cfg1.BaseBackoff != 10*time.Second {
		t.Errorf("expected default BaseBackoff 10s, got %v", cfg1.BaseBackoff)
	}
	if cfg1.PollInterval != 3*time.Second {
		t.Errorf("expected default PollInterval 3s, got %v", cfg1.PollInterval)
	}

	// Case 2: Invalid or negative durations must fall back to production defaults
	t.Setenv("RELAYGATE_WORKER_BASE_BACKOFF", "not-a-duration")
	t.Setenv("RELAYGATE_WORKER_POLL_INTERVAL", "-500ms")
	cfg2 := worker.DefaultConfig()
	cfg2.ApplyEnvOverrides()
	if cfg2.BaseBackoff != 10*time.Second {
		t.Errorf("expected fallback BaseBackoff 10s for invalid string, got %v", cfg2.BaseBackoff)
	}
	if cfg2.PollInterval != 3*time.Second {
		t.Errorf("expected fallback PollInterval 3s for negative duration, got %v", cfg2.PollInterval)
	}

	// Case 3: Valid positive durations must override config
	t.Setenv("RELAYGATE_WORKER_BASE_BACKOFF", "100ms")
	t.Setenv("RELAYGATE_WORKER_POLL_INTERVAL", "50ms")
	cfg3 := worker.DefaultConfig()
	cfg3.ApplyEnvOverrides()
	if cfg3.BaseBackoff != 100*time.Millisecond {
		t.Errorf("expected overridden BaseBackoff 100ms, got %v", cfg3.BaseBackoff)
	}
	if cfg3.PollInterval != 50*time.Millisecond {
		t.Errorf("expected overridden PollInterval 50ms, got %v", cfg3.PollInterval)
	}
}

func TestWorker_RetryingWithAttemptsEqualMax_MarkedFailedWithoutDownstream(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	var downstreamReqCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamReqCount.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-guard-test",
		Name:      "guard-ep",
		SecretKey: "secret",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:             "evt-retrying-guard",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		Status:         model.StatusRetrying,
		Attempts:       5,
		MaxAttempts:    5,
		HTTPStatusCode: 504,
		LastError:      "HTTP 504 Gateway Timeout",
		FailureCode:    string(model.ErrCodeHTTP5xx),
		IsVerified:     1,
		Headers: map[string]string{
			"Content-Type": "application/json",
		},
		Payload: []byte(`{"ping":true}`),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	// Execute 1 worker cycle / dispatch
	if err := pool.Dispatch(ctx, ev.ID); err != nil {
		t.Fatalf("Dispatch failed: %v", err)
	}

	// Verify downstream received NO requests
	if count := downstreamReqCount.Load(); count != 0 {
		t.Errorf("expected 0 requests to downstream, got %d", count)
	}

	// Verify event is now marked FAILED, preserving last_error and http_status_code, and has failed_at set
	updated, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	if updated.Status != model.StatusFailed {
		t.Errorf("expected status FAILED, got %s", updated.Status)
	}
	if updated.Attempts != 5 {
		t.Errorf("expected attempts = 5, got %d", updated.Attempts)
	}
	if updated.HTTPStatusCode != 504 {
		t.Errorf("expected http_status_code = 504, got %d", updated.HTTPStatusCode)
	}
	if updated.LastError != "HTTP 504 Gateway Timeout" {
		t.Errorf("expected last_error preserved, got %s", updated.LastError)
	}
	if updated.FailedAt == nil {
		t.Errorf("expected failed_at to be set, got nil")
	}
}

type zeroMaxAttemptsRepo struct {
	storage.Repository
}

func (r *zeroMaxAttemptsRepo) GetEventByID(ctx context.Context, id string) (*model.WebhookEvent, error) {
	ev, err := r.Repository.GetEventByID(ctx, id)
	if err != nil {
		return nil, err
	}
	ev.MaxAttempts = 0
	return ev, nil
}

func TestWorker_MaxAttemptsZeroOrNull_UsesDefaultAndDispatches(t *testing.T) {
	db, v, cleanup := createTestEnv(t)
	defer cleanup()

	ctx := context.Background()

	var downstreamReqCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamReqCount.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	ep := &model.Endpoint{
		ID:        "ep-zero-max-test",
		Name:      "zero-max-ep",
		SecretKey: "secret",
		TargetURL: server.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// Case 1: DB row has attempts=0, max_attempts=0 in SQLite
	ev1 := &model.WebhookEvent{
		ID:          "evt-zero-max-db",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		Status:      model.StatusPending,
		Attempts:    0,
		MaxAttempts: 0,
		IsVerified:  1,
		Headers:     map[string]string{"Content-Type": "application/json"},
		Payload:     []byte(`{"test":"zero_max_db"}`),
	}
	if err := db.SaveEvent(ctx, ev1); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}
	// Force max_attempts = 0 in raw SQLite row to test storage + worker guard fallback
	if _, err := db.RawDB().ExecContext(ctx, `UPDATE webhook_events SET max_attempts = 0 WHERE id = ?;`, ev1.ID); err != nil {
		t.Fatalf("failed to force max_attempts=0 in SQL: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.HTTPClient = server.Client()
	pool := worker.NewPool(db, v, cfg)

	if err := pool.Dispatch(ctx, ev1.ID); err != nil {
		t.Fatalf("Dispatch failed for ev1: %v", err)
	}
	if count := downstreamReqCount.Load(); count != 1 {
		t.Fatalf("expected downstream to receive 1 request for max_attempts=0 DB row, got %d", count)
	}
	updated1, err := db.GetEventByID(ctx, ev1.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if updated1.Status != model.StatusDelivered {
		t.Errorf("expected status DELIVERED, got %s", updated1.Status)
	}

	// Case 2: Repository returns event with Attempts=0, MaxAttempts=0 directly to worker guard
	ev2 := &model.WebhookEvent{
		ID:          "evt-zero-max-struct",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		Status:      model.StatusPending,
		Attempts:    0,
		MaxAttempts: 0,
		IsVerified:  1,
		Headers:     map[string]string{"Content-Type": "application/json"},
		Payload:     []byte(`{"test":"zero_max_struct"}`),
	}
	if err := db.SaveEvent(ctx, ev2); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	poolWithZeroRepo := worker.NewPool(&zeroMaxAttemptsRepo{Repository: db}, v, cfg)
	if err := poolWithZeroRepo.Dispatch(ctx, ev2.ID); err != nil {
		t.Fatalf("Dispatch failed for ev2: %v", err)
	}
	if count := downstreamReqCount.Load(); count != 2 {
		t.Fatalf("expected downstream to receive 2nd request when repo returns MaxAttempts=0, got %d", count)
	}
	updated2, err := db.GetEventByID(ctx, ev2.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if updated2.Status != model.StatusDelivered {
		t.Errorf("expected status DELIVERED for ev2, got %s", updated2.Status)
	}
}
