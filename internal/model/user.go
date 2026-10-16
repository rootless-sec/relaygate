package model

import "time"

// User represents an authenticated RelayGate user account
type User struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Email        string    `json:"email"`
	Role         string    `json:"role"` // "admin" or "viewer"
	PasswordHash string    `json:"-"`
	CreatedAt    time.Time `json:"created_at"`
}

// Session represents an authenticated session associated with a user
type Session struct {
	Token        string    `json:"token"`
	UserID       string    `json:"user_id"`
	UserEmail    string    `json:"user_email"`
	Role         string    `json:"role"`
	ExpiresAt    time.Time `json:"expires_at"`
	LastActiveAt time.Time `json:"last_active_at"`
	CreatedAt    time.Time `json:"created_at"`
}

// AuditReveal records when an admin reveals sensitive headers for an event
type AuditReveal struct {
	ID                  string    `json:"id"`
	EventID             string    `json:"event_id"`
	UserID              string    `json:"user_id"`
	UserEmail           string    `json:"user_email"`
	RevealedHeaderNames string    `json:"revealed_header_names"` // Comma-separated list of sensitive header names ONLY, NO header values!
	IPAddress           string    `json:"ip_address"`
	CreatedAt           time.Time `json:"created_at"`
}

// DefaultVerificationMaxAttempts defines the default maximum OTP verification attempts for email registration.
const DefaultVerificationMaxAttempts = 5

// NormalizeVerificationMaxAttempts returns maxAttempts if positive, or DefaultVerificationMaxAttempts when <= 0.
func NormalizeVerificationMaxAttempts(maxAttempts int) int {
	if maxAttempts <= 0 {
		return DefaultVerificationMaxAttempts
	}
	return maxAttempts
}

// EmailVerification represents a pending registration email OTP
type EmailVerification struct {
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	PasswordHash string    `json:"-"`
	Code         string    `json:"-"`
	Attempts     int       `json:"attempts"`
	MaxAttempts  int       `json:"max_attempts"`
	LastSentAt   time.Time `json:"last_sent_at"`
	ExpiresAt    time.Time `json:"expires_at"`
	CreatedAt    time.Time `json:"created_at"`
}

