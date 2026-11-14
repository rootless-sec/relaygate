export type ProviderType = 'generic' | 'midtrans' | 'stripe' | 'xendit' | 'github' | 'shopify' | 'doku' | 'flip';

export type EventStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'RETRYING';

export interface DeliveryLogEntry {
  attempt: number;
  code: number;
  ms: number;
  err?: string;
  t: string;
}

export interface WebhookEvent {
  id: string;
  endpoint_id: string;
  provider: ProviderType;
  source_ip: string;
  headers: Record<string, string>;
  payload?: any;
  payload_json?: any;
  payload_raw: string;
  signature?: string;
  is_verified: number; // 1: valid, 0: skipped, -1: invalid
  status: EventStatus;
  http_status_code: number;
  attempts: number;
  max_attempts: number;
  last_error?: string;
  next_retry_at?: string | null;
  created_at: string;
  updated_at: string;
  failed_at?: string;
  delivery_log?: DeliveryLogEntry[];
  failure_code?: string;
  error_code?: string;
  error_class?: 'VERIFICATION_REJECTED' | 'DELIVERY_FAILED';
  verification_kind?: 'static_token' | 'hmac' | 'hash';
}

export interface EndpointDestination {
  url: string;
  max_attempts?: number;
}

export interface Endpoint {
  id: string;
  name: string;
  secret_key: string;
  target_url: string;
  target_urls?: string[];
  destinations?: EndpointDestination[];
  wrap_envelope?: boolean;
  notification_url?: string;
  telegram_webhook?: string;
  telegram_chat_id?: string;
  discord_webhook?: string;
  slack_webhook?: string;
  notification_email?: string;
  provider: ProviderType;
  is_active: boolean;
  agent_token?: string;
  agent_connected?: boolean;
  created_at: string;
}

export interface BackupResult {
  destination_path: string;
  size_bytes: number;
  duration_ms: number;
  created_at: string;
}

export interface StatsSummary {
  total_events: number;
  delivered_events: number;
  pending_events?: number;
  retrying_events: number;
  failed_events: number;
}

export interface ThroughputBucket {
  index: number;
  total: number;
  failed: number;
  label: string;
}

export interface EndpointBreakdown {
  id: string;
  name: string;
  provider: ProviderType;
  total: number;
  delivered: number;
  failed: number;
  success_rate: number;
}

export interface OverviewData {
  stats: StatsSummary;
  throughput: ThroughputBucket[];
  endpoint_breakdown: EndpointBreakdown[];
  recent_failed: WebhookEvent[];
}

export type NavTab = 'overview' | 'events' | 'dead' | 'endpoints';
