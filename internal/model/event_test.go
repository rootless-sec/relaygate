package model

import (
	"testing"
)

func TestInferFailureCode_VerificationErrors(t *testing.T) {
	testCases := []struct {
		name          string
		lastError     string
		expectedClass ErrorClass
		expectedCode  ErrorCode
	}{
		// Header missing cases
		{
			name:          "generic missing signature header",
			lastError:     "cryptographic signature verification failed: missing signature header",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureHeaderMissing,
		},
		{
			name:          "stripe missing signature header",
			lastError:     "cryptographic signature verification failed: missing Stripe-Signature header",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureHeaderMissing,
		},
		{
			name:          "github missing signature header",
			lastError:     "cryptographic signature verification failed: missing X-Hub-Signature-256 header",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureHeaderMissing,
		},
		{
			name:          "xendit missing signature header",
			lastError:     "cryptographic signature verification failed: missing X-Callback-Token header",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureHeaderMissing,
		},
		{
			name:          "midtrans signature key not found",
			lastError:     "cryptographic signature verification failed: midtrans signature_key not found in payload or headers",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureHeaderMissing,
		},

		// Timestamp expired cases
		{
			name:          "stripe timestamp expired",
			lastError:     "cryptographic signature verification failed: stripe signature timestamp too old (tolerance 5m0s exceeded)",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureTimestampExpired,
		},
		{
			name:          "stripe tolerance exceeded generic",
			lastError:     "stripe signature tolerance exceeded",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureTimestampExpired,
		},

		// Timestamp invalid cases
		{
			name:          "stripe missing timestamp t",
			lastError:     "cryptographic signature verification failed: stripe signature missing timestamp (t)",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureTimestampInvalid,
		},
		{
			name:          "stripe invalid timestamp parse error",
			lastError:     "cryptographic signature verification failed: invalid stripe timestamp: strconv.ParseInt: parsing 'abc': invalid syntax",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureTimestampInvalid,
		},
		{
			name:          "stripe missing v1 signature",
			lastError:     "cryptographic signature verification failed: stripe signature missing v1 signature",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureTimestampInvalid,
		},

		// Payload malformed cases
		{
			name:          "midtrans empty payload",
			lastError:     "cryptographic signature verification failed: empty midtrans payload",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignaturePayloadMalformed,
		},
		{
			name:          "midtrans parse json failure",
			lastError:     "cryptographic signature verification failed: failed to parse midtrans json payload: unexpected end of JSON input",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignaturePayloadMalformed,
		},
		{
			name:          "midtrans missing required fields",
			lastError:     "cryptographic signature verification failed: midtrans missing required fields (order_id, status_code, or gross_amount)",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignaturePayloadMalformed,
		},

		// Signature mismatch cases
		{
			name:          "generic signature mismatch",
			lastError:     "cryptographic signature verification failed: generic signature mismatch",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureMismatch,
		},
		{
			name:          "stripe v1 signature mismatch",
			lastError:     "cryptographic signature verification failed: stripe v1 signature mismatch",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureMismatch,
		},
		{
			name:          "github signature mismatch",
			lastError:     "cryptographic signature verification failed: github signature mismatch",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureMismatch,
		},
		{
			name:          "xendit callback token mismatch",
			lastError:     "cryptographic signature verification failed: xendit callback token mismatch",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureMismatch,
		},
		{
			name:          "midtrans signature hash mismatch",
			lastError:     "cryptographic signature verification failed: midtrans signature hash mismatch",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureMismatch,
		},
		{
			name:          "generic crypto verification failed fallback to mismatch",
			lastError:     "cryptographic signature verification failed: invalid signature format",
			expectedClass: ErrorClassVerificationRejected,
			expectedCode:  ErrCodeSignatureMismatch,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			cls, code := InferFailureCode(tc.lastError, 0, 0, -1)
			if cls != tc.expectedClass {
				t.Errorf("expected class %s, got %s", tc.expectedClass, cls)
			}
			if code != tc.expectedCode {
				t.Errorf("expected code %s, got %s", tc.expectedCode, code)
			}
		})
	}
}

func TestInferFailureCode_DeliveryErrors(t *testing.T) {
	testCases := []struct {
		name           string
		lastError      string
		httpStatusCode int
		attempts       int
		expectedClass  ErrorClass
		expectedCode   ErrorCode
	}{
		{
			name:           "http 500 downstream internal server error",
			lastError:      "downstream server error",
			httpStatusCode: 500,
			attempts:       5,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeHTTP5xx,
		},
		{
			name:           "http 502 bad gateway",
			lastError:      "Bad Gateway",
			httpStatusCode: 502,
			attempts:       3,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeHTTP5xx,
		},
		{
			name:           "http 504 gateway timeout",
			lastError:      "Gateway Timeout",
			httpStatusCode: 504,
			attempts:       5,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeHTTP5xx,
		},
		{
			name:           "http 404 endpoint not found",
			lastError:      "Not Found",
			httpStatusCode: 404,
			attempts:       5,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeHTTP4xx,
		},
		{
			name:           "http 401 unauthorized",
			lastError:      "Unauthorized",
			httpStatusCode: 401,
			attempts:       1,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeHTTP4xx,
		},
		{
			name:           "timeout context deadline exceeded",
			lastError:      "Post \"http://localhost:9999/webhook\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
			httpStatusCode: 0,
			attempts:       5,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeTimeout,
		},
		{
			name:           "network connection refused",
			lastError:      "Post \"http://127.0.0.1:9999/webhook\": dial tcp 127.0.0.1:9999: connect: connection refused",
			httpStatusCode: 0,
			attempts:       5,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeNetworkError,
		},
		{
			name:           "network no such host",
			lastError:      "dial tcp: lookup nonexistent.host.example: no such host",
			httpStatusCode: 0,
			attempts:       5,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeNetworkError,
		},
		{
			name:           "generic delivery failure",
			lastError:      "unexpected protocol error",
			httpStatusCode: 0,
			attempts:       5,
			expectedClass:  ErrorClassDeliveryFailed,
			expectedCode:   ErrCodeDeliveryFailed,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			cls, code := InferFailureCode(tc.lastError, tc.httpStatusCode, tc.attempts, 1)
			if cls != tc.expectedClass {
				t.Errorf("expected class %s, got %s", tc.expectedClass, cls)
			}
			if code != tc.expectedCode {
				t.Errorf("expected code %s, got %s", tc.expectedCode, code)
			}
		})
	}
}

func TestIsEligibleForReplay(t *testing.T) {
	// 1. Signature Mismatch: ELIGIBLE
	evMismatch := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    0,
		IsVerified:  -1,
		FailureCode: string(ErrCodeSignatureMismatch),
	}
	if !evMismatch.IsEligibleForReplay() {
		t.Errorf("expected signature mismatch to be eligible for replay")
	}

	// 2. Missing Header: INELIGIBLE
	evMissingHeader := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    0,
		IsVerified:  -1,
		FailureCode: string(ErrCodeSignatureHeaderMissing),
	}
	if evMissingHeader.IsEligibleForReplay() {
		t.Errorf("expected missing header to be ineligible for replay")
	}

	// 3. Timestamp Expired: INELIGIBLE
	evTimestampExpired := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    0,
		IsVerified:  -1,
		FailureCode: string(ErrCodeSignatureTimestampExpired),
	}
	if evTimestampExpired.IsEligibleForReplay() {
		t.Errorf("expected timestamp expired to be ineligible for replay")
	}

	// 4. Timestamp Invalid: INELIGIBLE
	evTimestampInvalid := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    0,
		IsVerified:  -1,
		FailureCode: string(ErrCodeSignatureTimestampInvalid),
	}
	if evTimestampInvalid.IsEligibleForReplay() {
		t.Errorf("expected timestamp invalid to be ineligible for replay")
	}

	// 5. Payload Malformed: INELIGIBLE
	evMalformed := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    0,
		IsVerified:  -1,
		FailureCode: string(ErrCodeSignaturePayloadMalformed),
	}
	if evMalformed.IsEligibleForReplay() {
		t.Errorf("expected malformed payload to be ineligible for replay")
	}

	// 6. Delivery failures: ELIGIBLE
	evDeliveryFailed := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    5,
		IsVerified:  1,
		FailureCode: string(ErrCodeHTTP5xx),
	}
	if !evDeliveryFailed.IsEligibleForReplay() {
		t.Errorf("expected delivery failure to be eligible for replay")
	}

	// 7. Legacy row without FailureCode: Signature Mismatch -> ELIGIBLE
	evLegacyMismatch := &WebhookEvent{
		Status:     StatusFailed,
		Attempts:   0,
		IsVerified: -1,
		LastError:  "cryptographic signature verification failed: generic signature mismatch",
	}
	if !evLegacyMismatch.IsEligibleForReplay() {
		t.Errorf("expected legacy mismatch to be eligible for replay")
	}

	// 8. Legacy row without FailureCode: Missing Header -> INELIGIBLE
	evLegacyMissingHeader := &WebhookEvent{
		Status:     StatusFailed,
		Attempts:   0,
		IsVerified: -1,
		LastError:  "cryptographic signature verification failed: missing signature header",
	}
	if evLegacyMissingHeader.IsEligibleForReplay() {
		t.Errorf("expected legacy missing header to be ineligible for replay")
	}

	// 9. Endpoint disabled (0 attempts, not verification rejection) -> ELIGIBLE
	evEndpointDisabled := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    0,
		IsVerified:  0,
		LastError:   "endpoint ep-test is disabled",
		FailureCode: string(ErrCodeDeliveryFailed),
	}
	if !evEndpointDisabled.IsEligibleForReplay() {
		t.Errorf("expected disabled endpoint to be eligible for replay")
	}
}

func TestClassifyEventError_DeliveryFailedWithZeroAttempts(t *testing.T) {
	ev := &WebhookEvent{
		Status:      StatusFailed,
		Attempts:    0,
		IsVerified:  0,
		LastError:   "endpoint ep-test is disabled",
		FailureCode: string(ErrCodeDeliveryFailed),
	}
	cls, code := ClassifyEventError(ev)
	if cls != string(ErrorClassDeliveryFailed) {
		t.Errorf("expected ErrorClassDeliveryFailed, got %s", cls)
	}
	if code != string(ErrCodeDeliveryFailed) {
		t.Errorf("expected ErrCodeDeliveryFailed, got %s", code)
	}
}

func TestNormalizeMaxAttempts(t *testing.T) {
	cases := []struct {
		name     string
		input    int
		expected int
	}{
		{name: "negative becomes default", input: -3, expected: DefaultMaxAttempts},
		{name: "zero becomes default", input: 0, expected: DefaultMaxAttempts},
		{name: "positive 1 preserved", input: 1, expected: 1},
		{name: "positive 3 preserved", input: 3, expected: 3},
		{name: "positive 5 preserved", input: 5, expected: 5},
		{name: "positive 10 preserved", input: 10, expected: 10},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeMaxAttempts(tc.input)
			if got != tc.expected {
				t.Errorf("NormalizeMaxAttempts(%d) = %d, expected %d", tc.input, got, tc.expected)
			}
		})
	}
}

func TestVerificationMaxAttemptsIndependentOfWebhookDefaultMaxAttempts(t *testing.T) {
	orig := DefaultMaxAttempts
	defer func() {
		DefaultMaxAttempts = orig
	}()

	DefaultMaxAttempts = 9

	if got := NormalizeMaxAttempts(0); got != 9 {
		t.Fatalf("expected webhook NormalizeMaxAttempts(0) to follow DefaultMaxAttempts=9, got %d", got)
	}
	if DefaultVerificationMaxAttempts != 5 {
		t.Fatalf("expected DefaultVerificationMaxAttempts to remain 5 when DefaultMaxAttempts=9, got %d", DefaultVerificationMaxAttempts)
	}
	if got := NormalizeVerificationMaxAttempts(0); got != 5 {
		t.Fatalf("expected NormalizeVerificationMaxAttempts(0) to remain 5 when DefaultMaxAttempts=9, got %d", got)
	}
}
