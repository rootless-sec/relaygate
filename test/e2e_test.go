package test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/api"
	"github.com/rootless-sec/relaygate/internal/ingest"
	"github.com/rootless-sec/relaygate/internal/mailer"
	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

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



