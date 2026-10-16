package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/storage"
	"github.com/rootless-sec/relaygate/internal/verifier"
	"github.com/rootless-sec/relaygate/internal/worker"
)

// A1: Sesi expiry absolut & idle dengan clock yang bisa di-inject, 401 dan baris dihapus, logout merevoke.
func TestCriteria_A1_SessionExpiryLifecycle(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	user := &model.User{
		ID:           "usr_a1_test",
		Name:         "A1 Tester",
		Email:        "a1@relaygate.local",
		Role:         "admin",
		PasswordHash: "hash",
		CreatedAt:    time.Now().UTC(),
	}
	_ = db.SaveUser(ctx, user)

	baseTime := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	currentTime := baseTime
	SetClock(func() time.Time { return currentTime })
	defer ResetClock()

	// Configure timeouts: 12h absolute, 30m idle
	SetSessionTimeouts(12*time.Hour, 30*time.Minute)
	defer ResetSessionTimeouts()

	router := NewRouter(db, nil, NewHub())

	// 1. Create session at baseTime
	sess := &model.Session{
		Token:        "sess_a1_active",
		UserID:       user.ID,
		UserEmail:    user.Email,
		Role:         user.Role,
		ExpiresAt:    baseTime.Add(12 * time.Hour),
		LastActiveAt: baseTime,
		CreatedAt:    baseTime,
	}
	if err := db.SaveSession(ctx, sess); err != nil {
		t.Fatalf("SaveSession failed: %v", err)
	}

	// 2. Request at baseTime + 10m -> OK, touches session
	currentTime = baseTime.Add(10 * time.Minute)
	req1 := httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil)
	req1.Header.Set("Authorization", "Bearer "+sess.Token)
	rec1 := httptest.NewRecorder()
	router.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("expected 200 OK at 10m, got %d", rec1.Code)
	}

	// Verify last_active_at was touched
	savedSess, err := db.GetSession(ctx, sess.Token)
	if err != nil || savedSess == nil {
		t.Fatalf("session missing after valid request: %v", err)
	}
	if !savedSess.LastActiveAt.Equal(currentTime) {
		t.Errorf("expected LastActiveAt %v, got %v", currentTime, savedSess.LastActiveAt)
	}

	// 3. Test Idle Expiry: advance time by 31 minutes without activity (to 10m + 31m = 41m)
	currentTime = baseTime.Add(41 * time.Minute)
	reqIdle := httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil)
	reqIdle.Header.Set("Authorization", "Bearer "+sess.Token)
	recIdle := httptest.NewRecorder()
	router.ServeHTTP(recIdle, reqIdle)

	if recIdle.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized for idle-expired session, got %d", recIdle.Code)
	}

	// Verify row was deleted from DB
	if _, err := db.GetSession(ctx, sess.Token); err == nil {
		t.Errorf("expected idle-expired session row to be deleted from DB, but it still exists")
	}

	// 4. Test Absolute Expiry: create session and advance beyond 12 hours
	sess2 := &model.Session{
		Token:        "sess_a1_abs",
		UserID:       user.ID,
		UserEmail:    user.Email,
		Role:         user.Role,
		ExpiresAt:    baseTime.Add(12 * time.Hour),
		LastActiveAt: baseTime.Add(11 * time.Hour + 50 * time.Minute),
		CreatedAt:    baseTime,
	}
	_ = db.SaveSession(ctx, sess2)

	currentTime = baseTime.Add(12*time.Hour + 1*time.Minute)
	reqAbs := httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil)
	reqAbs.Header.Set("Authorization", "Bearer "+sess2.Token)
	recAbs := httptest.NewRecorder()
	router.ServeHTTP(recAbs, reqAbs)

	if recAbs.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized for absolute-expired session, got %d", recAbs.Code)
	}
	if _, err := db.GetSession(ctx, sess2.Token); err == nil {
		t.Errorf("expected absolute-expired session row to be deleted from DB, but it still exists")
	}

	// 5. Logout revokes session
	sess3 := &model.Session{
		Token:        "sess_a1_logout",
		UserID:       user.ID,
		UserEmail:    user.Email,
		Role:         user.Role,
		ExpiresAt:    currentTime.Add(12 * time.Hour),
		LastActiveAt: currentTime,
		CreatedAt:    currentTime,
	}
	_ = db.SaveSession(ctx, sess3)

	reqLogout := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	reqLogout.Header.Set("Authorization", "Bearer "+sess3.Token)
	recLogout := httptest.NewRecorder()
	router.ServeHTTP(recLogout, reqLogout)
	if recLogout.Code != http.StatusOK {
		t.Errorf("expected 200 for logout, got %d", recLogout.Code)
	}
	if _, err := db.GetSession(ctx, sess3.Token); err == nil {
		t.Errorf("expected logged-out session to be deleted from DB, but it still exists")
	}
}

// A2: Cookie sesi HttpOnly, SameSite=Strict, Secure otomatis saat HTTPS / X-Forwarded-Proto dari trusted proxy, Path=/
func TestCriteria_A2_SessionCookieAttributes(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	adminUser := &model.User{
		ID:           "usr_admin_cookie",
		Name:         "Admin Cookie",
		Email:        "admin_cookie@relaygate.local",
		Role:         "admin",
		PasswordHash: "$2a$10$abcdefghijklmnopqrstuvwxyz123456789012345678901234567890",
		CreatedAt:    time.Now().UTC(),
	}
	_ = db.SaveUser(ctx, adminUser)

	router := NewRouter(db, nil, NewHub())

	// Plain HTTP login (no HTTPS, no proxy)
	loginBody, _ := json.Marshal(map[string]string{
		"email":    "admin@relaygate.local",
		"password": "relaygate123",
	})
	reqPlain := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody))
	reqPlain.Header.Set("Content-Type", "application/json")
	recPlain := httptest.NewRecorder()
	router.ServeHTTP(recPlain, reqPlain)

	if recPlain.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", recPlain.Code, recPlain.Body.String())
	}

	setCookieHeader := recPlain.Header().Get("Set-Cookie")
	if setCookieHeader == "" {
		t.Fatalf("expected Set-Cookie header on login, got none")
	}

	if !strings.Contains(setCookieHeader, "HttpOnly") {
		t.Errorf("expected HttpOnly in Set-Cookie: %s", setCookieHeader)
	}
	if !strings.Contains(setCookieHeader, "SameSite=Strict") {
		t.Errorf("expected SameSite=Strict in Set-Cookie: %s", setCookieHeader)
	}
	if !strings.Contains(setCookieHeader, "Path=/") {
		t.Errorf("expected Path=/ in Set-Cookie: %s", setCookieHeader)
	}
	if strings.Contains(setCookieHeader, "Secure") {
		t.Errorf("plain HTTP should NOT set Secure flag: %s", setCookieHeader)
	}

	// HTTPS login via trusted proxy (127.0.0.1) with X-Forwarded-Proto: https
	reqHTTPS := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody))
	reqHTTPS.Header.Set("Content-Type", "application/json")
	reqHTTPS.RemoteAddr = "127.0.0.1:45678"
	reqHTTPS.Header.Set("X-Forwarded-Proto", "https")
	recHTTPS := httptest.NewRecorder()
	router.ServeHTTP(recHTTPS, reqHTTPS)

	setCookieHTTPS := recHTTPS.Header().Get("Set-Cookie")
	if !strings.Contains(setCookieHTTPS, "Secure") {
		t.Errorf("expected Secure flag when behind trusted proxy with X-Forwarded-Proto: https, got: %s", setCookieHTTPS)
	}
	if !strings.Contains(setCookieHTTPS, "SameSite=Strict") {
		t.Errorf("expected SameSite=Strict in HTTPS Set-Cookie: %s", setCookieHTTPS)
	}

	// Also verify VerifyCode sets fixed SameSite=Strict without branching
	regBody, _ := json.Marshal(map[string]string{
		"name":     "Unverified User",
		"email":    "unverified@relaygate.local",
		"password": "relaygatepassword123",
	})
	reqReg := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewReader(regBody))
	reqReg.Header.Set("Content-Type", "application/json")
	recReg := httptest.NewRecorder()
	router.ServeHTTP(recReg, reqReg)
	if recReg.Code != http.StatusOK {
		t.Fatalf("register failed: %d %s", recReg.Code, recReg.Body.String())
	}
	var regResp struct {
		DevCode string `json:"dev_code"`
	}
	_ = json.Unmarshal(recReg.Body.Bytes(), &regResp)

	verifyBody, _ := json.Marshal(map[string]string{
		"email": "unverified@relaygate.local",
		"code":  regResp.DevCode,
	})
	reqVerify := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", bytes.NewReader(verifyBody))
	reqVerify.Header.Set("Content-Type", "application/json")
	recVerify := httptest.NewRecorder()
	router.ServeHTTP(recVerify, reqVerify)

	if recVerify.Code != http.StatusCreated {
		t.Fatalf("verify code failed: %d %s", recVerify.Code, recVerify.Body.String())
	}
	setCookieVerify := recVerify.Header().Get("Set-Cookie")
	if !strings.Contains(setCookieVerify, "SameSite=Strict") {
		t.Errorf("expected SameSite=Strict in VerifyCode Set-Cookie, got: %s", setCookieVerify)
	}
}

// A3: CSRF matriks lengkap
func TestCriteria_A3_CSRFMatrix(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_csrf_test",
		Name:      "test-csrf",
		TargetURL: "http://localhost:8080",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:             "ev-csrf-test",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"content-type": "application/json"},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "TIMEOUT",
		HTTPStatusCode: 504,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev)

	sess := &model.Session{
		Token:        "sess_csrf_token",
		UserID:       "usr_csrf",
		UserEmail:    "csrf@relaygate.local",
		Role:         "admin",
		ExpiresAt:    time.Now().UTC().Add(12 * time.Hour),
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	_ = db.SaveSession(ctx, sess)

	// Configure allowed origins
	SetAllowedOrigins([]string{"https://relaygate.example.com"})
	defer SetAllowedOrigins(nil)

	router := NewRouter(db, nil, NewHub())

	// Matrix 1: Same-origin with cookie -> 200 OK
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	req1.Host = "localhost:8080"
	req1.AddCookie(&http.Cookie{Name: "session", Value: sess.Token})
	req1.Header.Set("Origin", "http://localhost:8080")
	rec1 := httptest.NewRecorder()
	router.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Errorf("Matrix 1 (same-origin): expected 200 OK, got %d", rec1.Code)
	}

	// Matrix 2: Cross-origin with cookie -> 403 Forbidden
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	req2.Host = "localhost:8080"
	req2.AddCookie(&http.Cookie{Name: "session", Value: sess.Token})
	req2.Header.Set("Origin", "https://attacker.evil.com")
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusForbidden {
		t.Errorf("Matrix 2 (cross-origin): expected 403 Forbidden, got %d", rec2.Code)
	}

	// Matrix 3: Without Origin and Referer with cookie -> 403 Forbidden
	req3 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	req3.Host = "localhost:8080"
	req3.AddCookie(&http.Cookie{Name: "session", Value: sess.Token})
	rec3 := httptest.NewRecorder()
	router.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusForbidden {
		t.Errorf("Matrix 3 (no origin/referer): expected 403 Forbidden, got %d", rec3.Code)
	}

	// Matrix 4: Bearer token without cookie and without Origin -> 200 or 409 OK (not CSRF blocked)
	req4 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	req4.Host = "localhost:8080"
	req4.Header.Set("Authorization", "Bearer "+sess.Token)
	rec4 := httptest.NewRecorder()
	router.ServeHTTP(rec4, req4)
	if rec4.Code == http.StatusForbidden {
		t.Errorf("Matrix 4 (bearer without cookie): should not be blocked by CSRF (got 403)")
	}

	// Matrix 5: Behind trusted proxy with different Host OK if origin is in allowlist
	req5 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	req5.RemoteAddr = "127.0.0.1:54321" // Trusted proxy
	req5.Header.Set("X-Forwarded-Host", "internal-proxy.local")
	req5.AddCookie(&http.Cookie{Name: "session", Value: sess.Token})
	req5.Header.Set("Origin", "https://relaygate.example.com")
	rec5 := httptest.NewRecorder()
	router.ServeHTTP(rec5, req5)
	if rec5.Code == http.StatusForbidden {
		t.Errorf("Matrix 5 (allowed origin behind proxy): should be permitted (got 403)")
	}

	// Matrix 6: X-Forwarded-Host from untrusted peer is ignored
	req6 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	req6.RemoteAddr = "198.51.100.2:12345" // Untrusted external peer
	req6.Host = "relaygate.internal"
	req6.Header.Set("X-Forwarded-Host", "attacker.com")
	req6.AddCookie(&http.Cookie{Name: "session", Value: sess.Token})
	req6.Header.Set("Origin", "https://attacker.com")
	rec6 := httptest.NewRecorder()
	router.ServeHTTP(rec6, req6)
	if rec6.Code != http.StatusForbidden {
		t.Errorf("Matrix 6 (untrusted peer X-Forwarded-Host): expected 403 Forbidden, got %d", rec6.Code)
	}
}

// A4: Trusted proxy CIDR validation from env
func TestCriteria_A4_TrustedProxyCIDR(t *testing.T) {
	// Valid CIDRs and IPs
	err := SetTrustedProxies([]string{"127.0.0.1", "10.0.0.0/8", "::1"})
	if err != nil {
		t.Errorf("valid proxies should succeed: %v", err)
	}

	// Invalid CIDR must fail with clear error message
	errInvalid := SetTrustedProxies([]string{"127.0.0.1", "999.999.999.999/24"})
	if errInvalid == nil || !strings.Contains(errInvalid.Error(), "invalid trusted proxy") {
		t.Errorf("expected clear error on invalid CIDR, got %v", errInvalid)
	}

	// Reset back to loopback only
	_ = ResetTrustedProxies()
	if !IsTrustedProxy("127.0.0.1:1234") {
		t.Errorf("127.0.0.1 should be trusted loopback")
	}
	if IsTrustedProxy("10.1.2.3:1234") {
		t.Errorf("10.1.2.3 should NOT be trusted by default (loopback only)")
	}
}

// A5 & A6: Reveal Security (Fail closed on audit failure, headers masked on SSE, logs, responses)
type failingAuditRepo struct {
	storage.Repository
}

func (f *failingAuditRepo) SaveAuditReveal(ctx context.Context, audit *model.AuditReveal) error {
	return fmt.Errorf("database disk I/O error writing audit table")
}

func TestCriteria_A5_A6_RevealSecurity_FailClosed(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_test",
		Name:      "test-endpoint",
		TargetURL: "http://localhost:8080",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:             "ev-reveal-sec-test",
		EndpointID:     "ep_test",
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"x-callback-token": "super_secret_token_12345", "authorization": "Bearer sec123"},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "SIGNATURE_MISMATCH",
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev)

	sess := &model.Session{
		Token:        "sess_admin_reveal",
		UserID:       "usr_admin",
		UserEmail:    "admin@relaygate.local",
		Role:         "admin",
		ExpiresAt:    time.Now().UTC().Add(12 * time.Hour),
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	_ = db.SaveSession(ctx, sess)

	// Wrap repo with audit failure injector
	failingRepo := &failingAuditRepo{Repository: db}
	router := NewRouter(failingRepo, nil, NewHub())

	// Request reveal with failing audit write -> MUST FAIL CLOSED (500) and NOT reveal secrets
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID+"?reveal=1", nil)
	req.Header.Set("Authorization", "Bearer "+sess.Token)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("A6 Fail closed: expected 500 when audit write fails, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "super_secret_token_12345") {
		t.Fatalf("FATAL SECURITY BUG: sensitive header revealed despite audit write failure!")
	}

	// Normal router with working DB: verify SSE stream broadcast does NOT contain sensitive values
	hub := NewHub()
	normalRouter := NewRouter(db, nil, hub)
	sseReq := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
	sseRec := httptest.NewRecorder()
	sseCtx, sseCancel := context.WithCancel(context.Background())
	sseReq = sseReq.WithContext(sseCtx)

	done := make(chan struct{})
	go func() {
		normalRouter.ServeHTTP(sseRec, sseReq)
		close(done)
	}()
	time.Sleep(50 * time.Millisecond)

	// Broadcast event with secret headers
	hub.Broadcast("event_created", ev)
	time.Sleep(50 * time.Millisecond)
	sseCancel()
	<-done

	sseOutput := sseRec.Body.String()
	if strings.Contains(sseOutput, "super_secret_token_12345") || strings.Contains(sseOutput, "Bearer sec123") {
		t.Fatalf("FATAL SECURITY BUG: SSE stream broadcast leaked sensitive header values!")
	}
}

// A8: Masking table-driven test
func TestCriteria_A8_MaskingTableDriven(t *testing.T) {
	tests := []struct {
		name      string
		headerKey string
		sensitive bool
	}{
		{"exact authorization", "authorization", true},
		{"mixed case authorization", "Authorization", true},
		{"exact proxy-authorization", "proxy-authorization", true},
		{"exact cookie", "cookie", true},
		{"mixed case cookie", "Cookie", true},
		{"exact set-cookie", "set-cookie", true},
		{"mixed case set-cookie", "Set-Cookie", true},
		{"exact x-callback-token", "x-callback-token", true},
		{"exact x-api-key", "x-api-key", true},
		{"exact stripe-signature", "stripe-signature", true},
		{"prefix x-hub-signature", "x-hub-signature", true},
		{"prefix x-hub-signature-256", "x-hub-signature-256", true},
		{"keyword token", "my-app-token", true},
		{"keyword secret", "client-secret", true},
		{"keyword signature", "custom-signature-val", true},
		{"keyword auth", "x-custom-auth-hdr", true},
		{"keyword password", "user-password", true},
		{"keyword key", "api-access-key", true},
		{"safe content-type", "content-type", false},
		{"safe accept", "accept", false},
		{"safe user-agent", "user-agent", false},
		{"safe host", "host", false},
		{"safe x-request-id", "x-request-id", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isSensitiveHeader(tc.headerKey)
			if got != tc.sensitive {
				t.Errorf("isSensitiveHeader(%q) = %v; expected %v", tc.headerKey, got, tc.sensitive)
			}
		})
	}
}

// B1: attempts lifecycle: replay mereset ke 0; DELIVERED minimal 1; kuota habis = max; ditolak verifikasi = 0
func TestCriteria_B1_AttemptsLifecycle(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_b1_test",
		Name:      "b1-endpoint",
		TargetURL: "http://localhost:8080/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	// 1. Ditolak verifikasi: attempts = 0
	evRejected := &model.WebhookEvent{
		ID:             "ev-b1-rejected",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{},
		Payload:        []byte(`{}`),
		IsVerified:     -1,
		Status:         model.StatusFailed,
		FailureCode:    "SIGNATURE_HEADER_MISSING",
		Attempts:       0,
		MaxAttempts:    5,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, evRejected)

	storedRejected, _ := db.GetEventByID(ctx, evRejected.ID)
	if storedRejected.Attempts != 0 {
		t.Errorf("verification rejected event should have 0 attempts, got %d", storedRejected.Attempts)
	}

	// 2. Replay resets attempts to 0
	evFailed := &model.WebhookEvent{
		ID:             "ev-b1-failed",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{},
		Payload:        []byte(`{}`),
		IsVerified:     1,
		Status:         model.StatusFailed,
		FailureCode:    "HTTP_5XX",
		HTTPStatusCode: 500,
		Attempts:       5,
		MaxAttempts:    5,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, evFailed)

	router := NewRouter(db, nil, NewHub())
	reqReplay := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+evFailed.ID+"/replay", nil)
	recReplay := httptest.NewRecorder()
	router.ServeHTTP(recReplay, reqReplay)
	if recReplay.Code != http.StatusOK {
		t.Fatalf("replay failed: %d", recReplay.Code)
	}

	replayedEv, _ := db.GetEventByID(ctx, evFailed.ID)
	if replayedEv.Attempts != 0 {
		t.Errorf("replay should reset attempts to 0, got %d", replayedEv.Attempts)
	}
	if replayedEv.Status != model.StatusPending {
		t.Errorf("replay should transition status to PENDING, got %s", replayedEv.Status)
	}

	// 3. Worker delivery success after 2 retries (attempts = 3)
	// Simulate retry 1
	_ = db.IncrementAttempts(ctx, evFailed.ID, nil, "retry 1", 502)
	// Simulate retry 2
	_ = db.IncrementAttempts(ctx, evFailed.ID, nil, "retry 2", 502)

	afterRetries, _ := db.GetEventByID(ctx, evFailed.ID)
	if afterRetries.Attempts != 2 {
		t.Errorf("expected 2 attempts before success, got %d", afterRetries.Attempts)
	}

	// Success delivery on 3rd attempt
	_ = db.UpdateEventStatus(ctx, evFailed.ID, model.StatusDelivered, 200, "")
	afterSuccess, _ := db.GetEventByID(ctx, evFailed.ID)
	if afterSuccess.Attempts != 3 {
		t.Errorf("expected attempts = 3 on 3rd attempt success, got %d", afterSuccess.Attempts)
	}
	if afterSuccess.Status != model.StatusDelivered {
		t.Errorf("expected DELIVERED status, got %s", afterSuccess.Status)
	}
}

// B2: Replay idempotent: dua replay beruntun cepat hanya menghasilkan satu transisi PENDING, yang kedua 409
func TestCriteria_B2_ReplayIdempotency(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_b2_test",
		Name:      "b2-endpoint",
		TargetURL: "http://localhost:8080/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:             "ev-b2-idempotency",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"content-type": "application/json"},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "HTTP_5XX",
		HTTPStatusCode: 503,
		Attempts:       5,
		MaxAttempts:    5,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev)

	router := NewRouter(db, nil, NewHub())

	// Call 1: transitions to PENDING -> 200 OK
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	rec1 := httptest.NewRecorder()
	router.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first replay expected 200 OK, got %d", rec1.Code)
	}

	// Call 2: event is already PENDING -> 409 Conflict
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusConflict {
		t.Fatalf("second replay on PENDING event expected 409 Conflict, got %d", rec2.Code)
	}

	var errBody map[string]any
	_ = json.Unmarshal(rec2.Body.Bytes(), &errBody)
	errMsg, _ := errBody["error"].(string)
	if !strings.Contains(errMsg, "antrean") && !strings.Contains(errMsg, "Menunggu") {
		t.Errorf("expected human-friendly Indonesian error message, got: %q", errMsg)
	}
}

// B3: Eligibility ditentukan di server, single & bulk memakai fungsi yang sama, response mengembalikan breakdown
func TestCriteria_B3_ServerEligibilityAndBulkBreakdown(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_b3_test",
		Name:      "b3-endpoint",
		TargetURL: "http://localhost:8080/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	// Event 1: Eligible (SIGNATURE_MISMATCH)
	ev1 := &model.WebhookEvent{
		ID:             "ev-b3-mismatch",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "SIGNATURE_MISMATCH",
		IsVerified:     -1,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev1)

	// Event 2: Ineligible (SIGNATURE_HEADER_MISSING)
	ev2 := &model.WebhookEvent{
		ID:             "ev-b3-missing",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "SIGNATURE_HEADER_MISSING",
		IsVerified:     -1,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev2)

	// Event 3: Ineligible (SIGNATURE_TIMESTAMP_EXPIRED)
	ev3 := &model.WebhookEvent{
		ID:             "ev-b3-expired",
		EndpointID:     ep.ID,
		Provider:       model.ProviderStripe,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "SIGNATURE_TIMESTAMP_EXPIRED",
		IsVerified:     -1,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev3)

	router := NewRouter(db, nil, NewHub())

	// Test Single replay on ineligible event 2 -> 400 Bad Request
	reqSingle := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev2.ID+"/replay", nil)
	recSingle := httptest.NewRecorder()
	router.ServeHTTP(recSingle, reqSingle)
	if recSingle.Code != http.StatusBadRequest {
		t.Errorf("single replay of ineligible event expected 400, got %d", recSingle.Code)
	}

	// Test Bulk replay with all 3 events
	bulkPayload, _ := json.Marshal(map[string]any{
		"ids": []string{ev1.ID, ev2.ID, ev3.ID},
	})
	reqBulk := httptest.NewRequest(http.MethodPost, "/api/v1/events/bulk-replay", bytes.NewReader(bulkPayload))
	recBulk := httptest.NewRecorder()
	router.ServeHTTP(recBulk, reqBulk)
	if recBulk.Code != http.StatusOK {
		t.Fatalf("bulk replay expected 200, got %d", recBulk.Code)
	}

	var bulkResp BulkReplayResponse
	_ = json.Unmarshal(recBulk.Body.Bytes(), &bulkResp)

	if bulkResp.EligibleCount != 1 {
		t.Errorf("expected eligible_count = 1, got %d", bulkResp.EligibleCount)
	}
	if bulkResp.SkippedCount != 2 {
		t.Errorf("expected skipped_count = 2, got %d", bulkResp.SkippedCount)
	}
	if bulkResp.SkippedBreakdown["SIGNATURE_HEADER_MISSING"] != 1 {
		t.Errorf("expected SIGNATURE_HEADER_MISSING: 1, got %d", bulkResp.SkippedBreakdown["SIGNATURE_HEADER_MISSING"])
	}
	if bulkResp.SkippedBreakdown["SIGNATURE_TIMESTAMP_EXPIRED"] != 1 {
		t.Errorf("expected SIGNATURE_TIMESTAMP_EXPIRED: 1, got %d", bulkResp.SkippedBreakdown["SIGNATURE_TIMESTAMP_EXPIRED"])
	}
}

// B4: Baris lama: failure_code NULL memakai InferFailureCode, failed_at NULL fallback ke updated_at
func TestCriteria_B4_LegacyRowsFallback(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_b4_test",
		Name:      "b4-endpoint",
		TargetURL: "http://localhost:8080/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	updatedTime := time.Date(2026, 10, 10, 8, 30, 0, 0, time.UTC)
	updatedStr := updatedTime.Format("2006-01-02 15:04:05")

	// Insert legacy row with raw SQL so failure_code and failed_at are literally NULL
	_, err = db.RawDB().ExecContext(ctx, `
		INSERT INTO webhook_events (
			id, endpoint_id, provider, source_ip, headers, payload,
			is_verified, status, http_status_code, attempts, max_attempts,
			last_error, failure_code, failed_at, created_at, updated_at
		) VALUES (
			'ev-b4-legacy', 'ep_b4_test', 'generic', '127.0.0.1', '{}', '{}',
			1, 'FAILED', 504, 5, 5,
			'gateway timeout 504', NULL, NULL, ?, ?
		);
	`, updatedStr, updatedStr)
	if err != nil {
		t.Fatalf("failed to insert legacy event: %v", err)
	}

	router := NewRouter(db, nil, NewHub())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events/ev-b4-legacy", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}

	var resp EventResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)

	// Verify inferred failure code
	if resp.FailureCode != "HTTP_5XX" {
		t.Errorf("expected legacy failure_code fallback to HTTP_5XX, got %q", resp.FailureCode)
	}
	// Verify failed_at fallback to updated_at
	if resp.FailedAt == nil {
		t.Fatalf("expected failed_at to fallback to updated_at, got nil")
	}
	if !resp.FailedAt.Equal(updatedTime) {
		t.Errorf("expected failed_at %v, got %v", updatedTime, *resp.FailedAt)
	}
}

// B5: verification_kind per provider berasal dari verifier dan ada di EventResponse
func TestCriteria_B5_VerificationKind(t *testing.T) {
	if verifier.ProviderVerificationKind(model.ProviderXendit) != verifier.VerificationKindStaticToken {
		t.Errorf("Xendit must have verification_kind = static_token")
	}
	if verifier.ProviderVerificationKind(model.ProviderMidtrans) != verifier.VerificationKindHash {
		t.Errorf("Midtrans must have verification_kind = hash")
	}
	if verifier.ProviderVerificationKind(model.ProviderStripe) != verifier.VerificationKindHMAC {
		t.Errorf("Stripe must have verification_kind = hmac")
	}
	if verifier.ProviderVerificationKind(model.ProviderGithub) != verifier.VerificationKindHMAC {
		t.Errorf("GitHub must have verification_kind = hmac")
	}

	// Verify API response returns verification_kind
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_b5_test",
		Name:      "b5-xendit",
		TargetURL: "http://localhost:8080/target",
		Provider:  model.ProviderXendit,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:             "ev-b5-xendit",
		EndpointID:     ep.ID,
		Provider:       model.ProviderXendit,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "SIGNATURE_MISMATCH",
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev)

	router := NewRouter(db, nil, NewHub())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events/"+ev.ID, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	var resp EventResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)

	if resp.VerificationKind != "static_token" {
		t.Errorf("expected verification_kind = 'static_token', got %q", resp.VerificationKind)
	}
}

// B6: Kode HTTP satu sumber kebenaran, replay tidak menghapus status code terakhir
func TestCriteria_B6_HTTPStatusCodePreservedOnReplay(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_b6_test",
		Name:      "b6-endpoint",
		TargetURL: "http://localhost:8080/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	ev := &model.WebhookEvent{
		ID:             "ev-b6-status-test",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{},
		Payload:        []byte(`{}`),
		Status:         model.StatusFailed,
		FailureCode:    "HTTP_5XX",
		HTTPStatusCode: 504,
		Attempts:       5,
		MaxAttempts:    5,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	_ = db.SaveEvent(ctx, ev)

	router := NewRouter(db, nil, NewHub())

	// Trigger replay
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("replay failed: %d", rec.Code)
	}

	afterReplay, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("failed to fetch event: %v", err)
	}

	if afterReplay.HTTPStatusCode != 504 {
		t.Errorf("replay MUST preserve last http_status_code (expected 504, got %d)", afterReplay.HTTPStatusCode)
	}
}

// B1: Regression test: event 5/5 -> replay via single DAN via bulk -> downstream mock selalu timeout -> amati attempts 0, 1..max, tidak pernah > max_attempts, akhir FAILED "max/max Kuota habis"
func TestCriteria_B1_AttemptsNeverExceedMax_SingleAndBulkReplay(t *testing.T) {
	var downstreamRequests atomic.Int32
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamRequests.Add(1)
		w.WriteHeader(http.StatusGatewayTimeout) // 504
		w.Write([]byte(`{"error":"gateway timeout"}`))
	}))
	defer downstream.Close()

	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_attempts_test",
		Name:      "attempts-endpoint",
		TargetURL: downstream.URL,
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	cfg.BaseBackoff = 5 * time.Millisecond
	cfg.HTTPClient = downstream.Client()
	pool := worker.NewPool(db, verifier.NewEngine(), cfg)
	router := NewRouter(db, pool, NewHub())

	// 1. Initial State: Event 5/5 FAILED (Kuota habis)
	ev := &model.WebhookEvent{
		ID:             "ev-attempts-exhausted-504",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"test":"timeout"}`),
		Status:         model.StatusFailed,
		FailureCode:    "HTTP_5XX",
		HTTPStatusCode: 504,
		Attempts:       5,
		MaxAttempts:    5,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("SaveEvent failed: %v", err)
	}

	// 2. PART 1: SINGLE REPLAY
	downstreamRequests.Store(0)
	reqSingle := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev.ID+"/replay", nil)
	recSingle := httptest.NewRecorder()
	router.ServeHTTP(recSingle, reqSingle)
	if recSingle.Code != http.StatusOK {
		t.Fatalf("single replay failed: %d, body: %s", recSingle.Code, recSingle.Body.String())
	}

	evAfterSingle, err := db.GetEventByID(ctx, ev.ID)
	if err != nil {
		t.Fatalf("failed to fetch event after single replay: %v", err)
	}
	if evAfterSingle.Attempts != 0 {
		t.Errorf("expected attempts reset to 0 after replay, got %d", evAfterSingle.Attempts)
	}
	if evAfterSingle.Status != model.StatusPending {
		t.Errorf("expected status PENDING after replay, got %s", evAfterSingle.Status)
	}

	// Dispatch attempts 1..5 through pool
	for i := 1; i <= 5; i++ {
		err := pool.Dispatch(ctx, ev.ID)
		if err != nil {
			t.Fatalf("dispatch %d failed: %v", i, err)
		}
		curEv, err := db.GetEventByID(ctx, ev.ID)
		if err != nil {
			t.Fatalf("failed to fetch event at step %d: %v", i, err)
		}
		if curEv.Attempts != i {
			t.Errorf("step %d: expected attempts = %d, got %d", i, i, curEv.Attempts)
		}
		if curEv.Attempts > curEv.MaxAttempts {
			t.Fatalf("CRITICAL: attempts %d exceeded max_attempts %d at step %d", curEv.Attempts, curEv.MaxAttempts, i)
		}
		if i < 5 && curEv.Status != model.StatusRetrying {
			t.Errorf("step %d: expected status RETRYING, got %s", i, curEv.Status)
		}
	}

	finalSingle, _ := db.GetEventByID(ctx, ev.ID)
	if finalSingle.Status != model.StatusFailed {
		t.Errorf("expected final status FAILED, got %s", finalSingle.Status)
	}
	if finalSingle.Attempts != 5 {
		t.Errorf("expected final attempts = 5 (max), got %d", finalSingle.Attempts)
	}

	// Provoke extra dispatch and direct increment: MUST NEVER exceed max_attempts and MUST NOT trigger extra downstream request
	_ = pool.Dispatch(ctx, ev.ID)
	_ = db.IncrementAttempts(ctx, ev.ID, nil, "extra timeout", 504)
	afterExtra, _ := db.GetEventByID(ctx, ev.ID)
	if afterExtra.Attempts != 5 {
		t.Errorf("attempts exceeded max_attempts after extra dispatch/increment: got %d, expected 5", afterExtra.Attempts)
	}
	if reqs := downstreamRequests.Load(); reqs != 5 {
		t.Errorf("CRITICAL: expected mock downstream to receive EXACTLY 5 requests in single replay cycle, got %d", reqs)
	}

	// 3. PART 2: BULK REPLAY
	downstreamRequests.Store(0)
	bulkPayload, _ := json.Marshal(map[string]any{
		"ids": []string{ev.ID},
	})
	reqBulk := httptest.NewRequest(http.MethodPost, "/api/v1/events/bulk-replay", bytes.NewReader(bulkPayload))
	recBulk := httptest.NewRecorder()
	router.ServeHTTP(recBulk, reqBulk)
	if recBulk.Code != http.StatusOK {
		t.Fatalf("bulk replay failed: %d, body: %s", recBulk.Code, recBulk.Body.String())
	}

	evAfterBulk, _ := db.GetEventByID(ctx, ev.ID)
	if evAfterBulk.Attempts != 0 {
		t.Errorf("bulk replay should reset attempts to 0, got %d", evAfterBulk.Attempts)
	}
	if evAfterBulk.Status != model.StatusPending {
		t.Errorf("bulk replay should set status to PENDING, got %s", evAfterBulk.Status)
	}

	// Dispatch attempts 1..5 through pool
	for i := 1; i <= 5; i++ {
		err := pool.Dispatch(ctx, ev.ID)
		if err != nil {
			t.Fatalf("bulk dispatch %d failed: %v", i, err)
		}
		curEv, err := db.GetEventByID(ctx, ev.ID)
		if err != nil {
			t.Fatalf("failed to fetch event at bulk step %d: %v", i, err)
		}
		if curEv.Attempts != i {
			t.Errorf("bulk step %d: expected attempts = %d, got %d", i, i, curEv.Attempts)
		}
		if curEv.Attempts > curEv.MaxAttempts {
			t.Fatalf("CRITICAL: bulk attempts %d exceeded max_attempts %d at step %d", curEv.Attempts, curEv.MaxAttempts, i)
		}
	}

	finalBulk, _ := db.GetEventByID(ctx, ev.ID)
	if finalBulk.Status != model.StatusFailed {
		t.Errorf("expected final bulk status FAILED, got %s", finalBulk.Status)
	}
	if finalBulk.Attempts != 5 {
		t.Errorf("expected final bulk attempts = 5 (max), got %d", finalBulk.Attempts)
	}

	// Provoke extra dispatch again: must remain 5 and MUST NOT trigger extra downstream request
	_ = pool.Dispatch(ctx, ev.ID)
	afterExtraBulk, _ := db.GetEventByID(ctx, ev.ID)
	if afterExtraBulk.Attempts != 5 {
		t.Errorf("attempts exceeded max_attempts after extra bulk dispatch: got %d, expected 5", afterExtraBulk.Attempts)
	}
	if reqs := downstreamRequests.Load(); reqs != 5 {
		t.Errorf("CRITICAL: expected mock downstream to receive EXACTLY 5 requests in bulk replay cycle, got %d", reqs)
	}
}

// B2 / 3b: Keyed mutex concurrency test:
// Two concurrent bulk replays on DIFFERENT events must NOT block each other.
// Concurrent replays on the SAME event must return 409 Conflict.
func TestCriteria_B2_KeyedMutexConcurrentBulkReplay(t *testing.T) {
	db, err := storage.Open(":memory:")
	if err != nil {
		t.Fatalf("storage.Open failed: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep_conc_test",
		Name:      "conc-endpoint",
		TargetURL: "http://127.0.0.1:9999/dummy",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	if err := db.SaveEndpoint(ctx, ep); err != nil {
		t.Fatalf("SaveEndpoint failed: %v", err)
	}

	ev1 := &model.WebhookEvent{
		ID:             "ev_conc_diff_1",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"event":"conc.1"}`),
		Status:         model.StatusFailed,
		FailureCode:    "HTTP_5XX",
		HTTPStatusCode: 500,
		Attempts:       5,
		MaxAttempts:    5,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	ev2 := &model.WebhookEvent{
		ID:             "ev_conc_diff_2",
		EndpointID:     ep.ID,
		Provider:       model.ProviderGeneric,
		SourceIP:       "127.0.0.1",
		Headers:        map[string]string{"Content-Type": "application/json"},
		Payload:        []byte(`{"event":"conc.2"}`),
		Status:         model.StatusFailed,
		FailureCode:    "HTTP_5XX",
		HTTPStatusCode: 500,
		Attempts:       5,
		MaxAttempts:    5,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
	}
	if err := db.SaveEvent(ctx, ev1); err != nil {
		t.Fatalf("SaveEvent ev1 failed: %v", err)
	}
	if err := db.SaveEvent(ctx, ev2); err != nil {
		t.Fatalf("SaveEvent ev2 failed: %v", err)
	}

	cfg := worker.DefaultConfig()
	pool := worker.NewPool(db, verifier.NewEngine(), cfg)
	router := NewRouter(db, pool, NewHub())

	// 1. Concurrent bulk replays on DIFFERENT events: both must succeed without blocking
	var wg sync.WaitGroup
	var code1, code2 int
	var res1, res2 BulkReplayResponse

	wg.Add(2)
	go func() {
		defer wg.Done()
		b, _ := json.Marshal(map[string]any{"ids": []string{ev1.ID}})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/events/bulk-replay", bytes.NewReader(b))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		code1 = rec.Code
		_ = json.Unmarshal(rec.Body.Bytes(), &res1)
	}()
	go func() {
		defer wg.Done()
		b, _ := json.Marshal(map[string]any{"ids": []string{ev2.ID}})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/events/bulk-replay", bytes.NewReader(b))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		code2 = rec.Code
		_ = json.Unmarshal(rec.Body.Bytes(), &res2)
	}()
	wg.Wait()

	if code1 != http.StatusOK || res1.EligibleCount != 1 {
		t.Errorf("bulk replay for ev1 failed: code %d, res: %+v", code1, res1)
	}
	if code2 != http.StatusOK || res2.EligibleCount != 1 {
		t.Errorf("bulk replay for ev2 failed: code %d, res: %+v", code2, res2)
	}

	// 2. Concurrent replays on the SAME event: one must succeed, second must return 409 Conflict
	// Reset ev1 back to FAILED
	_ = db.UpdateEventStatus(ctx, ev1.ID, model.StatusFailed, 500, "failed again")

	var sameWg sync.WaitGroup
	codes := make([]int, 2)
	bodies := make([]string, 2)

	sameWg.Add(2)
	for i := 0; i < 2; i++ {
		idx := i
		go func() {
			defer sameWg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/v1/events/"+ev1.ID+"/replay", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			codes[idx] = rec.Code
			bodies[idx] = rec.Body.String()
		}()
	}
	sameWg.Wait()

	has200 := (codes[0] == http.StatusOK || codes[1] == http.StatusOK)
	has409 := (codes[0] == http.StatusConflict || codes[1] == http.StatusConflict)

	if !has200 || !has409 {
		t.Errorf("expected one 200 OK and one 409 Conflict for concurrent replays on same event, got: [%d, %d], bodies: [%s, %s]",
			codes[0], codes[1], bodies[0], bodies[1])
	}
}

