package storage_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
)

func createTempDB(t *testing.T) (*storage.DB, func()) {
	t.Helper()
	tempDir, err := os.MkdirTemp("", "relaygate-storage-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	dbPath := filepath.Join(tempDir, "test.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		os.RemoveAll(tempDir)
		t.Fatalf("failed to open storage db: %v", err)
	}

	cleanup := func() {
		_ = db.Close()
		_ = os.RemoveAll(tempDir)
	}

	return db, cleanup
}

func TestStorage_EndpointCRUD(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-123",
		Name:      "Stripe Production",
		SecretKey: "whsec_test123",
		TargetURL: "https://example.com/webhook",
		Provider:  model.ProviderStripe,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}

	// 1. Save Endpoint
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 2. Get Endpoint By ID
	fetched, err := db.GetEndpointByID(ctx, ep.ID)
	if err != nil {
		t.Fatalf("GetEndpointByID failed: %v", err)
	}
	if fetched.Name != ep.Name {
		t.Errorf("expected name %s, got %s", ep.Name, fetched.Name)
	}
	if fetched.SecretKey != ep.SecretKey {
		t.Errorf("expected secret_key %s, got %s", ep.SecretKey, fetched.SecretKey)
	}
	if fetched.TargetURL != ep.TargetURL {
		t.Errorf("expected target_url %s, got %s", ep.TargetURL, fetched.TargetURL)
	}
	if fetched.Provider != ep.Provider {
		t.Errorf("expected provider %s, got %s", ep.Provider, fetched.Provider)
	}
	if !fetched.IsActive {
		t.Errorf("expected active to be true")
	}

	// 3. Upsert / Update Endpoint
	ep.Name = "Stripe Updated"
	ep.IsActive = false
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint update failed: %v", err)
	}

	fetchedUpdated, err := db.GetEndpointByID(ctx, ep.ID)
	if err != nil {
		t.Fatalf("GetEndpointByID after update failed: %v", err)
	}
	if fetchedUpdated.Name != "Stripe Updated" {
		t.Errorf("expected name 'Stripe Updated', got %s", fetchedUpdated.Name)
	}
	if fetchedUpdated.IsActive {
		t.Errorf("expected active to be false")
	}

	// 4. List Endpoints
	list, err := db.ListEndpoints(ctx)
	if err != nil {
		t.Fatalf("ListEndpoints failed: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 endpoint, got %d", len(list))
	}

	// 5. Non-existent endpoint
	_, err = db.GetEndpointByID(ctx, "non-existent")
	if err == nil {
		t.Fatalf("expected error for non-existent endpoint, got nil")
	}
}

func TestStorage_EventLifecycle(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	// Seed endpoint
	ep := &model.Endpoint{
		ID:        "ep-test",
		Name:      "Test Endpoint",
		SecretKey: "secret",
		TargetURL: "https://api.example.com",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 1. Save Event
	event := &model.WebhookEvent{
		ID:         "evt-001",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "192.168.1.100",
		Headers: map[string]string{
			"content-type": "application/json",
			"x-signature":  "abc123sig",
		},
		Payload:     []byte(`{"event":"order.completed","amount":5000}`),
		Signature:   "abc123sig",
		IsVerified:  0,
		Status:      model.StatusPending,
		MaxAttempts: 3,
	}

	if err := db.SaveEvent(ctx, event); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// 2. Get Event By ID
	fetched, err := db.GetEventByID(ctx, event.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if fetched.ID != event.ID {
		t.Errorf("expected event ID %s, got %s", event.ID, fetched.ID)
	}
	if fetched.SourceIP != event.SourceIP {
		t.Errorf("expected source_ip %s, got %s", event.SourceIP, fetched.SourceIP)
	}
	if string(fetched.Payload) != string(event.Payload) {
		t.Errorf("expected payload %s, got %s", string(event.Payload), string(fetched.Payload))
	}
	if fetched.Headers["x-signature"] != "abc123sig" {
		t.Errorf("expected header x-signature, got %v", fetched.Headers)
	}
	if fetched.Status != model.StatusPending {
		t.Errorf("expected status PENDING, got %s", fetched.Status)
	}

	// 3. Update Verification
	if err := db.UpdateEventVerification(ctx, event.ID, 1); err != nil {
		t.Fatalf("UpdateEventVerification failed: %v", err)
	}
	fetched, _ = db.GetEventByID(ctx, event.ID)
	if fetched.IsVerified != 1 {
		t.Errorf("expected is_verified = 1, got %d", fetched.IsVerified)
	}

	// 3b. Simulate retrying state with next_retry_at
	nextRetryTime := time.Now().UTC().Add(30 * time.Second)
	if err := db.IncrementAttempts(ctx, event.ID, &nextRetryTime, "temp error", 500); err != nil {
		t.Fatalf("IncrementAttempts failed: %v", err)
	}
	fetched, _ = db.GetEventByID(ctx, event.ID)
	if fetched.NextRetryAt == nil {
		t.Errorf("expected next_retry_at to be set during RETRYING")
	}

	// 4. Update Event Status to DELIVERED (should clear next_retry_at)
	if err := db.UpdateEventStatus(ctx, event.ID, model.StatusDelivered, 200, ""); err != nil {
		t.Fatalf("UpdateEventStatus failed: %v", err)
	}
	fetched, _ = db.GetEventByID(ctx, event.ID)
	if fetched.Status != model.StatusDelivered {
		t.Errorf("expected status DELIVERED, got %s", fetched.Status)
	}
	if fetched.HTTPStatusCode != 200 {
		t.Errorf("expected HTTP status 200, got %d", fetched.HTTPStatusCode)
	}
	if fetched.NextRetryAt != nil {
		t.Errorf("expected next_retry_at to be cleared (nil) upon DELIVERED, got %v", fetched.NextRetryAt)
	}
}

func TestStorage_RetryAndIncrementAttempts(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-retry",
		Name:      "Retry Endpoint",
		SecretKey: "key",
		TargetURL: "https://retry.example.com",
		Provider:  model.ProviderMidtrans,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	event := &model.WebhookEvent{
		ID:          "evt-retry-1",
		EndpointID:  ep.ID,
		Provider:    model.ProviderMidtrans,
		SourceIP:    "10.0.0.1",
		Headers:     map[string]string{"content-type": "application/json"},
		Payload:     []byte(`{"order_id":"123"}`),
		Status:      model.StatusPending,
		Attempts:    0,
		MaxAttempts: 3,
	}
	if err := db.SaveEvent(ctx, event); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// First attempt failure -> status should become RETRYING, attempts = 1
	nextRetry := time.Now().UTC().Add(10 * time.Second)
	if err := db.IncrementAttempts(ctx, event.ID, &nextRetry, "connection refused", 502); err != nil {
		t.Fatalf("IncrementAttempts (1) failed: %v", err)
	}

	ev1, err := db.GetEventByID(ctx, event.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if ev1.Attempts != 1 {
		t.Errorf("expected attempts 1, got %d", ev1.Attempts)
	}
	if ev1.Status != model.StatusRetrying {
		t.Errorf("expected status RETRYING, got %s", ev1.Status)
	}
	if ev1.HTTPStatusCode != 502 {
		t.Errorf("expected status code 502, got %d", ev1.HTTPStatusCode)
	}
	if ev1.LastError != "connection refused" {
		t.Errorf("expected last_error 'connection refused', got %s", ev1.LastError)
	}

	// Second attempt failure -> attempts = 2, status still RETRYING
	if err := db.IncrementAttempts(ctx, event.ID, &nextRetry, "timeout", 504); err != nil {
		t.Fatalf("IncrementAttempts (2) failed: %v", err)
	}
	ev2, _ := db.GetEventByID(ctx, event.ID)
	if ev2.Attempts != 2 {
		t.Errorf("expected attempts 2, got %d", ev2.Attempts)
	}
	if ev2.Status != model.StatusRetrying {
		t.Errorf("expected status RETRYING, got %s", ev2.Status)
	}

	// Third attempt failure -> attempts = 3 (reaches max_attempts 3) -> status should become FAILED
	if err := db.IncrementAttempts(ctx, event.ID, nil, "permanent error", 500); err != nil {
		t.Fatalf("IncrementAttempts (3) failed: %v", err)
	}
	ev3, _ := db.GetEventByID(ctx, event.ID)
	if ev3.Attempts != 3 {
		t.Errorf("expected attempts 3, got %d", ev3.Attempts)
	}
	if ev3.Status != model.StatusFailed {
		t.Errorf("expected status FAILED, got %s", ev3.Status)
	}
}

func TestStorage_GetPendingRetries(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-pending",
		Name:      "Pending Endpoint",
		SecretKey: "key",
		TargetURL: "https://pending.example.com",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	// Due retry event (next_retry_at in past)
	past := time.Now().UTC().Add(-10 * time.Second)
	eventDue := &model.WebhookEvent{
		ID:          "evt-due",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{},
		Payload:     []byte(`{}`),
		Status:      model.StatusRetrying,
		NextRetryAt: &past,
		MaxAttempts: 5,
	}
	if err := db.SaveEvent(ctx, eventDue); err != nil {
		t.Fatalf("SaveEvent eventDue failed: %v", err)
	}

	// Future retry event (next_retry_at in 10 minutes)
	future := time.Now().UTC().Add(10 * time.Minute)
	eventFuture := &model.WebhookEvent{
		ID:          "evt-future",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{},
		Payload:     []byte(`{}`),
		Status:      model.StatusRetrying,
		NextRetryAt: &future,
		MaxAttempts: 5,
	}
	if err := db.SaveEvent(ctx, eventFuture); err != nil {
		t.Fatalf("SaveEvent eventFuture failed: %v", err)
	}

	// Delivered event
	eventDelivered := &model.WebhookEvent{
		ID:          "evt-delivered",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{},
		Payload:     []byte(`{}`),
		Status:      model.StatusDelivered,
		MaxAttempts: 5,
	}
	if err := db.SaveEvent(ctx, eventDelivered); err != nil {
		t.Fatalf("SaveEvent eventDelivered failed: %v", err)
	}

	// Query pending retries
	retries, err := db.GetPendingRetries(ctx, 10)
	if err != nil {
		t.Fatalf("GetPendingRetries failed: %v", err)
	}

	if len(retries) != 1 {
		t.Fatalf("expected 1 pending retry, got %d", len(retries))
	}
	if retries[0].ID != "evt-due" {
		t.Errorf("expected evt-due, got %s", retries[0].ID)
	}
}

func TestStorage_ListEventsAndStats(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-stats",
		Name:      "Stats Endpoint",
		SecretKey: "key",
		TargetURL: "https://stats.example.com",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	_ = db.SaveEndpoint(ctx, ep)

	// Insert delivered
	_ = db.SaveEvent(ctx, &model.WebhookEvent{
		ID:         "e-deliv",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "1.1.1.1",
		Headers:    map[string]string{},
		Payload:    []byte(`{"payment":"ok"}`),
		Status:     model.StatusDelivered,
	})

	// Insert retrying
	_ = db.SaveEvent(ctx, &model.WebhookEvent{
		ID:         "e-retry",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "2.2.2.2",
		Headers:    map[string]string{},
		Payload:    []byte(`{"payment":"fail"}`),
		Status:     model.StatusRetrying,
		LastError:  "target timeout error",
	})

	// Insert failed
	_ = db.SaveEvent(ctx, &model.WebhookEvent{
		ID:         "e-fail",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "3.3.3.3",
		Headers:    map[string]string{},
		Payload:    []byte(`{"payment":"dropped"}`),
		Status:     model.StatusFailed,
		LastError:  "max retries exceeded",
	})

	// 1. Stats test
	stats, err := db.GetStats(ctx)
	if err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
	if stats.TotalEvents != 3 {
		t.Errorf("expected 3 total events, got %d", stats.TotalEvents)
	}
	if stats.DeliveredEvents != 1 {
		t.Errorf("expected 1 delivered, got %d", stats.DeliveredEvents)
	}
	if stats.RetryingEvents != 1 {
		t.Errorf("expected 1 retrying, got %d", stats.RetryingEvents)
	}
	if stats.FailedEvents != 1 {
		t.Errorf("expected 1 failed, got %d", stats.FailedEvents)
	}

	// 2. Filter by status
	events, total, err := db.ListEvents(ctx, storage.ListFilter{Status: model.StatusFailed})
	if err != nil {
		t.Fatalf("ListEvents failed: %v", err)
	}
	if total != 1 || len(events) != 1 {
		t.Fatalf("expected 1 failed event, got total=%d len=%d", total, len(events))
	}
	if events[0].ID != "e-fail" {
		t.Errorf("expected e-fail, got %s", events[0].ID)
	}

	// 3. Search filter
	events, total, err = db.ListEvents(ctx, storage.ListFilter{Search: "timeout"})
	if err != nil {
		t.Fatalf("ListEvents search failed: %v", err)
	}
	if total != 1 || len(events) != 1 {
		t.Fatalf("expected 1 event with search 'timeout', got total=%d len=%d", total, len(events))
	}
	if events[0].ID != "e-retry" {
		t.Errorf("expected e-retry, got %s", events[0].ID)
	}
}

func TestStorage_ConcurrentWritesAndReads(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-conc",
		Name:      "Concurrent Endpoint",
		SecretKey: "key",
		TargetURL: "https://conc.example.com",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	const goroutines = 20
	const eventsPerGoroutine = 10
	var wg sync.WaitGroup

	// Concurrently save events
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for j := 0; j < eventsPerGoroutine; j++ {
				evID := fmt.Sprintf("evt-w%d-%d", workerID, j)
				ev := &model.WebhookEvent{
					ID:         evID,
					EndpointID: ep.ID,
					Provider:   model.ProviderGeneric,
					SourceIP:   "127.0.0.1",
					Headers:    map[string]string{"worker": fmt.Sprintf("%d", workerID)},
					Payload:    []byte(fmt.Sprintf(`{"msg":"concurrent %d-%d"}`, workerID, j)),
					Status:     model.StatusPending,
				}
				if err := db.SaveEvent(ctx, ev); err != nil {
					t.Errorf("SaveEvent in worker %d failed: %v", workerID, err)
					return
				}

				// Also concurrently read
				if _, err := db.GetEventByID(ctx, evID); err != nil {
					t.Errorf("GetEventByID in worker %d failed: %v", workerID, err)
					return
				}
			}
		}(i)
	}

	wg.Wait()

	stats, err := db.GetStats(ctx)
	if err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
	expectedTotal := int64(goroutines * eventsPerGoroutine)
	if stats.TotalEvents != expectedTotal {
		t.Fatalf("expected total events %d, got %d", expectedTotal, stats.TotalEvents)
	}
}

func TestStorage_Checkpoint(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-ckpt",
		Name:      "Checkpoint Endpoint",
		SecretKey: "key",
		TargetURL: "https://ckpt.example.com",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:         "evt-ckpt-1",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "127.0.0.1",
		Headers:    map[string]string{},
		Payload:    []byte(`{"test":"checkpoint"}`),
		Status:     model.StatusPending,
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// Trigger Checkpoint
	if err := db.Checkpoint(ctx); err != nil {
		t.Fatalf("Checkpoint failed: %v", err)
	}
}
