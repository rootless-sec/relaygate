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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/ingest"
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
