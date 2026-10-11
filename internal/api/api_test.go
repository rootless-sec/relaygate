package api_test

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
		SecretKey: "whsec_test",
		TargetURL: "https://example.com/webhook",
		Provider:  model.ProviderStripe,
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
	if evDetail.ID != ev.ID || len(evDetail.DeliveryLog) == 0 {
		t.Errorf("unexpected event detail: %+v", evDetail)
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

	// 2. Test register new account
	regBody := []byte(`{"name":"Dev User","email":"dev@company.com","password":"securepassword"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected registration 201 Created, got %d: %s", rec.Code, rec.Body.String())
	}
	var regRes api.AuthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &regRes); err != nil {
		t.Fatalf("failed to decode register response: %v", err)
	}
	if regRes.User.Email != "dev@company.com" || regRes.User.Name != "Dev User" {
		t.Errorf("unexpected registered user: %+v", regRes.User)
	}

	// 3. Test register duplicate email
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected duplicate registration 409 Conflict, got %d: %s", rec.Code, rec.Body.String())
	}

	// 4. Test login with newly registered user
	loginNewBody := []byte(`{"email":"dev@company.com","password":"securepassword"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginNewBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected user login 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	// 5. Test invalid password
	badLoginBody := []byte(`{"email":"dev@company.com","password":"wrongpassword"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(badLoginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected bad login 401 Unauthorized, got %d: %s", rec.Code, rec.Body.String())
	}

	// 6. Test short password validation
	shortRegBody := []byte(`{"name":"Dev User","email":"test@company.com","password":"123"}`)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(shortRegBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected short password 400 Bad Request, got %d: %s", rec.Code, rec.Body.String())
	}
}

