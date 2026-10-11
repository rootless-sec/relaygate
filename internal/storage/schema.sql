-- ============================================================================
-- RelayGate Database Schema
-- Embedded SQLite in WAL (Write-Ahead Logging) Mode
-- ============================================================================

CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    target_url TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'generic', -- generic, midtrans, stripe, xendit, github
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,                       -- UUID v4 or ULID
    endpoint_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_ip TEXT NOT NULL,
    headers TEXT NOT NULL,                     -- JSON serialized key-value map
    payload BLOB NOT NULL,                     -- Raw byte payload
    signature TEXT,                            -- Signature header if present
    is_verified INTEGER NOT NULL DEFAULT 0,    -- 0: unverified, 1: valid, -1: invalid
    status TEXT NOT NULL,                      -- 'PENDING', 'DELIVERED', 'FAILED', 'RETRYING'
    http_status_code INTEGER DEFAULT 0,        -- Last response from target
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error TEXT,
    next_retry_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(endpoint_id) REFERENCES endpoints(id)
);

CREATE INDEX IF NOT EXISTS idx_events_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_events_next_retry ON webhook_events(next_retry_at) WHERE status = 'RETRYING';
CREATE INDEX IF NOT EXISTS idx_events_created ON webhook_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_endpoint ON webhook_events(endpoint_id);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

