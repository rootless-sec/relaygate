package storage_test

import (
	"context"
	"crypto/sha256"
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

	// Insert pending
	_ = db.SaveEvent(ctx, &model.WebhookEvent{
		ID:         "e-pending",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "4.4.4.4",
		Headers:    map[string]string{},
		Payload:    []byte(`{"payment":"queued"}`),
		Status:     model.StatusPending,
	})

	// 1. Stats test
	stats, err := db.GetStats(ctx)
	if err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
	if stats.TotalEvents != 4 {
		t.Errorf("expected 4 total events, got %d", stats.TotalEvents)
	}
	if stats.DeliveredEvents != 1 {
		t.Errorf("expected 1 delivered, got %d", stats.DeliveredEvents)
	}
	if stats.PendingEvents != 1 {
		t.Errorf("expected 1 pending, got %d", stats.PendingEvents)
	}
	if stats.RetryingEvents != 1 {
		t.Errorf("expected 1 retrying, got %d", stats.RetryingEvents)
	}
	if stats.FailedEvents != 1 {
		t.Errorf("expected 1 failed, got %d", stats.FailedEvents)
	}
	if stats.DeliveredEvents+stats.PendingEvents+stats.RetryingEvents+stats.FailedEvents != stats.TotalEvents {
		t.Errorf("expected sum of status counts to equal TotalEvents (%d), got %d",
			stats.TotalEvents, stats.DeliveredEvents+stats.PendingEvents+stats.RetryingEvents+stats.FailedEvents)
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

func TestStorage_UserOperations(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	// 1. Verify default admin account seeded by Migrate
	admin, err := db.GetUserByEmail(ctx, "admin@relaygate.local")
	if err != nil {
		t.Fatalf("expected admin@relaygate.local to be seeded, got err: %v", err)
	}
	if admin.Name != "Administrator" {
		t.Errorf("expected admin name 'Administrator', got %s", admin.Name)
	}
	if admin.PasswordHash == "" {
		t.Errorf("expected admin password hash to be populated")
	}

	// 2. Create new user
	newUser := &model.User{
		ID:           "usr_alice",
		Name:         "Alice Operator",
		Email:        "Alice@example.com",
		PasswordHash: "hashedpassword123",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, newUser); err != nil {
		t.Fatalf("SaveUser failed: %v", err)
	}

	// 3. Retrieve user by email (case insensitive)
	fetched, err := db.GetUserByEmail(ctx, "alice@example.com")
	if err != nil {
		t.Fatalf("GetUserByEmail failed: %v", err)
	}
	if fetched.ID != "usr_alice" || fetched.Name != "Alice Operator" {
		t.Errorf("unexpected fetched user: %+v", fetched)
	}

	// 4. Retrieve by ID
	byID, err := db.GetUserByID(ctx, "usr_alice")
	if err != nil {
		t.Fatalf("GetUserByID failed: %v", err)
	}
	if byID.Email != "alice@example.com" {
		t.Errorf("expected email alice@example.com, got %s", byID.Email)
	}

	// 5. Non-existent user
	_, err = db.GetUserByEmail(ctx, "nonexistent@example.com")
	if err == nil {
		t.Errorf("expected error for nonexistent user, got nil")
	}
}

func TestStorage_EmailVerificationOperations(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	// 1. Save email verification
	v := &model.EmailVerification{
		Email:        "user@example.com",
		Name:         "John Doe",
		PasswordHash: "hashedpass",
		Code:         "123456",
		Attempts:     0,
		MaxAttempts:  5,
		LastSentAt:   time.Now().UTC(),
		ExpiresAt:    time.Now().UTC().Add(15 * time.Minute),
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveEmailVerification(ctx, v); err != nil {
		t.Fatalf("SaveEmailVerification failed: %v", err)
	}

	// 2. Fetch email verification (case insensitive)
	fetched, err := db.GetEmailVerification(ctx, "USER@example.COM")
	if err != nil {
		t.Fatalf("GetEmailVerification failed: %v", err)
	}
	if fetched.Email != "user@example.com" || fetched.Code != "123456" || fetched.Name != "John Doe" {
		t.Errorf("unexpected fetched verification: %+v", fetched)
	}

	// 3. Increment attempts
	attempts, err := db.IncrementVerificationAttempts(ctx, "user@example.com")
	if err != nil {
		t.Fatalf("IncrementVerificationAttempts failed: %v", err)
	}
	if attempts != 1 {
		t.Errorf("expected 1 attempt, got %d", attempts)
	}

	attempts, err = db.IncrementVerificationAttempts(ctx, "user@example.com")
	if err != nil {
		t.Fatalf("second increment failed: %v", err)
	}
	if attempts != 2 {
		t.Errorf("expected 2 attempts, got %d", attempts)
	}

	// 4. Upsert (e.g. resend code)
	v.Code = "654321"
	v.Attempts = 0
	if err := db.SaveEmailVerification(ctx, v); err != nil {
		t.Fatalf("SaveEmailVerification upsert failed: %v", err)
	}

	fetched2, err := db.GetEmailVerification(ctx, "user@example.com")
	if err != nil {
		t.Fatalf("GetEmailVerification after upsert failed: %v", err)
	}
	if fetched2.Code != "654321" || fetched2.Attempts != 0 {
		t.Errorf("expected updated code 654321 and 0 attempts, got code=%s attempts=%d", fetched2.Code, fetched2.Attempts)
	}

	// 5. Delete verification
	if err := db.DeleteEmailVerification(ctx, "user@example.com"); err != nil {
		t.Fatalf("DeleteEmailVerification failed: %v", err)
	}

	_, err = db.GetEmailVerification(ctx, "user@example.com")
	if err == nil {
		t.Errorf("expected error after deleting verification, got nil")
	}

	// 6. Verify email verification default max_attempts is independent of webhook DefaultMaxAttempts
	origWebhookMax := model.DefaultMaxAttempts
	defer func() {
		model.DefaultMaxAttempts = origWebhookMax
	}()
	model.DefaultMaxAttempts = 9

	vDefault := &model.EmailVerification{
		Email:        "indep@example.com",
		Name:         "Independent User",
		PasswordHash: "hashedpass",
		Code:         "999888",
		Attempts:     0,
		MaxAttempts:  0,
	}
	if err := db.SaveEmailVerification(ctx, vDefault); err != nil {
		t.Fatalf("SaveEmailVerification failed: %v", err)
	}
	fetchedIndep, err := db.GetEmailVerification(ctx, "indep@example.com")
	if err != nil {
		t.Fatalf("GetEmailVerification failed: %v", err)
	}
	if fetchedIndep.MaxAttempts != model.DefaultVerificationMaxAttempts || fetchedIndep.MaxAttempts == model.DefaultMaxAttempts {
		t.Errorf("expected email verification MaxAttempts to remain %d when DefaultMaxAttempts=%d, got %d", model.DefaultVerificationMaxAttempts, model.DefaultMaxAttempts, fetchedIndep.MaxAttempts)
	}
}

func TestStorage_SessionAndAuditRevealOperations(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	// 1. Test Session CRUD
	sess := &model.Session{
		Token:     "test_token_12345",
		UserID:    "usr_admin",
		UserEmail: "admin@relaygate.local",
		Role:      "admin",
		ExpiresAt: time.Now().UTC().Add(1 * time.Hour),
		CreatedAt: time.Now().UTC(),
	}

	if err := db.SaveSession(ctx, sess); err != nil {
		t.Fatalf("SaveSession failed: %v", err)
	}

	fetchedSess, err := db.GetSession(ctx, "test_token_12345")
	if err != nil {
		t.Fatalf("GetSession failed: %v", err)
	}
	if fetchedSess.UserID != "usr_admin" || fetchedSess.Role != "admin" {
		t.Errorf("expected user_id=usr_admin, role=admin, got id=%s, role=%s", fetchedSess.UserID, fetchedSess.Role)
	}

	// Verify raw token is NOT stored in database plaintext, but rather as SHA-256 hash
	expectedHash := fmt.Sprintf("%x", sha256.Sum256([]byte("test_token_12345")))
	var dbHash string
	if err := db.RawDB().QueryRowContext(ctx, "SELECT token_hash FROM sessions WHERE user_id = ?;", "usr_admin").Scan(&dbHash); err != nil {
		t.Fatalf("failed to query sessions table directly: %v", err)
	}
	if dbHash != expectedHash {
		t.Errorf("expected token_hash in DB to be %s, got %s", expectedHash, dbHash)
	}

	// 2. Test Audit Reveal
	audit := &model.AuditReveal{
		ID:                  "audit_1",
		EventID:             "ev_test_1",
		UserID:              "usr_admin",
		UserEmail:           "admin@relaygate.local",
		RevealedHeaderNames: "Authorization,Cookie,X-Api-Key",
		IPAddress:           "127.0.0.1",
		CreatedAt:           time.Now().UTC(),
	}

	if err := db.SaveAuditReveal(ctx, audit); err != nil {
		t.Fatalf("SaveAuditReveal failed: %v", err)
	}

	reveals, err := db.ListAuditReveals(ctx, "ev_test_1")
	if err != nil {
		t.Fatalf("ListAuditReveals failed: %v", err)
	}
	if len(reveals) != 1 {
		t.Fatalf("expected 1 audit reveal, got %d", len(reveals))
	}
	if reveals[0].RevealedHeaderNames != "Authorization,Cookie,X-Api-Key" {
		t.Errorf("unexpected revealed headers: %s", reveals[0].RevealedHeaderNames)
	}
	if reveals[0].UserEmail != "admin@relaygate.local" {
		t.Errorf("expected user_email admin@relaygate.local, got %s", reveals[0].UserEmail)
	}

	// 3. Test Session Deletion
	if err := db.DeleteSession(ctx, "test_token_12345"); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
	_, err = db.GetSession(ctx, "test_token_12345")
	if err == nil {
		t.Errorf("expected error after deleting session, got nil")
	}
}


