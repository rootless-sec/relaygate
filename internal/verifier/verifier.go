package verifier

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/rootless-sec/relaygate/internal/model"
)

const (
	// DefaultStripeTolerance is the default tolerance window for Stripe webhook timestamps
	DefaultStripeTolerance = 300 * time.Second

	// Verification status values matching model.WebhookEvent
	VerificationValid   = 1
	VerificationSkipped = 0
	VerificationInvalid = -1
)

// VerificationError represents a typed error occurring during webhook signature verification
type VerificationError struct {
	Code model.ErrorCode
	Err  error
}

func (ve *VerificationError) Error() string {
	if ve.Err != nil {
		return ve.Err.Error()
	}
	return string(ve.Code)
}

func (ve *VerificationError) Unwrap() error {
	return ve.Err
}

func newVerificationError(code model.ErrorCode, format string, a ...any) *VerificationError {
	return &VerificationError{
		Code: code,
		Err:  fmt.Errorf(format, a...),
	}
}

// Engine orchestrates webhook cryptographic verification across multiple providers
type Engine struct {
	stripeTolerance time.Duration
}

// Option configures verification engine options
type Option func(*Engine)

// WithStripeTolerance sets the timestamp tolerance for Stripe signature verification
func WithStripeTolerance(tolerance time.Duration) Option {
	return func(e *Engine) {
		e.stripeTolerance = tolerance
	}
}

// NewEngine creates a new cryptographic verification engine
func NewEngine(opts ...Option) *Engine {
	e := &Engine{
		stripeTolerance: DefaultStripeTolerance,
	}
	for _, opt := range opts {
		opt(e)
	}
	return e
}

// Verify evaluates signature authenticity based on the endpoint provider and secret key
// Returns VerificationValid (1), VerificationSkipped (0), or VerificationInvalid (-1)
func (e *Engine) Verify(ep *model.Endpoint, headers map[string]string, payload []byte) (int, error) {
	if ep == nil {
		return VerificationSkipped, fmt.Errorf("endpoint cannot be nil")
	}

	secretKey := strings.TrimSpace(ep.SecretKey)
	if secretKey == "" {
		return VerificationSkipped, nil
	}

	switch ep.Provider {
	case model.ProviderStripe:
		valid, err := e.VerifyStripe(secretKey, headers, payload)
		if err != nil || !valid {
			return VerificationInvalid, err
		}
		return VerificationValid, nil

	case model.ProviderMidtrans:
		valid, err := e.VerifyMidtrans(secretKey, headers, payload)
		if err != nil || !valid {
			return VerificationInvalid, err
		}
		return VerificationValid, nil

	case model.ProviderGithub:
		valid, err := e.VerifyGithub(secretKey, headers, payload)
		if err != nil || !valid {
			return VerificationInvalid, err
		}
		return VerificationValid, nil

	case model.ProviderXendit:
		valid, err := e.VerifyXendit(secretKey, headers)
		if err != nil || !valid {
			return VerificationInvalid, err
		}
		return VerificationValid, nil

	case model.ProviderGeneric:
		fallthrough
	default:
		valid, err := e.VerifyGeneric(secretKey, headers, payload)
		if err != nil || !valid {
			return VerificationInvalid, err
		}
		return VerificationValid, nil
	}
}

// VerifyGeneric performs generic HMAC-SHA256 signature verification
func (e *Engine) VerifyGeneric(secretKey string, headers map[string]string, payload []byte) (bool, error) {
	sigHeader := getHeader(headers,
		"X-Signature-SHA256",
		"X-Hub-Signature-256",
		"X-Signature",
		"Signature",
		"X-RelayGate-Signature",
	)

	if sigHeader == "" {
		return false, newVerificationError(model.ErrCodeSignatureHeaderMissing, "missing signature header")
	}

	// Remove common prefixes
	cleanSig := strings.TrimSpace(sigHeader)
	lowerClean := strings.ToLower(cleanSig)
	if strings.HasPrefix(lowerClean, "sha256=") {
		cleanSig = strings.TrimSpace(cleanSig[7:])
	} else if strings.HasPrefix(lowerClean, "sha256:") {
		cleanSig = strings.TrimSpace(cleanSig[7:])
	}

	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write(payload)
	expectedBytes := mac.Sum(nil)
	expectedHex := hex.EncodeToString(expectedBytes)

	// Constant time comparison
	if subtle.ConstantTimeCompare([]byte(strings.ToLower(cleanSig)), []byte(strings.ToLower(expectedHex))) == 1 {
		return true, nil
	}

	return false, newVerificationError(model.ErrCodeSignatureMismatch, "generic signature mismatch")
}

// VerifyMidtrans performs SHA512 hash verification for Midtrans webhooks
// Formula: SHA512(order_id + status_code + gross_amount + ServerKey)
func (e *Engine) VerifyMidtrans(serverKey string, headers map[string]string, payload []byte) (bool, error) {
	if len(payload) == 0 {
		return false, newVerificationError(model.ErrCodeSignaturePayloadMalformed, "empty midtrans payload")
	}

	var data map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.UseNumber()
	if err := decoder.Decode(&data); err != nil {
		return false, newVerificationError(model.ErrCodeSignaturePayloadMalformed, "failed to parse midtrans json payload: %w", err)
	}

	// Extract signature key from body or headers
	var signatureKey string
	if sig, ok := data["signature_key"].(string); ok && sig != "" {
		signatureKey = sig
	} else {
		signatureKey = getHeader(headers, "X-Signature-Key", "X-Signature", "Signature")
	}

	if signatureKey == "" {
		return false, newVerificationError(model.ErrCodeSignatureHeaderMissing, "midtrans signature_key not found in payload or headers")
	}

	orderID := getStringField(data, "order_id")
	statusCode := getStringField(data, "status_code")
	grossAmount := getStringField(data, "gross_amount")

	if orderID == "" || statusCode == "" || grossAmount == "" {
		return false, newVerificationError(model.ErrCodeSignaturePayloadMalformed, "midtrans missing required fields (order_id, status_code, or gross_amount)")
	}

	candidates := []string{grossAmount}
	if !strings.Contains(grossAmount, ".") {
		candidates = append(candidates, grossAmount+".00")
	} else if strings.HasSuffix(grossAmount, ".00") {
		candidates = append(candidates, strings.TrimSuffix(grossAmount, ".00"))
	}

	cleanSig := strings.TrimSpace(strings.ToLower(signatureKey))
	for _, ga := range candidates {
		combined := orderID + statusCode + ga + serverKey
		hash := sha512.Sum512([]byte(combined))
		expectedHex := hex.EncodeToString(hash[:])

		if subtle.ConstantTimeCompare([]byte(cleanSig), []byte(expectedHex)) == 1 {
			return true, nil
		}
	}

	return false, newVerificationError(model.ErrCodeSignatureMismatch, "midtrans signature hash mismatch")
}

// VerifyStripe performs v1 HMAC-SHA256 signature and timestamp verification for Stripe webhooks
// Format: Stripe-Signature: t=1614555000,v1=5257a869e7...,v0=...
func (e *Engine) VerifyStripe(secretKey string, headers map[string]string, payload []byte) (bool, error) {
	sigHeader := getHeader(headers, "Stripe-Signature")
	if sigHeader == "" {
		return false, newVerificationError(model.ErrCodeSignatureHeaderMissing, "missing Stripe-Signature header")
	}

	parts := strings.Split(sigHeader, ",")
	var timestampStr string
	var signatures []string

	for _, part := range parts {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		k := strings.TrimSpace(kv[0])
		v := strings.TrimSpace(kv[1])
		if k == "t" {
			timestampStr = v
		} else if k == "v1" {
			signatures = append(signatures, v)
		}
	}

	if timestampStr == "" {
		return false, newVerificationError(model.ErrCodeSignatureTimestampInvalid, "stripe signature missing timestamp (t)")
	}
	if len(signatures) == 0 {
		return false, newVerificationError(model.ErrCodeSignatureTimestampInvalid, "stripe signature missing v1 signature")
	}

	// Timestamp tolerance check
	if e.stripeTolerance > 0 {
		tsSec, err := strconv.ParseInt(timestampStr, 10, 64)
		if err != nil {
			return false, newVerificationError(model.ErrCodeSignatureTimestampInvalid, "invalid stripe timestamp: %w", err)
		}

		eventTime := time.Unix(tsSec, 0)
		diff := time.Since(eventTime)
		if diff < 0 {
			diff = -diff
		}
		if diff > e.stripeTolerance {
			return false, newVerificationError(model.ErrCodeSignatureTimestampExpired, "stripe signature timestamp too old (tolerance %v exceeded)", e.stripeTolerance)
		}
	}

	// Compute expected HMAC-SHA256 of "${timestamp}.${payload}"
	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write([]byte(timestampStr + "."))
	mac.Write(payload)
	expectedBytes := mac.Sum(nil)
	expectedHex := hex.EncodeToString(expectedBytes)

	// Compare with any provided v1 signature
	for _, sig := range signatures {
		if subtle.ConstantTimeCompare([]byte(strings.ToLower(sig)), []byte(strings.ToLower(expectedHex))) == 1 {
			return true, nil
		}
	}

	return false, newVerificationError(model.ErrCodeSignatureMismatch, "stripe v1 signature mismatch")
}

// VerifyGithub performs GitHub HMAC-SHA256 verification (X-Hub-Signature-256)
func (e *Engine) VerifyGithub(secretKey string, headers map[string]string, payload []byte) (bool, error) {
	sigHeader := getHeader(headers, "X-Hub-Signature-256")
	if sigHeader == "" {
		return false, newVerificationError(model.ErrCodeSignatureHeaderMissing, "missing X-Hub-Signature-256 header")
	}

	cleanSig := strings.TrimSpace(sigHeader)
	if strings.HasPrefix(strings.ToLower(cleanSig), "sha256=") {
		cleanSig = cleanSig[7:]
	}

	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write(payload)
	expectedHex := hex.EncodeToString(mac.Sum(nil))

	if subtle.ConstantTimeCompare([]byte(strings.ToLower(cleanSig)), []byte(strings.ToLower(expectedHex))) == 1 {
		return true, nil
	}

	return false, newVerificationError(model.ErrCodeSignatureMismatch, "github signature mismatch")
}

// VerifyXendit performs callback token verification for Xendit webhooks
func (e *Engine) VerifyXendit(callbackToken string, headers map[string]string) (bool, error) {
	receivedToken := getHeader(headers, "X-Callback-Token")
	if receivedToken == "" {
		return false, newVerificationError(model.ErrCodeSignatureHeaderMissing, "missing X-Callback-Token header")
	}

	if subtle.ConstantTimeCompare([]byte(receivedToken), []byte(callbackToken)) == 1 {
		return true, nil
	}

	return false, newVerificationError(model.ErrCodeSignatureMismatch, "xendit callback token mismatch")
}

func getHeader(headers map[string]string, keys ...string) string {
	if headers == nil {
		return ""
	}
	for _, target := range keys {
		// Exact match
		if val, ok := headers[target]; ok && strings.TrimSpace(val) != "" {
			return strings.TrimSpace(val)
		}
		// Case-insensitive match
		for k, v := range headers {
			if strings.EqualFold(k, target) && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	return ""
}

func getStringField(m map[string]any, key string) string {
	val, ok := m[key]
	if !ok || val == nil {
		return ""
	}
	switch v := val.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(v, 10)
	case int:
		return strconv.Itoa(v)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// VerificationKind defines the verification mechanism per provider
type VerificationKind string

const (
	VerificationKindStaticToken VerificationKind = "static_token"
	VerificationKindHMAC        VerificationKind = "hmac"
	VerificationKindHash        VerificationKind = "hash"
)

// ProviderVerificationKind returns the verification kind for a given provider.
// This is the single source of truth for verification kinds.
func ProviderVerificationKind(provider model.ProviderType) VerificationKind {
	switch provider {
	case model.ProviderXendit:
		return VerificationKindStaticToken
	case model.ProviderMidtrans:
		return VerificationKindHash
	case model.ProviderStripe, model.ProviderGithub, model.ProviderGeneric:
		return VerificationKindHMAC
	default:
		return VerificationKindHMAC
	}
}

