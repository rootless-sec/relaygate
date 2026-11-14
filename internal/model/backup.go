package model

import "time"

// BackupResult holds metadata about a completed SQLite hot backup snapshot
type BackupResult struct {
	DestinationPath string    `json:"destination_path"`
	SizeBytes       int64     `json:"size_bytes"`
	DurationMs      int64     `json:"duration_ms"`
	CreatedAt       time.Time `json:"created_at"`
}

// BackupRequest represents the payload for triggering a backup snapshot
type BackupRequest struct {
	DestinationPath string `json:"destination_path,omitempty"`
}
