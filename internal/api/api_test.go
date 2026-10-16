package api_test

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

	"github.com/rootless-sec/relaygate/internal/api"
	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

func setupTestAPI(t *testing.T) (*storage.DB, *worker.Pool, *api.Hub, *api.Router, func()) {
	t.Helper()
	tempDir, err := os.MkdirTemp("", "relaygate-api-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	dbPath := filepath.Join(tempDir, "test.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		_ = os.RemoveAll(tempDir)
		t.Fatalf("failed to open storage db: %v", err)
	}

	v := verifier.NewEngine()
	cfg := worker.DefaultConfig()
	pool := worker.NewPool(db, v, cfg)

	hub := api.NewHub()
	router := api.NewRouter(db, pool, hub)

	cleanup := func() {
		pool.Stop()
		_ = db.Close()
		_ = os.RemoveAll(tempDir)
	}

	return db, pool, hub, router, cleanup
}

func TestAPI_EndpointsCRUD(t *testing.T) {
	db, _, _, router, cleanup := setupTestAPI(t)
	defer cleanup()

	// 1. Create Endpoint
	body := []byte(`{"name":"Payments API","provider":"midtrans","target_url":"https://api.example.com/hooks"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/endpoints", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status 201 Created, got %d: %s", rec.Code, rec.Body.String())
	}

	var created model.Endpoint
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to unmarshal created endpoint: %v", err)
	}
	if created.ID == "" || created.Name != "Payments API" || !created.IsActive {
		t.Errorf("unexpected endpoint data: %+v", created)
	}

	// 2. List Endpoints
	req = httptest.NewRequest(http.MethodGet, "/api/v1/endpoints", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	var listRes api.EndpointsListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("failed to unmarshal list endpoints: %v", err)
	}
	if len(listRes.Endpoints) != 1 {
		t.Errorf("expected 1 endpoint, got %d", len(listRes.Endpoints))
	}

	// 3. Patch Endpoint (toggle active)
	patchBody := []byte(`{"is_active":false}`)
	req = httptest.NewRequest(http.MethodPatch, "/api/v1/endpoints/"+created.ID, bytes.NewReader(patchBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK on patch, got %d: %s", rec.Code, rec.Body.String())
	}

	epAfter, err := db.GetEndpointByID(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("GetEndpointByID failed: %v", err)
	}
	if epAfter.IsActive {
		t.Errorf("expected endpoint to be deactivated, but is_active = true")
	}
}

func TestAPI_EventsAndReplay(t *testing.T) {
	db, pool, _, router, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx := context.Background()

	// Seed an endpoint
	ep := &model.Endpoint{
		ID:        "ep-test",
		Name:      "Orders API",
		SecretKey: "",
		TargetURL: "https://example.com/webhook",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("failed to save endpoint: %v", err)
	}

	// Seed a failed event
	ev := &model.WebhookEvent{
		ID:             "evt-failed-123",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "192.0.2.1",
		Headers:        map[string]string{"content-type": "application/json"},
		Payload:        []byte(`{"order_id":"ORD-999","amount":50000}`),
		Status:         model.StatusFailed,
		HTTPStatusCode: 500,
		Attempts:       5,
		MaxAttempts:    5,
		LastError:      "Internal Server Error",
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("failed to save event: %v", err)
	}

	pool.Start()

	// 1. List Events
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events?status=FAILED", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	var eventsRes api.EventsListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &eventsRes); err != nil {
		t.Fatalf("failed to unmarshal events list: %v", err)
	}
	if len(eventsRes.Events) != 1 || eventsRes.Events[0].ID != ev.ID {
		t.Fatalf("unexpected events list: %+v", eventsRes)
	}
	if eventsRes.Events[0].PayloadJSON == nil {
		t.Errorf("expected parsed PayloadJSON")
	}

	// 2. Get Event Detail
	req = httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID, nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK on get event, got %d: %s", rec.Code, rec.Body.String())
	}

	var evDetail api.EventResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &evDetail); err != nil {
		t.Fatalf("failed to unmarshal event detail: %v", err)
	}
	if evDetail.ID != ev.ID {
		t.Errorf("unexpected event detail: %+v", evDetail)
	}
	if len(evDetail.DeliveryLog) != 0 {
		t.Errorf("expected 0 delivery log entries (no synthetic logs), got %d", len(evDetail.DeliveryLog))
	}

	// 3. Replay Single Event
	req = httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK on replay, got %d: %s", rec.Code, rec.Body.String())
	}

	evAfter, _ := db.GetEventByID(ctx, ev.ID)
	if evAfter.Status != model.StatusPending {
		t.Errorf("expected status to be reset to PENDING, got %s", evAfter.Status)
	}

	// 4. Bulk Replay
	_ = db.UpdateEventStatus(ctx, ev.ID, model.StatusFailed, 503, "Service Unavailable")
	bulkReqBody := []byte(`{"all_failed":true}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/events/bulk-replay", bytes.NewReader(bulkReqBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK on bulk replay, got %d: %s", rec.Code, rec.Body.String())
	}
	var bulkRes api.BulkReplayResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &bulkRes)
	if bulkRes.ReplayedCount != 1 {
		t.Errorf("expected 1 replayed event, got %d", bulkRes.ReplayedCount)
	}

	// 5. Stats Endpoint
	req = httptest.NewRequest(http.MethodGet, "/api/v1/stats", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK on stats, got %d: %s", rec.Code, rec.Body.String())
	}

	// 6. Overview Endpoint
	req = httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK on overview, got %d: %s", rec.Code, rec.Body.String())
	}
	var overviewRes api.OverviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &overviewRes); err != nil {
		t.Fatalf("failed to unmarshal overview: %v", err)
	}
	if len(overviewRes.Throughput) != 12 {
		t.Errorf("expected 12 throughput buckets, got %d", len(overviewRes.Throughput))
	}
}

func TestAPI_SSEStream(t *testing.T) {
	_, _, hub, router, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	go func() {
		time.Sleep(30 * time.Millisecond)
		hub.Broadcast("test_ping", map[string]string{"hello": "world"})
		time.Sleep(30 * time.Millisecond)
		hub.Broadcast("event_created", &model.WebhookEvent{
			ID:         "test_ev_123",
			EndpointID: "ep_1",
			Provider:   model.ProviderGeneric,
			Payload:    []byte(`{"order_id":"ord_999","amount":100}`),
			Status:     model.StatusPending,
		})
	}()

	router.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !bytes.Contains([]byte(body), []byte("event: connected")) {
		t.Errorf("expected SSE connected event, got: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("event: test_ping")) {
		t.Errorf("expected SSE test_ping event, got: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("event: event_created")) {
		t.Errorf("expected SSE event_created event, got: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("payload_raw")) {
		t.Errorf("expected SSE event to contain payload_raw, got: %s", body)
	}
	if !bytes.Contains([]byte(body), []byte("ord_999")) {
		t.Errorf("expected SSE event to contain unmarshaled payload text ord_999, got: %s", body)
	}
}

func TestAPI_AuthRegisterAndLogin(t *testing.T) {
	_, _, _, router, cleanup := setupTestAPI(t)
	defer cleanup()

	// 1. Test seeded admin login
	loginBody := []byte(`{"email":"admin@relaygate.local","password":"relaygate123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected admin login 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}
	var adminRes api.AuthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &adminRes); err != nil {
		t.Fatalf("failed to decode admin login response: %v", err)
	}
	if adminRes.User.Email != "admin@relaygate.local" {
		t.Errorf("expected admin email, got %s", adminRes.User.Email)
	}

	// 2. Test register new account (initiates OTP verification)
	regBody := []byte(`{"name":"Dev User","email":"dev@company.com","password":"securepassword"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected registration 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}
	var regRes api.RegisterResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &regRes); err != nil {
		t.Fatalf("failed to decode register response: %v", err)
	}
	if regRes.Email != "dev@company.com" || regRes.DevCode == "" || regRes.Status != "pending_verification" {
		t.Errorf("unexpected register response: %+v", regRes)
	}

	// 3. User should NOT be able to login before completing verification
	loginEarlyBody := []byte(`{"email":"dev@company.com","password":"securepassword"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginEarlyBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected unverified user login 401 Unauthorized, got %d: %s", rec.Code, rec.Body.String())
	}

	// 4. Test verify with incorrect code
	badVerifyBody := []byte(`{"email":"dev@company.com","code":"000000"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", bytes.NewReader(badVerifyBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected wrong code 400 Bad Request, got %d: %s", rec.Code, rec.Body.String())
	}

	// 5. Test verify with correct dev code
	verifyBody := []byte(`{"email":"dev@company.com","code":"` + regRes.DevCode + `"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", bytes.NewReader(verifyBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected verify 201 Created, got %d: %s", rec.Code, rec.Body.String())
	}
	var authRes api.AuthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &authRes); err != nil {
		t.Fatalf("failed to decode verify response: %v", err)
	}
	if authRes.User == nil || authRes.User.Email != "dev@company.com" || authRes.User.Name != "Dev User" {
		t.Errorf("unexpected verified user response: %+v", authRes)
	}

	// 6. Test register duplicate email
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected duplicate registration 409 Conflict, got %d: %s", rec.Code, rec.Body.String())
	}

	// 7. Test login with newly registered user
	loginNewBody := []byte(`{"email":"dev@company.com","password":"securepassword"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginNewBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected user login 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	// 8. Test invalid password
	badLoginBody := []byte(`{"email":"dev@company.com","password":"wrongpassword"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(badLoginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected bad login 401 Unauthorized, got %d: %s", rec.Code, rec.Body.String())
	}

	// 9. Test short password validation
	shortRegBody := []byte(`{"name":"Dev User","email":"test@company.com","password":"123"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(shortRegBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected short password 400 Bad Request, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAPI_EmailVerificationEdgeCases(t *testing.T) {
	db, _, _, router, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx := context.Background()

	// 1. Register pending user
	regBody := []byte(`{"name":"Brute Tester","email":"brute@example.com","password":"mypassword123"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK register, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Immediate duplicate registration or resend should trigger cooldown rate limit (30s)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests for rapid duplicate registration, got %d: %s", rec.Code, rec.Body.String())
	}

	resendBody := []byte(`{"email":"brute@example.com"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/resend-code", bytes.NewReader(resendBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests for quick resend, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. Invalid code length validation (should reject without burning attempt counters)
	shortCodeBody := []byte(`{"email":"brute@example.com","code":"123"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", bytes.NewReader(shortCodeBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for short code, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "6 digit angka") {
		t.Errorf("expected 6 digit error message, got: %s", rec.Body.String())
	}

	// 4. Brute force attempts (max 5)
	for i := 1; i <= 5; i++ {
		badBody := []byte(`{"email":"brute@example.com","code":"000000"}`)
		req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", bytes.NewReader(badBody))
		req.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d: expected 400 Bad Request, got %d: %s", i, rec.Code, rec.Body.String())
		}
	}

	// 6th attempt should be blocked due to max attempts exceeded
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", bytes.NewReader([]byte(`{"email":"brute@example.com","code":"000000"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests after max attempts, got %d: %s", rec.Code, rec.Body.String())
	}

	// 5. Test expired verification and resend recovery
	expired := &model.EmailVerification{
		Email:        "expired@example.com",
		Name:         "Expired User",
		PasswordHash: "somehash",
		Code:         "111222",
		Attempts:     0,
		MaxAttempts:  5,
		LastSentAt:   time.Now().UTC().Add(-20 * time.Minute),
		ExpiresAt:    time.Now().UTC().Add(-5 * time.Minute),
		CreatedAt:    time.Now().UTC().Add(-20 * time.Minute),
	}
	if err := db.SaveEmailVerification(ctx, expired); err != nil {
		t.Fatalf("failed to seed expired verification: %v", err)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", bytes.NewReader([]byte(`{"email":"expired@example.com","code":"111222"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for expired code, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "kedaluwarsa") {
		t.Errorf("expected expired message, got: %s", rec.Body.String())
	}

	// Verify that user can request a fresh code after expiration rather than being stranded
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/resend-code", bytes.NewReader([]byte(`{"email":"expired@example.com"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for resend code after expiration, got %d: %s", rec.Code, rec.Body.String())
	}
	var resendRes api.ResendCodeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resendRes); err != nil {
		t.Fatalf("failed to decode resend response: %v", err)
	}
	if resendRes.DevCode == "" {
		t.Fatalf("expected new dev code in resend response")
	}

	// 6. Test that stale session (>24h) is rejected
	stale := &model.EmailVerification{
		Email:        "stale@example.com",
		Name:         "Stale User",
		PasswordHash: "somehash",
		Code:         "999888",
		Attempts:     0,
		MaxAttempts:  5,
		LastSentAt:   time.Now().UTC().Add(-25 * time.Hour),
		ExpiresAt:    time.Now().UTC().Add(-24 * time.Hour),
		CreatedAt:    time.Now().UTC().Add(-25 * time.Hour),
	}
	if err := db.SaveEmailVerification(ctx, stale); err != nil {
		t.Fatalf("failed to seed stale verification: %v", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/resend-code", bytes.NewReader([]byte(`{"email":"stale@example.com"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found for stale session (>24h), got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAPI_VerificationFailureEmptyDeliveryLogAndStructuredCode(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "relaygate-api-dlq-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	db, err := storage.Open(filepath.Join(tempDir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep-test-dlq",
		Name:      "DLQ Test Endpoint",
		SecretKey: "secret_dlq_123",
		TargetURL: "http://localhost:9999",
		Provider:  model.ProviderStripe,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 1. Seed verification rejected event (0 attempts)
	evRejected := &model.WebhookEvent{
		ID:             "ev-rejected-header",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"test":"rejected"}`),
		IsVerified:     -1,
		Status:         model.StatusFailed,
		HTTPStatusCode: 0,
		Attempts:       0,
		MaxAttempts:    5,
		LastError:      "cryptographic signature verification failed: missing Stripe-Signature header",
	}
	if err := db.SaveEvent(ctx, evRejected); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// 2. Seed delivery failed event (5 attempts exhausted)
	evDeliveryFailed := &model.WebhookEvent{
		ID:             "ev-delivery-timeout",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"test":"timeout"}`),
		IsVerified:     1,
		Status:         model.StatusFailed,
		HTTPStatusCode: 0,
		Attempts:       5,
		MaxAttempts:    5,
		LastError:      "network delivery error: connection timeout after 5000ms",
	}
	if err := db.SaveEvent(ctx, evDeliveryFailed); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	router := api.NewRouter(db, nil, api.NewHub())

	// Test GET /api/v1/events/ev-rejected-header
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+evRejected.ID, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	var resRejected api.EventResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resRejected); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if len(resRejected.DeliveryLog) != 0 {
		t.Errorf("expected 0 delivery log entries for rejected event, got %d", len(resRejected.DeliveryLog))
	}
	if resRejected.ErrorClass != "VERIFICATION_REJECTED" {
		t.Errorf("expected ErrorClass VERIFICATION_REJECTED, got %s", resRejected.ErrorClass)
	}
	if resRejected.ErrorCode != "SIGNATURE_HEADER_MISSING" {
		t.Errorf("expected ErrorCode SIGNATURE_HEADER_MISSING, got %s", resRejected.ErrorCode)
	}

	// Test GET /api/v1/events/ev-delivery-timeout
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+evDeliveryFailed.ID, nil)
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec2.Code, rec2.Body.String())
	}

	var resDelivery api.EventResponse
	if err := json.Unmarshal(rec2.Body.Bytes(), &resDelivery); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if len(resDelivery.DeliveryLog) != 0 {
		t.Errorf("expected 0 delivery log entries for exhausted delivery failure (no synthetic timeline), got %d", len(resDelivery.DeliveryLog))
	}
	if resDelivery.ErrorClass != "DELIVERY_FAILED" {
		t.Errorf("expected ErrorClass DELIVERY_FAILED, got %s", resDelivery.ErrorClass)
	}
	if resDelivery.ErrorCode != "TIMEOUT" {
		t.Errorf("expected ErrorCode TIMEOUT, got %s", resDelivery.ErrorCode)
	}

	// 3. Test Replay on ineligible event (missing header) is rejected with 400 Bad Request
	reqReplayIneligible := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+evRejected.ID+"/replay", nil)
	recReplayIneligible := httptest.NewRecorder()
	router.ServeHTTP(recReplayIneligible, reqReplayIneligible)
	if recReplayIneligible.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for ineligible event replay, got %d", recReplayIneligible.Code)
	}

	// 4. Test Replay on eligible event (mismatch): replay succeeds and resets is_verified to 0
	evMismatch := &model.WebhookEvent{
		ID:             "ev-rejected-mismatch",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json", "Stripe-Signature": "t=123,v1=abc"},
		Payload:        []byte(`{"test":"mismatch"}`),
		IsVerified:     -1,
		Status:         model.StatusFailed,
		HTTPStatusCode: 0,
		Attempts:       0,
		MaxAttempts:    5,
		LastError:      "cryptographic signature verification failed: stripe v1 signature mismatch",
		FailureCode:    string(model.ErrCodeSignatureMismatch),
	}
	if err := db.SaveEvent(ctx, evMismatch); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	reqReplayMismatch := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+evMismatch.ID+"/replay", nil)
	recReplayMismatch := httptest.NewRecorder()
	router.ServeHTTP(recReplayMismatch, reqReplayMismatch)

	if recReplayMismatch.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for eligible mismatch replay, got %d: %s", recReplayMismatch.Code, recReplayMismatch.Body.String())
	}

	updatedEv, err := db.GetEventByID(ctx, evMismatch.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if updatedEv.IsVerified != 0 {
		t.Errorf("expected is_verified reset to 0 after replay, got %d", updatedEv.IsVerified)
	}
	if updatedEv.Status != model.StatusPending {
		t.Errorf("expected status reset to PENDING after replay, got %s", updatedEv.Status)
	}
}

func TestAPI_BulkReplay_EligibilityFilter(t *testing.T) {
	db, _, _, _, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep-test-bulk",
		Name:      "Bulk Endpoint",
		TargetURL: "http://localhost:9999/webhook",
		SecretKey: "secret_123",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 1. Ineligible event (header missing)
	evIneligible := &model.WebhookEvent{
		ID:          "ev-bulk-ineligible",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		IsVerified:  -1,
		Status:      model.StatusFailed,
		LastError:   "cryptographic signature verification failed: missing signature header",
		FailureCode: string(model.ErrCodeSignatureHeaderMissing),
	}
	_ = db.SaveEvent(ctx, evIneligible)

	// 2. Eligible event (mismatch)
	evEligible := &model.WebhookEvent{
		ID:          "ev-bulk-eligible",
		EndpointID:  ep.ID,
		Provider:    model.ProviderGeneric,
		IsVerified:  -1,
		Status:      model.StatusFailed,
		LastError:   "cryptographic signature verification failed: generic signature mismatch",
		FailureCode: string(model.ErrCodeSignatureMismatch),
	}
	_ = db.SaveEvent(ctx, evEligible)

	router := api.NewRouter(db, nil, api.NewHub())

	// Call BulkReplay with both IDs
	body, _ := json.Marshal(api.BulkReplayRequest{
		IDs: []string{evIneligible.ID, evEligible.ID},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events/bulk-replay", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for bulk replay, got %d: %s", rec.Code, rec.Body.String())
	}

	var res api.BulkReplayResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if res.ReplayedCount != 1 {
		t.Errorf("expected 1 replayed event, got %d", res.ReplayedCount)
	}
	if res.SkippedCount != 1 {
		t.Errorf("expected 1 skipped event, got %d", res.SkippedCount)
	}

	// Verify evEligible was reset to PENDING and is_verified to 0
	checkEligible, _ := db.GetEventByID(ctx, evEligible.ID)
	if checkEligible.Status != model.StatusPending || checkEligible.IsVerified != 0 {
		t.Errorf("expected evEligible to be PENDING with is_verified=0, got status=%s, is_verified=%d", checkEligible.Status, checkEligible.IsVerified)
	}

	// Verify evIneligible remains FAILED with is_verified=-1
	checkIneligible, _ := db.GetEventByID(ctx, evIneligible.ID)
	if checkIneligible.Status != model.StatusFailed || checkIneligible.IsVerified != -1 {
		t.Errorf("expected evIneligible to remain FAILED with is_verified=-1, got status=%s, is_verified=%d", checkIneligible.Status, checkIneligible.IsVerified)
	}
}

func TestAPI_GetEvent_RevealAdminCheckAndMaskingFallback(t *testing.T) {
	db, _, _, _, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep-test-reveal",
		Name:      "Reveal Test Endpoint",
		TargetURL: "http://localhost:9999/webhook",
		SecretKey: "secret_reveal",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// Create event with all 7 sensitive header patterns: token, secret, signature, auth, key, password, cookie
	ev := &model.WebhookEvent{
		ID:         "ev-test-reveal-123",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		SourceIP:   "127.0.0.1",
		Headers: map[string]string{
			"X-Callback-Token": "xendit_token_value_abc",
			"Stripe-Signature": "t=12345,v1=stripe_signature_hash",
			"Authorization":    "Bearer secret_token_xyz",
			"X-Endpoint-Secret": "shared_secret_456",
			"X-Api-Key":        "api_key_789",
			"X-User-Password":  "supersecretpassword",
			"Cookie":           "session=sess_cookie_val; id=123",
			"Content-Type":     "application/json",
			"User-Agent":       "TestRunner/2.0",
		},
		Payload:     []byte(`{"test":"reveal"}`),
		Status:      model.StatusFailed,
		IsVerified:  -1,
		Attempts:    0,
		MaxAttempts: 5,
		LastError:   "signature mismatch",
		FailureCode: string(model.ErrCodeSignatureMismatch),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	router := api.NewRouter(db, nil, api.NewHub())

	// Seed sessions in storage:
	// 1. Viewer session
	viewerUser := &model.User{
		ID:           "usr_viewer_test",
		Name:         "Viewer User",
		Email:        "viewer@example.com",
		Role:         "viewer",
		PasswordHash: "dummyhash",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, viewerUser); err != nil {
		t.Fatalf("SaveUser failed: %v", err)
	}
	viewerSession := &model.Session{
		Token:     "sess_viewer_test_token_123",
		UserID:    viewerUser.ID,
		UserEmail: viewerUser.Email,
		Role:      "viewer",
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveSession(ctx, viewerSession); err != nil {
		t.Fatalf("SaveSession failed: %v", err)
	}

	// 2. Admin session
	adminUser, err := db.GetUserByEmail(ctx, "admin@relaygate.local")
	if err != nil || adminUser == nil {
		t.Fatalf("admin user not found: %v", err)
	}
	adminSession := &model.Session{
		Token:     "sess_admin_test_token_789",
		UserID:    adminUser.ID,
		UserEmail: adminUser.Email,
		Role:      "admin",
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveSession(ctx, adminSession); err != nil {
		t.Fatalf("SaveSession failed: %v", err)
	}

	// Case (d): Admin session without reveal=1 -> always masked (••••••••), 0 audit rows
	req1 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID, nil)
	req1.Header.Set("Authorization", "Bearer "+adminSession.Token)
	rec1 := httptest.NewRecorder()
	router.ServeHTTP(rec1, req1)

	if rec1.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", rec1.Code, rec1.Body.String())
	}
	var res1 api.EventResponse
	if err := json.Unmarshal(rec1.Body.Bytes(), &res1); err != nil {
		t.Fatalf("failed to decode res1: %v", err)
	}
	maskedPattern := "••••••••••••••••••••••••••••••••"
	for _, sensKey := range []string{
		"X-Callback-Token", "Stripe-Signature", "Authorization",
		"X-Endpoint-Secret", "X-Api-Key", "X-User-Password", "Cookie",
	} {
		val := res1.Headers[sensKey]
		if val != maskedPattern {
			t.Errorf("expected sensitive header %s to be masked (%s), got: %s", sensKey, maskedPattern, val)
		}
	}
	audits1, err := db.ListAuditReveals(ctx, ev.ID)
	if err != nil {
		t.Fatalf("ListAuditReveals failed: %v", err)
	}
	if len(audits1) != 0 {
		t.Fatalf("expected 0 audit reveals without reveal=1, got %d", len(audits1))
	}

	// Case (a): No session + X-Admin: true -> MUST return 401 Unauthorized (or 403)
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req2.Header.Set("X-Admin", "true")
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusUnauthorized && rec2.Code != http.StatusForbidden {
		t.Errorf("expected 401/403 for unauthenticated reveal with X-Admin: true, got %d: %s", rec2.Code, rec2.Body.String())
	}

	// Case: Static backdoor Bearer admin -> MUST be rejected (401/403)
	reqBackdoor := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	reqBackdoor.Header.Set("Authorization", "Bearer admin")
	recBackdoor := httptest.NewRecorder()
	router.ServeHTTP(recBackdoor, reqBackdoor)
	if recBackdoor.Code != http.StatusUnauthorized && recBackdoor.Code != http.StatusForbidden {
		t.Errorf("expected 401/403 for static Bearer admin, got %d: %s", recBackdoor.Code, recBackdoor.Body.String())
	}

	// Case (b): Viewer session + X-Admin: true -> MUST return 403 Forbidden
	req3 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req3.Header.Set("Authorization", "Bearer "+viewerSession.Token)
	req3.Header.Set("X-Admin", "true")
	req3.Header.Set("X-User-Role", "admin")
	rec3 := httptest.NewRecorder()
	router.ServeHTTP(rec3, req3)

	if rec3.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden for viewer session with spoofed X-Admin, got %d: %s", rec3.Code, rec3.Body.String())
	}
	if !strings.Contains(rec3.Body.String(), "admin role required") {
		t.Errorf("expected 'admin role required' error message, got: %s", rec3.Body.String())
	}

	// Case (c): Admin session + ?reveal=1 -> plaintext headers + exactly 1 row added to audit table
	req4 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req4.Header.Set("Authorization", "Bearer "+adminSession.Token)
	rec4 := httptest.NewRecorder()
	router.ServeHTTP(rec4, req4)

	if rec4.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for admin session reveal, got %d: %s", rec4.Code, rec4.Body.String())
	}

	var res4 api.EventResponse
	if err := json.Unmarshal(rec4.Body.Bytes(), &res4); err != nil {
		t.Fatalf("failed to decode res4: %v", err)
	}

	if res4.Headers["X-Callback-Token"] != "xendit_token_value_abc" {
		t.Errorf("expected unmasked X-Callback-Token, got: %s", res4.Headers["X-Callback-Token"])
	}
	if res4.Headers["Cookie"] != "session=sess_cookie_val; id=123" {
		t.Errorf("expected unmasked Cookie, got: %s", res4.Headers["Cookie"])
	}
	if res4.Headers["Authorization"] != "Bearer secret_token_xyz" {
		t.Errorf("expected unmasked Authorization, got: %s", res4.Headers["Authorization"])
	}

	// Verify audit table: exactly 1 row added
	auditsAfter, err := db.ListAuditReveals(ctx, ev.ID)
	if err != nil {
		t.Fatalf("ListAuditReveals failed: %v", err)
	}
	if len(auditsAfter) != 1 {
		t.Fatalf("expected exactly 1 audit reveal row, got %d", len(auditsAfter))
	}
	auditRow := auditsAfter[0]
	if auditRow.UserEmail != adminUser.Email {
		t.Errorf("expected audit user_email %s, got %s", adminUser.Email, auditRow.UserEmail)
	}
	if auditRow.EventID != ev.ID {
		t.Errorf("expected audit event_id %s, got %s", ev.ID, auditRow.EventID)
	}
	// Verify that revealed_header_names contains only header NAMES, NEVER header values
	if !strings.Contains(auditRow.RevealedHeaderNames, "Authorization") ||
		!strings.Contains(auditRow.RevealedHeaderNames, "Cookie") ||
		!strings.Contains(auditRow.RevealedHeaderNames, "X-Callback-Token") {
		t.Errorf("expected revealed_header_names to contain header names, got: %s", auditRow.RevealedHeaderNames)
	}
	if strings.Contains(auditRow.RevealedHeaderNames, "xendit_token_value_abc") ||
		strings.Contains(auditRow.RevealedHeaderNames, "secret_token_xyz") ||
		strings.Contains(auditRow.RevealedHeaderNames, "supersecretpassword") {
		t.Fatalf("CRITICAL SECURITY DEFECT: sensitive header value leaked into audit table! audit names: %s", auditRow.RevealedHeaderNames)
	}
}

func TestAPI_ProxyHeaderSanitizationAndAuditIP(t *testing.T) {
	db, _, _, _, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx := context.Background()
	router := api.NewRouter(db, nil, nil)

	adminUser := &model.User{
		ID:           "usr_sec_admin",
		Name:         "Security Admin",
		Email:        "secadmin@relaygate.local",
		Role:         "admin",
		PasswordHash: "dummyhash",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, adminUser); err != nil {
		t.Fatalf("SaveUser failed: %v", err)
	}
	adminSession := &model.Session{
		Token:     "sess_sec_admin_token_456",
		UserID:    adminUser.ID,
		UserEmail: adminUser.Email,
		Role:      "admin",
		ExpiresAt: time.Now().UTC().Add(24 * time.Hour),
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveSession(ctx, adminSession); err != nil {
		t.Fatalf("SaveSession failed: %v", err)
	}
	ep := &model.Endpoint{
		ID:        "ep_test_proxy",
		Name:      "Proxy Test Endpoint",
		TargetURL: "http://localhost:9999/webhook",
		SecretKey: "secret_proxy",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:             "ev_proxy_test_1",
		EndpointID:     "ep_test_proxy",
		Provider:       "generic",
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Authorization": "Bearer secret_val"},
		Payload:        []byte(`{"test":true}`),
		Status:         model.StatusFailed,
		Attempts:       1,
		MaxAttempts:    5,
		HTTPStatusCode: 500,
		CreatedAt:      time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// 1. Untrusted external client sending spoofed proxy headers:
	// RemoteAddr is public IP 203.0.113.195:43210
	reqUntrusted := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	reqUntrusted.RemoteAddr = "203.0.113.195:43210"
	reqUntrusted.Header.Set("Authorization", "Bearer "+adminSession.Token)
	reqUntrusted.Header.Set("X-Forwarded-For", "10.0.0.1, 192.168.1.1")
	reqUntrusted.Header.Set("X-Real-IP", "10.0.0.1")
	reqUntrusted.Header.Set("X-Admin", "true")
	recUntrusted := httptest.NewRecorder()
	router.ServeHTTP(recUntrusted, reqUntrusted)

	if recUntrusted.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", recUntrusted.Code, recUntrusted.Body.String())
	}
	audits1, err := db.ListAuditReveals(ctx, ev.ID)
	if err != nil || len(audits1) != 1 {
		t.Fatalf("expected 1 audit reveal, got %d (err: %v)", len(audits1), err)
	}
	if audits1[0].IPAddress != "203.0.113.195" {
		t.Errorf("SECURITY FLAW: untrusted X-Forwarded-For was accepted! expected 203.0.113.195, got %s", audits1[0].IPAddress)
	}

	// 2. Trusted proxy sending forwarded client IP:
	// RemoteAddr is loopback 127.0.0.1:54321
	reqTrusted := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	reqTrusted.RemoteAddr = "127.0.0.1:54321"
	reqTrusted.Header.Set("Authorization", "Bearer "+adminSession.Token)
	reqTrusted.Header.Set("X-Forwarded-For", "198.51.100.25, 127.0.0.1")
	recTrusted := httptest.NewRecorder()
	router.ServeHTTP(recTrusted, reqTrusted)

	if recTrusted.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", recTrusted.Code, recTrusted.Body.String())
	}
	audits2, err := db.ListAuditReveals(ctx, ev.ID)
	if err != nil || len(audits2) != 2 {
		t.Fatalf("expected 2 audit reveals, got %d (err: %v)", len(audits2), err)
	}
	foundTrusted := false
	foundUntrusted := false
	for _, a := range audits2 {
		if a.IPAddress == "198.51.100.25" {
			foundTrusted = true
		}
		if a.IPAddress == "203.0.113.195" {
			foundUntrusted = true
		}
	}
	if !foundTrusted {
		t.Errorf("expected audit reveal with trusted proxy IP 198.51.100.25, found none")
	}
	if !foundUntrusted {
		t.Errorf("expected audit reveal with untrusted remote IP 203.0.113.195, found none")
	}
}

func TestAPI_TrustedProxyAllowlistConfigurable(t *testing.T) {
	defer api.ResetTrustedProxies()

	// 1. Default configuration: loopback only
	api.ResetTrustedProxies()

	if !api.IsTrustedProxy("127.0.0.1:8080") {
		t.Errorf("expected 127.0.0.1 to be trusted by default")
	}
	if !api.IsTrustedProxy("[::1]:54321") {
		t.Errorf("expected ::1 to be trusted by default")
	}
	// Private subnets must NOT be trusted by default (security hardening)
	if api.IsTrustedProxy("10.0.0.1:1234") {
		t.Errorf("expected 10.0.0.1 to NOT be trusted by default")
	}
	if api.IsTrustedProxy("192.168.1.1:1234") {
		t.Errorf("expected 192.168.1.1 to NOT be trusted by default")
	}

	// 2. Custom allowlist configuration
	api.SetTrustedProxies([]string{"10.0.0.0/24", "192.168.100.5"})

	if !api.IsTrustedProxy("10.0.0.42:8080") {
		t.Errorf("expected 10.0.0.42 to be trusted after CIDR allowlist configured")
	}
	if !api.IsTrustedProxy("192.168.100.5:8080") {
		t.Errorf("expected 192.168.100.5 to be trusted after IP allowlist configured")
	}
	if api.IsTrustedProxy("10.0.1.1:8080") {
		t.Errorf("expected 10.0.1.1 to NOT be trusted outside configured CIDR")
	}
}

func TestAPI_CSRFProtection_CookieAuth(t *testing.T) {
	db, _, _, _, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx := context.Background()
	adminUser := &model.User{
		ID:           "usr_csrf_admin",
		Name:         "CSRF Admin",
		Email:        "csrf-admin@relaygate.local",
		Role:         "admin",
		PasswordHash: "dummyhash",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, adminUser); err != nil {
		t.Fatalf("SaveUser failed: %v", err)
	}
	adminSession := &model.Session{
		Token:     "test_admin_csrf_sess",
		UserID:    "usr_csrf_admin",
		UserEmail: "csrf-admin@relaygate.local",
		Role:      "admin",
		ExpiresAt: time.Now().UTC().Add(1 * time.Hour),
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveSession(ctx, adminSession); err != nil {
		t.Fatalf("SaveSession failed: %v", err)
	}

	ep := &model.Endpoint{
		ID:        "ep-csrf-dummy",
		Name:      "CSRF Test Endpoint",
		TargetURL: "http://localhost:9999/webhook",
		SecretKey: "secret_123",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:         "ev-csrf-test",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		Headers:    map[string]string{"Authorization": "Bearer secret-val"},
		Payload:    []byte(`{}`),
		Status:     model.StatusFailed,
		CreatedAt:  time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	router := api.NewRouter(db, nil, api.NewHub())

	// 1. Cross-site Sec-Fetch-Site with cookie auth -> 403 Forbidden
	req1 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req1.Host = "relaygate.internal"
	req1.AddCookie(&http.Cookie{Name: "session", Value: adminSession.Token})
	req1.Header.Set("Sec-Fetch-Site", "cross-site")
	req1.Header.Set("Origin", "http://attacker.com")
	rec1 := httptest.NewRecorder()
	router.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden for cross-site cookie reveal, got %d", rec1.Code)
	}

	// 2. Mismatched Origin with cookie auth -> 403 Forbidden
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req2.Host = "relaygate.internal"
	req2.AddCookie(&http.Cookie{Name: "session", Value: adminSession.Token})
	req2.Header.Set("Origin", "http://evil.com")
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden for mismatched Origin with cookie auth, got %d", rec2.Code)
	}

	// 3. Same Origin with cookie auth -> 200 OK
	req3 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req3.Host = "relaygate.internal"
	req3.AddCookie(&http.Cookie{Name: "session", Value: adminSession.Token})
	req3.Header.Set("Origin", "http://relaygate.internal")
	rec3 := httptest.NewRecorder()
	router.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusOK {
		t.Errorf("expected 200 OK for valid same-origin cookie auth, got %d", rec3.Code)
	}

	// 4. Bearer token auth bypasses browser CSRF origin check -> 200 OK
	req4 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req4.Host = "relaygate.internal"
	req4.Header.Set("Authorization", "Bearer "+adminSession.Token)
	req4.Header.Set("Origin", "http://external-tool.com")
	rec4 := httptest.NewRecorder()
	router.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusOK {
		t.Errorf("expected 200 OK for Bearer token auth, got %d", rec4.Code)
	}
}

func TestAPI_SessionAuthAndLogoutRevocation(t *testing.T) {
	db, _, _, _, cleanup := setupTestAPI(t)
	defer cleanup()

	ctx := context.Background()
	userRevoc := &model.User{
		ID:           "usr_revoc",
		Name:         "Revoc User",
		Email:        "revoc@relaygate.local",
		Role:         "admin",
		PasswordHash: "dummyhash",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, userRevoc); err != nil {
		t.Fatalf("SaveUser failed: %v", err)
	}

	adminSession := &model.Session{
		Token:     "test_sess_revocation",
		UserID:    "usr_revoc",
		UserEmail: "revoc@relaygate.local",
		Role:      "admin",
		ExpiresAt: time.Now().UTC().Add(1 * time.Hour),
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveSession(ctx, adminSession); err != nil {
		t.Fatalf("SaveSession failed: %v", err)
	}

	ep := &model.Endpoint{
		ID:        "ep-revoc-dummy",
		Name:      "Revoc Test Endpoint",
		TargetURL: "http://localhost:9999/webhook",
		SecretKey: "secret_123",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev := &model.WebhookEvent{
		ID:         "ev-revoc-test",
		EndpointID: ep.ID,
		Provider:   model.ProviderGeneric,
		Headers:    map[string]string{"Authorization": "Bearer secret-token"},
		Payload:    []byte(`{}`),
		Status:     model.StatusFailed,
		CreatedAt:  time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	router := api.NewRouter(db, nil, api.NewHub())

	// 1. Initial access with valid session: 200 OK
	req1 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req1.Header.Set("Authorization", "Bearer "+adminSession.Token)
	rec1 := httptest.NewRecorder()
	router.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("expected 200 OK before logout, got %d", rec1.Code)
	}

	// 2. Perform Logout
	reqLogout := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	reqLogout.Header.Set("Authorization", "Bearer "+adminSession.Token)
	recLogout := httptest.NewRecorder()
	router.ServeHTTP(recLogout, reqLogout)
	if recLogout.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on logout, got %d", recLogout.Code)
	}

	// 3. Subsequent access with revoked session: 401 Unauthorized
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req2.Header.Set("Authorization", "Bearer "+adminSession.Token)
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized after session revocation, got %d", rec2.Code)
	}

	// 4. Expired session test
	userExp := &model.User{
		ID:           "usr_exp",
		Name:         "Expired User",
		Email:        "exp@relaygate.local",
		Role:         "admin",
		PasswordHash: "dummyhash",
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, userExp); err != nil {
		t.Fatalf("SaveUser usr_exp failed: %v", err)
	}

	expiredSession := &model.Session{
		Token:     "test_sess_expired",
		UserID:    "usr_exp",
		UserEmail: "exp@relaygate.local",
		Role:      "admin",
		ExpiresAt: time.Now().UTC().Add(-1 * time.Hour), // Expired!
		CreatedAt: time.Now().UTC().Add(-2 * time.Hour),
	}
	_ = db.SaveSession(ctx, expiredSession)

	reqExpired := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	reqExpired.Header.Set("Authorization", "Bearer "+expiredSession.Token)
	recExpired := httptest.NewRecorder()
	router.ServeHTTP(recExpired, reqExpired)
	if recExpired.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized for expired session, got %d", recExpired.Code)
	}
}

func TestAPI_RegisterVerificationLimitIndependentOfWebhookMaxAttempts(t *testing.T) {
	db, _, _, _, cleanup := setupTestAPI(t)
	defer cleanup()

	origWebhookMax := model.DefaultMaxAttempts
	defer func() {
		model.DefaultMaxAttempts = origWebhookMax
	}()
	model.DefaultMaxAttempts = 9

	router := api.NewRouter(db, nil, api.NewHub())

	body := `{"name":"Test Indep","email":"indep-reg@relaygate.local","password":"Password123!"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("expected 200/201 on register, got %d: %s", rec.Code, rec.Body.String())
	}

	ev, err := db.GetEmailVerification(context.Background(), "indep-reg@relaygate.local")
	if err != nil {
		t.Fatalf("GetEmailVerification failed: %v", err)
	}
	if ev.MaxAttempts != model.DefaultVerificationMaxAttempts || ev.MaxAttempts == model.DefaultMaxAttempts {
		t.Fatalf("expected Register to set EmailVerification.MaxAttempts=%d when DefaultMaxAttempts=%d, got %d",
			model.DefaultVerificationMaxAttempts, model.DefaultMaxAttempts, ev.MaxAttempts)
	}
}

