package model

import (
	"strings"
	"time"
)

// ProviderType defines supported webhook providers
type ProviderType string

const (
	ProviderGeneric  ProviderType = "generic"
	ProviderMidtrans ProviderType = "midtrans"
	ProviderStripe   ProviderType = "stripe"
	ProviderXendit   ProviderType = "xendit"
	ProviderGithub   ProviderType = "github"
)

// EventStatus defines delivery and processing lifecycle state
type EventStatus string

const (
	StatusPending   EventStatus = "PENDING"
	StatusDelivered EventStatus = "DELIVERED"
	StatusFailed    EventStatus = "FAILED"
	StatusRetrying  EventStatus = "RETRYING"
)

// DefaultMaxAttempts is the single canonical default webhook retry limit across ingest, storage, and worker dispatch.
var DefaultMaxAttempts = 5

// NormalizeMaxAttempts returns maxAttempts if positive, or DefaultMaxAttempts when <= 0.
func NormalizeMaxAttempts(maxAttempts int) int {
	if maxAttempts <= 0 {
		return DefaultMaxAttempts
	}
	return maxAttempts
}

// WebhookEvent represents an incoming webhook transaction record
type WebhookEvent struct {
	ID             string            `json:"id"`
	EndpointID     string            `json:"endpoint_id"`
	Provider       ProviderType      `json:"provider"`
	SourceIP       string            `json:"source_ip"`
	Headers        map[string]string `json:"headers"`
	Payload        []byte            `json:"payload"`
	Signature      string            `json:"signature,omitempty"`
	IsVerified     int               `json:"is_verified"` // 1: valid, 0: skipped/unknown, -1: invalid
	Status         EventStatus       `json:"status"`
	HTTPStatusCode int               `json:"http_status_code"`
	Attempts       int               `json:"attempts"`
	MaxAttempts    int               `json:"max_attempts"`
	LastError      string            `json:"last_error,omitempty"`
	NextRetryAt    *time.Time        `json:"next_retry_at,omitempty"`
	FailureCode    string            `json:"failure_code,omitempty"`
	FailedAt       *time.Time        `json:"failed_at,omitempty"`
	ErrorCode        string            `json:"error_code,omitempty"`
	ErrorClass       string            `json:"error_class,omitempty"`
	VerificationKind string            `json:"verification_kind,omitempty"`
	CreatedAt        time.Time         `json:"created_at"`
	UpdatedAt        time.Time         `json:"updated_at"`
}

// IsEligibleForReplay returns whether the event is eligible for replay.
// For verification failures, only SIGNATURE_MISMATCH is eligible (where updating the secret key allows retry).
// Missing headers, malformed payloads, and expired/invalid timestamps cannot be fixed by replay.
// Delivery failures (including any downstream errors or system errors) are always eligible.
// PENDING and DELIVERED events are never eligible.
func (e *WebhookEvent) IsEligibleForReplay() bool {
	if e == nil {
		return false
	}
	if e.Status == StatusPending || e.Status == StatusDelivered {
		return false
	}
	code := e.FailureCode
	if code == "" {
		code = e.ErrorCode
	}
	if code == "" && (e.Status == StatusFailed || e.Status == StatusRetrying) {
		_, inferred := InferFailureCode(e.LastError, e.HTTPStatusCode, e.Attempts, e.IsVerified)
		code = string(inferred)
	}

	switch ErrorCode(code) {
	case ErrCodeSignatureHeaderMissing,
		ErrCodeSignatureTimestampExpired,
		ErrCodeSignatureTimestampInvalid,
		ErrCodeSignaturePayloadMalformed,
		"PAYLOAD_CORRUPT":
		return false
	default:
		return true
	}
}

// ErrorClass defines high-level DLQ failure category
type ErrorClass string

const (
	ErrorClassVerificationRejected ErrorClass = "VERIFICATION_REJECTED"
	ErrorClassDeliveryFailed       ErrorClass = "DELIVERY_FAILED"
)

// ErrorCode defines structured failure reason
type ErrorCode string

const (
	// Verification failure codes
	ErrCodeSignatureHeaderMissing   ErrorCode = "SIGNATURE_HEADER_MISSING"
	ErrCodeSignatureMismatch        ErrorCode = "SIGNATURE_MISMATCH"
	ErrCodeSignatureTimestampExpired ErrorCode = "SIGNATURE_TIMESTAMP_EXPIRED"
	ErrCodeSignatureTimestampInvalid ErrorCode = "SIGNATURE_TIMESTAMP_INVALID"
	ErrCodeSignaturePayloadMalformed ErrorCode = "SIGNATURE_PAYLOAD_MALFORMED"

	// Delivery failure codes
	ErrCodeTimeout       ErrorCode = "TIMEOUT"
	ErrCodeHTTP5xx       ErrorCode = "HTTP_5XX"
	ErrCodeHTTP4xx       ErrorCode = "HTTP_4XX"
	ErrCodeNetworkError  ErrorCode = "NETWORK_ERROR"
	ErrCodeDeliveryFailed ErrorCode = "DELIVERY_FAILED"
)

// Endpoint represents a configured target webhook routing destination
type Endpoint struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	SecretKey string       `json:"secret_key"`
	TargetURL string       `json:"target_url"`
	Provider  ProviderType `json:"provider"`
	IsActive  bool         `json:"is_active"`
	CreatedAt time.Time    `json:"created_at"`
}

// IngestResponse represents the immediate response given to webhook providers
type IngestResponse struct {
	Status  string `json:"status"`
	EventID string `json:"event_id"`
	Message string `json:"message"`
}

// StatsSummary represents global dashboard metrics
type StatsSummary struct {
	TotalEvents     int64 `json:"total_events"`
	DeliveredEvents int64 `json:"delivered_events"`
	PendingEvents   int64 `json:"pending_events"`
	RetryingEvents  int64 `json:"retrying_events"`
	FailedEvents    int64 `json:"failed_events"`
}

// DeliveryLogEntry represents a delivery attempt log in the timeline
type DeliveryLogEntry struct {
	Attempt    int       `json:"attempt"`
	StatusCode int       `json:"code"`
	DurationMs int64     `json:"ms"`
	Error      string    `json:"err,omitempty"`
	CreatedAt  time.Time `json:"t"`
}

// Broadcaster defines a real-time event notification sink
type Broadcaster interface {
	Broadcast(eventType string, data any)
}

// InferFailureCode maps raw error messages and HTTP status codes to canonical ErrorClass and ErrorCode.
// This is the SINGLE canonical fallback mapping for legacy database rows lacking failure_code.
func InferFailureCode(lastError string, httpStatusCode int, attempts int, isVerified int) (ErrorClass, ErrorCode) {
	errLower := strings.ToLower(lastError)

	// If HTTP status code is present (reached downstream), it's a delivery failure
	if httpStatusCode >= 500 {
		return ErrorClassDeliveryFailed, ErrCodeHTTP5xx
	}
	if httpStatusCode >= 400 {
		return ErrorClassDeliveryFailed, ErrCodeHTTP4xx
	}

	// 1. Verification rejected: explicit verification invalid (-1) or (0 attempts and not explicitly verified)
	if isVerified == -1 || (attempts == 0 && isVerified != 1 && (strings.Contains(errLower, "signature") || strings.Contains(errLower, "payload") || strings.Contains(errLower, "header") || strings.Contains(errLower, "token") || strings.Contains(errLower, "midtrans") || strings.Contains(errLower, "stripe") || strings.Contains(errLower, "github") || strings.Contains(errLower, "xendit"))) {
		switch {
		case strings.Contains(errLower, "missing signature header") ||
			strings.Contains(errLower, "missing stripe-signature") ||
			strings.Contains(errLower, "missing x-hub-signature") ||
			strings.Contains(errLower, "missing x-callback-token") ||
			strings.Contains(errLower, "signature_key not found"):
			return ErrorClassVerificationRejected, ErrCodeSignatureHeaderMissing

		case strings.Contains(errLower, "too old") || strings.Contains(errLower, "tolerance"):
			return ErrorClassVerificationRejected, ErrCodeSignatureTimestampExpired

		case strings.Contains(errLower, "missing timestamp") ||
			strings.Contains(errLower, "invalid stripe timestamp") ||
			strings.Contains(errLower, "missing v1 signature"):
			return ErrorClassVerificationRejected, ErrCodeSignatureTimestampInvalid

		case strings.Contains(errLower, "empty midtrans payload") ||
			strings.Contains(errLower, "failed to parse midtrans") ||
			strings.Contains(errLower, "midtrans missing required fields") ||
			strings.Contains(errLower, "json parse") ||
			strings.Contains(errLower, "malformed") ||
			strings.Contains(errLower, "corrupt"):
			return ErrorClassVerificationRejected, ErrCodeSignaturePayloadMalformed

		default:
			return ErrorClassVerificationRejected, ErrCodeSignatureMismatch
		}
	}

	// 2. Delivery failed
	if strings.Contains(errLower, "timeout") || strings.Contains(errLower, "deadline exceeded") {
		return ErrorClassDeliveryFailed, ErrCodeTimeout
	}
	if strings.Contains(errLower, "connection refused") ||
		strings.Contains(errLower, "dial tcp") ||
		strings.Contains(errLower, "network") ||
		strings.Contains(errLower, "no such host") {
		return ErrorClassDeliveryFailed, ErrCodeNetworkError
	}

	return ErrorClassDeliveryFailed, ErrCodeDeliveryFailed
}

// ClassifyEventError categorizes failure into structured class and code for an event
func ClassifyEventError(ev *WebhookEvent) (string, string) {
	if ev == nil || (ev.Status != StatusFailed && ev.Status != StatusRetrying) {
		return "", ""
	}
	if ev.FailureCode != "" {
		cls := ErrorClassDeliveryFailed
		if strings.HasPrefix(ev.FailureCode, "SIGNATURE_") || ev.IsVerified == -1 {
			cls = ErrorClassVerificationRejected
		}
		return string(cls), ev.FailureCode
	}
	cls, code := InferFailureCode(ev.LastError, ev.HTTPStatusCode, ev.Attempts, ev.IsVerified)
	return string(cls), string(code)
}



