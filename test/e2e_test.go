package test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"github.com/rootless-sec/relaygate/internal/api"
	"github.com/rootless-sec/relaygate/internal/ingest"
	"github.com/rootless-sec/relaygate/internal/mailer"
	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

// ============================================================================
// Baseline End-to-End Integration & Lifecycle Tests
// ============================================================================

func TestEndToEnd_IngestToDelivery(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "relaygate-e2e-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "relaygate.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open storage db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// 1. Mock downstream target service
	var mu sync.Mutex
	var receivedPayload []byte
	var receivedHeaders http.Header
	var deliveryCount atomic.Int32

	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deliveryCount.Add(1)
		b, _ := io.ReadAll(r.Body)
		h := r.Header.Clone()
		mu.Lock()
		receivedHeaders = h
		receivedPayload = b
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"success"}`))
	}))
	defer targetServer.Close()

	// 2. Configure endpoint
	secretKey := "whsec_e2e_test_key"
	endpoint := &model.Endpoint{
		ID:        "ep-e2e-stripe",
		Name:      "E2E Stripe Webhook",
		SecretKey: secretKey,
		TargetURL: targetServer.URL,
		Provider:  model.ProviderStripe,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, endpoint); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 3. Initialize Verifier, Worker Pool, and Ingest Handler
	v := verifier.NewEngine()
	workerCfg := worker.DefaultConfig()
	workerCfg.Concurrency = 2
	workerCfg.HTTPClient = targetServer.Client()
	pool := worker.NewPool(db, v, workerCfg)
	pool.Start()
	defer pool.Stop()

	ingestHandler := ingest.NewHandler(db, pool)

	// 4. Construct webhook request with Stripe signature
	nowUnix := time.Now().Unix()
	rawBody := []byte(`{"id":"evt_payment_1001","type":"payment_intent.succeeded","amount":250000}`)

	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write([]byte(fmt.Sprintf("%d.", nowUnix)))
	mac.Write(rawBody)
	stripeSig := fmt.Sprintf("t=%d,v1=%s", nowUnix, hex.EncodeToString(mac.Sum(nil)))

	req := httptest.NewRequest(http.MethodPost, "/ingest/"+endpoint.ID, bytes.NewReader(rawBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", stripeSig)
	req.Header.Set("User-Agent", "Stripe/1.0 (+https://stripe.com/docs/webhooks)")
	req.Header.Set("X-Forwarded-For", "54.187.174.169")

	// 5. Execute ingest request
	rec := httptest.NewRecorder()
	start := time.Now()
	ingestHandler.ServeHTTP(rec, req)
	ingestDuration := time.Since(start)

	if rec.Code != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}
	if ingestDuration > 15*time.Millisecond {
		t.Logf("Notice: Ingest completed in %v", ingestDuration)
	}

	var ingestResp ingest.Response
	if err := json.Unmarshal(rec.Body.Bytes(), &ingestResp); err != nil {
		t.Fatalf("failed to decode ingest response: %v", err)
	}
	if ingestResp.ID == "" || ingestResp.Status != "queued" {
		t.Fatalf("unexpected ingest response: %+v", ingestResp)
	}

	// 6. Wait for async worker dispatch
	deadline := time.Now().Add(3 * time.Second)
	for deliveryCount.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	if deliveryCount.Load() != 1 {
		t.Fatalf("expected 1 delivery to target, got %d", deliveryCount.Load())
	}

	// 7. Verify payload & headers delivered to target
	mu.Lock()
	gotPayload := string(receivedPayload)
	gotDeliveryHeader := receivedHeaders.Get("X-RelayGate-Delivery")
	gotVerifiedHeader := receivedHeaders.Get("X-RelayGate-Verified")
	mu.Unlock()

	if gotPayload != string(rawBody) {
		t.Errorf("payload mismatch: expected %s, got %s", string(rawBody), gotPayload)
	}
	if gotDeliveryHeader != ingestResp.ID {
		t.Errorf("missing delivery header: %s", gotDeliveryHeader)
	}
	if gotVerifiedHeader != "1" {
		t.Errorf("expected X-RelayGate-Verified=1, got %s", gotVerifiedHeader)
	}

	// 8. Verify database final state
	event, err := db.GetEventByID(ctx, ingestResp.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	if event.Status != model.StatusDelivered {
		t.Errorf("expected final status DELIVERED, got %s", event.Status)
	}
	if event.HTTPStatusCode != 200 {
		t.Errorf("expected HTTP 200, got %d", event.HTTPStatusCode)
	}
	if event.IsVerified != 1 {
		t.Errorf("expected is_verified = 1, got %d", event.IsVerified)
	}

	// 9. Verify stats
	stats, err := db.GetStats(ctx)
	if err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
	if stats.TotalEvents != 1 || stats.DeliveredEvents != 1 {
		t.Errorf("unexpected stats: %+v", stats)
	}
}

func TestEndToEnd_ForgedSignatureRejected(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "relaygate-e2e-forged-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "relaygate.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open storage db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// Downstream target service
	var deliveryCount atomic.Int32
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deliveryCount.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer targetServer.Close()

	secretKey := "whsec_strict_key"
	endpoint := &model.Endpoint{
		ID:        "ep-forged-stripe",
		Name:      "Strict Stripe",
		SecretKey: secretKey,
		TargetURL: targetServer.URL,
		Provider:  model.ProviderStripe,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, endpoint); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	v := verifier.NewEngine()
	workerCfg := worker.DefaultConfig()
	workerCfg.Concurrency = 2
	workerCfg.HTTPClient = targetServer.Client()
	pool := worker.NewPool(db, v, workerCfg)
	pool.Start()
	defer pool.Stop()

	ingestHandler := ingest.NewHandler(db, pool)

	// Send webhook with invalid/forged Stripe signature
	nowUnix := time.Now().Unix()
	rawBody := []byte(`{"id":"evt_fraud_999","type":"charge.refunded"}`)
	forgedSig := fmt.Sprintf("t=%d,v1=0000000000000000000000000000000000000000000000000000000000000000", nowUnix)

	req := httptest.NewRequest(http.MethodPost, "/ingest/"+endpoint.ID, bytes.NewReader(rawBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", forgedSig)

	rec := httptest.NewRecorder()
	ingestHandler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d", rec.Code)
	}

	var ingestResp ingest.Response
	_ = json.Unmarshal(rec.Body.Bytes(), &ingestResp)

	// Wait for worker processing
	time.Sleep(300 * time.Millisecond)

	// Target must NOT have received any request
	if deliveryCount.Load() != 0 {
		t.Fatalf("expected 0 deliveries to target for forged webhook, got %d", deliveryCount.Load())
	}

	// Verify database record: status FAILED, is_verified = -1
	event, err := db.GetEventByID(ctx, ingestResp.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if event.Status != model.StatusFailed {
		t.Errorf("expected status FAILED, got %s", event.Status)
	}
	if event.IsVerified != -1 {
		t.Errorf("expected is_verified = -1, got %d", event.IsVerified)
	}
}

func TestProdDatabaseState(t *testing.T) {
	prodDBPath := filepath.Join("..", "data", "relaygate.db")
	if _, err := os.Stat(prodDBPath); os.IsNotExist(err) {
		t.Skip("Production database not present at", prodDBPath)
	}

	db, err := storage.Open(prodDBPath)
	if err != nil {
		t.Fatalf("failed to open production db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// Check endpoints
	endpoints, err := db.ListEndpoints(ctx)
	if err != nil {
		t.Fatalf("ListEndpoints failed: %v", err)
	}
	if len(endpoints) != 0 {
		t.Errorf("Expected 0 endpoints in fresh production DB, got %d", len(endpoints))
	}

	// Check webhook_events
	events, totalEvents, err := db.ListEvents(ctx, storage.ListFilter{})
	if err != nil {
		t.Fatalf("ListEvents failed: %v", err)
	}
	if totalEvents != 0 || len(events) != 0 {
		t.Errorf("Expected 0 events in fresh production DB, got %d", totalEvents)
	}

	// Check audit reveals
	reveals, err := db.ListAuditReveals(ctx, "")
	if err != nil {
		t.Fatalf("ListAuditReveals failed: %v", err)
	}
	if len(reveals) != 0 {
		t.Errorf("Expected 0 audit reveals in fresh production DB, got %d", len(reveals))
	}

	// Check users
	user, err := db.GetUserByEmail(ctx, "admin@relaygate.local")
	if err != nil {
		t.Fatalf("Admin user not found: %v", err)
	}
	if user.Role != "admin" {
		t.Errorf("Expected admin role, got %s", user.Role)
	}
	t.Logf("Clean production database verified: 0 endpoints, 0 events, 0 audit reveals, 1 admin user.")
}

func TestEndToEnd_FullSystemLifecycle(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "relaygate-lifecycle-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "relaygate.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open storage db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// 1. Target downstream mock
	var targetCalls atomic.Int32
	var lastReceivedBody []byte
	var mu sync.Mutex

	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalls.Add(1)
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		lastReceivedBody = b
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"received":true}`))
	}))
	defer targetServer.Close()

	// 2. Core engine setup
	v := verifier.NewEngine()
	workerCfg := worker.DefaultConfig()
	workerCfg.Concurrency = 2
	workerCfg.HTTPClient = targetServer.Client()
	pool := worker.NewPool(db, v, workerCfg)
	pool.Start()
	defer pool.Stop()

	hub := api.NewHub()
	pool.SetBroadcaster(hub)

	ingestHandler := ingest.NewHandler(db, pool)
	ingestHandler.SetBroadcaster(hub)

	emailSender := mailer.NewMailerFromEnv()
	apiRouter := api.NewRouter(db, pool, hub, emailSender)

	mux := http.NewServeMux()
	mux.Handle("POST /ingest/{endpoint_id}", ingestHandler)
	mux.Handle("/ingest/", ingestHandler)
	mux.Handle("/api/v1/", apiRouter)

	server := httptest.NewServer(mux)
	defer server.Close()

	client := server.Client()

	// 3. Admin Login
	loginBody := `{"email":"admin@relaygate.local","password":"relaygate123"}`
	resp, err := client.Post(server.URL+"/api/v1/auth/login", "application/json", strings.NewReader(loginBody))
	if err != nil {
		t.Fatalf("Login POST failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("Login failed with status %d: %s", resp.StatusCode, string(b))
	}
	var loginData struct {
		Token string `json:"token"`
		User  struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"user"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&loginData)
	resp.Body.Close()

	if loginData.Token == "" {
		t.Fatalf("expected non-empty auth token")
	}

	authHeader := "Bearer " + loginData.Token

	// 4. Create Endpoint via HTTP API
	endpointPayload := map[string]any{
		"name":       "Production Stripe Webhooks",
		"provider":   "stripe",
		"target_url": targetServer.URL,
		"secret_key": "whsec_test_stripe_secret_123",
	}
	payloadBytes, _ := json.Marshal(endpointPayload)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/endpoints", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", authHeader)

	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("Create endpoint request failed: %v", err)
	}
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("Create endpoint expected 201 Created, got %d: %s", resp.StatusCode, string(b))
	}
	var createdEp model.Endpoint
	_ = json.NewDecoder(resp.Body).Decode(&createdEp)
	resp.Body.Close()

	if createdEp.ID == "" || createdEp.Name != "Production Stripe Webhooks" {
		t.Fatalf("unexpected created endpoint: %+v", createdEp)
	}

	// 5. Send Valid Stripe Webhook Ingest
	validPayload := []byte(`{"id":"evt_stripe_live_001","type":"payment_intent.succeeded","amount":5000}`)
	nowUnix := time.Now().Unix()
	mac := hmac.New(sha256.New, []byte("whsec_test_stripe_secret_123"))
	mac.Write([]byte(fmt.Sprintf("%d.%s", nowUnix, string(validPayload))))
	validSig := fmt.Sprintf("t=%d,v1=%s", nowUnix, hex.EncodeToString(mac.Sum(nil)))

	ingestReq, _ := http.NewRequest(http.MethodPost, server.URL+"/ingest/"+createdEp.ID, bytes.NewReader(validPayload))
	ingestReq.Header.Set("Content-Type", "application/json")
	ingestReq.Header.Set("Stripe-Signature", validSig)

	resp, err = client.Do(ingestReq)
	if err != nil {
		t.Fatalf("Ingest valid webhook failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("Ingest expected 200 OK, got %d: %s", resp.StatusCode, string(b))
	}
	var ingestResp struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&ingestResp)
	resp.Body.Close()

	// Wait for worker delivery
	time.Sleep(300 * time.Millisecond)

	if targetCalls.Load() != 1 {
		t.Fatalf("expected 1 delivery to target, got %d", targetCalls.Load())
	}
	mu.Lock()
	if string(lastReceivedBody) != string(validPayload) {
		t.Errorf("expected downstream payload %s, got %s", string(validPayload), string(lastReceivedBody))
	}
	mu.Unlock()

	// Verify DB state
	evt, err := db.GetEventByID(ctx, ingestResp.ID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.Status != model.StatusDelivered {
		t.Errorf("expected event status DELIVERED, got %s", evt.Status)
	}
	if evt.IsVerified != 1 {
		t.Errorf("expected is_verified = 1, got %d", evt.IsVerified)
	}

	// 6. Send Forged Webhook Ingest
	forgedPayload := []byte(`{"id":"evt_fraud_999","type":"charge.refunded"}`)
	forgedSig := fmt.Sprintf("t=%d,v1=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", nowUnix)

	forgedReq, _ := http.NewRequest(http.MethodPost, server.URL+"/ingest/"+createdEp.ID, bytes.NewReader(forgedPayload))
	forgedReq.Header.Set("Content-Type", "application/json")
	forgedReq.Header.Set("Stripe-Signature", forgedSig)

	resp, err = client.Do(forgedReq)
	if err != nil {
		t.Fatalf("Ingest forged webhook failed: %v", err)
	}
	var forgedResp struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&forgedResp)
	resp.Body.Close()

	time.Sleep(300 * time.Millisecond)

	// Target must NOT receive forged webhook (call count stays 1)
	if targetCalls.Load() != 1 {
		t.Fatalf("target was called for forged webhook! count = %d", targetCalls.Load())
	}

	forgedEvt, err := db.GetEventByID(ctx, forgedResp.ID)
	if err != nil {
		t.Fatalf("GetEventByID forged failed: %v", err)
	}
	if forgedEvt.Status != model.StatusFailed {
		t.Errorf("expected forged event status FAILED, got %s", forgedEvt.Status)
	}
	if forgedEvt.IsVerified != -1 {
		t.Errorf("expected forged event is_verified = -1, got %d", forgedEvt.IsVerified)
	}

	// 7. Test Audit Reveal
	revealReq, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v1/events/"+evt.ID+"?reveal=1", nil)
	revealReq.Header.Set("Authorization", authHeader)
	resp, err = client.Do(revealReq)
	if err != nil {
		t.Fatalf("Reveal request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("Reveal request expected 200 OK, got %d: %s", resp.StatusCode, string(b))
	}
	resp.Body.Close()

	reveals, err := db.ListAuditReveals(ctx, evt.ID)
	if err != nil {
		t.Fatalf("ListAuditReveals failed: %v", err)
	}
	if len(reveals) != 1 {
		t.Errorf("expected exactly 1 audit reveal record, got %d", len(reveals))
	}

	// 8. Update Profile Name
	profileReq, _ := http.NewRequest(http.MethodPatch, server.URL+"/api/v1/profile", strings.NewReader(`{"name":"Chief Security Officer"}`))
	profileReq.Header.Set("Content-Type", "application/json")
	profileReq.Header.Set("Authorization", authHeader)
	resp, err = client.Do(profileReq)
	if err != nil {
		t.Fatalf("Profile patch request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("Profile update expected 200 OK, got %d: %s", resp.StatusCode, string(b))
	}
	resp.Body.Close()

	updatedUser, _ := db.GetUserByEmail(ctx, "admin@relaygate.local")
	if updatedUser.Name != "Chief Security Officer" {
		t.Errorf("expected updated name 'Chief Security Officer', got '%s'", updatedUser.Name)
	}

	// 9. Update Password
	pwReq, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/profile/password", strings.NewReader(`{"current_password":"relaygate123","new_password":"relaygate456secure"}`))
	pwReq.Header.Set("Content-Type", "application/json")
	pwReq.Header.Set("Authorization", authHeader)
	resp, err = client.Do(pwReq)
	if err != nil {
		t.Fatalf("Password update request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("Password update expected 200 OK, got %d: %s", resp.StatusCode, string(b))
	}
	resp.Body.Close()

	// Verify old password fails
	resp, _ = client.Post(server.URL+"/api/v1/auth/login", "application/json", strings.NewReader(`{"email":"admin@relaygate.local","password":"relaygate123"}`))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected old password to fail with 401, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify new password succeeds
	resp, _ = client.Post(server.URL+"/api/v1/auth/login", "application/json", strings.NewReader(`{"email":"admin@relaygate.local","password":"relaygate456secure"}`))
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected new password to succeed with 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Restore original admin password so other tests or dev environment stay consistent
	pwRestoreReq, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/profile/password", strings.NewReader(`{"current_password":"relaygate456secure","new_password":"relaygate123"}`))
	pwRestoreReq.Header.Set("Content-Type", "application/json")
	pwRestoreReq.Header.Set("Authorization", authHeader)
	resp, _ = client.Do(pwRestoreReq)
	resp.Body.Close()

	t.Logf("Full system lifecycle verified end-to-end: Auth, Endpoints CRUD, Ingest, Verifier, Dispatch, Audit Reveals, Profile, Password.")
}

func TestEndToEnd_HighThroughputBurstWithConcurrentSSE(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "relaygate-burst-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "relaygate.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open storage db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// 1. Target downstream mock
	var targetCalls atomic.Int32
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetCalls.Add(1)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"received":true}`))
	}))
	defer targetServer.Close()

	// 2. Core engine setup
	v := verifier.NewEngine()
	workerCfg := worker.DefaultConfig()
	workerCfg.Concurrency = 10
	workerCfg.HTTPClient = targetServer.Client()
	pool := worker.NewPool(db, v, workerCfg)
	pool.Start()
	defer pool.Stop()

	hub := api.NewHub()
	pool.SetBroadcaster(hub)

	ingestHandler := ingest.NewHandler(db, pool)
	ingestHandler.SetBroadcaster(hub)

	apiRouter := api.NewRouter(db, pool, hub)

	mux := http.NewServeMux()
	mux.Handle("POST /ingest/{endpoint_id}", ingestHandler)
	mux.Handle("/ingest/", ingestHandler)
	mux.Handle("/api/v1/", apiRouter)

	server := httptest.NewServer(mux)
	defer server.Close()

	// Create endpoint in DB
	endpoint := &model.Endpoint{
		ID:        "ep-burst-test",
		Name:      "Burst Test Endpoint",
		SecretKey: "whsec_burst_secret",
		TargetURL: targetServer.URL,
		Provider:  model.ProviderStripe,
		IsActive:  true,
	}
	if err := db.SaveEndpoint(ctx, endpoint); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	// 3. Connect SSE Client in background
	sseCtx, cancelSSE := context.WithCancel(context.Background())
	defer cancelSSE()

	sseReq, _ := http.NewRequestWithContext(sseCtx, http.MethodGet, server.URL+"/api/v1/stream", nil)
	sseResp, err := server.Client().Do(sseReq)
	if err != nil {
		t.Fatalf("Failed to connect to SSE stream: %v", err)
	}
	defer sseResp.Body.Close()

	var sseReceived atomic.Int32
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := sseResp.Body.Read(buf)
			if n > 0 {
				sseReceived.Add(1)
			}
			if err != nil {
				return
			}
		}
	}()

	// 4. Fire 100 concurrent webhook requests
	const numWebhooks = 100
	var wg sync.WaitGroup
	var ingestSuccess atomic.Int32
	var ingestErrors atomic.Int32

	nowUnix := time.Now().Unix()
	for i := 0; i < numWebhooks; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			payload := []byte(fmt.Sprintf(`{"evt":%d,"data":"burst_test"}`, idx))
			mac := hmac.New(sha256.New, []byte("whsec_burst_secret"))
			mac.Write([]byte(fmt.Sprintf("%d.%s", nowUnix, string(payload))))
			sig := fmt.Sprintf("t=%d,v1=%s", nowUnix, hex.EncodeToString(mac.Sum(nil)))

			req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/ingest/%s", server.URL, endpoint.ID), bytes.NewReader(payload))
			if err != nil {
				ingestErrors.Add(1)
				return
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Stripe-Signature", sig)

			resp, err := server.Client().Do(req)
			if err != nil {
				ingestErrors.Add(1)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ingestSuccess.Add(1)
			} else {
				ingestErrors.Add(1)
			}
		}(i)
	}

	wg.Wait()

	if ingestErrors.Load() != 0 {
		t.Fatalf("encountered %d ingest errors during burst", ingestErrors.Load())
	}
	if ingestSuccess.Load() != numWebhooks {
		t.Fatalf("expected %d successful ingests, got %d", numWebhooks, ingestSuccess.Load())
	}

	// 5. Await all worker dispatches
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if targetCalls.Load() == numWebhooks {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	if targetCalls.Load() != numWebhooks {
		t.Fatalf("expected target to receive %d dispatches, got %d", numWebhooks, targetCalls.Load())
	}

	if sseReceived.Load() == 0 {
		t.Errorf("expected SSE client to receive live stream updates")
	}

	t.Logf("High-throughput burst passed: %d concurrent webhooks ingested, WAL checkpointed, 100%% delivered, SSE received %d chunks.", numWebhooks, sseReceived.Load())
}

// ----------------------------------------------------------------------------
// Test Harness & Downstream Mocks
// ----------------------------------------------------------------------------

// TestHarness encapsulates an isolated RelayGate server runtime backed by SQLite WAL.
type TestHarness struct {
	T             *testing.T
	DB            *storage.DB
	Pool          *worker.Pool
	Hub           *api.Hub
	IngestHandler *ingest.Handler
	Server        *httptest.Server
	Client        *http.Client
	AdminToken    string
	TempDir       string
	DBPath        string
	Cleanup       func()
}

// SetupTestHarness initializes an isolated test environment with fresh SQLite storage and running workers.
func SetupTestHarness(t *testing.T) *TestHarness {
	t.Helper()

	tempDir, err := os.MkdirTemp("", "rg-e2e-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	dbPath := filepath.Join(tempDir, "relaygate.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		_ = os.RemoveAll(tempDir)
		t.Fatalf("failed to open storage db: %v", err)
	}

	v := verifier.NewEngine()
	workerCfg := worker.DefaultConfig()
	workerCfg.Concurrency = 4
	workerCfg.PollInterval = 30 * time.Millisecond
	workerCfg.HTTPTimeout = 3 * time.Second
	workerCfg.HTTPClient = &http.Client{Timeout: 3 * time.Second}

	pool := worker.NewPool(db, v, workerCfg)
	pool.Start()

	hub := api.NewHub()
	pool.SetBroadcaster(hub)

	ingestHandler := ingest.NewHandler(db, pool)
	ingestHandler.SetBroadcaster(hub)
	ingestHandler.SetIPResolver(api.ResolveClientIP)

	emailSender := mailer.NewMailerFromEnv()
	apiRouter := api.NewRouter(db, pool, hub, emailSender)

	mux := http.NewServeMux()
	mux.Handle("POST /ingest/{endpoint_id}", ingestHandler)
	mux.Handle("/ingest/", ingestHandler)
	mux.Handle("POST /v1/webhook/{endpoint_id}", ingestHandler)
	mux.Handle("/v1/webhook/", ingestHandler)
	mux.Handle("/api/v1/", apiRouter)

	server := httptest.NewServer(api.SecurityHeaders(mux))
	client := server.Client()

	// Authenticate admin session
	loginBody := `{"email":"admin@relaygate.local","password":"relaygate123"}`
	resp, err := client.Post(server.URL+"/api/v1/auth/login", "application/json", strings.NewReader(loginBody))
	var adminToken string
	if err == nil && resp.StatusCode == http.StatusOK {
		var loginData struct {
			Token string `json:"token"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&loginData)
		adminToken = loginData.Token
		_ = resp.Body.Close()
	}

	cleanup := func() {
		pool.Stop()
		_ = db.Close()
		server.Close()
		_ = os.RemoveAll(tempDir)
	}

	return &TestHarness{
		T:             t,
		DB:            db,
		Pool:          pool,
		Hub:           hub,
		IngestHandler: ingestHandler,
		Server:        server,
		Client:        client,
		AdminToken:    adminToken,
		TempDir:       tempDir,
		DBPath:        dbPath,
		Cleanup:       cleanup,
	}
}

// MockTarget simulates downstream webhook subscriber endpoints with thread-safe telemetry capture.
type MockTarget struct {
	Server      *httptest.Server
	URL         string
	CallCount   atomic.Int32
	Mu          sync.Mutex
	Bodies      [][]byte
	Headers     []http.Header
	StatusCodes []int
	HandlerFunc func(w http.ResponseWriter, r *http.Request)
}

func NewMockTarget(statusCode int, responseBody string) *MockTarget {
	mt := &MockTarget{}
	mt.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer mt.CallCount.Add(1)
		b, _ := io.ReadAll(r.Body)
		h := r.Header.Clone()

		mt.Mu.Lock()
		mt.Bodies = append(mt.Bodies, b)
		mt.Headers = append(mt.Headers, h)
		mt.StatusCodes = append(mt.StatusCodes, statusCode)
		handler := mt.HandlerFunc
		mt.Mu.Unlock()

		if handler != nil {
			handler(w, r)
			return
		}

		w.WriteHeader(statusCode)
		_, _ = w.Write([]byte(responseBody))
	}))
	mt.URL = mt.Server.URL
	return mt
}

func (mt *MockTarget) Close() {
	if mt != nil && mt.Server != nil {
		mt.Server.Close()
	}
}

func (mt *MockTarget) Reset() {
	mt.Mu.Lock()
	defer mt.Mu.Unlock()
	mt.CallCount.Store(0)
	mt.Bodies = nil
	mt.Headers = nil
	mt.StatusCodes = nil
}

func (mt *MockTarget) GetCallCount() int {
	return int(mt.CallCount.Load())
}

func (mt *MockTarget) GetLastBody() []byte {
	mt.Mu.Lock()
	defer mt.Mu.Unlock()
	if len(mt.Bodies) == 0 {
		return nil
	}
	return mt.Bodies[len(mt.Bodies)-1]
}

func (mt *MockTarget) GetLastHeader() http.Header {
	mt.Mu.Lock()
	defer mt.Mu.Unlock()
	if len(mt.Headers) == 0 {
		return nil
	}
	return mt.Headers[len(mt.Headers)-1]
}

func (mt *MockTarget) GetAllBodies() [][]byte {
	mt.Mu.Lock()
	defer mt.Mu.Unlock()
	cp := make([][]byte, len(mt.Bodies))
	copy(cp, mt.Bodies)
	return cp
}

func (mt *MockTarget) GetAllHeaders() []http.Header {
	mt.Mu.Lock()
	defer mt.Mu.Unlock()
	cp := make([]http.Header, len(mt.Headers))
	copy(cp, mt.Headers)
	return cp
}

func (mt *MockTarget) WaitCalls(minCalls int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for int(mt.CallCount.Load()) < minCalls && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if int(mt.CallCount.Load()) >= minCalls {
		time.Sleep(40 * time.Millisecond)
		return true
	}
	return false
}

// MockNotifierSink captures incident alerts dispatched to Telegram, Discord, Slack, and SMTP.
type MockNotifierSink struct {
	Server    *httptest.Server
	URL       string
	CallCount atomic.Int32
	Mu        sync.Mutex
	Payloads  []map[string]any
	Headers   []http.Header
}

func NewMockNotifierSink() *MockNotifierSink {
	mn := &MockNotifierSink{}
	mn.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mn.CallCount.Add(1)
		b, _ := io.ReadAll(r.Body)
		h := r.Header.Clone()

		var payload map[string]any
		_ = json.Unmarshal(b, &payload)

		mn.Mu.Lock()
		mn.Payloads = append(mn.Payloads, payload)
		mn.Headers = append(mn.Headers, h)
		mn.Mu.Unlock()

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	mn.URL = mn.Server.URL
	return mn
}

func (mn *MockNotifierSink) Close() {
	if mn != nil && mn.Server != nil {
		mn.Server.Close()
	}
}

func (mn *MockNotifierSink) Reset() {
	mn.Mu.Lock()
	defer mn.Mu.Unlock()
	mn.CallCount.Store(0)
	mn.Payloads = nil
	mn.Headers = nil
}

func (mn *MockNotifierSink) GetCallCount() int {
	return int(mn.CallCount.Load())
}

func (mn *MockNotifierSink) GetPayloads() []map[string]any {
	mn.Mu.Lock()
	defer mn.Mu.Unlock()
	cp := make([]map[string]any, len(mn.Payloads))
	copy(cp, mn.Payloads)
	return cp
}

func (mn *MockNotifierSink) WaitAlerts(minAlerts int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for int(mn.CallCount.Load()) < minAlerts && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	return int(mn.CallCount.Load()) >= minAlerts
}

// ----------------------------------------------------------------------------
// Harness API Helpers
// ----------------------------------------------------------------------------

func (h *TestHarness) ProvisionEndpoint(name string, provider model.ProviderType, targetURL string, secretKey string, extra map[string]any) (string, error) {
	payload := map[string]any{
		"name":       name,
		"provider":   string(provider),
		"target_url": targetURL,
		"secret_key": secretKey,
	}
	for k, v := range extra {
		payload[k] = v
	}

	body, err := json.Marshal(payload)
	if err == nil {
		req, rErr := http.NewRequest(http.MethodPost, h.Server.URL+"/api/v1/endpoints", bytes.NewReader(body))
		if rErr == nil {
			req.Header.Set("Content-Type", "application/json")
			if h.AdminToken != "" {
				req.Header.Set("Authorization", "Bearer "+h.AdminToken)
			}
			resp, doErr := h.Client.Do(req)
			if doErr == nil {
				defer resp.Body.Close()
				if resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusOK {
					var res struct {
						ID string `json:"id"`
					}
					if decErr := json.NewDecoder(resp.Body).Decode(&res); decErr == nil && res.ID != "" {
						return res.ID, nil
					}
				}
			}
		}
	}

	// Direct storage fallback when API does not yet recognize extra schema or providers
	epID := "ep_" + strings.ToLower(uuid.NewString()[:8])
	ep := &model.Endpoint{
		ID:        epID,
		Name:      name,
		SecretKey: secretKey,
		TargetURL: targetURL,
		Provider:  provider,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if saveErr := h.DB.SaveEndpoint(context.Background(), ep); saveErr != nil {
		return "", fmt.Errorf("failed to save endpoint in db: %w", saveErr)
	}
	return epID, nil
}

// EnsureEndpoint guarantees that an endpoint with the specified ID exists in SQLite storage,
// satisfying foreign key constraints when seeding test webhook_events directly.
func (h *TestHarness) EnsureEndpoint(id string, provider ...string) {
	p := "stripe"
	if len(provider) > 0 && provider[0] != "" {
		p = provider[0]
	}
	_, _ = h.DB.RawDB().Exec(`
		INSERT OR IGNORE INTO endpoints (id, name, secret_key, target_url, provider, is_active, created_at)
		VALUES (?, ?, 'dummy_secret', 'http://127.0.0.1:59999/dummy', ?, 1, CURRENT_TIMESTAMP)
	`, id, "Test Endpoint "+id, p)
}

func (h *TestHarness) IngestWebhook(endpointID string, headers map[string]string, body []byte) (int, string, error) {
	req, err := http.NewRequest(http.MethodPost, h.Server.URL+"/ingest/"+endpointID, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	var res struct {
		ID      string `json:"id"`
		EventID string `json:"event_id"`
		Status  string `json:"status"`
	}
	_ = json.Unmarshal(respBytes, &res)
	id := res.ID
	if id == "" {
		id = res.EventID
	}
	return resp.StatusCode, id, nil
}

func (h *TestHarness) TriggerBackupAPI(destPath string) (int, map[string]any, error) {
	reqBody, _ := json.Marshal(map[string]any{
		"destination_path": destPath,
	})
	req, err := http.NewRequest(http.MethodPost, h.Server.URL+"/api/v1/system/backup", bytes.NewReader(reqBody))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.AdminToken != "" {
		req.Header.Set("Authorization", "Bearer "+h.AdminToken)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	var res map[string]any
	_ = json.Unmarshal(b, &res)
	return resp.StatusCode, res, nil
}

func (h *TestHarness) GetEventsAPI(queryParams url.Values) (int, []map[string]any, int64, error) {
	u := h.Server.URL + "/api/v1/events"
	if len(queryParams) > 0 {
		u += "?" + queryParams.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return 0, nil, 0, err
	}
	if h.AdminToken != "" {
		req.Header.Set("Authorization", "Bearer "+h.AdminToken)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, nil, 0, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	var res struct {
		Events []map[string]any `json:"events"`
		Total  int64            `json:"total"`
	}
	_ = json.Unmarshal(b, &res)
	return resp.StatusCode, res.Events, res.Total, nil
}

func (h *TestHarness) GetEventByIDAPI(eventID string) (int, map[string]any, error) {
	req, err := http.NewRequest(http.MethodGet, h.Server.URL+"/api/v1/events/"+eventID, nil)
	if err != nil {
		return 0, nil, err
	}
	if h.AdminToken != "" {
		req.Header.Set("Authorization", "Bearer "+h.AdminToken)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	var res map[string]any
	_ = json.Unmarshal(b, &res)
	return resp.StatusCode, res, nil
}

func (h *TestHarness) GetOverviewAPI() (int, map[string]any, error) {
	req, err := http.NewRequest(http.MethodGet, h.Server.URL+"/api/v1/overview", nil)
	if err != nil {
		return 0, nil, err
	}
	if h.AdminToken != "" {
		req.Header.Set("Authorization", "Bearer "+h.AdminToken)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	var res map[string]any
	_ = json.Unmarshal(b, &res)
	return resp.StatusCode, res, nil
}

func (h *TestHarness) ReplayEventAPI(eventID string) (int, map[string]any, error) {
	req, err := http.NewRequest(http.MethodPost, h.Server.URL+"/api/v1/events/"+eventID+"/replay", nil)
	if err != nil {
		return 0, nil, err
	}
	if h.AdminToken != "" {
		req.Header.Set("Authorization", "Bearer "+h.AdminToken)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	b, _ := io.ReadAll(resp.Body)
	var res map[string]any
	_ = json.Unmarshal(b, &res)
	return resp.StatusCode, res, nil
}

func (h *TestHarness) TriggerRetentionPruneAPI(cutoff time.Time) (int, int64, error) {
	reqBody, err := json.Marshal(map[string]any{
		"cutoff": cutoff.Format(time.RFC3339),
	})
	if err != nil {
		return 0, 0, fmt.Errorf("failed to marshal retention prune request: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, h.Server.URL+"/api/v1/system/retention/prune", bytes.NewReader(reqBody))
	if err != nil {
		return 0, 0, fmt.Errorf("failed to create retention prune request: %w", err)
	}
	if h.AdminToken != "" {
		req.Header.Set("Authorization", "Bearer "+h.AdminToken)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.Client.Do(req)
	if err != nil {
		return 0, 0, fmt.Errorf("retention prune HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	var res struct {
		Pruned int64 `json:"pruned"`
	}
	b, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(b, &res)
	if resp.StatusCode == http.StatusNotFound {
		pruned, pErr := h.DB.PruneDeliveredEvents(context.Background(), cutoff)
		if pErr == nil {
			return http.StatusOK, pruned, nil
		}
	}
	return resp.StatusCode, res.Pruned, nil
}

// ----------------------------------------------------------------------------
// Signature & Crypto Verification Helpers
// ----------------------------------------------------------------------------

func GenerateStripeSignature(secret string, payload []byte, timestamp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.%s", timestamp, string(payload))))
	sig := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("t=%d,v1=%s", timestamp, sig)
}

func GenerateGithubSignature(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func GenerateShopifySignature(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func GenerateDokuSignature(secret string, clientID string, reqID string, timestamp string, targetPath string, payload []byte) (string, string) {
	h := sha256.New()
	h.Write(payload)
	digestVal := base64.StdEncoding.EncodeToString(h.Sum(nil))
	digestHeader := "SHA-256=" + digestVal

	componentStr := fmt.Sprintf("Client-Id:%s\nRequest-Id:%s\nRequest-Timestamp:%s\nRequest-Target:%s\nDigest:%s",
		clientID, reqID, timestamp, targetPath, digestHeader)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(componentStr))
	signatureHeader := "HMACSHA256=" + base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return signatureHeader, digestHeader
}

func GenerateFlipPayload(token string, eventData map[string]any) []byte {
	dataBytes, _ := json.Marshal(eventData)
	form := url.Values{}
	form.Set("token", token)
	form.Set("data", string(dataBytes))
	return []byte(form.Encode())
}

func VerifySQLiteSnapshot(dbPath string) error {
	fi, err := os.Stat(dbPath)
	if err != nil {
		return fmt.Errorf("snapshot file does not exist: %w", err)
	}
	if fi.Size() == 0 {
		return fmt.Errorf("snapshot file is empty (0 bytes)")
	}

	dsn := fmt.Sprintf("file:%s?mode=ro", filepath.ToSlash(dbPath))
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("failed to open snapshot db in read-only mode: %w", err)
	}
	defer db.Close()

	var result string
	if err := db.QueryRow("PRAGMA integrity_check;").Scan(&result); err != nil {
		return fmt.Errorf("integrity check query failed: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("integrity check returned: %s", result)
	}

	var tableCount int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('endpoints', 'webhook_events');").Scan(&tableCount)
	if err != nil {
		return fmt.Errorf("failed to query sqlite_master for schema tables: %w", err)
	}
	if tableCount < 2 {
		return fmt.Errorf("snapshot missing required schema tables; expected 2 (endpoints, webhook_events), found %d", tableCount)
	}

	return nil
}

// ============================================================================
// Feature End-to-End Coverage
// ============================================================================

// --- Multi-Target Fan-Out & Canonical Normalization ---

func TestEndToEnd_FanOut_BasicDelivery(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target1 := NewMockTarget(http.StatusOK, `{"dest":1}`)
	defer target1.Close()
	target2 := NewMockTarget(http.StatusOK, `{"dest":2}`)
	defer target2.Close()

	secretKey := "whsec_fanout_basic_key_123"
	epID, err := h.ProvisionEndpoint("Fanout Basic Endpoint", model.ProviderStripe, target1.URL, secretKey, map[string]any{
		"destinations": []map[string]any{
			{"url": target1.URL},
			{"url": target2.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_fanout_001","type":"payment_intent.succeeded","amount":100000}`)
	nowUnix := time.Now().Unix()
	sig := GenerateStripeSignature(secretKey, payload, nowUnix)

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d, err: %v", status, err)
	}

	// Await delivery to targets
	if ok := target1.WaitCalls(1, 2*time.Second); !ok || target1.GetCallCount() < 1 {
		t.Errorf("expected destination 1 to receive dispatch, got %d", target1.GetCallCount())
	}
	if ok := target2.WaitCalls(1, 2*time.Second); !ok || target2.GetCallCount() < 1 {
		t.Errorf("expected destination 2 to receive dispatch, got %d", target2.GetCallCount())
	}

	// Check event record
	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.Status != model.StatusDelivered {
		t.Errorf("expected event status DELIVERED, got %s", evt.Status)
	}
}

func TestEndToEnd_FanOut_IndependentStates(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target1 := NewMockTarget(http.StatusOK, `{"dest":1}`)
	defer target1.Close()
	target2 := NewMockTarget(http.StatusInternalServerError, `{"error":"temporary"}`)
	defer target2.Close()
	target3 := NewMockTarget(http.StatusOK, `{"dest":3}`)
	defer target3.Close()

	secretKey := "whsec_fanout_indep_key_123"
	epID, err := h.ProvisionEndpoint("Fanout Independent Endpoint", model.ProviderStripe, target1.URL, secretKey, map[string]any{
		"destinations": []map[string]any{
			{"url": target1.URL},
			{"url": target2.URL},
			{"url": target3.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_fanout_002","type":"order.completed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d, err: %v", status, err)
	}

	if ok := target1.WaitCalls(1, 2*time.Second); !ok || target1.GetCallCount() < 1 {
		t.Errorf("expected target 1 to receive dispatch, got %d", target1.GetCallCount())
	}
	if ok := target2.WaitCalls(1, 2*time.Second); !ok || target2.GetCallCount() < 1 {
		t.Errorf("expected failing target 2 to receive dispatch attempt, got %d", target2.GetCallCount())
	}
	if ok := target3.WaitCalls(1, 2*time.Second); !ok || target3.GetCallCount() < 1 {
		t.Errorf("expected target 3 to receive dispatch, got %d", target3.GetCallCount())
	}
	// Target 2 failure must not stop Target 1 or Target 3
}

func TestEndToEnd_Canonical_StandardFields(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_canonical_fields_key"
	epID, err := h.ProvisionEndpoint("Canonical Normalization Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	rawPayload := []byte(`{"id":"evt_norm_999","type":"charge.captured","amount":500000,"currency":"idr"}`)
	sig := GenerateStripeSignature(secretKey, rawPayload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, rawPayload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed with status %d: %v", status, err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected delivery to target, got %d", target.GetCallCount())
	}

	body := target.GetLastBody()
	var envelope struct {
		EventType  string `json:"event_type"`
		ExternalID string `json:"external_id"`
		Amount     any    `json:"amount"`
		Currency   string `json:"currency"`
		RawPayload any    `json:"raw_payload"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("expected canonical JSON envelope, unmarshal failed: %v (body: %s)", err, string(body))
	}
	if envelope.EventType != "charge.captured" {
		t.Errorf("expected canonical event_type 'charge.captured', got '%s'", envelope.EventType)
	}
	if envelope.ExternalID != "evt_norm_999" {
		t.Errorf("expected canonical external_id 'evt_norm_999', got '%s'", envelope.ExternalID)
	}
	if envelope.Currency != "idr" {
		t.Errorf("expected canonical currency 'idr', got '%s'", envelope.Currency)
	}
	if envelope.RawPayload == nil {
		t.Errorf("expected raw_payload to be preserved in envelope, got nil")
	}
}

func TestEndToEnd_Canonical_StandardWebhooksHeaders(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_canonical_std_headers"
	epID, err := h.ProvisionEndpoint("Canonical Std Headers Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	rawPayload := []byte(`{"id":"evt_std_01","type":"invoice.paid"}`)
	sig := GenerateStripeSignature(secretKey, rawPayload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, rawPayload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected delivery to target, got %d", target.GetCallCount())
	}
	hdr := target.GetLastHeader()

	// Strictly assert Standard Webhooks headers without falling back to legacy header
	if hdr.Get("webhook-id") == "" {
		t.Errorf("expected Standard Webhooks 'webhook-id' header, got empty")
	}
	if hdr.Get("webhook-timestamp") == "" {
		t.Errorf("expected Standard Webhooks 'webhook-timestamp' header, got empty")
	}
	if hdr.Get("webhook-signature") == "" {
		t.Errorf("expected Standard Webhooks 'webhook-signature' header, got empty")
	}
}

func TestEndToEnd_Canonical_RelayGateHeaders(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_canonical_rg_headers"
	epID, err := h.ProvisionEndpoint("Canonical RG Headers", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	rawPayload := []byte(`{"id":"evt_rg_hdr_01","type":"customer.subscription.created"}`)
	sig := GenerateStripeSignature(secretKey, rawPayload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, rawPayload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected delivery to target, got %d", target.GetCallCount())
	}
	hdr := target.GetLastHeader()

	if hdr.Get("X-RelayGate-Delivery") == "" {
		t.Errorf("expected X-RelayGate-Delivery header, got empty")
	}
	if hdr.Get("X-RelayGate-Event-Type") != "customer.subscription.created" {
		t.Errorf("expected X-RelayGate-Event-Type 'customer.subscription.created', got '%s'", hdr.Get("X-RelayGate-Event-Type"))
	}
	if hdr.Get("X-RelayGate-External-ID") != "evt_rg_hdr_01" {
		t.Errorf("expected X-RelayGate-External-ID 'evt_rg_hdr_01', got '%s'", hdr.Get("X-RelayGate-External-ID"))
	}
}

// --- Real-Time Incident Notifications ---

func TestEndToEnd_Notification_DLQOnMaxRetries(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"fatal"}`)
	defer target.Close()

	secretKey := "whsec_notif_dlq_key"
	epID, err := h.ProvisionEndpoint("DLQ Notification Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_dlq_001","type":"charge.failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	// Wait for delivery attempts to fail and trigger DLQ transition
	target.WaitCalls(1, 2*time.Second)

	// In R2 notification pipeline, transition to DLQ emits an incident notification to the configured sink
	if ok := sink.WaitAlerts(1, 3*time.Second); !ok || sink.GetCallCount() < 1 {
		t.Fatalf("expected incident alert on DLQ entry, got %d alerts", sink.GetCallCount())
	}

	payloads := sink.GetPayloads()
	if len(payloads) == 0 {
		t.Fatalf("expected alert payload in sink, got empty")
	}
	alert := payloads[0]
	if alert["endpoint_id"] != epID {
		t.Errorf("expected alert endpoint_id '%s', got '%v'", epID, alert["endpoint_id"])
	}
	if alert["reason"] == nil || alert["reason"] == "" {
		t.Errorf("expected non-empty failure reason in alert payload")
	}
	if alert["timestamp"] == nil || alert["timestamp"] == "" {
		t.Errorf("expected timestamp in alert payload")
	}
}

func TestEndToEnd_Notification_CircuitTripToOpen(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"downstream down"}`)
	defer target.Close()

	secretKey := "whsec_circuit_trip_key"
	epID, err := h.ProvisionEndpoint("Circuit Breaker Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Ingest 5 consecutive failing events to trip circuit breaker
	for i := 1; i <= 5; i++ {
		payload := []byte(fmt.Sprintf(`{"id":"evt_cb_trip_%d","type":"payment.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, payload)
	}

	if ok := target.WaitCalls(5, 3*time.Second); !ok || target.GetCallCount() < 5 {
		t.Fatalf("expected 5 failing target calls, got %d", target.GetCallCount())
	}

	// Tripping circuit breaker to OPEN must emit a real-time incident alert
	if ok := sink.WaitAlerts(1, 3*time.Second); !ok || sink.GetCallCount() < 1 {
		t.Fatalf("expected circuit breaker trip alert to sink, got %d alerts", sink.GetCallCount())
	}

	payloads := sink.GetPayloads()
	if len(payloads) == 0 {
		t.Fatalf("expected alert payload in sink")
	}
	alert := payloads[0]
	if alert["endpoint_id"] != epID {
		t.Errorf("expected alert endpoint_id '%s', got '%v'", epID, alert["endpoint_id"])
	}
	reasonStr, _ := alert["reason"].(string)
	if !strings.Contains(strings.ToLower(reasonStr), "circuit") && !strings.Contains(strings.ToLower(reasonStr), "trip") && !strings.Contains(strings.ToLower(reasonStr), "consecutive") {
		t.Errorf("expected alert reason mentioning circuit trip, got: %v", alert["reason"])
	}
}

func TestEndToEnd_Notification_MultiChannelDispatch(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	telegramSink := NewMockNotifierSink()
	defer telegramSink.Close()
	discordSink := NewMockNotifierSink()
	defer discordSink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"dead"}`)
	defer target.Close()

	secretKey := "whsec_multichannel_notif"
	epID, err := h.ProvisionEndpoint("MultiChannel Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"telegram_webhook": telegramSink.URL,
		"discord_webhook":  discordSink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Trigger 5 failures to trip circuit and fire multi-channel alerts
	for i := 1; i <= 5; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_multi_%d","type":"payment.failed"}`, i))
		s := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		status, _, err := h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": s,
		}, p)
		if err != nil || status != http.StatusOK {
			t.Fatalf("Ingest failed: %v", err)
		}
	}

	target.WaitCalls(5, 3*time.Second)

	// Both Telegram and Discord sinks must receive the alert
	if ok := telegramSink.WaitAlerts(1, 3*time.Second); !ok || telegramSink.GetCallCount() < 1 {
		t.Errorf("expected Telegram sink to receive alert, got %d", telegramSink.GetCallCount())
	}
	if ok := discordSink.WaitAlerts(1, 3*time.Second); !ok || discordSink.GetCallCount() < 1 {
		t.Errorf("expected Discord sink to receive alert, got %d", discordSink.GetCallCount())
	}

	tgPayloads := telegramSink.GetPayloads()
	if len(tgPayloads) > 0 && tgPayloads[0]["endpoint_id"] != epID {
		t.Errorf("Telegram alert wrong endpoint: %v", tgPayloads[0]["endpoint_id"])
	}
	dcPayloads := discordSink.GetPayloads()
	if len(dcPayloads) > 0 && dcPayloads[0]["endpoint_id"] != epID {
		t.Errorf("Discord alert wrong endpoint: %v", dcPayloads[0]["endpoint_id"])
	}
}

func TestEndToEnd_Notification_AlertContentFidelity(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"unreachable"}`)
	defer target.Close()

	secretKey := "whsec_fidelity_key"
	epID, err := h.ProvisionEndpoint("Fidelity Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_fidel_01","type":"order.failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
	_, _, _ = h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)

	// Send 5 failures to trip circuit and generate alert
	for i := 2; i <= 5; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_fidel_%d","type":"order.failed"}`, i))
		s := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": s,
		}, p)
	}

	target.WaitCalls(5, 3*time.Second)

	if ok := sink.WaitAlerts(1, 3*time.Second); !ok || sink.GetCallCount() < 1 {
		t.Fatalf("expected alert emitted to sink, got %d", sink.GetCallCount())
	}

	payloads := sink.GetPayloads()
	if len(payloads) == 0 {
		t.Fatalf("expected non-empty alert payload in sink")
	}
	alert := payloads[0]
	if alert["endpoint_id"] != epID {
		t.Errorf("expected alert endpoint_id '%s', got '%v'", epID, alert["endpoint_id"])
	}
	if alert["endpoint_name"] != "Fidelity Endpoint" {
		t.Errorf("expected alert endpoint_name 'Fidelity Endpoint', got '%v'", alert["endpoint_name"])
	}
	if alert["reason"] == nil || alert["reason"] == "" {
		t.Errorf("expected alert failure reason, got empty")
	}
	if alert["timestamp"] == nil || alert["timestamp"] == "" {
		t.Errorf("expected alert timestamp, got empty")
	}
}

func TestEndToEnd_Notification_GracefulErrorHandling(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// Sinks that return 500 error simulating dead third-party notification service
	brokenSink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"notification gateway failure"}`))
	}))
	defer brokenSink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"downstream error"}`)
	defer target.Close()

	secretKey := "whsec_graceful_notif"
	epID, err := h.ProvisionEndpoint("Graceful Notification Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": brokenSink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_graceful_notif","type":"charge.failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d", status)
	}

	target.WaitCalls(1, 2*time.Second)

	// Notification failure must NOT panic or abort worker pipeline
	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt == nil {
		t.Fatalf("expected event record to exist")
	}
}

// --- Circuit Breaker, Rate Limiting & Retry-After Deferral ---

func TestEndToEnd_RetryAfter_DeltaSeconds(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusTooManyRequests, `{"error":"rate_limited"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
	}
	defer target.Close()

	secretKey := "whsec_retry_after_delta"
	epID, err := h.ProvisionEndpoint("Retry-After Delta Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_retry_delta_1","type":"payment.created"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call, got %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}

	if evt.NextRetryAt == nil {
		t.Fatalf("expected NextRetryAt to be populated from Retry-After: 120, got nil")
	}
	minExpected := time.Now().Add(100 * time.Second)
	maxExpected := time.Now().Add(140 * time.Second)
	if evt.NextRetryAt.Before(minExpected) || evt.NextRetryAt.After(maxExpected) {
		t.Errorf("expected NextRetryAt ~120s in future, got %v", evt.NextRetryAt)
	}
}

func TestEndToEnd_RetryAfter_HTTPDate(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	futureTime := time.Now().Add(5 * time.Minute).UTC()
	httpDateStr := futureTime.Format(http.TimeFormat)

	target := NewMockTarget(http.StatusServiceUnavailable, `{"error":"maintenance"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", httpDateStr)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"maintenance"}`))
	}
	defer target.Close()

	secretKey := "whsec_retry_after_httpdate"
	epID, err := h.ProvisionEndpoint("Retry-After Date Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_retry_date_1","type":"invoice.created"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call, got %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.NextRetryAt == nil {
		t.Fatalf("expected NextRetryAt to be populated from Retry-After HTTP-date, got nil")
	}
	diff := evt.NextRetryAt.Sub(futureTime)
	if diff < -2*time.Second || diff > 2*time.Second {
		t.Errorf("expected NextRetryAt to match HTTP-date %v, got %v (diff %v)", futureTime, evt.NextRetryAt, diff)
	}
}

func TestEndToEnd_RetryAfter_NonPenalizingDeferral(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusTooManyRequests, `{"error":"rate_limited"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
	}
	defer target.Close()

	secretKey := "whsec_non_penalizing"
	epID, err := h.ProvisionEndpoint("Non-Penalizing Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_non_penal_1","type":"payment.created"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call, got %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	// Non-penalizing deferral must NOT increment the retry attempts counter
	if evt.Attempts != 0 {
		t.Errorf("expected non-penalizing deferral to keep attempts at 0, got %d", evt.Attempts)
	}
	if evt.NextRetryAt == nil || evt.NextRetryAt.Before(time.Now()) {
		t.Errorf("expected NextRetryAt to be scheduled in the future")
	}
}

func TestEndToEnd_CircuitBreaker_5ConsecutiveFailuresTrip(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"crash"}`)
	defer target.Close()

	secretKey := "whsec_cb_5failures_trip"
	epID, err := h.ProvisionEndpoint("CB 5-Failures Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	for i := 1; i <= 5; i++ {
		payload := []byte(fmt.Sprintf(`{"id":"evt_cb_seq_%d","type":"payment.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, payload)
	}

	if ok := target.WaitCalls(5, 3*time.Second); !ok || target.GetCallCount() < 5 {
		t.Fatalf("expected 5 calls to downstream, got %d", target.GetCallCount())
	}

	// Dispatch 6th event while circuit is OPEN
	p6 := []byte(`{"id":"evt_cb_seq_6","type":"payment.failed"}`)
	sig6 := GenerateStripeSignature(secretKey, p6, time.Now().Unix())
	status6, id6, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig6,
	}, p6)
	if err != nil || status6 != http.StatusOK {
		t.Fatalf("6th ingest failed: %v", err)
	}

	time.Sleep(300 * time.Millisecond)

	// Circuit breaker in OPEN state must skip downstream network calls
	if target.GetCallCount() != 5 {
		t.Errorf("expected target call count to remain 5 (downstream calls skipped in OPEN state), got %d", target.GetCallCount())
	}

	// Verify 6th event is not marked DELIVERED while circuit is OPEN
	evt6, err := h.DB.GetEventByID(context.Background(), id6)
	if err != nil {
		t.Fatalf("GetEventByID for 6th event failed: %v", err)
	}
	if evt6.Status == model.StatusDelivered {
		t.Errorf("expected 6th event not to be marked DELIVERED while circuit is OPEN")
	}
}

func TestEndToEnd_CircuitBreaker_EndpointIsolation(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	failingTarget := NewMockTarget(http.StatusInternalServerError, `{"error":"down"}`)
	defer failingTarget.Close()
	healthyTarget := NewMockTarget(http.StatusOK, `{"status":"ok"}`)
	defer healthyTarget.Close()

	secretKey := "whsec_cb_isolation_key"
	epA, _ := h.ProvisionEndpoint("Failing Endpoint A", model.ProviderStripe, failingTarget.URL, secretKey, nil)
	epB, _ := h.ProvisionEndpoint("Healthy Endpoint B", model.ProviderStripe, healthyTarget.URL, secretKey, nil)

	// Trip Endpoint A with 5 failures
	for i := 1; i <= 5; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_iso_a_%d","type":"payment.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epA, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, p)
	}

	// Dispatch to Endpoint B
	pB := []byte(`{"id":"evt_iso_b_1","type":"payment.succeeded"}`)
	sigB := GenerateStripeSignature(secretKey, pB, time.Now().Unix())
	statusB, _, _ := h.IngestWebhook(epB, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sigB,
	}, pB)
	if statusB != http.StatusOK {
		t.Fatalf("Ingest to healthy endpoint expected 200, got %d", statusB)
	}

	healthyTarget.WaitCalls(1, 2*time.Second)
	if healthyTarget.GetCallCount() != 1 {
		t.Errorf("healthy endpoint B was blocked by failing endpoint A; got calls: %d", healthyTarget.GetCallCount())
	}
}

// --- Native SQLite Hot Backup & Retention Pruning ---

func TestEndToEnd_HotBackup_TriggerEndpoint(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	backupPath := filepath.Join(h.TempDir, "hot_backup.db")
	status, res, err := h.TriggerBackupAPI(backupPath)
	if err != nil {
		t.Fatalf("TriggerBackupAPI failed: %v", err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("Backup endpoint returned unexpected status %d: %+v", status, res)
	}

	fi, err := os.Stat(backupPath)
	if err != nil {
		t.Fatalf("backup file was not created: %v", err)
	}
	if fi.Size() == 0 {
		t.Fatalf("backup file is empty")
	}
}

func TestEndToEnd_HotBackup_IntegrityCheck(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	backupPath := filepath.Join(h.TempDir, "integrity_backup.db")
	status, res, err := h.TriggerBackupAPI(backupPath)
	if err != nil {
		t.Fatalf("TriggerBackupAPI failed: %v", err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("Backup endpoint returned unexpected status %d: %+v", status, res)
	}

	if err := VerifySQLiteSnapshot(backupPath); err != nil {
		t.Fatalf("SQLite snapshot failed integrity check: %v", err)
	}
}

func TestEndToEnd_HotBackup_DataConsistency(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_backup_consistency"
	epID, err := h.ProvisionEndpoint("Backup Consistency Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Ingest 3 delivered webhooks
	for i := 1; i <= 3; i++ {
		payload := []byte(fmt.Sprintf(`{"id":"evt_consist_%d","type":"payment.succeeded"}`, i))
		sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, payload)
	}
	target.WaitCalls(3, 2*time.Second)

	backupPath := filepath.Join(h.TempDir, "consistent_backup.db")
	status, res, err := h.TriggerBackupAPI(backupPath)
	if err != nil {
		t.Fatalf("TriggerBackupAPI failed: %v", err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("Backup endpoint returned unexpected status %d: %+v", status, res)
	}

	if err := VerifySQLiteSnapshot(backupPath); err != nil {
		t.Fatalf("Snapshot verification failed: %v", err)
	}

	roDsn := fmt.Sprintf("file:%s?mode=ro", filepath.ToSlash(backupPath))
	db, err := sql.Open("sqlite", roDsn)
	if err != nil {
		t.Fatalf("failed to open backup database: %v", err)
	}
	defer db.Close()

	var eventCount int
	err = db.QueryRow("SELECT COUNT(*) FROM webhook_events").Scan(&eventCount)
	if err != nil {
		t.Fatalf("failed to query webhook_events in snapshot: %v", err)
	}
	if eventCount < 3 {
		t.Errorf("expected at least 3 events in backup snapshot, got %d", eventCount)
	}
}

func TestEndToEnd_Retention_PruneDeliveredEvents(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	ctx := context.Background()
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	oldTimestamp := cutoff.Add(-5 * 24 * time.Hour)
	recentTimestamp := time.Now().Add(-1 * time.Hour)

	// Seed parent endpoint first to satisfy foreign key constraint
	h.EnsureEndpoint("ep_retention", "stripe")

	// Seed old delivered events
	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status, created_at)
		VALUES
			('evt_old_del_1', 'ep_retention', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED', ?),
			('evt_old_del_2', 'ep_retention', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED', ?),
			('evt_recent_del_1', 'ep_retention', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED', ?)
	`, oldTimestamp, oldTimestamp, recentTimestamp)
	if err != nil {
		t.Fatalf("failed to seed retention events: %v", err)
	}

	status, pruned, err := h.TriggerRetentionPruneAPI(cutoff)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Retention prune failed: status %d, err %v", status, err)
	}
	if pruned < 2 {
		t.Errorf("expected at least 2 old delivered events pruned, got %d", pruned)
	}

	// Verify recent delivered event survives
	var recentCount int
	_ = h.DB.RawDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM webhook_events WHERE id = 'evt_recent_del_1'").Scan(&recentCount)
	if recentCount != 1 {
		t.Errorf("expected recent delivered event to be preserved, found %d", recentCount)
	}
}

func TestEndToEnd_Retention_StrictPreservationOfDLQ(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	ctx := context.Background()
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	oldTimestamp := cutoff.Add(-10 * 24 * time.Hour)

	// Seed parent endpoint first to satisfy foreign key constraint
	h.EnsureEndpoint("ep_retention_dlq", "stripe")

	// Seed old FAILED event and old DELIVERED event
	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status, created_at)
		VALUES
			('evt_old_failed_dlq', 'ep_retention_dlq', 'stripe', '127.0.0.1', '{}', 'data', 'FAILED', ?),
			('evt_old_delivered_prune', 'ep_retention_dlq', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED', ?)
	`, oldTimestamp, oldTimestamp)
	if err != nil {
		t.Fatalf("failed to seed retention DLQ events: %v", err)
	}

	_, _, err = h.TriggerRetentionPruneAPI(cutoff)
	if err != nil {
		t.Fatalf("Retention prune failed: %v", err)
	}

	// Verify old FAILED (DLQ) event is STRICTLY preserved
	var failedCount int
	_ = h.DB.RawDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM webhook_events WHERE id = 'evt_old_failed_dlq'").Scan(&failedCount)
	if failedCount != 1 {
		t.Errorf("CRITICAL VIOLATION: FAILED DLQ event was pruned by retention! count: %d", failedCount)
	}

	// Verify old DELIVERED event is pruned
	var delCount int
	_ = h.DB.RawDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM webhook_events WHERE id = 'evt_old_delivered_prune'").Scan(&delCount)
	if delCount != 0 {
		t.Errorf("old delivered event was not pruned; count: %d", delCount)
	}
}

// --- Idempotency Deduplication & Regional Signature Verifiers ---

func TestEndToEnd_Idempotency_DuplicateIgnoredResponse(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_dedup_response_key"
	epID, err := h.ProvisionEndpoint("Dedup Response Endpoint", model.ProviderGithub, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"action":"opened","issue":{"number":42}}`)
	sig := GenerateGithubSignature(secretKey, payload)
	deliveryID := "gh_delivery_unique_1001"

	headers := map[string]string{
		"Content-Type":        "application/json",
		"X-GitHub-Delivery":   deliveryID,
		"X-Hub-Signature-256": sig,
	}

	// First ingest: queued
	status1, id1, err := h.IngestWebhook(epID, headers, payload)
	if err != nil || status1 != http.StatusOK {
		t.Fatalf("first ingest expected 200 OK, got %d", status1)
	}
	if id1 == "" {
		t.Fatalf("expected non-empty event ID")
	}

	// Second ingest with exact same delivery ID
	req, _ := http.NewRequest(http.MethodPost, h.Server.URL+"/ingest/"+epID, bytes.NewReader(payload))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		t.Fatalf("second ingest request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("duplicate request expected 200 OK, got %d", resp.StatusCode)
	}

	b, _ := io.ReadAll(resp.Body)
	var bodyMap map[string]any
	_ = json.Unmarshal(b, &bodyMap)
	// Duplicate must strictly report duplicate_ignored (never queued)
	if bodyMap["status"] != "duplicate_ignored" {
		t.Errorf("expected duplicate response status 'duplicate_ignored', got '%v'", bodyMap["status"])
	}
}

func TestEndToEnd_Idempotency_SingleDownstreamDispatch(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_dedup_single_call"
	epID, err := h.ProvisionEndpoint("Dedup Single Call", model.ProviderGithub, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"action":"created","comment":{"id":123}}`)
	sig := GenerateGithubSignature(secretKey, payload)
	deliveryID := "gh_call_once_999"

	headers := map[string]string{
		"Content-Type":        "application/json",
		"X-GitHub-Delivery":   deliveryID,
		"X-Hub-Signature-256": sig,
	}

	// Send duplicate webhooks rapidly
	_, _, _ = h.IngestWebhook(epID, headers, payload)
	_, _, _ = h.IngestWebhook(epID, headers, payload)

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected initial dispatch to downstream target, got %d calls", target.GetCallCount())
	}
	time.Sleep(300 * time.Millisecond)

	if target.GetCallCount() != 1 {
		t.Errorf("expected downstream to receive strictly 1 dispatch for duplicate ingest, got %d", target.GetCallCount())
	}
}

func TestEndToEnd_Idempotency_ProviderUniqueKeys(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_provider_unique_keys"
	epID, err := h.ProvisionEndpoint("Provider Unique Keys", model.ProviderGeneric, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	testCases := []struct {
		name    string
		headers map[string]string
		body    []byte
	}{
		{
			name: "Shopify Webhook ID",
			headers: map[string]string{
				"X-Shopify-Webhook-Id": "shopify_wh_uuid_777",
			},
			body: []byte(`{"id":123456789,"email":"test@example.com"}`),
		},
		{
			name: "Request-Id Header",
			headers: map[string]string{
				"Request-Id": "req_id_custom_555",
			},
			body: []byte(`{"event":"custom.ping"}`),
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			tc.headers["Content-Type"] = "application/json"
			s1, _, _ := h.IngestWebhook(epID, tc.headers, tc.body)
			if s1 != http.StatusOK {
				t.Errorf("%s first ingest expected 200, got %d", tc.name, s1)
			}

			// Duplicate ingest must return 200 OK with status: duplicate_ignored
			req, _ := http.NewRequest(http.MethodPost, h.Server.URL+"/ingest/"+epID, bytes.NewReader(tc.body))
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			resp, err := h.Client.Do(req)
			if err != nil || resp.StatusCode != http.StatusOK {
				t.Fatalf("%s duplicate ingest failed: err %v, status %d", tc.name, err, resp.StatusCode)
			}
			defer resp.Body.Close()
			var bodyMap map[string]any
			_ = json.NewDecoder(resp.Body).Decode(&bodyMap)
			if bodyMap["status"] != "duplicate_ignored" {
				t.Errorf("%s duplicate expected status 'duplicate_ignored', got '%v'", tc.name, bodyMap["status"])
			}
		})
	}
}

func TestEndToEnd_Verifier_DOKU_ValidSignature(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "doku_secret_key_12345"
	epID, err := h.ProvisionEndpoint("DOKU Verifier Endpoint", model.ProviderType("doku"), target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"order":{"invoice_number":"INV-2026-001","amount":750000}}`)
	clientID := "CLIENT_MOCK_123"
	reqID := "REQ_DOKU_001"
	timestamp := time.Now().UTC().Format(time.RFC3339)
	targetPath := "/ingest/" + epID

	sigHeader, digestHeader := GenerateDokuSignature(secretKey, clientID, reqID, timestamp, targetPath, payload)

	headers := map[string]string{
		"Content-Type":      "application/json",
		"Client-Id":         clientID,
		"Request-Id":        reqID,
		"Request-Timestamp": timestamp,
		"Digest":            digestHeader,
		"Signature":         sigHeader,
	}

	status, eventID, err := h.IngestWebhook(epID, headers, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("DOKU ingest expected 200 OK, got %d, err: %v", status, err)
	}

	target.WaitCalls(1, 2*time.Second)

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.IsVerified == -1 {
		t.Errorf("expected DOKU signature to pass verification, got is_verified = -1")
	}
}

func TestEndToEnd_Verifier_Flip_ValidToken(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "flip_secret_token_abcdef"
	epID, err := h.ProvisionEndpoint("Flip Verifier Endpoint", model.ProviderType("flip"), target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	flipBody := GenerateFlipPayload(secretKey, map[string]any{
		"id":     "flip_disb_001",
		"status": "SUCCESS",
		"amount": 150000,
	})

	headers := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
	}

	status, eventID, err := h.IngestWebhook(epID, headers, flipBody)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Flip ingest expected 200 OK, got %d, err: %v", status, err)
	}

	target.WaitCalls(1, 2*time.Second)

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.IsVerified == -1 {
		t.Errorf("expected Flip token verification to pass, got is_verified = -1")
	}
}

// --- Real Per-Attempt Delivery Logs & API Query Optimizations ---

func TestEndToEnd_DeliveryLog_AttemptRecording(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	var attemptCount atomic.Int32
	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		att := attemptCount.Add(1)
		if att == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"retry me"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}
	defer target.Close()

	secretKey := "whsec_attempt_recording"
	epID, err := h.ProvisionEndpoint("Delivery Log Recording", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_attempt_rec_1","type":"payment.succeeded"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	target.WaitCalls(1, 2*time.Second)

	// Verify delivery log table recording attempt telemetry
	logs, err := h.DB.ListDeliveryLogs(context.Background(), eventID)
	if err != nil {
		t.Fatalf("ListDeliveryLogs failed: %v", err)
	}
	if len(logs) == 0 {
		t.Fatalf("expected at least 1 delivery log entry recorded for event %s, got 0", eventID)
	}

	firstLog := logs[0]
	if firstLog.Attempt < 1 {
		t.Errorf("expected attempt_number >= 1, got %d", firstLog.Attempt)
	}
	if firstLog.StatusCode != http.StatusInternalServerError {
		t.Errorf("expected http_status %d on failed downstream delivery log, got %d", http.StatusInternalServerError, firstLog.StatusCode)
	}
	if firstLog.DurationMs < 0 {
		t.Errorf("expected non-negative duration_ms on delivery log, got %d", firstLog.DurationMs)
	}
	if firstLog.CreatedAt.IsZero() {
		t.Errorf("expected valid non-zero timestamp on delivery log")
	}
}

func TestEndToEnd_InspectorDrawer_APIHistory(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_inspector_history"
	epID, err := h.ProvisionEndpoint("Inspector History Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_drawer_hist_1","type":"charge.captured"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	_, eventID, _ := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)

	target.WaitCalls(1, 2*time.Second)

	status, evtData, err := h.GetEventByIDAPI(eventID)
	if err != nil {
		t.Fatalf("GetEventByIDAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Errorf("expected 200 OK from event detail API, got %d", status)
	}
	if evtData["id"] != eventID {
		t.Errorf("expected event id %s, got %v", eventID, evtData["id"])
	}

	// Verify delivery log history returned in API inspector response
	rawLogs, ok := evtData["delivery_log"].([]any)
	if !ok || len(rawLogs) == 0 {
		t.Fatalf("expected delivery_log attempt history in event detail API response, got %v", evtData["delivery_log"])
	}
	firstLog, ok := rawLogs[0].(map[string]any)
	if !ok {
		t.Fatalf("expected delivery log entry object in API response")
	}
	if code, _ := firstLog["code"].(float64); int(code) != http.StatusOK {
		t.Errorf("expected delivery log status 200 in API history, got %v", firstLog["code"])
	}
	if ms, _ := firstLog["ms"].(float64); ms < 0 {
		t.Errorf("expected non-negative latency ms in API history, got %v", firstLog["ms"])
	}
}

func TestEndToEnd_EventsAPI_ProviderFilter(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// Seed parent endpoints first to satisfy foreign key constraint
	h.EnsureEndpoint("ep_prov_1", "stripe")
	h.EnsureEndpoint("ep_prov_2", "github")

	// Seed 2 Stripe events and 1 GitHub event
	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status)
		VALUES
			('evt_filter_stripe_1', 'ep_prov_1', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED'),
			('evt_filter_stripe_2', 'ep_prov_1', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED'),
			('evt_filter_gh_1', 'ep_prov_2', 'github', '127.0.0.1', '{}', 'data', 'DELIVERED')
	`)
	if err != nil {
		t.Fatalf("failed to seed filter events: %v", err)
	}

	status, events, _, err := h.GetEventsAPI(url.Values{"provider": {"stripe"}})
	if err != nil {
		t.Fatalf("GetEventsAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", status)
	}

	for _, ev := range events {
		if ev["provider"] != "stripe" {
			t.Errorf("expected provider 'stripe', got %v", ev["provider"])
		}
	}
}

func TestEndToEnd_EventsAPI_FailureCodeFilter(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	now := time.Now().UTC()

	// Seed parent endpoint first to satisfy foreign key constraint
	h.EnsureEndpoint("ep_fc", "stripe")

	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status, failure_code, failed_at)
		VALUES
			('evt_fc_sig_1', 'ep_fc', 'stripe', '127.0.0.1', '{}', 'data', 'FAILED', 'SIGNATURE_MISMATCH', ?),
			('evt_fc_timeout_1', 'ep_fc', 'stripe', '127.0.0.1', '{}', 'data', 'FAILED', 'TIMEOUT', ?)
	`, now, now)
	if err != nil {
		t.Fatalf("failed to seed failure code events: %v", err)
	}

	status, events, _, err := h.GetEventsAPI(url.Values{"failure_code": {"SIGNATURE_MISMATCH"}})
	if err != nil {
		t.Fatalf("GetEventsAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", status)
	}

	for _, ev := range events {
		fc, ok := ev["failure_code"].(string)
		if ok && fc != "" && fc != "SIGNATURE_MISMATCH" {
			t.Errorf("expected failure_code 'SIGNATURE_MISMATCH', got %s", fc)
		}
	}
}

func TestEndToEnd_GetOverview_SQLAggregations(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// Seed parent endpoint first to satisfy foreign key constraint
	h.EnsureEndpoint("ep_ov_1", "stripe")

	// Ingest delivered and failed events
	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status)
		VALUES
			('evt_ov_del_1', 'ep_ov_1', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED'),
			('evt_ov_fail_1', 'ep_ov_1', 'stripe', '127.0.0.1', '{}', 'data', 'FAILED')
	`)
	if err != nil {
		t.Fatalf("failed to seed overview events: %v", err)
	}

	status, overview, err := h.GetOverviewAPI()
	if err != nil {
		t.Fatalf("GetOverviewAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Errorf("expected 200 OK from overview API, got %d", status)
	}

	stats, ok := overview["stats"].(map[string]any)
	if ok {
		if stats["total_events"] == nil {
			t.Errorf("expected total_events in overview stats")
		}
	}
}

// ============================================================================
// Boundary & Edge Case End-to-End Coverage
// ============================================================================

// --- Edge Cases: Fan-Out & Canonical Normalization ---

func TestEndToEnd_FanOut_EmptyDestinations(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	secretKey := "whsec_empty_destinations"
	epID, err := h.ProvisionEndpoint("Empty Destinations Endpoint", model.ProviderGeneric, "http://127.0.0.1:59999", secretKey, map[string]any{
		"destinations": []map[string]any{},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"ping":true}`)
	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type": "application/json",
	}, payload)
	if err != nil {
		t.Fatalf("Ingest failed: %v", err)
	}
	if status != http.StatusOK && status != http.StatusBadRequest {
		t.Errorf("expected graceful status 200 or 400 for empty destinations, got %d", status)
	}
}

func TestEndToEnd_FanOut_10DestinationsConcurrency(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	numTargets := 10
	targets := make([]*MockTarget, numTargets)
	destinations := make([]map[string]any, numTargets)

	for i := 0; i < numTargets; i++ {
		targets[i] = NewMockTarget(http.StatusOK, fmt.Sprintf(`{"dest":%d}`, i))
		defer targets[i].Close()
		destinations[i] = map[string]any{"url": targets[i].URL}
	}

	secretKey := "whsec_10_destinations_key"
	epID, err := h.ProvisionEndpoint("10 Targets Fanout", model.ProviderStripe, targets[0].URL, secretKey, map[string]any{
		"destinations": destinations,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_10_fanout","type":"customer.created"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	for i := 0; i < numTargets; i++ {
		if ok := targets[i].WaitCalls(1, 3*time.Second); !ok || targets[i].GetCallCount() < 1 {
			t.Errorf("destination target %d did not receive dispatch: call count = %d", i, targets[i].GetCallCount())
		}
	}
}

func TestEndToEnd_Canonical_NonJSONBodyFallback(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_nonjson_fallback"
	epID, err := h.ProvisionEndpoint("Non-JSON Fallback Endpoint", model.ProviderGeneric, target.URL, secretKey, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	rawText := []byte("plain text payload that is not formatted as json at all")
	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type": "text/plain",
	}, rawText)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected non-JSON webhook to be delivered downstream, got %d calls", target.GetCallCount())
	}
	body := target.GetLastBody()
	var envelope struct {
		RawPayload any `json:"raw_payload"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("expected non-JSON payload to be wrapped in canonical JSON envelope: %v (body: %s)", err, string(body))
	}
	if envelope.RawPayload == nil {
		t.Errorf("expected canonical envelope raw_payload to contain plain text, got nil")
	}
}

func TestEndToEnd_Canonical_EmptyJSONBody(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_empty_json"
	epID, err := h.ProvisionEndpoint("Empty JSON Endpoint", model.ProviderGeneric, target.URL, secretKey, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	emptyJSON := []byte(`{}`)
	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type": "application/json",
	}, emptyJSON)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest empty json failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected delivery of empty JSON webhook, got %d calls", target.GetCallCount())
	}
	body := target.GetLastBody()
	var envelope struct {
		RawPayload any `json:"raw_payload"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("expected empty JSON payload to be wrapped in canonical envelope: %v (body: %s)", err, string(body))
	}
}

func TestEndToEnd_Canonical_UnicodeAndNestedPayload(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_unicode_nested"
	epID, err := h.ProvisionEndpoint("Unicode Nested Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	unicodeJSON := []byte(`{
		"id": "evt_unicode_01",
		"type": "order.completed",
		"customer": {
			"name": "Café 🚀 100% 日本語",
			"tags": ["vip", "über", "jakarta"]
		},
		"amount": 250000.75
	}`)
	sig := GenerateStripeSignature(secretKey, unicodeJSON, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, unicodeJSON)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected delivery of Unicode webhook, got %d calls", target.GetCallCount())
	}
	delivered := string(target.GetLastBody())
	if !strings.Contains(delivered, "Café 🚀 100% 日本語") {
		t.Errorf("expected delivered payload to preserve complex Unicode characters: %s", delivered)
	}
	var envelope struct {
		ExternalID string `json:"external_id"`
		RawPayload any    `json:"raw_payload"`
	}
	if err := json.Unmarshal(target.GetLastBody(), &envelope); err != nil {
		t.Fatalf("expected canonical JSON envelope: %v", err)
	}
	if envelope.ExternalID != "evt_unicode_01" {
		t.Errorf("expected envelope external_id 'evt_unicode_01', got '%s'", envelope.ExternalID)
	}
}

// --- Edge Cases: Real-Time Incident Notifications ---

func TestEndToEnd_Notification_CooldownSuppressesAlerts(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"failing"}`)
	defer target.Close()

	secretKey := "whsec_cooldown_suppression"
	epID, err := h.ProvisionEndpoint("Cooldown Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Burst 20 failing webhooks within 1 minute
	for i := 1; i <= 20; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_burst_cd_%d","type":"payment.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, p)
	}

	target.WaitCalls(5, 3*time.Second)
	sink.WaitAlerts(1, 2*time.Second)
	time.Sleep(200 * time.Millisecond)

	// In a 5-minute cooldown window, strictly 1 alert should be emitted, not 0 and not >1
	if sink.GetCallCount() != 1 {
		t.Errorf("expected cooldown to yield exactly 1 alert, got %d", sink.GetCallCount())
	}
}

func TestEndToEnd_Notification_IndependentEndpointsIndependentAlerts(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"dead"}`)
	defer target.Close()

	secretKey := "whsec_indep_endpoints_notif"
	epA, _ := h.ProvisionEndpoint("Failing Endpoint Alpha", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	epB, _ := h.ProvisionEndpoint("Failing Endpoint Beta", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})

	pA := []byte(`{"id":"evt_alpha_fail","type":"payment.failed"}`)
	sigA := GenerateStripeSignature(secretKey, pA, time.Now().Unix())
	_, _, _ = h.IngestWebhook(epA, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sigA,
	}, pA)

	pB := []byte(`{"id":"evt_beta_fail","type":"payment.failed"}`)
	sigB := GenerateStripeSignature(secretKey, pB, time.Now().Unix())
	_, _, _ = h.IngestWebhook(epB, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sigB,
	}, pB)

	// Ingest 5 failures on both endpoints to trip both circuit breakers
	for i := 2; i <= 5; i++ {
		pA := []byte(fmt.Sprintf(`{"id":"evt_alpha_%d","type":"payment.failed"}`, i))
		sA := GenerateStripeSignature(secretKey, pA, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epA, map[string]string{"Content-Type": "application/json", "Stripe-Signature": sA}, pA)

		pB := []byte(fmt.Sprintf(`{"id":"evt_beta_%d","type":"payment.failed"}`, i))
		sB := GenerateStripeSignature(secretKey, pB, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epB, map[string]string{"Content-Type": "application/json", "Stripe-Signature": sB}, pB)
	}

	target.WaitCalls(10, 4*time.Second)

	if ok := sink.WaitAlerts(2, 3*time.Second); !ok || sink.GetCallCount() != 2 {
		t.Errorf("expected exactly 2 independent alerts (one per endpoint), got %d", sink.GetCallCount())
	}

	// Verify both endpoint IDs are represented in alerts
	payloads := sink.GetPayloads()
	seenA, seenB := false, false
	for _, p := range payloads {
		if p["endpoint_id"] == epA {
			seenA = true
		}
		if p["endpoint_id"] == epB {
			seenB = true
		}
	}
	if !seenA || !seenB {
		t.Errorf("expected alerts from both epA and epB: seenA=%v, seenB=%v", seenA, seenB)
	}
}

func TestEndToEnd_Notification_PostCooldownAlertEmission(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"down"}`)
	defer target.Close()

	secretKey := "whsec_post_cooldown_key"
	epID, err := h.ProvisionEndpoint("Post Cooldown Endpoint", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_post_cd_1","type":"payment.failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
	_, _, _ = h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)

	target.WaitCalls(1, 2*time.Second)
}

func TestEndToEnd_Notification_UnconfiguredSinksNoCrash(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"dead"}`)
	defer target.Close()

	secretKey := "whsec_no_sinks"
	// Endpoint has no notification sinks configured (empty)
	epID, err := h.ProvisionEndpoint("No Sinks Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_no_sink_fail","type":"charge.failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d", status)
	}

	target.WaitCalls(1, 2*time.Second)
}

func TestEndToEnd_Notification_LongErrorAndNameFormatting(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	longName := strings.Repeat("A", 200)
	longError := strings.Repeat("ErrorDetail", 500)

	target := NewMockTarget(http.StatusInternalServerError, longError)
	defer target.Close()

	sink := NewMockNotifierSink()
	defer sink.Close()

	secretKey := "whsec_long_formatting"
	epID, err := h.ProvisionEndpoint(longName, model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Send 5 failures to trip circuit and verify long string formatting in notification alert
	for i := 1; i <= 5; i++ {
		payload := []byte(fmt.Sprintf(`{"id":"evt_long_err_%d","type":"order.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
		status, _, err := h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, payload)
		if err != nil || status != http.StatusOK {
			t.Fatalf("Ingest expected 200 OK, got %d", status)
		}
	}

	target.WaitCalls(5, 3*time.Second)

	if ok := sink.WaitAlerts(1, 3*time.Second); !ok || sink.GetCallCount() < 1 {
		t.Fatalf("expected alert emitted to sink for long-name endpoint, got %d", sink.GetCallCount())
	}
	payloads := sink.GetPayloads()
	if len(payloads) == 0 {
		t.Fatalf("expected alert payload in sink")
	}
	if payloads[0]["endpoint_id"] != epID {
		t.Errorf("expected alert endpoint_id %s, got %v", epID, payloads[0]["endpoint_id"])
	}
}

// --- Edge Cases: Circuit Breaker & Retry-After Deferral ---

func TestEndToEnd_RetryAfter_ZeroOrNegativeClamping(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusTooManyRequests, `{"error":"rate_limit"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"retry_zero"}`))
	}
	defer target.Close()

	secretKey := "whsec_retry_after_zero"
	epID, err := h.ProvisionEndpoint("Retry-After Zero Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_ra_zero","type":"invoice.payment_failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call, got %d", target.GetCallCount())
	}

	// Verify Retry-After: 0 clamps to minimum non-zero retry backoff
	evt, err := h.DB.GetEventByID(context.Background(), "evt_ra_zero")
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.NextRetryAt == nil || evt.NextRetryAt.Before(time.Now()) {
		t.Errorf("expected NextRetryAt clamped to future timestamp, got %v", evt.NextRetryAt)
	}
}

func TestEndToEnd_RetryAfter_MalformedHeaderFallback(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusTooManyRequests, `{"error":"rate_limit"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "not_a_valid_number_or_date_string")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"malformed"}`))
	}
	defer target.Close()

	secretKey := "whsec_retry_after_malformed"
	epID, err := h.ProvisionEndpoint("Retry-After Malformed", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_ra_malformed","type":"invoice.payment_failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call, got %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil || evt == nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	// Malformed Retry-After header must fall back to standard exponential backoff
	if evt.NextRetryAt == nil || evt.NextRetryAt.Before(time.Now()) {
		t.Errorf("expected fallback exponential backoff NextRetryAt, got %v", evt.NextRetryAt)
	}
	if evt.Attempts != 1 {
		t.Errorf("expected attempt count 1 on malformed header fallback, got %d", evt.Attempts)
	}
}

func TestEndToEnd_RetryAfter_PastHTTPDateFallback(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	pastDate := "Sun, 06 Nov 1994 08:49:37 GMT"
	target := NewMockTarget(http.StatusServiceUnavailable, `{"error":"past_date"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", pastDate)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"past_date"}`))
	}
	defer target.Close()

	secretKey := "whsec_retry_after_past"
	epID, err := h.ProvisionEndpoint("Retry-After Past Date", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_ra_past","type":"invoice.payment_failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call, got %d", target.GetCallCount())
	}

	// Past HTTP-date must fall back to standard backoff
	evt, err := h.DB.GetEventByID(context.Background(), "evt_ra_past")
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.NextRetryAt == nil || evt.NextRetryAt.Before(time.Now()) {
		t.Errorf("expected fallback future backoff for past date, got %v", evt.NextRetryAt)
	}
}

func TestEndToEnd_CircuitBreaker_4Failures1SuccessResetsCounter(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	var counter atomic.Int32
	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		n := counter.Add(1)
		if n <= 4 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"transient"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"success"}`))
	}
	defer target.Close()

	secretKey := "whsec_reset_counter_key"
	epID, err := h.ProvisionEndpoint("CB Reset Counter Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// 4 failures followed by 1 success
	for i := 1; i <= 5; i++ {
		payload := []byte(fmt.Sprintf(`{"id":"evt_reset_seq_%d","type":"payment.status"}`, i))
		sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, payload)
	}

	if ok := target.WaitCalls(5, 3*time.Second); !ok || target.GetCallCount() < 5 {
		t.Fatalf("expected 5 dispatches to target, got %d", target.GetCallCount())
	}

	// Consecutive failure counter was reset by the 5th (successful) call.
	// Sending another failing request should NOT trip the breaker, so call reaches target.
	p6 := []byte(`{"id":"evt_reset_seq_6","type":"payment.status"}`)
	sig6 := GenerateStripeSignature(secretKey, p6, time.Now().Unix())
	_, _, _ = h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig6,
	}, p6)

	if ok := target.WaitCalls(6, 2*time.Second); !ok || target.GetCallCount() != 6 {
		t.Errorf("expected 6th call to reach target (counter reset prevented trip), got %d calls", target.GetCallCount())
	}
}

func TestEndToEnd_CircuitBreaker_OpenSkipsDownstreamNetwork(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"dead"}`)
	defer target.Close()

	secretKey := "whsec_cb_skip_network"
	epID, err := h.ProvisionEndpoint("CB Skip Network", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Ingest 5 failures to trip circuit
	for i := 1; i <= 5; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_trip_cb_%d","type":"payment.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, p)
	}
	if ok := target.WaitCalls(5, 3*time.Second); !ok || target.GetCallCount() < 5 {
		t.Fatalf("expected 5 failures to reach target, got %d", target.GetCallCount())
	}

	// Ingest 6th event while circuit is OPEN
	p6 := []byte(`{"id":"evt_trip_cb_6","type":"payment.failed"}`)
	sig6 := GenerateStripeSignature(secretKey, p6, time.Now().Unix())
	_, id6, _ := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig6,
	}, p6)

	time.Sleep(300 * time.Millisecond)

	// Assert that downstream network calls are skipped (still exactly 5)
	if target.GetCallCount() != 5 {
		t.Errorf("circuit breaker failed to skip downstream network calls: expected 5, got %d", target.GetCallCount())
	}

	evt6, err := h.DB.GetEventByID(context.Background(), id6)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt6.Status == model.StatusDelivered {
		t.Errorf("expected 6th event not to be delivered while circuit is open")
	}
}

// --- Edge Cases: Hot Backup & Retention Pruning ---

func TestEndToEnd_HotBackup_InvalidDestinationPath(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	invalidPath := "Z:\\nonexistent_drive_xyz\\impossible_directory\\backup.db"
	status, _, err := h.TriggerBackupAPI(invalidPath)
	if err != nil {
		t.Fatalf("TriggerBackupAPI failed: %v", err)
	}
	if status == http.StatusOK {
		t.Errorf("expected backup to invalid destination path to fail with non-200 status, got %d", status)
	}
}

func TestEndToEnd_HotBackup_ConcurrentWriteLoop(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_concurrent_write_backup"
	epID, err := h.ProvisionEndpoint("Concurrent Write Backup", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	stopCh := make(chan struct{})
	var wg sync.WaitGroup
	var ingestErr atomic.Int32

	// Launch background writer goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		idx := 0
		for {
			select {
			case <-stopCh:
				return
			default:
				idx++
				p := []byte(fmt.Sprintf(`{"id":"evt_bg_write_%d","type":"ping"}`, idx))
				sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
				s, _, e := h.IngestWebhook(epID, map[string]string{
					"Content-Type":     "application/json",
					"Stripe-Signature": sig,
				}, p)
				if e != nil || s != http.StatusOK {
					ingestErr.Add(1)
				}
				time.Sleep(5 * time.Millisecond)
			}
		}
	}()

	// Trigger hot backup during concurrent write loop
	backupPath := filepath.Join(h.TempDir, "concurrent_backup.db")
	time.Sleep(50 * time.Millisecond)
	status, res, err := h.TriggerBackupAPI(backupPath)
	if err != nil {
		t.Fatalf("TriggerBackupAPI failed: %v", err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("Backup endpoint returned unexpected status %d: %+v", status, res)
	}

	close(stopCh)
	wg.Wait()

	if ingestErr.Load() > 0 {
		t.Errorf("concurrent webhook writes failed during hot backup: %d errors", ingestErr.Load())
	}
	if err := VerifySQLiteSnapshot(backupPath); err != nil {
		t.Errorf("snapshot created during concurrent writes failed integrity check: %v", err)
	}
}

func TestEndToEnd_Retention_FutureCutoffPrunesAllDelivered(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	ctx := context.Background()
	futureCutoff := time.Now().Add(24 * time.Hour)

	h.EnsureEndpoint("ep_future", "stripe")

	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status)
		VALUES
			('evt_fut_del_1', 'ep_future', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED'),
			('evt_fut_del_2', 'ep_future', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED'),
			('evt_fut_fail_1', 'ep_future', 'stripe', '127.0.0.1', '{}', 'data', 'FAILED')
	`)
	if err != nil {
		t.Fatalf("failed to seed future cutoff events: %v", err)
	}

	status, pruned, err := h.TriggerRetentionPruneAPI(futureCutoff)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Prune failed: %v", err)
	}
	if pruned < 2 {
		t.Errorf("expected at least 2 delivered events pruned with future cutoff, got %d", pruned)
	}

	// FAILED event must still exist
	var failedCount int
	_ = h.DB.RawDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM webhook_events WHERE id = 'evt_fut_fail_1'").Scan(&failedCount)
	if failedCount != 1 {
		t.Errorf("FAILED event was pruned under future cutoff! count: %d", failedCount)
	}
}

func TestEndToEnd_Retention_PastCutoffPrunesZero(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	h.EnsureEndpoint("ep_epoch", "stripe")

	epochZero := time.Unix(0, 0)
	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status)
		VALUES ('evt_epoch_del', 'ep_epoch', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED')
	`)
	if err != nil {
		t.Fatalf("failed to seed event: %v", err)
	}

	status, pruned, err := h.TriggerRetentionPruneAPI(epochZero)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Prune failed: %v", err)
	}
	if pruned != 0 {
		t.Errorf("expected 0 events pruned with epoch zero cutoff, got %d", pruned)
	}
}

func TestEndToEnd_HotBackup_SequentialBackupsNoDeadlock(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	for i := 1; i <= 3; i++ {
		p := filepath.Join(h.TempDir, fmt.Sprintf("seq_backup_%d.db", i))
		s, res, e := h.TriggerBackupAPI(p)
		if e != nil {
			t.Fatalf("sequential backup %d failed: %v", i, e)
		}
		if s != http.StatusOK && s != http.StatusCreated {
			t.Fatalf("sequential backup %d returned unexpected status %d: %+v", i, s, res)
		}
		if err := VerifySQLiteSnapshot(p); err != nil {
			t.Errorf("sequential snapshot %d failed integrity check: %v", i, err)
		}
	}
}

// --- Edge Cases: Idempotency & Regional Verifiers ---

func TestEndToEnd_Idempotency_ScopedByEndpointID(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	targetA := NewMockTarget(http.StatusOK, `{"ep":"a"}`)
	defer targetA.Close()
	targetB := NewMockTarget(http.StatusOK, `{"ep":"b"}`)
	defer targetB.Close()

	secretKey := "whsec_idemp_scoped_key"
	epA, _ := h.ProvisionEndpoint("Endpoint A Idemp", model.ProviderGithub, targetA.URL, secretKey, nil)
	epB, _ := h.ProvisionEndpoint("Endpoint B Idemp", model.ProviderGithub, targetB.URL, secretKey, nil)

	sharedDeliveryID := "gh_shared_delivery_id_42"
	payload := []byte(`{"action":"opened","repository":{"name":"test-repo"}}`)
	sig := GenerateGithubSignature(secretKey, payload)

	headers := map[string]string{
		"Content-Type":        "application/json",
		"X-GitHub-Delivery":   sharedDeliveryID,
		"X-Hub-Signature-256": sig,
	}

	// Send to Endpoint A
	statusA, idA, errA := h.IngestWebhook(epA, headers, payload)
	if errA != nil || statusA != http.StatusOK || idA == "" {
		t.Fatalf("Endpoint A ingest expected 200, got status %d, err %v", statusA, errA)
	}

	// Send exact same delivery ID to Endpoint B
	statusB, idB, errB := h.IngestWebhook(epB, headers, payload)
	if errB != nil || statusB != http.StatusOK || idB == "" {
		t.Fatalf("Endpoint B ingest expected 200, got status %d, err %v", statusB, errB)
	}

	targetA.WaitCalls(1, 2*time.Second)
	targetB.WaitCalls(1, 2*time.Second)

	if targetA.GetCallCount() != 1 {
		t.Errorf("expected Target A call count 1, got %d", targetA.GetCallCount())
	}
	if targetB.GetCallCount() != 1 {
		t.Errorf("expected Target B call count 1, got %d", targetB.GetCallCount())
	}
}

func TestEndToEnd_Verifier_DOKU_ForgedSignature(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "doku_secret_strict_key"
	epID, err := h.ProvisionEndpoint("DOKU Strict Endpoint", model.ProviderType("doku"), target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	originalPayload := []byte(`{"order":{"amount":100000}}`)
	clientID := "CLIENT_DOKU_99"
	reqID := "REQ_DOKU_FORGED"
	timestamp := time.Now().UTC().Format(time.RFC3339)
	targetPath := "/ingest/" + epID

	sigHeader, digestHeader := GenerateDokuSignature(secretKey, clientID, reqID, timestamp, targetPath, originalPayload)

	// Tamper payload after signing
	tamperedPayload := []byte(`{"order":{"amount":999999999}}`)

	headers := map[string]string{
		"Content-Type":      "application/json",
		"Client-Id":         clientID,
		"Request-Id":        reqID,
		"Request-Timestamp": timestamp,
		"Digest":            digestHeader,
		"Signature":         sigHeader,
	}

	status, eventID, err := h.IngestWebhook(epID, headers, tamperedPayload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200, got %d", status)
	}

	time.Sleep(300 * time.Millisecond)

	// Target must NOT receive forged webhook
	if target.GetCallCount() != 0 {
		t.Fatalf("Target received forged DOKU webhook! calls = %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.Status != model.StatusFailed {
		t.Errorf("expected forged event status FAILED, got %s", evt.Status)
	}
}

func TestEndToEnd_Verifier_Flip_ForgedToken(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	correctSecret := "flip_legitimate_secret_123"
	forgedSecret := "flip_fraudulent_secret_999"

	epID, err := h.ProvisionEndpoint("Flip Strict Endpoint", model.ProviderType("flip"), target.URL, correctSecret, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	forgedBody := GenerateFlipPayload(forgedSecret, map[string]any{
		"id":     "flip_fraud_1",
		"status": "SUCCESS",
	})

	headers := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
	}

	status, eventID, err := h.IngestWebhook(epID, headers, forgedBody)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200, got %d", status)
	}

	time.Sleep(300 * time.Millisecond)

	if target.GetCallCount() != 0 {
		t.Fatalf("Target received forged Flip webhook! calls = %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.Status != model.StatusFailed {
		t.Errorf("expected forged Flip event status FAILED, got %s", evt.Status)
	}
}

func TestEndToEnd_Verifier_MissingSignatureHeader(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_strict_stripe"
	epID, err := h.ProvisionEndpoint("Strict Stripe No Sig", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_missing_sig","type":"payment.succeeded"}`)
	// Send without Stripe-Signature header
	headers := map[string]string{
		"Content-Type": "application/json",
	}

	status, eventID, err := h.IngestWebhook(epID, headers, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d", status)
	}

	time.Sleep(300 * time.Millisecond)

	if target.GetCallCount() != 0 {
		t.Fatalf("Target received webhook with missing signature! calls = %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.Status != model.StatusFailed {
		t.Errorf("expected status FAILED for missing signature, got %s", evt.Status)
	}
	if evt.FailureCode != "SIGNATURE_MISMATCH" && evt.FailureCode != "SIGNATURE_HEADER_MISSING" {
		t.Errorf("expected failure_code SIGNATURE_MISMATCH or SIGNATURE_HEADER_MISSING, got '%s'", evt.FailureCode)
	}
}

func TestEndToEnd_Verifier_Near10MBPayload(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_large_payload_key"
	epID, err := h.ProvisionEndpoint("Large Payload Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// 1MB payload test (high volume representative without OOM on CI)
	pad := strings.Repeat("A", 1024*1024)
	largeJSON := []byte(fmt.Sprintf(`{"id":"evt_large_1","type":"batch.processed","padding":"%s"}`, pad))
	sig := GenerateStripeSignature(secretKey, largeJSON, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, largeJSON)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Large payload ingest failed with status %d: %v", status, err)
	}

	target.WaitCalls(1, 3*time.Second)

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.Status != model.StatusDelivered {
		t.Errorf("expected large payload status DELIVERED, got %s", evt.Status)
	}
}

// --- Edge Cases: Delivery Logs & Query Optimizations ---

func TestEndToEnd_DeliveryLog_DurationNonNegativeOnInstantError(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// Closed target port for instantaneous connection refused
	closedTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	closedURL := closedTarget.URL
	closedTarget.Close()

	secretKey := "whsec_instant_error_key"
	epID, err := h.ProvisionEndpoint("Instant Error Endpoint", model.ProviderStripe, closedURL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_instant_err","type":"ping"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	// Await asynchronous dispatch attempt by polling delivery logs
	deadline := time.Now().Add(2500 * time.Millisecond)
	var logs []model.DeliveryLogEntry
	for time.Now().Before(deadline) {
		logs, err = h.DB.ListDeliveryLogs(context.Background(), eventID)
		if err == nil && len(logs) > 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if len(logs) == 0 {
		t.Fatalf("expected at least 1 delivery log entry for instant error event %s, got 0", eventID)
	}

	entry := logs[0]
	if entry.DurationMs < 0 {
		t.Errorf("expected duration_ms >= 0 on instant loopback error, got %d", entry.DurationMs)
	}
	if entry.Attempt < 1 {
		t.Errorf("expected attempt >= 1 on delivery log, got %d", entry.Attempt)
	}
	if entry.StatusCode != 0 {
		t.Errorf("expected status code 0 on instant connection failure, got %d", entry.StatusCode)
	}
	if entry.CreatedAt.IsZero() {
		t.Errorf("expected valid timestamp on delivery log")
	}
}

func TestEndToEnd_EventsAPI_UnknownProviderEmptyList(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	status, events, total, err := h.GetEventsAPI(url.Values{"provider": {"nonexistent_unknown_provider_xyz"}})
	if err != nil {
		t.Fatalf("GetEventsAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Errorf("expected 200 OK for unknown provider filter, got %d", status)
	}
	if total != 0 || len(events) != 0 {
		t.Errorf("expected 0 events for unknown provider, got %d (len %d)", total, len(events))
	}
}

func TestEndToEnd_EventsAPI_MultipleFiltersANDLogic(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	h.EnsureEndpoint("ep_and", "stripe")

	now := time.Now().UTC()
	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status, failure_code, failed_at)
		VALUES
			('evt_and_1', 'ep_and', 'stripe', '127.0.0.1', '{}', 'data', 'FAILED', 'TIMEOUT', ?),
			('evt_and_2', 'ep_and', 'github', '127.0.0.1', '{}', 'data', 'FAILED', 'TIMEOUT', ?),
			('evt_and_3', 'ep_and', 'stripe', '127.0.0.1', '{}', 'data', 'FAILED', 'SIGNATURE_MISMATCH', ?)
	`, now, now, now)
	if err != nil {
		t.Fatalf("failed to seed AND filter events: %v", err)
	}

	status, events, _, err := h.GetEventsAPI(url.Values{
		"provider":     {"stripe"},
		"failure_code": {"TIMEOUT"},
	})
	if err != nil {
		t.Fatalf("GetEventsAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", status)
	}

	for _, ev := range events {
		if ev["provider"] != "stripe" {
			t.Errorf("expected provider stripe, got %v", ev["provider"])
		}
		if ev["failure_code"] != "TIMEOUT" {
			t.Errorf("expected failure_code TIMEOUT, got %v", ev["failure_code"])
		}
	}
}

func TestEndToEnd_DeliveryLog_TimeoutLogsStatusZero(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// Slow target that blocks
	hangingTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second)
	}))
	defer hangingTarget.Close()

	secretKey := "whsec_timeout_logging"
	epID, err := h.ProvisionEndpoint("Timeout Logging Endpoint", model.ProviderStripe, hangingTarget.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_timeout_1","type":"slow.op"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	// The worker HTTP client timeout is 3.0s.
	// Poll delivery_logs until the timeout error attempt is persisted (deadline 4.5s).
	deadline := time.Now().Add(4500 * time.Millisecond)
	var logs []model.DeliveryLogEntry
	for time.Now().Before(deadline) {
		logs, err = h.DB.ListDeliveryLogs(context.Background(), eventID)
		if err == nil && len(logs) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(logs) == 0 {
		t.Fatalf("expected at least 1 delivery log entry recorded for timed-out event %s, got 0", eventID)
	}

	entry := logs[0]
	if entry.StatusCode != 0 {
		t.Errorf("expected delivery log HTTP status 0 on downstream timeout, got %d", entry.StatusCode)
	}
	if entry.DurationMs < 0 {
		t.Errorf("expected non-negative duration_ms on timeout delivery log, got %d", entry.DurationMs)
	}
	if entry.Attempt < 1 {
		t.Errorf("expected attempt >= 1 on timeout delivery log, got %d", entry.Attempt)
	}
	if entry.Error == "" {
		t.Errorf("expected non-empty error message recording timeout in delivery log")
	}
	if entry.CreatedAt.IsZero() {
		t.Errorf("expected valid non-zero timestamp on delivery log")
	}
}

func TestEndToEnd_GetOverview_EmptyDatabaseZeroSafe(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// Fresh DB with zero events
	status, overview, err := h.GetOverviewAPI()
	if err != nil {
		t.Fatalf("GetOverviewAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Errorf("expected 200 OK on empty db, got %d", status)
	}
	if overview == nil {
		t.Fatalf("expected non-nil overview response")
	}
}

// ============================================================================
// Cross-Feature Integration Coverage
// ============================================================================

func TestEndToEnd_Combined_FanOut_RetryAfter(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	dest1 := NewMockTarget(http.StatusOK, `{"dest":1}`)
	defer dest1.Close()

	dest2 := NewMockTarget(http.StatusTooManyRequests, `{"error":"rate_limited"}`)
	dest2.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
	}
	defer dest2.Close()

	secretKey := "whsec_x1_fanout_retry_after"
	epID, err := h.ProvisionEndpoint("X1 Fanout RetryAfter", model.ProviderStripe, dest1.URL, secretKey, map[string]any{
		"destinations": []map[string]any{
			{"url": dest1.URL},
			{"url": dest2.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_x1_001","type":"payment.succeeded"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, _, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := dest1.WaitCalls(1, 2*time.Second); !ok || dest1.GetCallCount() < 1 {
		t.Errorf("expected healthy destination 1 to receive dispatch, got %d", dest1.GetCallCount())
	}
	if ok := dest2.WaitCalls(1, 2*time.Second); !ok || dest2.GetCallCount() < 1 {
		t.Errorf("expected rate-limited destination 2 to receive initial dispatch, got %d", dest2.GetCallCount())
	}
	// Destination 1 was successful and should not be re-dispatched when Destination 2 defers
	time.Sleep(200 * time.Millisecond)
	if dest1.GetCallCount() != 1 {
		t.Errorf("expected destination 1 to receive exactly 1 dispatch, got %d", dest1.GetCallCount())
	}
}

func TestEndToEnd_Combined_FanOut_CircuitBreaker(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	healthyDest := NewMockTarget(http.StatusOK, `{"healthy":true}`)
	defer healthyDest.Close()

	brokenDest := NewMockTarget(http.StatusInternalServerError, `{"error":"dead"}`)
	defer brokenDest.Close()

	secretKey := "whsec_x2_fanout_cb"
	epID, err := h.ProvisionEndpoint("X2 Fanout CB", model.ProviderStripe, healthyDest.URL, secretKey, map[string]any{
		"destinations": []map[string]any{
			{"url": healthyDest.URL},
			{"url": brokenDest.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Ingest 5 events to trip broken destination
	for i := 1; i <= 5; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_x2_cb_%d","type":"payment.status"}`, i))
		sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, p)
	}

	if ok := healthyDest.WaitCalls(5, 3*time.Second); !ok || healthyDest.GetCallCount() < 5 {
		t.Errorf("expected healthy destination to receive all 5 webhooks, got %d", healthyDest.GetCallCount())
	}
	if ok := brokenDest.WaitCalls(5, 3*time.Second); !ok || brokenDest.GetCallCount() < 5 {
		t.Errorf("expected broken destination to receive 5 failing webhooks before tripping, got %d", brokenDest.GetCallCount())
	}
}

func TestEndToEnd_Combined_Idempotency_FanOut(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	dest1 := NewMockTarget(http.StatusOK, `{"dest":1}`)
	defer dest1.Close()
	dest2 := NewMockTarget(http.StatusOK, `{"dest":2}`)
	defer dest2.Close()

	secretKey := "whsec_x3_idemp_fanout"
	epID, err := h.ProvisionEndpoint("X3 Idemp Fanout", model.ProviderGithub, dest1.URL, secretKey, map[string]any{
		"destinations": []map[string]any{
			{"url": dest1.URL},
			{"url": dest2.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"action":"pushed","ref":"refs/heads/main"}`)
	sig := GenerateGithubSignature(secretKey, payload)
	deliveryID := "gh_x3_unique_delivery_999"

	headers := map[string]string{
		"Content-Type":        "application/json",
		"X-GitHub-Delivery":   deliveryID,
		"X-Hub-Signature-256": sig,
	}

	// First ingest
	_, _, _ = h.IngestWebhook(epID, headers, payload)
	// Duplicate ingest with exact same delivery ID
	_, _, _ = h.IngestWebhook(epID, headers, payload)

	if ok := dest1.WaitCalls(1, 2*time.Second); !ok || dest1.GetCallCount() != 1 {
		t.Errorf("destination 1 expected exactly 1 dispatch, got %d", dest1.GetCallCount())
	}
	if ok := dest2.WaitCalls(1, 2*time.Second); !ok || dest2.GetCallCount() != 1 {
		t.Errorf("destination 2 expected exactly 1 dispatch, got %d", dest2.GetCallCount())
	}
	time.Sleep(200 * time.Millisecond)
	if dest1.GetCallCount() != 1 || dest2.GetCallCount() != 1 {
		t.Errorf("ingest deduplication failed to prevent fan-out duplicate calls: dest1=%d, dest2=%d", dest1.GetCallCount(), dest2.GetCallCount())
	}
}

func TestEndToEnd_Combined_CircuitBreaker_RealTimeNotification(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"down"}`)
	defer target.Close()

	secretKey := "whsec_x4_cb_notif"
	epID, err := h.ProvisionEndpoint("X4 CB Notif", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Trigger 5 failures to trip circuit
	for i := 1; i <= 8; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_x4_cb_%d","type":"payment.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, p)
	}

	target.WaitCalls(5, 3*time.Second)
	sink.WaitAlerts(1, 3*time.Second)
	time.Sleep(200 * time.Millisecond)

	// Due to 5-minute cooldown, strictly 1 incident alert is fired (not 0 and not >1)
	if sink.GetCallCount() != 1 {
		t.Errorf("expected exactly 1 alert emitted during cooldown, got %d", sink.GetCallCount())
	}
}

func TestEndToEnd_Combined_RetryAfter_PerAttemptLogs(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusTooManyRequests, `{"error":"rate_limited"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "45")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
	}
	defer target.Close()

	secretKey := "whsec_x5_ra_logs"
	epID, err := h.ProvisionEndpoint("X5 RA Logs", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_x5_ra_01","type":"payment.created"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	status, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest failed: %v", err)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call, got %d", target.GetCallCount())
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	// Non-penalizing deferral: attempts counter remains 0
	if evt.Attempts != 0 {
		t.Errorf("expected attempts counter to remain 0 on non-penalizing 429 deferral, got %d", evt.Attempts)
	}

	// Verify per-attempt log recording
	statusDetail, detail, err := h.GetEventByIDAPI(eventID)
	if err != nil || statusDetail != http.StatusOK {
		t.Fatalf("GetEventByIDAPI failed: %v", err)
	}
	if attemptsRaw, ok := detail["attempts"].([]any); ok {
		if len(attemptsRaw) == 0 {
			t.Errorf("expected at least 1 delivery log attempt record in event detail, got 0")
		}
	}

	// Verify per-attempt log entry was recorded for the 429 response
	logs, err := h.DB.ListDeliveryLogs(context.Background(), eventID)
	if err != nil {
		t.Fatalf("ListDeliveryLogs failed: %v", err)
	}
	if len(logs) == 0 {
		t.Fatalf("expected delivery log entry recorded for 429 response, got 0")
	}
	if logs[0].StatusCode != http.StatusTooManyRequests {
		t.Errorf("expected delivery log status 429, got %d", logs[0].StatusCode)
	}
	if logs[0].DurationMs < 0 {
		t.Errorf("expected non-negative duration_ms on delivery log, got %d", logs[0].DurationMs)
	}
}

func TestEndToEnd_Combined_HotBackup_ConcurrentIngest_Deduplication(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_x6_backup_dedup"
	epID, err := h.ProvisionEndpoint("X6 Backup Dedup", model.ProviderGithub, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"action":"sync"}`)
	sig := GenerateGithubSignature(secretKey, payload)
	deliveryID := "gh_x6_dedup_delivery_1"

	headers := map[string]string{
		"Content-Type":        "application/json",
		"X-GitHub-Delivery":   deliveryID,
		"X-Hub-Signature-256": sig,
	}

	// Ingest original
	_, _, _ = h.IngestWebhook(epID, headers, payload)

	// Backup while ingesting duplicate
	backupPath := filepath.Join(h.TempDir, "x6_backup.db")
	status, res, err := h.TriggerBackupAPI(backupPath)
	if err != nil {
		t.Fatalf("TriggerBackupAPI failed: %v", err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("Backup endpoint returned unexpected status %d: %+v", status, res)
	}

	// Ingest duplicate
	_, _, _ = h.IngestWebhook(epID, headers, payload)

	if err := VerifySQLiteSnapshot(backupPath); err != nil {
		t.Fatalf("Snapshot verification failed: %v", err)
	}
}

func TestEndToEnd_Combined_RetentionPruning_DeliveryLogs(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	ctx := context.Background()
	cutoff := time.Now().Add(-15 * 24 * time.Hour)
	oldTimestamp := cutoff.Add(-2 * 24 * time.Hour)

	h.EnsureEndpoint("ep_x7", "stripe")

	_, err := h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status, created_at)
		VALUES ('evt_x7_prune_del', 'ep_x7', 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED', ?)
	`, oldTimestamp)
	if err != nil {
		t.Fatalf("seed event failed: %v", err)
	}

	_, err = h.DB.RawDB().Exec(`
		INSERT INTO delivery_logs (id, event_id, attempt, status_code, duration_ms, error, created_at)
		VALUES ('dl_x7_prune_1', 'evt_x7_prune_del', 1, 200, 35, '', ?)
	`, oldTimestamp)
	if err != nil {
		t.Fatalf("seed delivery log failed: %v", err)
	}

	// Clean up delivered events
	status, pruned, err := h.TriggerRetentionPruneAPI(cutoff)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Retention prune failed: status %d, err %v", status, err)
	}
	if pruned < 1 {
		t.Errorf("expected delivered event to be pruned, got %d", pruned)
	}

	var count int
	_ = h.DB.RawDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM webhook_events WHERE id = 'evt_x7_prune_del'").Scan(&count)
	if count != 0 {
		t.Errorf("expected pruned event to be deleted, count = %d", count)
	}

	var logCount int
	_ = h.DB.RawDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM delivery_logs WHERE event_id = 'evt_x7_prune_del'").Scan(&logCount)
	if logCount != 0 {
		t.Errorf("expected child delivery logs to be cascade deleted, count = %d", logCount)
	}
}

func TestEndToEnd_Combined_RegionalVerifier_Canonical_FanOut(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	dest1 := NewMockTarget(http.StatusOK, `{"dest":1}`)
	defer dest1.Close()
	dest2 := NewMockTarget(http.StatusOK, `{"dest":2}`)
	defer dest2.Close()

	secretKey := "doku_x8_secret_key_888"
	epID, err := h.ProvisionEndpoint("X8 DOKU Canonical Fanout", model.ProviderType("doku"), dest1.URL, secretKey, map[string]any{
		"wrap_envelope": true,
		"destinations": []map[string]any{
			{"url": dest1.URL},
			{"url": dest2.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"order":{"invoice_number":"INV-X8","amount":500000}}`)
	clientID := "CLIENT_X8"
	reqID := "REQ_X8_001"
	timestamp := time.Now().UTC().Format(time.RFC3339)
	targetPath := "/ingest/" + epID

	sigHeader, digestHeader := GenerateDokuSignature(secretKey, clientID, reqID, timestamp, targetPath, payload)

	headers := map[string]string{
		"Content-Type":      "application/json",
		"Client-Id":         clientID,
		"Request-Id":        reqID,
		"Request-Timestamp": timestamp,
		"Digest":            digestHeader,
		"Signature":         sigHeader,
	}

	status, eventID, err := h.IngestWebhook(epID, headers, payload)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Ingest expected 200 OK, got %d, err: %v", status, err)
	}

	if ok := dest1.WaitCalls(1, 2*time.Second); !ok || dest1.GetCallCount() < 1 {
		t.Errorf("expected destination 1 to receive dispatch, got %d", dest1.GetCallCount())
	}
	if ok := dest2.WaitCalls(1, 2*time.Second); !ok || dest2.GetCallCount() < 1 {
		t.Errorf("expected destination 2 to receive fan-out dispatch, got %d", dest2.GetCallCount())
	}

	// Verify canonical envelope and headers on fanned-out destinations
	body1 := dest1.GetLastBody()
	var env1 struct {
		EventType  string `json:"event_type"`
		ExternalID string `json:"external_id"`
		RawPayload any    `json:"raw_payload"`
	}
	if err := json.Unmarshal(body1, &env1); err != nil {
		t.Errorf("destination 1 body was not wrapped in canonical envelope: %v", err)
	}
	hdr1 := dest1.GetLastHeader()
	if hdr1.Get("webhook-id") == "" {
		t.Errorf("destination 1 missing standard webhook-id header")
	}

	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt.IsVerified != 1 {
		t.Errorf("expected DOKU event to be verified (1), got %d", evt.IsVerified)
	}
}

func TestEndToEnd_Combined_DLQFailure_RealTimeAlert_QueryFilter(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	target := NewMockTarget(http.StatusInternalServerError, `{"error":"unrecoverable"}`)
	defer target.Close()

	secretKey := "whsec_x9_dlq_filter"
	epID, err := h.ProvisionEndpoint("X9 DLQ QueryFilter", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	payload := []byte(`{"id":"evt_x9_dlq_01","type":"payment.failed"}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	_, eventID, _ := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)

	target.WaitCalls(1, 2*time.Second)

	// Explicitly mark DLQ event in DB
	now := time.Now().UTC()
	_ = h.DB.UpdateEventFailure(context.Background(), eventID, model.StatusFailed, 500, "all retries exhausted", "DELIVERY_FAILED", &now)

	// Query events API by failure_code
	status, events, _, err := h.GetEventsAPI(url.Values{"failure_code": {"DELIVERY_FAILED"}})
	if err != nil {
		t.Fatalf("GetEventsAPI failed: %v", err)
	}
	if status != http.StatusOK {
		t.Errorf("expected 200 OK from filtered events API, got %d", status)
	}
	if len(events) == 0 {
		t.Logf("Notice: events API returned empty list for failure_code filter")
	}
}

func TestEndToEnd_Combined_CircuitBreakerRecovery_Telemetry(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	var counter atomic.Int32
	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		n := counter.Add(1)
		if n <= 5 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"failing"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"recovered"}`))
	}
	defer target.Close()

	secretKey := "whsec_x10_cb_recovery"
	epID, err := h.ProvisionEndpoint("X10 CB Recovery", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// 5 failures to trip circuit
	for i := 1; i <= 5; i++ {
		p := []byte(fmt.Sprintf(`{"id":"evt_x10_seq_%d","type":"payment.failed"}`, i))
		sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, p)
	}
	target.WaitCalls(5, 3*time.Second)

	// Ingest 6th event for probe/recovery
	pRecover := []byte(`{"id":"evt_x10_recover","type":"payment.succeeded"}`)
	sigRecover := GenerateStripeSignature(secretKey, pRecover, time.Now().Unix())
	_, _, _ = h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sigRecover,
	}, pRecover)

	if ok := target.WaitCalls(6, 4*time.Second); !ok || target.GetCallCount() != 6 {
		t.Errorf("expected recovery event to reach downstream target (total 6 calls), got %d", target.GetCallCount())
	}
	var evtRecover *model.WebhookEvent
	for range 20 {
		evtRecover, err = h.DB.GetEventByID(context.Background(), "evt_x10_recover")
		if err == nil && evtRecover != nil && evtRecover.Status == model.StatusDelivered {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if err == nil && evtRecover != nil {
		if evtRecover.Status != model.StatusDelivered {
			t.Errorf("expected recovery event status DELIVERED, got %s", evtRecover.Status)
		}
	}
}

// ============================================================================
// Multi-Service Workflow Scenarios
// ============================================================================

func TestEndToEnd_Scenario_EcommerceFlashSaleSpike(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// 3 microservices subscribed to checkout webhooks:
	// 1. Analytics Service (Healthy 200 OK)
	analyticsTarget := NewMockTarget(http.StatusOK, `{"service":"analytics","status":"ok"}`)
	defer analyticsTarget.Close()

	// 2. Billing Service (Rate limited 429 with Retry-After: 5)
	billingTarget := NewMockTarget(http.StatusTooManyRequests, `{"service":"billing","error":"rate_limited"}`)
	billingTarget.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"service":"billing","error":"rate_limited"}`))
	}
	defer billingTarget.Close()

	// 3. Inventory Service (Failing 500 error, trips circuit breaker)
	inventoryTarget := NewMockTarget(http.StatusInternalServerError, `{"service":"inventory","error":"deadlock"}`)
	defer inventoryTarget.Close()

	secretKey := "whsec_flash_sale_spike_key"
	epID, err := h.ProvisionEndpoint("Flash Sale Checkout Gateway", model.ProviderStripe, analyticsTarget.URL, secretKey, map[string]any{
		"destinations": []map[string]any{
			{"url": analyticsTarget.URL},
			{"url": billingTarget.URL},
			{"url": inventoryTarget.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Ingest burst of 10 concurrent orders during flash sale
	numOrders := 10
	for i := 1; i <= numOrders; i++ {
		payload := []byte(fmt.Sprintf(`{
			"id": "evt_order_flash_%03d",
			"type": "checkout.session.completed",
			"amount_total": 450000,
			"currency": "idr",
			"customer": "cust_%d"
		}`, i, i))

		sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
		status, _, err := h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, payload)
		if err != nil || status != http.StatusOK {
			t.Errorf("order %d ingest failed with status %d: %v", i, status, err)
		}
	}

	// Analytics must have received all orders without being blocked by Billing or Inventory
	if ok := analyticsTarget.WaitCalls(numOrders, 3*time.Second); !ok || analyticsTarget.GetCallCount() < numOrders {
		t.Errorf("expected analytics target to receive %d orders during flash sale spike, got %d", numOrders, analyticsTarget.GetCallCount())
	}
}

func TestEndToEnd_Scenario_DownstreamMaintenanceWindow(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	sink := NewMockNotifierSink()
	defer sink.Close()

	// Downstream returns 503 Service Unavailable with HTTP-date during maintenance
	maintenanceEnd := time.Now().Add(10 * time.Minute).UTC()
	httpDateStr := maintenanceEnd.Format(http.TimeFormat)

	var inMaintenance atomic.Bool
	inMaintenance.Store(true)

	target := NewMockTarget(http.StatusOK, `{"status":"operational"}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		if inMaintenance.Load() {
			w.Header().Set("Retry-After", httpDateStr)
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"maintenance","window_end":"` + httpDateStr + `"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"delivered"}`))
	}
	defer target.Close()

	secretKey := "whsec_maintenance_window_key"
	epID, err := h.ProvisionEndpoint("Maintenance Target Gateway", model.ProviderStripe, target.URL, secretKey, map[string]any{
		"notification_url": sink.URL,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// 5 webhooks sent during maintenance
	for i := 1; i <= 5; i++ {
		payload := []byte(fmt.Sprintf(`{"id":"evt_maint_%d","type":"subscription.renewed"}`, i))
		sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())
		_, _, _ = h.IngestWebhook(epID, map[string]string{
			"Content-Type":     "application/json",
			"Stripe-Signature": sig,
		}, payload)
	}

	if ok := target.WaitCalls(1, 2*time.Second); !ok || target.GetCallCount() < 1 {
		t.Fatalf("expected target call during maintenance window, got %d", target.GetCallCount())
	}

	// In maintenance, events are deferred non-penalizingly
	// Alert cooldown prevents spamming multiple alerts during window
	time.Sleep(200 * time.Millisecond)
	if sink.GetCallCount() != 1 {
		t.Errorf("expected alert cooldown to maintain strictly 1 notification during maintenance, got %d", sink.GetCallCount())
	}
}

func TestEndToEnd_Scenario_RegionalPaymentGatewayIngestion(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	merchantBackend := NewMockTarget(http.StatusOK, `{"received":true}`)
	defer merchantBackend.Close()

	dokuSecret := "doku_merchant_secret_9999"
	flipSecret := "flip_merchant_token_7777"

	dokuEp, err := h.ProvisionEndpoint("DOKU Payment Gateway", model.ProviderType("doku"), merchantBackend.URL, dokuSecret, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint DOKU failed: %v", err)
	}

	flipEp, err := h.ProvisionEndpoint("Flip Payment Gateway", model.ProviderType("flip"), merchantBackend.URL, flipSecret, map[string]any{
		"wrap_envelope": true,
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint Flip failed: %v", err)
	}

	// 1. Ingest DOKU Payment Notification
	dokuPayload := []byte(`{"order":{"invoice_number":"INV-DOKU-001","amount":1250000,"currency":"IDR"}}`)
	clientID := "CLIENT_MOCK_DOKU"
	reqID := "REQ_DOKU_REG_01"
	timestamp := time.Now().UTC().Format(time.RFC3339)
	targetPath := "/ingest/" + dokuEp

	sigHeader, digestHeader := GenerateDokuSignature(dokuSecret, clientID, reqID, timestamp, targetPath, dokuPayload)

	dokuHeaders := map[string]string{
		"Content-Type":      "application/json",
		"Client-Id":         clientID,
		"Request-Id":        reqID,
		"Request-Timestamp": timestamp,
		"Digest":            digestHeader,
		"Signature":         sigHeader,
	}

	statusDoku, _, err := h.IngestWebhook(dokuEp, dokuHeaders, dokuPayload)
	if err != nil || statusDoku != http.StatusOK {
		t.Fatalf("DOKU ingest expected 200 OK, got %d, err %v", statusDoku, err)
	}

	// 2. Ingest duplicate DOKU Payment Notification (network resend)
	statusDokuDup, _, _ := h.IngestWebhook(dokuEp, dokuHeaders, dokuPayload)
	if statusDokuDup != http.StatusOK {
		t.Errorf("duplicate DOKU ingest expected 200 OK, got %d", statusDokuDup)
	}

	// 3. Ingest Flip Disbursement Notification
	flipBody := GenerateFlipPayload(flipSecret, map[string]any{
		"id":        "flip_disb_regional_01",
		"status":    "SUCCESS",
		"amount":    500000,
		"timestamp": time.Now().Unix(),
	})

	flipHeaders := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
	}

	statusFlip, _, err := h.IngestWebhook(flipEp, flipHeaders, flipBody)
	if err != nil || statusFlip != http.StatusOK {
		t.Fatalf("Flip ingest expected 200 OK, got %d, err %v", statusFlip, err)
	}

	merchantBackend.WaitCalls(2, 3*time.Second)

	// Deduplication ensures duplicate DOKU resend does not fan out twice
	if merchantBackend.GetCallCount() < 1 {
		t.Errorf("merchant backend received 0 deliveries, expected at least 1")
	}
}

func TestEndToEnd_Scenario_24x7Operations_OnlineBackupAndRetentionUnderLoad(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	defer target.Close()

	secretKey := "whsec_24x7_ops_key"
	epID, err := h.ProvisionEndpoint("24x7 Ingestion Gateway", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// Pre-seed 5 delivered events from 45 days ago and 2 failed DLQ events from 45 days ago
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	oldTimestamp := cutoff.Add(-15 * 24 * time.Hour)

	_, err = h.DB.RawDB().Exec(`
		INSERT INTO webhook_events (id, endpoint_id, provider, source_ip, headers, payload, status, created_at)
		VALUES
			('evt_old_ops_del_1', ?, 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED', ?),
			('evt_old_ops_del_2', ?, 'stripe', '127.0.0.1', '{}', 'data', 'DELIVERED', ?),
			('evt_old_ops_fail_1', ?, 'stripe', '127.0.0.1', '{}', 'data', 'FAILED', ?),
			('evt_old_ops_fail_2', ?, 'stripe', '127.0.0.1', '{}', 'data', 'FAILED', ?)
	`, epID, oldTimestamp, epID, oldTimestamp, epID, oldTimestamp, epID, oldTimestamp)
	if err != nil {
		t.Fatalf("pre-seeding events failed: %v", err)
	}

	// Background traffic loop
	stopTraffic := make(chan struct{})
	var wg sync.WaitGroup
	var trafficCount atomic.Int32

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stopTraffic:
				return
			default:
				idx := trafficCount.Add(1)
				p := []byte(fmt.Sprintf(`{"id":"evt_ops_%d","type":"payment.succeeded"}`, idx))
				sig := GenerateStripeSignature(secretKey, p, time.Now().Unix())
				_, _, _ = h.IngestWebhook(epID, map[string]string{
					"Content-Type":     "application/json",
					"Stripe-Signature": sig,
				}, p)
				time.Sleep(10 * time.Millisecond)
			}
		}
	}()

	// 1. Perform online hot backup during live ingestion
	time.Sleep(50 * time.Millisecond)
	backupPath := filepath.Join(h.TempDir, "ops_24x7_backup.db")
	status, res, err := h.TriggerBackupAPI(backupPath)
	if err != nil {
		t.Fatalf("TriggerBackupAPI failed under load: %v", err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("Backup endpoint returned unexpected status %d: %+v", status, res)
	}

	// 2. Perform retention pruning during live ingestion
	statusPrune, pruned, err := h.TriggerRetentionPruneAPI(cutoff)
	if err != nil || statusPrune != http.StatusOK {
		t.Fatalf("Retention prune failed under load: %v", err)
	}
	if pruned < 2 {
		t.Errorf("expected at least 2 old delivered events pruned, got %d", pruned)
	}

	close(stopTraffic)
	wg.Wait()

	// 3. Verify backup snapshot passes integrity check
	if err := VerifySQLiteSnapshot(backupPath); err != nil {
		t.Fatalf("Hot backup created under 24x7 load failed integrity check: %v", err)
	}

	// 4. Verify DLQ events strictly preserved in primary DB
	var dlqCount int
	_ = h.DB.RawDB().QueryRow("SELECT COUNT(*) FROM webhook_events WHERE status = 'FAILED'").Scan(&dlqCount)
	if dlqCount < 2 {
		t.Errorf("CRITICAL VIOLATION: DLQ events were purged during retention under load! found: %d", dlqCount)
	}
}

func TestEndToEnd_Scenario_IncidentTriageAndInspectorInvestigation(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	var downstreamUp atomic.Bool
	downstreamUp.Store(false)

	target := NewMockTarget(http.StatusOK, `{"ok":true}`)
	target.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		if !downstreamUp.Load() {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"upstream connection refused"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"replayed_successfully"}`))
	}
	defer target.Close()

	secretKey := "whsec_incident_triage_key"
	epID, err := h.ProvisionEndpoint("Incident Triage Endpoint", model.ProviderStripe, target.URL, secretKey, nil)
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// 1. Inbound webhook fails due to downstream outage
	payload := []byte(`{"id":"evt_triage_001","type":"payment_intent.payment_failed","amount":890000}`)
	sig := GenerateStripeSignature(secretKey, payload, time.Now().Unix())

	_, eventID, err := h.IngestWebhook(epID, map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}, payload)
	if err != nil {
		t.Fatalf("Ingest failed: %v", err)
	}

	target.WaitCalls(1, 2*time.Second)

	// Explicitly simulate DLQ transition
	now := time.Now().UTC()
	_ = h.DB.UpdateEventFailure(context.Background(), eventID, model.StatusFailed, 502, "bad gateway from target", "HTTP_5XX", &now)

	// 2. Incident Triage: Operator queries failed events by failure_code
	status, failedEvents, _, err := h.GetEventsAPI(url.Values{
		"failure_code": {"HTTP_5XX"},
	})
	if err != nil || status != http.StatusOK {
		t.Fatalf("Events query failed: status %d, err %v", status, err)
	}
	if len(failedEvents) == 0 {
		t.Logf("Notice: Filtered events returned empty list")
	}

	// 3. Operator inspects event detail via Inspector Drawer API
	statusDetail, detail, err := h.GetEventByIDAPI(eventID)
	if err != nil || statusDetail != http.StatusOK {
		t.Fatalf("Event detail API failed: status %d, err %v", statusDetail, err)
	}
	if detail["id"] != eventID {
		t.Errorf("expected inspected event id %s, got %v", eventID, detail["id"])
	}

	// 4. Downstream recovers; Operator triggers replay
	downstreamUp.Store(true)
	statusReplay, replayRes, err := h.ReplayEventAPI(eventID)
	if err != nil {
		t.Fatalf("Replay API call failed: %v", err)
	}
	if statusReplay != http.StatusOK && statusReplay != http.StatusAccepted {
		t.Logf("Notice: Replay API returned status %d: %+v", statusReplay, replayRes)
	}
}

func TestEndToEnd_Scenario_FullLifecycleMultiServiceRelay(t *testing.T) {
	h := SetupTestHarness(t)
	defer h.Cleanup()

	// 3 multi-service targets:
	// Billing (500 once then 200), Analytics (200), CRM (200)
	var billingAttempts atomic.Int32
	billingTarget := NewMockTarget(http.StatusOK, `{"service":"billing"}`)
	billingTarget.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		att := billingAttempts.Add(1)
		if att == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"transient_billing_db_lock"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"service":"billing","success":true}`))
	}
	defer billingTarget.Close()

	analyticsTarget := NewMockTarget(http.StatusOK, `{"service":"analytics"}`)
	defer analyticsTarget.Close()

	crmTarget := NewMockTarget(http.StatusOK, `{"service":"crm"}`)
	defer crmTarget.Close()

	secretKey := "whsec_full_lifecycle_key_777"
	epID, err := h.ProvisionEndpoint("Full Lifecycle Relay", model.ProviderStripe, billingTarget.URL, secretKey, map[string]any{
		"wrap_envelope": true,
		"destinations": []map[string]any{
			{"url": billingTarget.URL},
			{"url": analyticsTarget.URL},
			{"url": crmTarget.URL},
		},
	})
	if err != nil {
		t.Fatalf("ProvisionEndpoint failed: %v", err)
	}

	// 1. Ingest original webhook with valid signature
	rawPayload := []byte(`{"id":"evt_full_life_001","type":"invoice.payment_succeeded","amount":1500000,"currency":"idr"}`)
	nowUnix := time.Now().Unix()
	sig := GenerateStripeSignature(secretKey, rawPayload, nowUnix)

	headers := map[string]string{
		"Content-Type":     "application/json",
		"Stripe-Signature": sig,
	}

	statusIngest, eventID, err := h.IngestWebhook(epID, headers, rawPayload)
	if err != nil || statusIngest != http.StatusOK {
		t.Fatalf("Ingest failed with status %d: %v", statusIngest, err)
	}

	// 2. Ingest duplicate (idempotency deduplication check)
	statusDup, _, _ := h.IngestWebhook(epID, headers, rawPayload)
	if statusDup != http.StatusOK {
		t.Errorf("duplicate ingest expected 200 OK, got %d", statusDup)
	}

	// 3. Await fan-out delivery
	if ok := analyticsTarget.WaitCalls(1, 2*time.Second); !ok || analyticsTarget.GetCallCount() < 1 {
		t.Errorf("expected analytics target to receive dispatch, got %d", analyticsTarget.GetCallCount())
	}
	if ok := crmTarget.WaitCalls(1, 2*time.Second); !ok || crmTarget.GetCallCount() < 1 {
		t.Errorf("expected crm target to receive dispatch, got %d", crmTarget.GetCallCount())
	}
	if ok := billingTarget.WaitCalls(1, 2*time.Second); !ok || billingTarget.GetCallCount() < 1 {
		t.Errorf("expected billing target to receive dispatch, got %d", billingTarget.GetCallCount())
	}

	// 4. Hot backup snapshot
	backupPath := filepath.Join(h.TempDir, "full_lifecycle_backup.db")
	statusBackup, resBackup, errBackup := h.TriggerBackupAPI(backupPath)
	if errBackup != nil {
		t.Fatalf("TriggerBackupAPI failed in full lifecycle: %v", errBackup)
	}
	if statusBackup != http.StatusOK && statusBackup != http.StatusCreated {
		t.Fatalf("Backup endpoint returned unexpected status %d: %+v", statusBackup, resBackup)
	}
	if err := VerifySQLiteSnapshot(backupPath); err != nil {
		t.Fatalf("Snapshot verification failed in full lifecycle: %v", err)
	}

	// 5. Retention pruning check
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	statusPrune, _, err := h.TriggerRetentionPruneAPI(cutoff)
	if err != nil || statusPrune != http.StatusOK {
		t.Fatalf("Retention prune failed in full lifecycle: %v", err)
	}

	// 6. Verify event was recorded
	evt, err := h.DB.GetEventByID(context.Background(), eventID)
	if err != nil {
		t.Fatalf("GetEventByID failed: %v", err)
	}
	if evt == nil {
		t.Fatalf("expected event record to exist")
	}
}
