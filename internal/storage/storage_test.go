package storage_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestStorage_UpdateUserProfileAndPassword(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	u := &model.User{
		ID:           "usr_update_test",
		Name:         "Original Name",
		Email:        "original@example.com",
		Role:         "viewer",
		AvatarURL:    "",
		PasswordHash: "orig_hash",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, u); err != nil {
		t.Fatalf("SaveUser failed: %v", err)
	}

	// 1. Update Profile (Name & AvatarURL)
	if err := db.UpdateUserProfile(ctx, u.ID, "Updated Name", "/api/v1/profile/avatar/test.png"); err != nil {
		t.Fatalf("UpdateUserProfile failed: %v", err)
	}

	fetched, err := db.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID failed: %v", err)
	}
	if fetched.Name != "Updated Name" {
		t.Errorf("expected name 'Updated Name', got %s", fetched.Name)
	}
	if fetched.AvatarURL != "/api/v1/profile/avatar/test.png" {
		t.Errorf("expected avatar_url '/api/v1/profile/avatar/test.png', got %s", fetched.AvatarURL)
	}

	// 2. Update Password Hash
	if err := db.UpdateUserPassword(ctx, u.ID, "new_hashed_password"); err != nil {
		t.Fatalf("UpdateUserPassword failed: %v", err)
	}

	fetched2, err := db.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID failed: %v", err)
	}
	if fetched2.PasswordHash != "new_hashed_password" {
		t.Errorf("expected password_hash 'new_hashed_password', got %s", fetched2.PasswordHash)
	}

	// 3. Update non-existent user returns error
	if err := db.UpdateUserProfile(ctx, "nonexistent_id", "Name", ""); err == nil {
		t.Errorf("expected error when updating nonexistent user profile, got nil")
	}
	if err := db.UpdateUserPassword(ctx, "nonexistent_id", "hash"); err == nil {
		t.Errorf("expected error when updating nonexistent user password, got nil")
	}
}

func TestStorage_DeleteSessionsByUserIDExcept(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	userID := "usr_session_revocation_test"
	user := &model.User{
		ID:           userID,
		Name:         "Session User",
		Email:        "user@example.com",
		Role:         "admin",
		PasswordHash: "hashed_pass",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, user); err != nil {
		t.Fatalf("SaveUser failed: %v", err)
	}

	sess1 := &model.Session{
		Token:        "token_1_keep",
		UserID:       userID,
		UserEmail:    "user@example.com",
		Role:         "admin",
		ExpiresAt:    time.Now().UTC().Add(2 * time.Hour),
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	sess2 := &model.Session{
		Token:        "token_2_revoke",
		UserID:       userID,
		UserEmail:    "user@example.com",
		Role:         "admin",
		ExpiresAt:    time.Now().UTC().Add(2 * time.Hour),
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	sess3 := &model.Session{
		Token:        "token_3_revoke",
		UserID:       userID,
		UserEmail:    "user@example.com",
		Role:         "admin",
		ExpiresAt:    time.Now().UTC().Add(2 * time.Hour),
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}

	if err := db.SaveSession(ctx, sess1); err != nil {
		t.Fatalf("SaveSession sess1 failed: %v", err)
	}
	if err := db.SaveSession(ctx, sess2); err != nil {
		t.Fatalf("SaveSession sess2 failed: %v", err)
	}
	if err := db.SaveSession(ctx, sess3); err != nil {
		t.Fatalf("SaveSession sess3 failed: %v", err)
	}

	keepHash := storage.HashSessionToken("token_1_keep")
	if err := db.DeleteSessionsByUserIDExcept(ctx, userID, keepHash); err != nil {
		t.Fatalf("DeleteSessionsByUserIDExcept failed: %v", err)
	}

	// Verify sess1 still exists
	gotSess1, err := db.GetSession(ctx, "token_1_keep")
	if err != nil || gotSess1 == nil {
		t.Errorf("expected kept session to still exist, got err: %v", err)
	}

	// Verify sess2 and sess3 were deleted
	gotSess2, err := db.GetSession(ctx, "token_2_revoke")
	if err == nil && gotSess2 != nil {
		t.Errorf("expected sess2 to be deleted, but still found")
	}
	gotSess3, err := db.GetSession(ctx, "token_3_revoke")
	if err == nil && gotSess3 != nil {
		t.Errorf("expected sess3 to be deleted, but still found")
	}
}

func TestStorage_DeleteEndpointWithActiveEventsBlocked(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()
	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep_del_storage_test",
		Name:      "Delete Storage Test",
		SecretKey: "whsec_del_storage_key",
		TargetURL: "http://127.0.0.1:8080/dest",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:         "ev_del_active",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "127.0.0.1",
		Headers:    map[string]string{"Content-Type": "application/json"},
		Payload:    []byte(`{"status":"in_flight"}`),
		Status:     model.StatusPending,
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// 1. Deletion must fail while event is PENDING
	err := db.DeleteEndpoint(ctx, ep.ID)
	if err == nil {
		t.Fatalf("expected DeleteEndpoint to fail when PENDING event exists, but succeeded")
	}
	if !strings.Contains(err.Error(), "active events") {
		t.Errorf("expected error message to mention active events, got: %v", err)
	}

	// Verify endpoint and event still exist
	existingEP, _ := db.GetEndpointByID(ctx, ep.ID)
	if existingEP == nil {
		t.Fatalf("endpoint was wrongly removed on aborted deletion transaction")
	}
	existingEV, _ := db.GetEventByID(ctx, ev.ID)
	if existingEV == nil {
		t.Fatalf("event was wrongly removed on aborted deletion transaction")
	}

	// 2. Mark event as DELIVERED: deletion must now succeed cleanly
	if err := db.UpdateEventStatus(ctx, ev.ID, model.StatusDelivered, 200, ""); err != nil {
		t.Fatalf("UpdateEventStatus failed: %v", err)
	}

	if err := db.DeleteEndpoint(ctx, ep.ID); err != nil {
		t.Fatalf("DeleteEndpoint failed on delivered events: %v", err)
	}

	// Verify both endpoint and event were deleted
	deletedEP, _ := db.GetEndpointByID(ctx, ep.ID)
	if deletedEP != nil {
		t.Errorf("expected endpoint to be deleted from database")
	}
	deletedEV, _ := db.GetEventByID(ctx, ev.ID)
	if deletedEV != nil {
		t.Errorf("expected delivered events to be purged with endpoint")
	}
}




func TestStorage_DeliveryLogs(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-logs-test",
		Name:      "Delivery Log Endpoint",
		SecretKey: "whsec_test",
		TargetURL: "https://example.com/webhook",
		Provider:  model.ProviderStripe,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:          "ev-logs-test-1",
		EndpointID:  ep.ID,
		Provider:    model.ProviderStripe,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{"Content-Type": "application/json"},
		Payload:     []byte(`{"test":true}`),
		Status:      model.StatusRetrying,
		Attempts:    2,
		MaxAttempts: 5,
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// 1. Initial empty logs check
	initialLogs, err := db.ListDeliveryLogs(ctx, ev.ID)
	if err != nil {
		t.Fatalf("ListDeliveryLogs failed: %v", err)
	}
	if len(initialLogs) != 0 {
		t.Fatalf("expected 0 initial logs, got %d", len(initialLogs))
	}

	// 2. Save 3 attempts in non-sorted insertion order (attempt 2, then 1, then 3)
	entry2 := &model.DeliveryLogEntry{
		Attempt:    2,
		StatusCode: 429,
		DurationMs: 45,
		Error:      "rate limited: 429",
		CreatedAt:  time.Now().UTC().Add(-1 * time.Minute),
	}
	entry1 := &model.DeliveryLogEntry{
		Attempt:    1,
		StatusCode: 500,
		DurationMs: 82,
		Error:      "upstream server error: 500",
		CreatedAt:  time.Now().UTC().Add(-2 * time.Minute),
	}
	entry3 := &model.DeliveryLogEntry{
		Attempt:    3,
		StatusCode: 200,
		DurationMs: 14,
		Error:      "",
		CreatedAt:  time.Now().UTC(),
	}

	if err := db.SaveDeliveryLog(ctx, ev.ID, entry2); err != nil {
		t.Fatalf("SaveDeliveryLog attempt 2 failed: %v", err)
	}
	if err := db.SaveDeliveryLog(ctx, ev.ID, entry1); err != nil {
		t.Fatalf("SaveDeliveryLog attempt 1 failed: %v", err)
	}
	if err := db.SaveDeliveryLog(ctx, ev.ID, entry3); err != nil {
		t.Fatalf("SaveDeliveryLog attempt 3 failed: %v", err)
	}

	// 3. List logs and assert sorted by attempt ASC
	logs, err := db.ListDeliveryLogs(ctx, ev.ID)
	if err != nil {
		t.Fatalf("ListDeliveryLogs failed: %v", err)
	}
	if len(logs) != 3 {
		t.Fatalf("expected 3 delivery logs, got %d", len(logs))
	}

	if logs[0].Attempt != 1 || logs[0].StatusCode != 500 || logs[0].DurationMs != 82 || logs[0].Error != "upstream server error: 500" {
		t.Errorf("unexpected log 0: %+v", logs[0])
	}
	if logs[1].Attempt != 2 || logs[1].StatusCode != 429 || logs[1].DurationMs != 45 || logs[1].Error != "rate limited: 429" {
		t.Errorf("unexpected log 1: %+v", logs[1])
	}
	if logs[2].Attempt != 3 || logs[2].StatusCode != 200 || logs[2].DurationMs != 14 || logs[2].Error != "" {
		t.Errorf("unexpected log 2: %+v", logs[2])
	}

	// 4. Test ON DELETE CASCADE: delete event and assert logs are cascaded
	_, err = db.RawDB().ExecContext(ctx, "DELETE FROM webhook_events WHERE id = ?;", ev.ID)
	if err != nil {
		t.Fatalf("failed to delete event: %v", err)
	}

	cascadedLogs, err := db.ListDeliveryLogs(ctx, ev.ID)
	if err != nil {
		t.Fatalf("ListDeliveryLogs after delete failed: %v", err)
	}
	if len(cascadedLogs) != 0 {
		t.Errorf("expected 0 delivery logs after event deletion (ON DELETE CASCADE), got %d", len(cascadedLogs))
	}
}

func TestStorage_PruneDeliveredEvents_DLQPreserved(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-prune-test",
		Name:      "Prune Test Endpoint",
		SecretKey: "whsec_test",
		TargetURL: "https://example.com/webhook",
		Provider:  model.ProviderStripe,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	now := time.Now().UTC()
	oldTime := now.Add(-10 * 24 * time.Hour) // 10 days ago

	// 1. Old DELIVERED event (should be pruned)
	evOldDelivered := &model.WebhookEvent{
		ID:             "ev-old-delivered",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"delivered":true}`),
		Status:         model.StatusDelivered,
		HTTPStatusCode: 200,
		Attempts:       1,
		MaxAttempts:    5,
		CreatedAt:      oldTime,
		UpdatedAt:      oldTime,
	}
	if err := db.SaveEvent(ctx, evOldDelivered); err != nil {
		t.Fatalf("SaveEvent evOldDelivered failed: %v", err)
	}
	// Add delivery log to ensure it cascades on prune
	if err := db.SaveDeliveryLog(ctx, evOldDelivered.ID, &model.DeliveryLogEntry{
		Attempt:    1,
		StatusCode: 200,
		DurationMs: 25,
		CreatedAt:  oldTime,
	}); err != nil {
		t.Fatalf("SaveDeliveryLog failed: %v", err)
	}

	// 2. Recent DELIVERED event (should NOT be pruned)
	evRecentDelivered := &model.WebhookEvent{
		ID:             "ev-recent-delivered",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"delivered":true}`),
		Status:         model.StatusDelivered,
		HTTPStatusCode: 200,
		Attempts:       1,
		MaxAttempts:    5,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := db.SaveEvent(ctx, evRecentDelivered); err != nil {
		t.Fatalf("SaveEvent evRecentDelivered failed: %v", err)
	}

	// 3. Old FAILED event (DLQ: must be strictly preserved!)
	evOldFailed := &model.WebhookEvent{
		ID:             "ev-old-failed",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"failed":true}`),
		Status:         model.StatusFailed,
		HTTPStatusCode: 500,
		Attempts:       5,
		MaxAttempts:    5,
		LastError:      "fatal downstream error",
		FailureCode:    "DOWNSTREAM_5XX",
		CreatedAt:      oldTime,
		UpdatedAt:      oldTime,
	}
	if err := db.SaveEvent(ctx, evOldFailed); err != nil {
		t.Fatalf("SaveEvent evOldFailed failed: %v", err)
	}

	// 4. Old RETRYING event (must be preserved)
	evOldRetrying := &model.WebhookEvent{
		ID:             "ev-old-retrying",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"retrying":true}`),
		Status:         model.StatusRetrying,
		HTTPStatusCode: 429,
		Attempts:       2,
		MaxAttempts:    5,
		CreatedAt:      oldTime,
		UpdatedAt:      oldTime,
	}
	if err := db.SaveEvent(ctx, evOldRetrying); err != nil {
		t.Fatalf("SaveEvent evOldRetrying failed: %v", err)
	}

	// Manually update created_at for old events because SaveEvent uses CURRENT_TIMESTAMP if not forced
	oldTimeStr := oldTime.Format("2006-01-02 15:04:05")
	_, err := db.RawDB().ExecContext(ctx, "UPDATE webhook_events SET created_at = ? WHERE id IN (?, ?, ?);",
		oldTimeStr, evOldDelivered.ID, evOldFailed.ID, evOldRetrying.ID)
	if err != nil {
		t.Fatalf("failed to update created_at: %v", err)
	}

	// 5. Run Prune with 5-day cutoff
	cutoff := now.Add(-5 * 24 * time.Hour)
	prunedCount, err := db.PruneDeliveredEvents(ctx, cutoff)
	if err != nil {
		t.Fatalf("PruneDeliveredEvents failed: %v", err)
	}
	if prunedCount != 1 {
		t.Errorf("expected 1 pruned event, got %d", prunedCount)
	}

	// 6. Verify old DELIVERED event is deleted
	oldDel, _ := db.GetEventByID(ctx, evOldDelivered.ID)
	if oldDel != nil {
		t.Errorf("expected old DELIVERED event to be pruned")
	}
	// Verify its delivery log was also cascaded
	logs, _ := db.ListDeliveryLogs(ctx, evOldDelivered.ID)
	if len(logs) != 0 {
		t.Errorf("expected delivery logs for pruned event to be deleted, got %d", len(logs))
	}

	// 7. Verify recent DELIVERED event still exists
	recDel, _ := db.GetEventByID(ctx, evRecentDelivered.ID)
	if recDel == nil {
		t.Errorf("expected recent DELIVERED event to be preserved")
	}

	// 8. CRITICAL: Verify old FAILED (DLQ) event is strictly preserved!
	oldFail, _ := db.GetEventByID(ctx, evOldFailed.ID)
	if oldFail == nil {
		t.Fatalf("CRITICAL: old FAILED (DLQ) event was mistakenly deleted by retention pruning!")
	}
	if oldFail.Status != model.StatusFailed {
		t.Errorf("expected FAILED status preserved, got %s", oldFail.Status)
	}

	// 9. Verify old RETRYING event still exists
	oldRet, _ := db.GetEventByID(ctx, evOldRetrying.ID)
	if oldRet == nil {
		t.Errorf("expected old RETRYING event to be preserved")
	}

	// 10. Test validation: zero time returns error
	_, err = db.PruneDeliveredEvents(ctx, time.Time{})
	if err == nil {
		t.Errorf("expected error when olderThan is zero time")
	}
}

func TestStorage_DeferRetry(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-defer-test",
		Name:      "Defer Test Endpoint",
		SecretKey: "whsec_test",
		TargetURL: "https://example.com/webhook",
		Provider:  model.ProviderStripe,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:          "ev-defer-test-1",
		EndpointID:  ep.ID,
		Provider:    model.ProviderStripe,
		SourceIP:    "127.0.0.1",
		Headers:     map[string]string{"Content-Type": "application/json"},
		Payload:     []byte(`{"test":true}`),
		Status:      model.StatusRetrying,
		Attempts:    2,
		MaxAttempts: 5,
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// Defer retry to 60 seconds into the future
	futureTime := time.Now().UTC().Add(60 * time.Second)
	errMsg := "rate limited: 429 Too Many Requests (Retry-After: 60)"
	statusCode := 429

	if err := db.DeferRetry(ctx, ev.ID, futureTime, errMsg, statusCode); err != nil {
		t.Fatalf("DeferRetry failed: %v", err)
	}

	updated, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	// Non-penalizing invariant: attempts MUST NOT be incremented
	if updated.Attempts != 2 {
		t.Errorf("expected attempts to remain 2, got %d", updated.Attempts)
	}
	if updated.Status != model.StatusRetrying {
		t.Errorf("expected status RETRYING, got %s", updated.Status)
	}
	if updated.HTTPStatusCode != 429 {
		t.Errorf("expected status code 429, got %d", updated.HTTPStatusCode)
	}
	if updated.LastError != errMsg {
		t.Errorf("expected last error %q, got %q", errMsg, updated.LastError)
	}
	if updated.NextRetryAt == nil {
		t.Fatalf("expected next_retry_at to be set, got nil")
	}
	if diff := updated.NextRetryAt.Sub(futureTime); diff > time.Second || diff < -time.Second {
		t.Errorf("expected next_retry_at close to %v, got %v (diff: %v)", futureTime, *updated.NextRetryAt, diff)
	}

	// Test non-existent event
	err = db.DeferRetry(ctx, "nonexistent-ev-id", futureTime, "err", 503)
	if err == nil {
		t.Errorf("expected error when deferring non-existent event")
	}
}

func TestStorage_ListEvents_Filters(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	epStripe := &model.Endpoint{
		ID: "ep-stripe-flt", Name: "Stripe Endpoint", SecretKey: "sec1", TargetURL: "https://stripe.com",
		Provider: model.ProviderStripe, IsActive: true, CreatedAt: time.Now().UTC(),
	}
	epGitHub := &model.Endpoint{
		ID: "ep-github-flt", Name: "GitHub Endpoint", SecretKey: "sec2", TargetURL: "https://github.com",
		Provider: model.ProviderGithub, IsActive: true, CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, epStripe); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}
	if err := db.SaveEndpoint(ctx, epGitHub); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 1. Stripe event with SIGNATURE_MISMATCH
	ev1 := &model.WebhookEvent{
		ID: "ev-flt-1", EndpointID: epStripe.ID, Provider: model.ProviderStripe, SourceIP: "1.1.1.1",
		Headers: map[string]string{}, Payload: []byte(`{}`), Status: model.StatusFailed,
		FailureCode: "SIGNATURE_MISMATCH", MaxAttempts: 5, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	// 2. Stripe event with TIMEOUT
	ev2 := &model.WebhookEvent{
		ID: "ev-flt-2", EndpointID: epStripe.ID, Provider: model.ProviderStripe, SourceIP: "1.1.1.2",
		Headers: map[string]string{}, Payload: []byte(`{}`), Status: model.StatusFailed,
		FailureCode: "TIMEOUT", MaxAttempts: 5, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	// 3. GitHub event with SIGNATURE_MISMATCH
	ev3 := &model.WebhookEvent{
		ID: "ev-flt-3", EndpointID: epGitHub.ID, Provider: model.ProviderGithub, SourceIP: "1.1.1.3",
		Headers: map[string]string{}, Payload: []byte(`{}`), Status: model.StatusFailed,
		FailureCode: "SIGNATURE_MISMATCH", MaxAttempts: 5, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}

	for _, ev := range []*model.WebhookEvent{ev1, ev2, ev3} {
		if err := db.SaveEvent(ctx, ev); err != nil {
			t.Fatalf("SaveEvent failed: %v", err)
		}
	}

	// Filter by Provider = Stripe (should return ev1 and ev2)
	stripeEvents, totalStripe, err := db.ListEvents(ctx, storage.ListFilter{Provider: model.ProviderStripe})
	if err != nil {
		t.Fatalf("ListEvents provider stripe failed: %v", err)
	}
	if totalStripe != 2 || len(stripeEvents) != 2 {
		t.Errorf("expected 2 stripe events, got total=%d len=%d", totalStripe, len(stripeEvents))
	}
	for _, ev := range stripeEvents {
		if ev.Provider != model.ProviderStripe {
			t.Errorf("expected provider stripe, got %s", ev.Provider)
		}
	}

	// Filter by FailureCode = SIGNATURE_MISMATCH (should return ev1 and ev3)
	sigEvents, totalSig, err := db.ListEvents(ctx, storage.ListFilter{FailureCode: "SIGNATURE_MISMATCH"})
	if err != nil {
		t.Fatalf("ListEvents failure_code failed: %v", err)
	}
	if totalSig != 2 || len(sigEvents) != 2 {
		t.Errorf("expected 2 signature mismatch events, got total=%d len=%d", totalSig, len(sigEvents))
	}
	for _, ev := range sigEvents {
		if ev.FailureCode != "SIGNATURE_MISMATCH" {
			t.Errorf("expected failure code SIGNATURE_MISMATCH, got %s", ev.FailureCode)
		}
	}

	// Filter by both Provider = Stripe AND FailureCode = SIGNATURE_MISMATCH (should return only ev1)
	combinedEvents, totalComb, err := db.ListEvents(ctx, storage.ListFilter{
		Provider:    model.ProviderStripe,
		FailureCode: "SIGNATURE_MISMATCH",
	})
	if err != nil {
		t.Fatalf("ListEvents combined failed: %v", err)
	}
	if totalComb != 1 || len(combinedEvents) != 1 || combinedEvents[0].ID != "ev-flt-1" {
		t.Errorf("expected only ev-flt-1 for combined filter, got total=%d len=%d", totalComb, len(combinedEvents))
	}
}

func TestStorage_Backup_NonBlocking(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep := &model.Endpoint{
		ID:        "ep-backup-test",
		Name:      "Backup Test Endpoint",
		SecretKey: "whsec_test",
		TargetURL: "https://example.com/webhook",
		Provider:  model.ProviderStripe,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// Seed some initial data
	for i := 0; i < 10; i++ {
		ev := &model.WebhookEvent{
			ID:          fmt.Sprintf("ev-seed-%d", i),
			EndpointID:  ep.ID,
			Provider:    model.ProviderStripe,
			SourceIP:    "127.0.0.1",
			Headers:     map[string]string{"Content-Type": "application/json"},
			Payload:     []byte(fmt.Sprintf(`{"index":%d}`, i)),
			Status:      model.StatusDelivered,
			MaxAttempts: 5,
			CreatedAt:   time.Now().UTC(),
			UpdatedAt:   time.Now().UTC(),
		}
		if err := db.SaveEvent(ctx, ev); err != nil {
			t.Fatalf("SaveEvent seed %d failed: %v", i, err)
		}
	}

	// Run concurrent writers during backup to verify non-blocking behavior
	stopCh := make(chan struct{})
	var wg sync.WaitGroup
	var concurrentWrites int64
	var writeMu sync.Mutex

	for w := 0; w < 3; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			idx := 0
			for {
				select {
				case <-stopCh:
					return
				default:
					ev := &model.WebhookEvent{
						ID:          fmt.Sprintf("ev-async-%d-%d-%d", workerID, idx, time.Now().UnixNano()),
						EndpointID:  ep.ID,
						Provider:    model.ProviderStripe,
						SourceIP:    "127.0.0.1",
						Headers:     map[string]string{"Content-Type": "application/json"},
						Payload:     []byte(`{"concurrent":true}`),
						Status:      model.StatusPending,
						MaxAttempts: 5,
						CreatedAt:   time.Now().UTC(),
						UpdatedAt:   time.Now().UTC(),
					}
					if err := db.SaveEvent(ctx, ev); err == nil {
						writeMu.Lock()
						concurrentWrites++
						writeMu.Unlock()
					}
					idx++
					time.Sleep(1 * time.Millisecond)
				}
			}
		}(w)
	}

	backupDir, err := os.MkdirTemp("", "relaygate-backup-test-*")
	if err != nil {
		t.Fatalf("failed to create temp backup dir: %v", err)
	}
	defer os.RemoveAll(backupDir)

	backupFile := filepath.Join(backupDir, "snapshot.db")

	// Trigger hot backup
	result, err := db.Backup(ctx, backupFile)
	if err != nil {
		t.Fatalf("db.Backup failed: %v", err)
	}

	// Stop concurrent writers
	close(stopCh)
	wg.Wait()

	if result.DestinationPath != backupFile {
		t.Errorf("expected destination path %s, got %s", backupFile, result.DestinationPath)
	}
	if result.SizeBytes <= 0 {
		t.Errorf("expected positive size_bytes, got %d", result.SizeBytes)
	}
	if result.DurationMs < 0 {
		t.Errorf("expected non-negative duration_ms, got %d", result.DurationMs)
	}

	// Verify the backup database is valid and uncorrupted
	backupDB, err := storage.Open(backupFile)
	if err != nil {
		t.Fatalf("failed to open backup database: %v", err)
	}
	defer backupDB.Close()

	var integrity string
	row := backupDB.RawDB().QueryRowContext(ctx, "PRAGMA integrity_check;")
	if err := row.Scan(&integrity); err != nil || integrity != "ok" {
		t.Errorf("integrity check failed on backup snapshot: %s, err: %v", integrity, err)
	}

	// Verify endpoints and events can be read from the backup snapshot
	epBack, err := backupDB.GetEndpointByID(ctx, ep.ID)
	if err != nil || epBack == nil {
		t.Fatalf("failed to query endpoint from backup snapshot: %v", err)
	}

	// Close the reader DB so Windows allows unlinking the file on the next backup
	if err := backupDB.Close(); err != nil {
		t.Fatalf("failed to close backup db: %v", err)
	}

	// Test overwriting existing file
	result2, err := db.Backup(ctx, backupFile)
	if err != nil {
		t.Fatalf("db.Backup overwrite failed: %v", err)
	}
	if result2.SizeBytes <= 0 {
		t.Errorf("expected positive size after overwrite, got %d", result2.SizeBytes)
	}
}

func TestStorage_Backup_PathConfinement(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	// 1. Directory traversal rejection
	_, err := db.Backup(ctx, "../../escaped_backup.db")
	if err == nil {
		t.Fatalf("expected error for directory traversal path with '..', got nil")
	}

	// 2. Prohibit direct filesystem root
	_, err = db.Backup(ctx, "/root_backup.db")
	if err == nil {
		t.Fatalf("expected error for filesystem root path, got nil")
	}

	// 3. Prohibit system directories outside allowed roots
	var sysPath string
	if runtime.GOOS == "windows" {
		sysPath = "C:\\Windows\\System32\\test_backup.db"
	} else {
		sysPath = "/etc/test_backup.db"
	}
	_, err = db.Backup(ctx, sysPath)
	if err == nil {
		t.Fatalf("expected error for system directory path %s, got nil", sysPath)
	}
}

func TestStorage_OverviewAggregations(t *testing.T) {
	db, cleanup := createTempDB(t)
	defer cleanup()

	ctx := context.Background()

	ep1 := &model.Endpoint{
		ID: "ep-agg-1", Name: "Endpoint One", SecretKey: "sec1", TargetURL: "https://one.com",
		Provider: model.ProviderStripe, IsActive: true, CreatedAt: time.Now().UTC(),
	}
	ep2 := &model.Endpoint{
		ID: "ep-agg-2", Name: "Endpoint Two", SecretKey: "sec2", TargetURL: "https://two.com",
		Provider: model.ProviderGithub, IsActive: true, CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep1); err != nil {
		t.Fatalf("SaveEndpoint 1 failed: %v", err)
	}
	if err := db.SaveEndpoint(ctx, ep2); err != nil {
		t.Fatalf("SaveEndpoint 2 failed: %v", err)
	}

	// Endpoint 1: 2 DELIVERED, 1 FAILED
	// Endpoint 2: 0 events
	ev1 := &model.WebhookEvent{
		ID: "ev-agg-1", EndpointID: ep1.ID, Provider: model.ProviderStripe, SourceIP: "1.1.1.1",
		Headers: map[string]string{}, Payload: []byte(`{}`), Status: model.StatusDelivered,
		MaxAttempts: 5, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	ev2 := &model.WebhookEvent{
		ID: "ev-agg-2", EndpointID: ep1.ID, Provider: model.ProviderStripe, SourceIP: "1.1.1.1",
		Headers: map[string]string{}, Payload: []byte(`{}`), Status: model.StatusDelivered,
		MaxAttempts: 5, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	ev3 := &model.WebhookEvent{
		ID: "ev-agg-3", EndpointID: ep1.ID, Provider: model.ProviderStripe, SourceIP: "1.1.1.1",
		Headers: map[string]string{}, Payload: []byte(`{}`), Status: model.StatusFailed,
		MaxAttempts: 5, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}

	for _, ev := range []*model.WebhookEvent{ev1, ev2, ev3} {
		if err := db.SaveEvent(ctx, ev); err != nil {
			t.Fatalf("SaveEvent failed: %v", err)
		}
	}

	// 1. Throughput buckets
	buckets, err := db.GetThroughput(ctx, 12)
	if err != nil {
		t.Fatalf("GetThroughput failed: %v", err)
	}
	if len(buckets) != 12 {
		t.Fatalf("expected 12 buckets, got %d", len(buckets))
	}
	// Bucket 11 is "now"
	if buckets[11].Label != "now" {
		t.Errorf("expected bucket 11 label 'now', got %s", buckets[11].Label)
	}
	if buckets[11].Total != 3 {
		t.Errorf("expected 3 total events in current bucket, got %d", buckets[11].Total)
	}
	if buckets[11].Failed != 1 {
		t.Errorf("expected 1 failed event in current bucket, got %d", buckets[11].Failed)
	}

	// 2. Endpoint breakdown
	breakdown, err := db.GetEndpointBreakdown(ctx)
	if err != nil {
		t.Fatalf("GetEndpointBreakdown failed: %v", err)
	}
	if len(breakdown) != 2 {
		t.Fatalf("expected 2 endpoints in breakdown, got %d", len(breakdown))
	}

	foundEP1 := false
	foundEP2 := false
	for _, b := range breakdown {
		if b.ID == ep1.ID {
			foundEP1 = true
			if b.Total != 3 || b.Delivered != 2 || b.Failed != 1 {
				t.Errorf("ep1 unexpected breakdown: total=%d, del=%d, fail=%d", b.Total, b.Delivered, b.Failed)
			}
			// 2/3 * 100 = 66%
			if b.SuccessRate != 66 {
				t.Errorf("expected success rate 66, got %d", b.SuccessRate)
			}
		}
		if b.ID == ep2.ID {
			foundEP2 = true
			if b.Total != 0 || b.Delivered != 0 || b.Failed != 0 || b.SuccessRate != 0 {
				t.Errorf("ep2 unexpected breakdown: %+v", b)
			}
		}
	}
	if !foundEP1 || !foundEP2 {
		t.Errorf("did not find both endpoints in breakdown: foundEP1=%v foundEP2=%v", foundEP1, foundEP2)
	}

	// 3. Recent failed events
	recentFailed, err := db.GetRecentFailedEvents(ctx, 5)
	if err != nil {
		t.Fatalf("GetRecentFailedEvents failed: %v", err)
	}
	if len(recentFailed) != 1 {
		t.Fatalf("expected 1 recent failed event, got %d", len(recentFailed))
	}
	if recentFailed[0].ID != ev3.ID {
		t.Errorf("expected failed event %s, got %s", ev3.ID, recentFailed[0].ID)
	}
}
