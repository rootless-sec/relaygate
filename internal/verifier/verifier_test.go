package verifier_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"testing"
	"time"

	"github.com/rootless-sec/relaygate/internal/model"
	"github.com/rootless-sec/relaygate/internal/verifier"
)

func TestVerifier_GenericHMAC(t *testing.T) {
	engine := verifier.NewEngine()
	secret := "super-secret-key-123"
	payload := []byte(`{"event":"user.created","id":"usr_99"}`)

	// Compute valid HMAC
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	validSig := hex.EncodeToString(mac.Sum(nil))

	ep := &model.Endpoint{
		ID:        "ep-gen",
		Provider:  model.ProviderGeneric,
		SecretKey: secret,
	}

	// 1. Valid with X-Signature-SHA256
	status, err := engine.Verify(ep, map[string]string{
		"X-Signature-SHA256": validSig,
	}, payload)
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid verification, got status=%d, err=%v", status, err)
	}

	// 2. Valid with sha256= prefix and case insensitivity
	status, err = engine.Verify(ep, map[string]string{
		"x-signature": "sha256=" + validSig,
	}, payload)
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid verification with prefix, got status=%d, err=%v", status, err)
	}

	// 3. Invalid signature
	status, err = engine.Verify(ep, map[string]string{
		"X-Signature-SHA256": "bad-signature",
	}, payload)
	if status != verifier.VerificationInvalid || err == nil {
		t.Fatalf("expected invalid verification, got status=%d, err=%v", status, err)
	}

	// 4. Missing signature header
	status, err = engine.Verify(ep, map[string]string{}, payload)
	if status != verifier.VerificationInvalid || err == nil {
		t.Fatalf("expected invalid verification for missing header, got status=%d, err=%v", status, err)
	}

	// 5. Empty secret key -> Skipped
	epNoSecret := &model.Endpoint{
		ID:        "ep-gen-nosecret",
		Provider:  model.ProviderGeneric,
		SecretKey: "",
	}
	status, err = engine.Verify(epNoSecret, map[string]string{}, payload)
	if status != verifier.VerificationSkipped || err != nil {
		t.Fatalf("expected skipped verification, got status=%d, err=%v", status, err)
	}
}

func TestVerifier_MidtransSHA512(t *testing.T) {
	engine := verifier.NewEngine()
	serverKey := "SB-Mid-server-key-xyz"

	orderID := "ORDER-2026-001"
	statusCode := "200"
	grossAmount := "150000.00"

	// SHA512(order_id + status_code + gross_amount + ServerKey)
	hashInput := orderID + statusCode + grossAmount + serverKey
	sum := sha512.Sum512([]byte(hashInput))
	expectedSignature := hex.EncodeToString(sum[:])

	ep := &model.Endpoint{
		ID:        "ep-midtrans",
		Provider:  model.ProviderMidtrans,
		SecretKey: serverKey,
	}

	// 1. Valid payload with signature_key inside JSON
	validPayload := []byte(fmt.Sprintf(`{
		"order_id": "%s",
		"status_code": "%s",
		"gross_amount": "%s",
		"signature_key": "%s",
		"transaction_status": "settlement"
	}`, orderID, statusCode, grossAmount, expectedSignature))

	status, err := engine.Verify(ep, map[string]string{"content-type": "application/json"}, validPayload)
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid Midtrans verification, got status=%d, err=%v", status, err)
	}

	// 2. Valid with signature in header
	payloadNoSig := []byte(fmt.Sprintf(`{
		"order_id": "%s",
		"status_code": "%s",
		"gross_amount": "%s"
	}`, orderID, statusCode, grossAmount))

	status, err = engine.Verify(ep, map[string]string{
		"X-Signature-Key": expectedSignature,
	}, payloadNoSig)
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid Midtrans verification via header, got status=%d, err=%v", status, err)
	}

	// 3. Tampered payload
	tamperedPayload := []byte(fmt.Sprintf(`{
		"order_id": "%s",
		"status_code": "400",
		"gross_amount": "%s",
		"signature_key": "%s"
	}`, orderID, grossAmount, expectedSignature))

	status, err = engine.Verify(ep, map[string]string{}, tamperedPayload)
	if status != verifier.VerificationInvalid || err == nil {
		t.Fatalf("expected invalid Midtrans verification for tampered payload, got status=%d, err=%v", status, err)
	}

	// 4. Empty payload
	status, err = engine.Verify(ep, map[string]string{}, []byte{})
	if status != verifier.VerificationInvalid || err == nil {
		t.Fatalf("expected invalid for empty payload, got status=%d, err=%v", status, err)
	}
}

func TestVerifier_StripeSignature(t *testing.T) {
	engine := verifier.NewEngine(verifier.WithStripeTolerance(300 * time.Second))
	webhookSecret := "whsec_test_secret_stripe_999"

	payload := []byte(`{"id":"evt_123","type":"payment_intent.succeeded"}`)
	nowUnix := time.Now().Unix()

	// Stripe signature: HMAC-SHA256(timestamp + "." + payload)
	mac := hmac.New(sha256.New, []byte(webhookSecret))
	mac.Write([]byte(fmt.Sprintf("%d.", nowUnix)))
	mac.Write(payload)
	v1Sig := hex.EncodeToString(mac.Sum(nil))

	ep := &model.Endpoint{
		ID:        "ep-stripe",
		Provider:  model.ProviderStripe,
		SecretKey: webhookSecret,
	}

	// 1. Valid Stripe-Signature header
	sigHeader := fmt.Sprintf("t=%d,v1=%s", nowUnix, v1Sig)
	status, err := engine.Verify(ep, map[string]string{
		"Stripe-Signature": sigHeader,
	}, payload)
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid Stripe verification, got status=%d, err=%v", status, err)
	}

	// 2. Multiple v1 signatures (rolling keys)
	multiSigHeader := fmt.Sprintf("t=%d,v1=bad_old_sig,v1=%s,v0=something_else", nowUnix, v1Sig)
	status, err = engine.Verify(ep, map[string]string{
		"stripe-signature": multiSigHeader,
	}, payload)
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid with multiple signatures, got status=%d, err=%v", status, err)
	}

	// 3. Expired timestamp (exceeds 300s tolerance)
	oldUnix := nowUnix - 600
	oldMac := hmac.New(sha256.New, []byte(webhookSecret))
	oldMac.Write([]byte(fmt.Sprintf("%d.", oldUnix)))
	oldMac.Write(payload)
	oldV1Sig := hex.EncodeToString(oldMac.Sum(nil))

	oldSigHeader := fmt.Sprintf("t=%d,v1=%s", oldUnix, oldV1Sig)
	status, err = engine.Verify(ep, map[string]string{
		"Stripe-Signature": oldSigHeader,
	}, payload)
	if status != verifier.VerificationInvalid || err == nil {
		t.Fatalf("expected expired Stripe signature to fail, got status=%d, err=%v", status, err)
	}

	// 4. Tampered payload
	status, err = engine.Verify(ep, map[string]string{
		"Stripe-Signature": sigHeader,
	}, []byte(`{"id":"tampered"}`))
	if status != verifier.VerificationInvalid || err == nil {
		t.Fatalf("expected tampered payload to fail Stripe verification, got status=%d, err=%v", status, err)
	}
}

func TestVerifier_GithubAndXendit(t *testing.T) {
	engine := verifier.NewEngine()

	// GitHub
	ghSecret := "gh-secret-token"
	ghPayload := []byte(`{"action":"push","ref":"refs/heads/main"}`)
	ghMac := hmac.New(sha256.New, []byte(ghSecret))
	ghMac.Write(ghPayload)
	ghSig := "sha256=" + hex.EncodeToString(ghMac.Sum(nil))

	epGH := &model.Endpoint{
		ID:        "ep-gh",
		Provider:  model.ProviderGithub,
		SecretKey: ghSecret,
	}

	status, err := engine.Verify(epGH, map[string]string{
		"X-Hub-Signature-256": ghSig,
	}, ghPayload)
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid GitHub verification, got status=%d, err=%v", status, err)
	}

	// Xendit
	xenditToken := "xnd_callback_token_abc"
	epXendit := &model.Endpoint{
		ID:        "ep-xendit",
		Provider:  model.ProviderXendit,
		SecretKey: xenditToken,
	}

	status, err = engine.Verify(epXendit, map[string]string{
		"X-Callback-Token": xenditToken,
	}, []byte(`{"status":"PAID"}`))
	if err != nil || status != verifier.VerificationValid {
		t.Fatalf("expected valid Xendit verification, got status=%d, err=%v", status, err)
	}

	// Invalid Xendit token
	status, err = engine.Verify(epXendit, map[string]string{
		"X-Callback-Token": "wrong-token",
	}, []byte(`{"status":"PAID"}`))
	if status != verifier.VerificationInvalid || err == nil {
		t.Fatalf("expected invalid Xendit token to fail, got status=%d, err=%v", status, err)
	}
}
