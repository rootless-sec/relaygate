import { Endpoint, OverviewData, StatsSummary, WebhookEvent } from './types';

const BASE_URL = '/api/v1';

async function parseErrorResponse(res: Response, fallback: string): Promise<Error> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {}

  if (res.status === 401) {
    try {
      localStorage.removeItem('relaygate_auth');
      window.dispatchEvent(
        new CustomEvent('relaygate_session_expired', {
          detail: { message: 'Sesi berakhir' },
        })
      );
    } catch {}
    return new Error('Sesi berakhir');
  }

  if (res.status === 403) {
    return new Error(data?.error || 'Akses ditolak. Anda tidak memiliki izin untuk tindakan ini.');
  }

  if (res.status === 409) {
    return new Error(data?.error || 'Konflik: Event ini sudah dalam status diproses ulang.');
  }

  if (res.status >= 500) {
    return new Error(data?.error || 'Terjadi kesalahan pada server RelayGate. Silakan coba sesaat lagi.');
  }

  return new Error(data?.error || fallback);
}

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
    throw await parseErrorResponse(res, 'Gagal memuat daftar event');
  }
  return res.json();
}

export async function fetchEvent(id: string, reveal = false): Promise<WebhookEvent> {
  const query = reveal ? '?reveal=1' : '';
  const headers: Record<string, string> = {};
  try {
    const stored = localStorage.getItem('relaygate_auth');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.token) {
        headers['Authorization'] = `Bearer ${parsed.token}`;
      }
    }
  } catch {}
  const res = await fetch(`${BASE_URL}/events/${encodeURIComponent(id)}${query}`, {
    headers,
  });
  if (!res.ok) {
    throw await parseErrorResponse(res, `Gagal memuat event ${id}`);
  }
  return res.json();
}

export async function replayEvent(id: string): Promise<{ status: string; id: string }> {
  const res = await fetch(`${BASE_URL}/events/${encodeURIComponent(id)}/replay`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw await parseErrorResponse(res, `Gagal memicu replay event ${id}`);
  }
  return res.json();
}

export async function bulkReplay(params: {
  ids?: string[];
  all_failed?: boolean;
  endpoint_id?: string;
}): Promise<{ replayed_count: number; skipped_count?: number }> {
  const res = await fetch(`${BASE_URL}/events/bulk-replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Gagal memproses replay massal');
  }
  return res.json();
}

export async function fetchEndpoints(): Promise<Endpoint[]> {
  const res = await fetch(`${BASE_URL}/endpoints`);
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Gagal memuat daftar endpoint');
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
    throw await parseErrorResponse(res, 'Gagal menambahkan endpoint');
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
    throw await parseErrorResponse(res, `Gagal mengubah endpoint ${id}`);
  }
  return res.json();
}

export async function fetchStats(): Promise<StatsSummary> {
  const res = await fetch(`${BASE_URL}/stats`);
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Gagal memuat statistik');
  }
  return res.json();
}

export async function fetchOverview(): Promise<OverviewData> {
  const res = await fetch(`${BASE_URL}/overview`);
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Gagal memuat overview');
  }
  return res.json();
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role?: string;
  created_at?: string;
}

export interface RegisterResult {
  status: string;
  message: string;
  email: string;
  dev_code?: string;
}

export async function loginUser(email: string, password: string): Promise<{ user: UserProfile; token?: string; message?: string }> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Email atau password tidak sesuai.');
  }
  return res.json();
}

export async function registerUser(name: string, email: string, password: string): Promise<RegisterResult> {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Gagal mendaftarkan akun.');
  }
  return res.json();
}

export async function verifyRegistrationCode(
  email: string,
  code: string
): Promise<{ user: UserProfile; token?: string; message?: string }> {
  const res = await fetch(`${BASE_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Kode verifikasi tidak valid.');
  }
  return res.json();
}

export async function resendVerificationCode(
  email: string
): Promise<{ message: string; dev_code?: string }> {
  const res = await fetch(`${BASE_URL}/auth/resend-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    throw await parseErrorResponse(res, 'Gagal mengirim ulang kode verifikasi.');
  }
  return res.json();
}


