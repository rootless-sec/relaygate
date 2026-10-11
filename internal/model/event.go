package model

import "time"

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
	CreatedAt      time.Time         `json:"created_at"`
	UpdatedAt      time.Time         `json:"updated_at"`
}

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

