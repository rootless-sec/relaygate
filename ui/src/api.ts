import { Endpoint, OverviewData, StatsSummary, WebhookEvent } from './types';

const BASE_URL = '/api/v1';

export async function fetchEvents(params: {
  page?: number;
  limit?: number;
  status?: string;
  endpoint_id?: string;
  search?: string;
} = {}): Promise<{ events: WebhookEvent[]; total: number; page: number; limit: number }> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', params.page.toString());
  if (params.limit) query.set('limit', params.limit.toString());
  if (params.status) query.set('status', params.status);
  if (params.endpoint_id) query.set('endpoint_id', params.endpoint_id);
  if (params.search) query.set('search', params.search);

  const res = await fetch(`${BASE_URL}/events?${query.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch events: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchEvent(id: string): Promise<WebhookEvent> {
  const res = await fetch(`${BASE_URL}/events/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch event ${id}: ${res.statusText}`);
  }
  return res.json();
}

export async function replayEvent(id: string): Promise<{ status: string; id: string }> {
  const res = await fetch(`${BASE_URL}/events/${encodeURIComponent(id)}/replay`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Failed to replay event ${id}: ${res.statusText}`);
  }
  return res.json();
}

export async function bulkReplay(params: {
  ids?: string[];
  all_failed?: boolean;
  endpoint_id?: string;
}): Promise<{ replayed_count: number }> {
  const res = await fetch(`${BASE_URL}/events/bulk-replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`Failed bulk replay: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchEndpoints(): Promise<Endpoint[]> {
  const res = await fetch(`${BASE_URL}/endpoints`);
  if (!res.ok) {
    throw new Error(`Failed to fetch endpoints: ${res.statusText}`);
  }
  const data = await res.json();
  return data.endpoints || [];
}

export async function createEndpoint(data: {
  name: string;
  provider: string;
  target_url: string;
  secret_key?: string;
}): Promise<Endpoint> {
  const res = await fetch(`${BASE_URL}/endpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to create endpoint');
  }
  return res.json();
}

export async function updateEndpoint(
  id: string,
  data: {
    name?: string;
    provider?: string;
    target_url?: string;
    secret_key?: string;
    is_active?: boolean;
  }
): Promise<Endpoint> {
  const res = await fetch(`${BASE_URL}/endpoints/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Failed to update endpoint ${id}: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchStats(): Promise<StatsSummary> {
  const res = await fetch(`${BASE_URL}/stats`);
  if (!res.ok) {
    throw new Error(`Failed to fetch stats: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchOverview(): Promise<OverviewData> {
  const res = await fetch(`${BASE_URL}/overview`);
  if (!res.ok) {
    throw new Error(`Failed to fetch overview: ${res.statusText}`);
  }
  return res.json();
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  created_at?: string;
}

export async function loginUser(email: string, password: string): Promise<{ user: UserProfile; message?: string }> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Autentikasi gagal' }));
    throw new Error(data.error || 'Email atau password tidak sesuai.');
  }
  return res.json();
}

export async function registerUser(name: string, email: string, password: string): Promise<{ user: UserProfile; message?: string }> {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Registrasi gagal' }));
    throw new Error(data.error || 'Gagal mendaftarkan akun.');
  }
  return res.json();
}

