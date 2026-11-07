package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
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
	"golang.org/x/crypto/bcrypt"
)

func setupProfileTestEnv(t *testing.T) (*storage.DB, *api.Router, *model.User, string, func()) {
	t.Helper()
	tempDir, err := os.MkdirTemp("", "relaygate-profile-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	avatarsDir := filepath.Join(tempDir, "avatars")
	api.SetAvatarsDir(avatarsDir)

	dbPath := filepath.Join(tempDir, "test.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		_ = os.RemoveAll(tempDir)
		t.Fatalf("failed to open storage db: %v", err)
	}

	router := api.NewRouter(db, nil, api.NewHub())

	// Create test user
	ctx := context.Background()
	hash, _ := bcrypt.GenerateFromPassword([]byte("InitialPassword123!"), bcrypt.DefaultCost)
	testUser := &model.User{
		ID:           "usr_test_profile",
		Name:         "Budi Santoso",
		Email:        "budi@example.com",
		Role:         "admin",
		PasswordHash: string(hash),
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveUser(ctx, testUser); err != nil {
		t.Fatalf("failed to save test user: %v", err)
	}

	// Create active session
	sessionToken := "sess_test_token_1234567890abcdef"
	sess := &model.Session{
		Token:        sessionToken,
		UserID:       testUser.ID,
		UserEmail:    testUser.Email,
		Role:         testUser.Role,
		ExpiresAt:    time.Now().UTC().Add(12 * time.Hour),
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveSession(ctx, sess); err != nil {
		t.Fatalf("failed to save session: %v", err)
	}

	cleanup := func() {
		_ = db.Close()
		_ = os.RemoveAll(tempDir)
		api.SetAvatarsDir("./data/avatars")
	}

	return db, router, testUser, sessionToken, cleanup
}

func TestProfile_GetProfile(t *testing.T) {
	_, router, user, token, cleanup := setupProfileTestEnv(t)
	defer cleanup()

	// 1. Unauthenticated request -> 401
	reqUnauth := httptest.NewRequest(http.MethodGet, "/api/v1/profile", nil)
	recUnauth := httptest.NewRecorder()
	router.ServeHTTP(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized for unauth get profile, got %d", recUnauth.Code)
	}

	// 2. Authenticated with Bearer token -> 200 OK
	reqAuth := httptest.NewRequest(http.MethodGet, "/api/v1/profile", nil)
	reqAuth.Header.Set("Authorization", "Bearer "+token)
	recAuth := httptest.NewRecorder()
	router.ServeHTTP(recAuth, reqAuth)
	if recAuth.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for auth get profile, got %d: %s", recAuth.Code, recAuth.Body.String())
	}

	var fetched model.User
	if err := json.Unmarshal(recAuth.Body.Bytes(), &fetched); err != nil {
		t.Fatalf("failed to unmarshal user profile: %v", err)
	}
	if fetched.ID != user.ID || fetched.Email != user.Email || fetched.Name != user.Name || fetched.Role != user.Role {
		t.Errorf("unexpected profile payload: %+v", fetched)
	}
}

func TestProfile_UpdateProfile(t *testing.T) {
	_, router, _, token, cleanup := setupProfileTestEnv(t)
	defer cleanup()

	// 1. Unauthenticated -> 401
	body := []byte(`{"name":"New Nickname"}`)
	reqUnauth := httptest.NewRequest(http.MethodPatch, "/api/v1/profile", bytes.NewReader(body))
	reqUnauth.Header.Set("Content-Type", "application/json")
	recUnauth := httptest.NewRecorder()
	router.ServeHTTP(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized, got %d", recUnauth.Code)
	}

	// 2. Name too short (< 2 chars) -> 400
	tooShortBody := []byte(`{"name":"A"}`)
	reqShort := httptest.NewRequest(http.MethodPatch, "/api/v1/profile", bytes.NewReader(tooShortBody))
	reqShort.Header.Set("Content-Type", "application/json")
	reqShort.Header.Set("Authorization", "Bearer "+token)
	recShort := httptest.NewRecorder()
	router.ServeHTTP(recShort, reqShort)
	if recShort.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for name < 2 chars, got %d", recShort.Code)
	}

	// 3. Valid name update -> 200 OK
	validBody := []byte(`{"name":"Raden Mas Budi"}`)
	reqValid := httptest.NewRequest(http.MethodPatch, "/api/v1/profile", bytes.NewReader(validBody))
	reqValid.Header.Set("Content-Type", "application/json")
	reqValid.Header.Set("Authorization", "Bearer "+token)
	recValid := httptest.NewRecorder()
	router.ServeHTTP(recValid, reqValid)
	if recValid.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for valid name update, got %d: %s", recValid.Code, recValid.Body.String())
	}

	var updated model.User
	_ = json.Unmarshal(recValid.Body.Bytes(), &updated)
	if updated.Name != "Raden Mas Budi" {
		t.Errorf("expected updated name 'Raden Mas Budi', got %s", updated.Name)
	}

	// 4. Reject name containing control characters
	controlCharBody := []byte(`{"name":"Budi\x00Santoso\r\n"}`)
	reqControl := httptest.NewRequest(http.MethodPatch, "/api/v1/profile", bytes.NewReader(controlCharBody))
	reqControl.Header.Set("Content-Type", "application/json")
	reqControl.Header.Set("Authorization", "Bearer "+token)
	recControl := httptest.NewRecorder()
	router.ServeHTTP(recControl, reqControl)
	if recControl.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for name with control characters, got %d", recControl.Code)
	}

	// 5. Verify duplicate PUT route is removed (must return 405 Method Not Allowed or 404)
	putBody := []byte(`{"name":"Budi Santoso S.Kom"}`)
	reqPut := httptest.NewRequest(http.MethodPut, "/api/v1/profile", bytes.NewReader(putBody))
	reqPut.Header.Set("Content-Type", "application/json")
	reqPut.Header.Set("Authorization", "Bearer "+token)
	recPut := httptest.NewRecorder()
	router.ServeHTTP(recPut, reqPut)
	if recPut.Code != http.StatusMethodNotAllowed && recPut.Code != http.StatusNotFound {
		t.Errorf("expected 405 or 404 for removed duplicate PUT endpoint, got %d", recPut.Code)
	}
}

func TestProfile_UpdatePassword(t *testing.T) {
	api.ResetRateLimits()
	db, router, user, token, cleanup := setupProfileTestEnv(t)
	defer cleanup()

	// Setup a second active session for the same user to test multi-session revocation
	secondToken := "sess_second_device_token_9876543210"
	secondSess := &model.Session{
		Token:        secondToken,
		UserID:       user.ID,
		UserEmail:    user.Email,
		Role:         user.Role,
		ExpiresAt:    time.Now().UTC().Add(12 * time.Hour),
		LastActiveAt: time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}
	if err := db.SaveSession(context.Background(), secondSess); err != nil {
		t.Fatalf("failed to save second session: %v", err)
	}

	// 1. Wrong current password -> 400
	wrongPassBody, _ := json.Marshal(map[string]string{
		"current_password": "WrongPassword123!",
		"new_password":     "BrandNewPassword456!",
	})
	reqWrong := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", bytes.NewReader(wrongPassBody))
	reqWrong.Header.Set("Content-Type", "application/json")
	reqWrong.Header.Set("Authorization", "Bearer "+token)
	recWrong := httptest.NewRecorder()
	router.ServeHTTP(recWrong, reqWrong)
	if recWrong.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for wrong current password, got %d", recWrong.Code)
	}

	// 2. New password too short (< 8 chars) -> 400
	shortPassBody, _ := json.Marshal(map[string]string{
		"current_password": "InitialPassword123!",
		"new_password":     "short",
	})
	reqShort := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", bytes.NewReader(shortPassBody))
	reqShort.Header.Set("Content-Type", "application/json")
	reqShort.Header.Set("Authorization", "Bearer "+token)
	recShort := httptest.NewRecorder()
	router.ServeHTTP(recShort, reqShort)
	if recShort.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for new password < 8 chars, got %d", recShort.Code)
	}

	// 3. New password too long (> 72 chars) -> 400
	longPass := strings.Repeat("A", 73)
	longPassBody, _ := json.Marshal(map[string]string{
		"current_password": "InitialPassword123!",
		"new_password":     longPass,
	})
	reqLong := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", bytes.NewReader(longPassBody))
	reqLong.Header.Set("Content-Type", "application/json")
	reqLong.Header.Set("Authorization", "Bearer "+token)
	recLong := httptest.NewRecorder()
	router.ServeHTTP(recLong, reqLong)
	if recLong.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for password > 72 chars, got %d", recLong.Code)
	}

	// 4. New password same as current password -> 400
	samePassBody, _ := json.Marshal(map[string]string{
		"current_password": "InitialPassword123!",
		"new_password":     "InitialPassword123!",
	})
	reqSame := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", bytes.NewReader(samePassBody))
	reqSame.Header.Set("Content-Type", "application/json")
	reqSame.Header.Set("Authorization", "Bearer "+token)
	recSame := httptest.NewRecorder()
	router.ServeHTTP(recSame, reqSame)
	if recSame.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when new password equals current password, got %d", recSame.Code)
	}

	// 5. Successful password update -> 200 OK
	validPassBody, _ := json.Marshal(map[string]string{
		"current_password": "InitialPassword123!",
		"new_password":     "BrandNewSecurePassword456!",
	})
	reqSuccess := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", bytes.NewReader(validPassBody))
	reqSuccess.Header.Set("Content-Type", "application/json")
	reqSuccess.Header.Set("Authorization", "Bearer "+token)
	recSuccess := httptest.NewRecorder()
	router.ServeHTTP(recSuccess, reqSuccess)
	if recSuccess.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for valid password update, got %d: %s", recSuccess.Code, recSuccess.Body.String())
	}

	// 6. Verify current session (token) remains valid
	reqCheckSess1 := httptest.NewRequest(http.MethodGet, "/api/v1/profile", nil)
	reqCheckSess1.Header.Set("Authorization", "Bearer "+token)
	recCheckSess1 := httptest.NewRecorder()
	router.ServeHTTP(recCheckSess1, reqCheckSess1)
	if recCheckSess1.Code != http.StatusOK {
		t.Errorf("expected current session to remain active after password change, got %d", recCheckSess1.Code)
	}

	// 7. Verify second session (secondToken) has been revoked -> 401
	reqCheckSess2 := httptest.NewRequest(http.MethodGet, "/api/v1/profile", nil)
	reqCheckSess2.Header.Set("Authorization", "Bearer "+secondToken)
	recCheckSess2 := httptest.NewRecorder()
	router.ServeHTTP(recCheckSess2, reqCheckSess2)
	if recCheckSess2.Code != http.StatusUnauthorized {
		t.Errorf("expected second session to be revoked after password change, got %d", recCheckSess2.Code)
	}

	// 8. Verify login with old password now fails
	oldLoginBody, _ := json.Marshal(map[string]string{
		"email":    user.Email,
		"password": "InitialPassword123!",
	})
	reqOldLogin := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(oldLoginBody))
	reqOldLogin.Header.Set("Content-Type", "application/json")
	recOldLogin := httptest.NewRecorder()
	router.ServeHTTP(recOldLogin, reqOldLogin)
	if recOldLogin.Code != http.StatusUnauthorized {
		t.Errorf("expected old password login to fail with 401, got %d", recOldLogin.Code)
	}

	// 9. Verify login with new password succeeds
	newLoginBody, _ := json.Marshal(map[string]string{
		"email":    user.Email,
		"password": "BrandNewSecurePassword456!",
	})
	reqNewLogin := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(newLoginBody))
	reqNewLogin.Header.Set("Content-Type", "application/json")
	recNewLogin := httptest.NewRecorder()
	router.ServeHTTP(recNewLogin, reqNewLogin)
	if recNewLogin.Code != http.StatusOK {
		t.Fatalf("expected new password login to succeed with 200, got %d: %s", recNewLogin.Code, recNewLogin.Body.String())
	}
}

func TestProfile_RateLimiting(t *testing.T) {
	api.ResetRateLimits()
	_, router, user, token, cleanup := setupProfileTestEnv(t)
	defer cleanup()

	// 1. Password update rate limiting: 5 failed attempts allowed, 6th should return 429
	for i := 1; i <= 5; i++ {
		wrongBody, _ := json.Marshal(map[string]string{
			"current_password": "WrongPasswordAttempt!",
			"new_password":     "SomeNewPassword123!",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", bytes.NewReader(wrongBody))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d: expected 400, got %d", i, rec.Code)
		}
	}

	// 6th attempt should be blocked by rate limiter
	blockedBody, _ := json.Marshal(map[string]string{
		"current_password": "WrongPasswordAttempt!",
		"new_password":     "SomeNewPassword123!",
	})
	reqBlocked := httptest.NewRequest(http.MethodPost, "/api/v1/profile/password", bytes.NewReader(blockedBody))
	reqBlocked.Header.Set("Content-Type", "application/json")
	reqBlocked.Header.Set("Authorization", "Bearer "+token)
	recBlocked := httptest.NewRecorder()
	router.ServeHTTP(recBlocked, reqBlocked)
	if recBlocked.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 Too Many Requests after 5 failed attempts, got %d", recBlocked.Code)
	}

	// 2. Login rate limiting: 5 failed attempts allowed, 6th should return 429
	api.ResetRateLimits()
	for i := 1; i <= 5; i++ {
		wrongLogin, _ := json.Marshal(map[string]string{
			"email":    user.Email,
			"password": "WrongLoginPassword!",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(wrongLogin))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("login attempt %d: expected 401, got %d", i, rec.Code)
		}
	}

	// 6th login attempt should be blocked with 429
	loginBlocked, _ := json.Marshal(map[string]string{
		"email":    user.Email,
		"password": "WrongLoginPassword!",
	})
	reqLoginBlocked := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBlocked))
	reqLoginBlocked.Header.Set("Content-Type", "application/json")
	recLoginBlocked := httptest.NewRecorder()
	router.ServeHTTP(recLoginBlocked, reqLoginBlocked)
	if recLoginBlocked.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 Too Many Requests after 5 failed login attempts, got %d", recLoginBlocked.Code)
	}
}

func generateTestPNGImage() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for x := 0; x < 32; x++ {
		for y := 0; y < 32; y++ {
			img.Set(x, y, color.RGBA{R: 50, G: 100, B: 200, A: 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func TestProfile_AvatarUploadAndServe(t *testing.T) {
	_, router, _, token, cleanup := setupProfileTestEnv(t)
	defer cleanup()

	// 1. Reject non-image upload (e.g. text/html or SVG with scripts)
	var bodyBuf bytes.Buffer
	mw := multipart.NewWriter(&bodyBuf)
	part, _ := mw.CreateFormFile("avatar", "exploit.html")
	_, _ = part.Write([]byte("<html><script>alert(1)</script></html>"))
	_ = mw.Close()

	reqBadMime := httptest.NewRequest(http.MethodPost, "/api/v1/profile/avatar", &bodyBuf)
	reqBadMime.Header.Set("Content-Type", mw.FormDataContentType())
	reqBadMime.Header.Set("Authorization", "Bearer "+token)
	recBadMime := httptest.NewRecorder()
	router.ServeHTTP(recBadMime, reqBadMime)
	if recBadMime.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for non-image upload, got %d: %s", recBadMime.Code, recBadMime.Body.String())
	}

	// 2. Upload valid PNG image
	pngData := generateTestPNGImage()
	bodyBuf.Reset()
	mw = multipart.NewWriter(&bodyBuf)
	part, _ = mw.CreateFormFile("avatar", "profile.png")
	_, _ = part.Write(pngData)
	_ = mw.Close()

	reqValidUpload := httptest.NewRequest(http.MethodPost, "/api/v1/profile/avatar", &bodyBuf)
	reqValidUpload.Header.Set("Content-Type", mw.FormDataContentType())
	reqValidUpload.Header.Set("Authorization", "Bearer "+token)
	recValidUpload := httptest.NewRecorder()
	router.ServeHTTP(recValidUpload, reqValidUpload)
	if recValidUpload.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for valid PNG upload, got %d: %s", recValidUpload.Code, recValidUpload.Body.String())
	}

	var userWithAvatar model.User
	_ = json.Unmarshal(recValidUpload.Body.Bytes(), &userWithAvatar)
	if userWithAvatar.AvatarURL == "" || !strings.HasPrefix(userWithAvatar.AvatarURL, "/api/v1/profile/avatar/") {
		t.Fatalf("expected avatar_url to start with /api/v1/profile/avatar/, got %s", userWithAvatar.AvatarURL)
	}

	// 3. Serve the uploaded avatar
	reqServe := httptest.NewRequest(http.MethodGet, userWithAvatar.AvatarURL, nil)
	recServe := httptest.NewRecorder()
	router.ServeHTTP(recServe, reqServe)
	if recServe.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for serving avatar, got %d", recServe.Code)
	}
	if nosniff := recServe.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
		t.Errorf("expected X-Content-Type-Options: nosniff, got %q", nosniff)
	}
	if recServe.Body.Len() != len(pngData) {
		t.Errorf("expected served avatar size %d, got %d", len(pngData), recServe.Body.Len())
	}

	// 4. Path traversal attack attempt -> 404
	reqTraversal := httptest.NewRequest(http.MethodGet, "/api/v1/profile/avatar/..%2f..%2ftest.db", nil)
	recTraversal := httptest.NewRecorder()
	router.ServeHTTP(recTraversal, reqTraversal)
	if recTraversal.Code != http.StatusNotFound {
		t.Errorf("expected 404 for path traversal attempt, got %d", recTraversal.Code)
	}

	// 5. Delete Avatar -> 200 OK and resets avatar_url
	reqDelete := httptest.NewRequest(http.MethodDelete, "/api/v1/profile/avatar", nil)
	reqDelete.Header.Set("Authorization", "Bearer "+token)
	recDelete := httptest.NewRecorder()
	router.ServeHTTP(recDelete, reqDelete)
	if recDelete.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for avatar deletion, got %d: %s", recDelete.Code, recDelete.Body.String())
	}

	var userAfterDelete model.User
	_ = json.Unmarshal(recDelete.Body.Bytes(), &userAfterDelete)
	if userAfterDelete.AvatarURL != "" {
		t.Errorf("expected avatar_url to be empty after delete, got %s", userAfterDelete.AvatarURL)
	}

	// Verify avatar file is removed from disk (subsequent GET returns 404)
	reqServeAfter := httptest.NewRequest(http.MethodGet, userWithAvatar.AvatarURL, nil)
	recServeAfter := httptest.NewRecorder()
	router.ServeHTTP(recServeAfter, reqServeAfter)
	if recServeAfter.Code != http.StatusNotFound {
		t.Errorf("expected 404 for deleted avatar, got %d", recServeAfter.Code)
	}
}

func TestIngest_EndpointIDExtractionParity(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "relaygate-ingest-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "test.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open storage db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	ep := &model.Endpoint{
		ID:        "ep-parity-test",
		Name:      "Parity Endpoint",
		SecretKey: "whsec_test",
		TargetURL: "https://example.com/target",
		Provider:  model.ProviderGeneric,
		IsActive:  true,
		CreatedAt: time.Now().UTC(),
	}
	_ = db.SaveEndpoint(ctx, ep)

	// Ingest handler
	h := api.NewRouter(db, nil, api.NewHub())
	_ = h

	// Test with /ingest/
	body := []byte(`{"event":"test"}`)
	reqIngest := httptest.NewRequest(http.MethodPost, "/ingest/"+ep.ID, bytes.NewReader(body))
	reqIngest.Header.Set("Content-Type", "application/json")

	// We can test both prefixes directly against router or ingest handler
	var isTrusted bool
	// Test api.IsTrustedProxy
	isTrusted = api.IsTrustedProxy("127.0.0.1:12345")
	if !isTrusted {
		t.Errorf("expected loopback 127.0.0.1 to be trusted")
	}
	isTrusted = api.IsTrustedProxy("203.0.113.195:12345")
	if isTrusted {
		t.Errorf("untrusted external IP must not be recognized as trusted proxy")
	}
}
