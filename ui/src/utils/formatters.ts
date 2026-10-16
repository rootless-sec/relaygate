import { WebhookEvent } from '../types';

/**
 * Format timestamp into relative Indonesian time.
 */
export function formatRelativeTime(isoString?: string): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 0) return 'baru saja';
    if (diffSec < 60) return `${Math.max(1, diffSec)} detik lalu`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} menit lalu`;

    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours} jam lalu`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays} hari lalu`;

    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths} bulan lalu`;

    return `${Math.floor(diffMonths / 12)} tahun lalu`;
  } catch {
    return isoString;
  }
}

/**
 * Format timestamp into full absolute Indonesian time.
 */
export function formatAbsoluteTime(isoString?: string): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

/**
 * Human-friendly source IP representation.
 */
export function formatSourceIP(ip?: string): string {
  if (!ip || ip.trim() === '') return 'Tidak diketahui';
  const trimmed = ip.trim();
  if (trimmed === '::1') return 'localhost (IPv6)';
  if (trimmed === '127.0.0.1') return 'localhost (IPv4)';
  return trimmed;
}

export function getExpectedHeaderForProvider(provider?: string): string {
  switch (provider?.toLowerCase()) {
    case 'stripe':
      return 'Stripe-Signature';
    case 'github':
      return 'X-Hub-Signature-256';
    case 'xendit':
      return 'X-Callback-Token';
    case 'midtrans':
      return 'signature_key';
    default:
      return 'X-Signature-SHA256';
  }
}

/**
 * Extract sorted list of received header names (keys only, no values).
 */
export function getReceivedHeaderNames(headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) {
    return '(tidak ada)';
  }
  return Object.keys(headers)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}

/**
 * Determine whether a header key contains sensitive credentials.
 */
export function isSensitiveHeader(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === 'authorization' ||
    lower === 'proxy-authorization' ||
    lower === 'cookie' ||
    lower === 'set-cookie' ||
    lower === 'x-callback-token' ||
    lower === 'stripe-signature' ||
    lower === 'x-api-key' ||
    lower.startsWith('x-hub-signature') ||
    lower === 'x-signature-sha256' ||
    lower === 'x-signature' ||
    lower === 'signature' ||
    lower === 'x-signature-key' ||
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('signature') ||
    lower.includes('auth') ||
    lower.includes('password') ||
    lower.includes('key') ||
    lower.includes('cookie')
  );
}

export type DLQClassType = 'VERIFICATION_REJECTED' | 'DELIVERY_FAILED';

export type ErrorCodeType =
  | 'SIGNATURE_HEADER_MISSING'
  | 'SIGNATURE_MISMATCH'
  | 'SIGNATURE_TIMESTAMP_EXPIRED'
  | 'SIGNATURE_TIMESTAMP_INVALID'
  | 'SIGNATURE_PAYLOAD_MALFORMED'
  | 'TIMEOUT'
  | 'HTTP_5XX'
  | 'HTTP_4XX'
  | 'NETWORK_ERROR'
  | 'DELIVERY_FAILED';

export const FAILURE_FAMILY_KEYS = [
  'SIGNATURE_MISMATCH',
  'SIGNATURE_HEADER_MISSING',
  'SIGNATURE_TIMESTAMP_EXPIRED',
  'SIGNATURE_TIMESTAMP_INVALID',
  'SIGNATURE_PAYLOAD_MALFORMED',
  'HTTP_4XX',
  'HTTP_5XX',
  'TIMEOUT',
] as const;

export type FailureFamilyKey = typeof FAILURE_FAMILY_KEYS[number];

export const FAILURE_CODE_LABELS: Record<string, string> = {
  SIGNATURE_MISMATCH: 'Signature/token tidak cocok',
  SIGNATURE_HEADER_MISSING: 'Signature/token hilang',
  SIGNATURE_TIMESTAMP_EXPIRED: 'Timestamp kedaluwarsa',
  SIGNATURE_TIMESTAMP_INVALID: 'Timestamp tidak valid',
  SIGNATURE_PAYLOAD_MALFORMED: 'Payload rusak',
  HTTP_4XX: 'Downstream menolak (4xx)',
  HTTP_5XX: 'Downstream error (5xx)',
  TIMEOUT: 'Timeout/jaringan',
  NETWORK_ERROR: 'Timeout/jaringan',
  DELIVERY_FAILED: 'Downstream error (5xx)',
};

export function formatFailureCodeLabel(code?: string): string {
  if (!code) return '';
  if (FAILURE_CODE_LABELS[code]) {
    return FAILURE_CODE_LABELS[code];
  }
  const upper = code.toUpperCase();
  if (upper.startsWith('HTTP_5') || upper === 'DELIVERY_FAILED') return 'Downstream error (5xx)';
  if (upper.startsWith('HTTP_4')) return 'Downstream menolak (4xx)';
  if (upper.includes('TIMEOUT') || upper.includes('NETWORK')) return 'Timeout/jaringan';
  if (upper.includes('HEADER_MISSING')) return 'Signature/token hilang';
  if (upper.includes('EXPIRED')) return 'Timestamp kedaluwarsa';
  if (upper.includes('INVALID') && upper.includes('TIMESTAMP')) return 'Timestamp tidak valid';
  if (upper.includes('PAYLOAD') || upper.includes('MALFORMED')) return 'Payload rusak';
  if (upper.includes('MISMATCH') || upper.startsWith('SIGNATURE_')) return 'Signature/token tidak cocok';
  return 'Downstream error (5xx)';
}

export function isFailureCodeInFamily(
  eventCodeOrFailureCode?: string,
  family?: string,
  statusCode?: number
): boolean {
  if (!family) return true;
  const raw = (eventCodeOrFailureCode || '').toUpperCase();
  const status = statusCode || 0;

  switch (family) {
    case 'SIGNATURE_MISMATCH':
      return raw === 'SIGNATURE_MISMATCH' || (raw.startsWith('SIGNATURE_') && !raw.includes('HEADER') && !raw.includes('TIMESTAMP') && !raw.includes('PAYLOAD'));
    case 'SIGNATURE_HEADER_MISSING':
      return raw === 'SIGNATURE_HEADER_MISSING' || raw.includes('HEADER_MISSING');
    case 'SIGNATURE_TIMESTAMP_EXPIRED':
      return raw === 'SIGNATURE_TIMESTAMP_EXPIRED' || raw.includes('EXPIRED');
    case 'SIGNATURE_TIMESTAMP_INVALID':
      return raw === 'SIGNATURE_TIMESTAMP_INVALID' || (raw.includes('TIMESTAMP') && raw.includes('INVALID'));
    case 'SIGNATURE_PAYLOAD_MALFORMED':
      return raw === 'SIGNATURE_PAYLOAD_MALFORMED' || raw.includes('PAYLOAD') || raw.includes('MALFORMED');
    case 'HTTP_4XX':
      return raw === 'HTTP_4XX' || raw.startsWith('HTTP_4') || (status >= 400 && status < 500);
    case 'HTTP_5XX':
      return raw === 'HTTP_5XX' || raw.startsWith('HTTP_5') || raw === 'DELIVERY_FAILED' || status >= 500;
    case 'TIMEOUT':
      return raw === 'TIMEOUT' || raw === 'NETWORK_ERROR' || raw.includes('TIMEOUT') || raw.includes('NETWORK');
    default:
      return raw === family;
  }
}

export type ErrorCategoryType = 'signature' | 'http5xx' | 'http4xx' | 'timeout' | 'network' | 'other';

export interface ErrorAnalysis {
  type: ErrorCategoryType;
  code: ErrorCodeType;
  class: DLQClassType;
  badgeLabel: string;
  badgeStyle: string;
  title: string;
  summary: string;
  advice: string[];
  expectedHeader?: string;
  receivedHeadersList?: string;
  isEligibleForReplay: boolean;
  isEligibleForBulkReplay: boolean;
  ineligibleReason?: string;
  ineligibleHelperText?: string;
}

/**
 * Categorize error and provide root-cause explanation + remediation steps.
 * Maps backend failure_code directly to UI copy without frontend string matching.
 */
export function analyzeEventError(event: WebhookEvent): ErrorAnalysis {
  const statusCode = event.http_status_code || 0;
  const rawCode = event.failure_code || event.error_code || '';
  const code: ErrorCodeType = (rawCode as ErrorCodeType) || (statusCode >= 400 ? (statusCode >= 500 ? 'HTTP_5XX' : 'HTTP_4XX') : 'DELIVERY_FAILED');
  
  const isRejected =
    code.startsWith('SIGNATURE_') ||
    event.is_verified === -1;

  const cls: DLQClassType =
    (event.error_class as DLQClassType) ||
    (isRejected ? 'VERIFICATION_REJECTED' : 'DELIVERY_FAILED');
  const expectedHeader = getExpectedHeaderForProvider(event.provider);
  const providerDisplay = event.provider ? event.provider.toUpperCase() : 'provider';

  switch (code) {
    case 'SIGNATURE_HEADER_MISSING': {
      const isStaticToken = event.verification_kind === 'static_token' || (event.provider || '').toLowerCase() === 'xendit';
      const receivedHeadersList = getReceivedHeaderNames(event.headers);
      if (isStaticToken) {
        return {
          type: 'signature',
          code,
          class: cls,
          badgeLabel: 'Token hilang',
          badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
          title: 'Token callback Xendit tidak ditemukan',
          summary: '',
          advice: [
            'Aktifkan pengiriman header X-Callback-Token pada konfigurasi webhook di dashboard Xendit.',
            'Minta provider mengirim ulang webhook jika datanya masih dibutuhkan downstream.',
          ],
          expectedHeader,
          receivedHeadersList,
          isEligibleForReplay: false,
          isEligibleForBulkReplay: false,
          ineligibleReason: 'Permintaan tersimpan tanpa header token callback dari provider. Perbaiki konfigurasi webhook agar event baru lolos, atau minta pengiriman ulang.',
          ineligibleHelperText: 'Tidak bisa diverifikasi ulang karena header token callback tidak pernah diterima.',
        };
      }
      return {
        type: 'signature',
        code,
        class: cls,
        badgeLabel: 'Header hilang',
        badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
        title: 'Header signature tidak ditemukan',
        summary: '',
        advice: [
          `Aktifkan pengiriman header ${expectedHeader} pada konfigurasi webhook di portal provider.`,
          `Minta provider mengirim ulang webhook jika datanya masih dibutuhkan downstream.`,
        ],
        expectedHeader,
        receivedHeadersList,
        isEligibleForReplay: false,
        isEligibleForBulkReplay: false,
        ineligibleReason: 'Permintaan tersimpan tanpa header signature dari provider. Perbaiki konfigurasi webhook agar event baru lolos, atau minta pengiriman ulang.',
        ineligibleHelperText: 'Tidak bisa diverifikasi ulang karena header signature tidak pernah diterima.',
      };
    }

    case 'SIGNATURE_MISMATCH': {
      const prov = (event.provider || '').toLowerCase();
      if (event.verification_kind === 'static_token' || prov === 'xendit') {
        return {
          type: 'signature',
          code,
          class: cls,
          badgeLabel: 'Token tidak cocok',
          badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
          title: 'Token callback Xendit tidak cocok',
          summary: 'Token callback pada header X-Callback-Token tidak sesuai dengan secret key endpoint RelayGate.',
          advice: [
            'Samakan Secret Key di menu Endpoints RelayGate dengan Verification Token di dashboard pengembang Xendit.',
          ],
          expectedHeader,
          isEligibleForReplay: true,
          isEligibleForBulkReplay: true,
        };
      }
      if (prov === 'midtrans') {
        return {
          type: 'signature',
          code,
          class: cls,
          badgeLabel: 'Signature tidak cocok',
          badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
          title: 'Hash signature Midtrans tidak cocok',
          summary: 'Hasil perhitungan SHA512(order_id + status_code + gross_amount + ServerKey) tidak cocok dengan signature_key.',
          advice: [
            'Samakan Server Key di menu Endpoints RelayGate dengan Server Key di dashboard Midtrans.',
            'Periksa kesesuaian nilai order_id, status_code, dan gross_amount pada payload transaksi.',
            'Klik Verifikasi ulang & kirim setelah Server Key diperbaiki.',
          ],
          expectedHeader,
          isEligibleForReplay: true,
          isEligibleForBulkReplay: true,
        };
      }
      if (prov === 'stripe') {
        return {
          type: 'signature',
          code,
          class: cls,
          badgeLabel: 'Signature tidak cocok',
          badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
          title: 'Signature v1 Stripe tidak cocok',
          summary: 'HMAC-SHA256 dari timestamp dan payload tidak cocok dengan v1 signature pada header Stripe-Signature.',
          advice: [
            'Samakan signing secret (whsec_...) di menu Endpoints RelayGate dengan dashboard Stripe.',
            'Pastikan proxy, CDN, atau WAF di antara Stripe dan RelayGate tidak mengubah body atau header request.',
            'Klik Verifikasi ulang & kirim setelah secret diperbaiki.',
          ],
          expectedHeader,
          isEligibleForReplay: true,
          isEligibleForBulkReplay: true,
        };
      }
      if (prov === 'github') {
        return {
          type: 'signature',
          code,
          class: cls,
          badgeLabel: 'Signature tidak cocok',
          badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
          title: 'Signature X-Hub GitHub tidak cocok',
          summary: 'HMAC-SHA256 dari payload tidak cocok dengan signature pada header X-Hub-Signature-256.',
          advice: [
            'Samakan Webhook Secret di menu Endpoints RelayGate dengan secret di dashboard GitHub.',
            'Pastikan reverse proxy atau WAF di antara GitHub dan RelayGate tidak memodifikasi raw payload.',
            'Klik Verifikasi ulang & kirim setelah secret diperbaiki.',
          ],
          expectedHeader,
          isEligibleForReplay: true,
          isEligibleForBulkReplay: true,
        };
      }
      return {
        type: 'signature',
        code,
        class: cls,
        badgeLabel: 'Signature tidak cocok',
        badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
        title: 'Signature HMAC tidak cocok',
        summary: `Signature yang dikirim ${providerDisplay} tidak cocok dengan hasil perhitungan RelayGate.`,
        advice: [
          'Samakan secret key di menu Endpoints RelayGate dengan signing secret di dashboard provider.',
          'Pastikan proxy, CDN, atau WAF di antara provider dan RelayGate tidak memodifikasi raw payload.',
          'Klik Verifikasi ulang & kirim setelah secret diperbaiki.',
        ],
        expectedHeader,
        isEligibleForReplay: true,
        isEligibleForBulkReplay: true,
      };
    }

    case 'SIGNATURE_TIMESTAMP_EXPIRED':
      return {
        type: 'signature',
        code,
        class: cls,
        badgeLabel: 'Timestamp kedaluwarsa',
        badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
        title: 'Timestamp signature kedaluwarsa',
        summary: `Timestamp signature dari ${providerDisplay} telah melewati batas toleransi waktu RelayGate.`,
        advice: [
          'Sinkronkan jam server RelayGate menggunakan NTP agar selaras dengan waktu standar.',
          'Minta provider mengirim ulang webhook untuk transaksi ini.',
        ],
        expectedHeader,
        isEligibleForReplay: false,
        isEligibleForBulkReplay: false,
        ineligibleReason: 'Toleransi waktu kedaluwarsa telah terlampaui pada saat penerimaan request. Sinkronkan waktu server agar transaksi berikutnya lolos, atau minta pengiriman ulang.',
        ineligibleHelperText: 'Tidak bisa diverifikasi ulang karena timestamp signature sudah kedaluwarsa.',
      };

    case 'SIGNATURE_TIMESTAMP_INVALID':
      return {
        type: 'signature',
        code,
        class: cls,
        badgeLabel: 'Timestamp tidak valid',
        badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
        title: 'Format timestamp signature tidak valid',
        summary: `Header signature dari ${providerDisplay} tidak membawa format timestamp yang valid.`,
        advice: [
          'Periksa format header signature yang dikirimkan pada portal provider.',
          'Minta provider mengirim ulang webhook dengan format timestamp yang benar.',
        ],
        expectedHeader,
        isEligibleForReplay: false,
        isEligibleForBulkReplay: false,
        ineligibleReason: 'Format penanda waktu pada request tersimpan tidak memenuhi standar yang diharapkan.',
        ineligibleHelperText: 'Tidak bisa diverifikasi ulang karena parameter waktu signature tidak dikenali.',
      };

    case 'SIGNATURE_PAYLOAD_MALFORMED':
      return {
        type: 'signature',
        code,
        class: cls,
        badgeLabel: 'Payload rusak',
        badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
        title: 'Payload webhook rusak',
        summary: `Payload dari ${providerDisplay} kosong, bukan JSON valid, atau field wajib untuk verifikasi signature tidak lengkap.`,
        advice: [
          'Periksa body request webhook di portal developer provider.',
          'Minta provider mengirim ulang payload dengan struktur data yang lengkap dan valid.',
        ],
        expectedHeader,
        isEligibleForReplay: false,
        isEligibleForBulkReplay: false,
        ineligibleReason: 'Struktur payload tersimpan tidak memenuhi format JSON valid atau atribut wajib tidak lengkap.',
        ineligibleHelperText: 'Tidak bisa diverifikasi ulang karena struktur payload tidak dapat diproses.',
      };

    case 'TIMEOUT':
      return {
        type: 'timeout',
        code,
        class: cls,
        badgeLabel: 'Timeout',
        badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
        title: 'Koneksi ke downstream timeout',
        summary: 'RelayGate tidak menerima respons dari target endpoint dalam batas waktu toleransi HTTP client.',
        advice: [
          'Periksa latensi jaringan dan daya tanggap endpoint downstream.',
          'Konfigurasikan endpoint downstream agar memproses webhook secara asinkron.',
          'Klik Replay setelah performa downstream kembali normal.',
        ],
        isEligibleForReplay: true,
        isEligibleForBulkReplay: true,
      };

    case 'HTTP_5XX':
      if (statusCode === 504) {
        return {
          type: 'http5xx',
          code,
          class: cls,
          badgeLabel: 'HTTP 504',
          badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
          title: 'Gateway downstream timeout (HTTP 504)',
          summary: 'Server di depan aplikasi downstream (reverse proxy/load balancer) tidak menerima respons tepat waktu dari aplikasi.',
          advice: [
            'Ubah downstream agar membalas HTTP 2xx cepat lalu memproses webhook di background worker.',
            'Periksa dan tingkatkan batas timeout pada reverse proxy atau API gateway downstream.',
            'Klik Replay setelah server downstream kembali responsif.',
          ],
          isEligibleForReplay: true,
          isEligibleForBulkReplay: true,
        };
      }
      if (statusCode === 502 || statusCode === 503) {
        return {
          type: 'http5xx',
          code,
          class: cls,
          badgeLabel: `HTTP ${statusCode}`,
          badgeStyle: 'bg-amber-50 text-amber-800 border-amber-200',
          title: `Downstream tidak terjangkau (HTTP ${statusCode})`,
          summary: 'Server atau reverse proxy downstream mengindikasikan layanan tidak tersedia atau kelebihan beban (overload).',
          advice: [
            'Pastikan service aplikasi downstream berjalan dan port listener aktif.',
            'Periksa utilisasi resource (CPU, memori) server downstream dari lonjakan beban.',
            'Klik Replay setelah service downstream kembali online.',
          ],
          isEligibleForReplay: true,
          isEligibleForBulkReplay: true,
        };
      }
      return {
        type: 'http5xx',
        code,
        class: cls,
        badgeLabel: `HTTP ${statusCode || 500}`,
        badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
        title: `Error internal aplikasi downstream (HTTP ${statusCode || 500})`,
        summary: 'Aplikasi downstream menerima webhook tetapi mengalami kegagalan internal saat mengeksekusi logika request.',
        advice: [
          'Periksa application log dan stack trace pada server downstream.',
          'Periksa kestabilan koneksi database dan microservice downstream.',
          'Klik Replay setelah bug di kode aplikasi downstream diperbaiki.',
        ],
        isEligibleForReplay: true,
        isEligibleForBulkReplay: true,
      };

    case 'HTTP_4XX':
      return {
        type: 'http4xx',
        code,
        class: cls,
        badgeLabel: `HTTP ${statusCode || 400}`,
        badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
        title: `Downstream menolak request (HTTP ${statusCode || 400})`,
        summary: 'Server downstream menolak request webhook karena validasi, otorisasi, atau target endpoint tidak sesuai.',
        advice: [
          'Periksa keaktifan target URL dan rute endpoint downstream.',
          'Periksa header otentikasi atau izin akses downstream jika diperlukan.',
          'Pastikan format dan skema payload sesuai kontrak validasi downstream.',
        ],
        isEligibleForReplay: true,
        isEligibleForBulkReplay: true,
      };

    case 'NETWORK_ERROR':
      return {
        type: 'network',
        code,
        class: cls,
        badgeLabel: 'Koneksi gagal',
        badgeStyle: 'bg-rose-50 text-rose-800 border-rose-200',
        title: 'Gagal terhubung ke host downstream',
        summary: 'RelayGate gagal membuka koneksi TCP ke target URL (masalah DNS atau connection refused).',
        advice: [
          'Pastikan nama domain target URL valid dan DNS dapat di-resolve.',
          'Pastikan port target downstream terbuka dan service sedang listening.',
          'Periksa pengaturan firewall atau security group yang memblokir akses.',
        ],
        isEligibleForReplay: true,
        isEligibleForBulkReplay: true,
      };

    default:
      return {
        type: 'other',
        code: 'DELIVERY_FAILED',
        class: cls,
        badgeLabel: 'Gagal terkirim',
        badgeStyle: 'bg-zinc-100 text-zinc-800 border-zinc-200',
        title: 'Pengiriman webhook gagal',
        summary: 'Terjadi kesalahan saat worker mencoba mengirim webhook ke target downstream.',
        advice: [
          'Periksa apakah target URL dan konfigurasi endpoint masih aktif.',
          'Klik Salin cURL untuk menguji request langsung ke target downstream.',
          'Klik Replay untuk mengirim ulang event ini.',
        ],
        isEligibleForReplay: true,
        isEligibleForBulkReplay: true,
      };
  }
}

export interface AttemptsDisplayInfo {
  primaryText: string;
  secondaryText: string | null;
  rawFraction: string | null;
  isRejected: boolean;
}

/**
 * Single source of truth for attempts formatting across DLQ table, Events table, and Inspector Drawer.
 * Rules:
 * - Rejected verification (is_verified === -1 || SIGNATURE_*): "Tidak dicoba" (bold) + subtext "Ditolak saat verifikasi" (without numeric fraction).
 * - PENDING: "0 / max" (or "0" if max_attempts is absent)
 * - RETRYING: "N / max" (or "N" if max_attempts is absent) + subtext "Mencoba ulang..."
 * - DELIVERED: "N / max" (or "N" if max_attempts is absent, at least 1)
 * - FAILED:
 *   - attempts >= max_attempts: "N / max" + subtext "Kuota habis"
 *   - attempts < max_attempts: "N / max" + subtext actual stop reason (or "Dihentikan"), NEVER "Kuota habis", NEVER "Dalam proses".
 */
export function formatAttemptsDisplay(event: {
  is_verified?: number;
  status?: string;
  attempts?: number;
  max_attempts?: number;
  last_error?: string;
  failure_code?: string;
}): AttemptsDisplayInfo {
  const max = typeof event.max_attempts === 'number' && event.max_attempts > 0 ? event.max_attempts : null;
  const attempts = event.attempts ?? 0;
  const isRejected = event.is_verified === -1 || (event.failure_code || '').startsWith('SIGNATURE_');
  const formatCount = (n: number) => (max !== null ? `${n} / ${max}` : `${n}`);

  if (isRejected) {
    return {
      primaryText: 'Tidak dicoba',
      secondaryText: 'Ditolak saat verifikasi',
      rawFraction: null,
      isRejected: true,
    };
  }

  if (event.status === 'PENDING') {
    const text = formatCount(0);
    return {
      primaryText: text,
      secondaryText: null,
      rawFraction: text,
      isRejected: false,
    };
  }

  if (event.status === 'RETRYING') {
    const text = formatCount(attempts);
    return {
      primaryText: text,
      secondaryText: 'Mencoba ulang...',
      rawFraction: text,
      isRejected: false,
    };
  }

  if (event.status === 'DELIVERED') {
    const effAttempts = Math.max(1, attempts);
    const text = formatCount(effAttempts);
    return {
      primaryText: text,
      secondaryText: null,
      rawFraction: text,
      isRejected: false,
    };
  }

  // FAILED
  const fraction = formatCount(attempts);
  if (max !== null && attempts >= max) {
    return {
      primaryText: fraction,
      secondaryText: 'Kuota habis',
      rawFraction: fraction,
      isRejected: false,
    };
  }

  // attempts < max on FAILED (e.g. stopped, manual stop, or error)
  const defaultStopReason = attempts > 0 ? `Dihentikan pada percobaan ${attempts}` : 'Dihentikan';
  let reason = defaultStopReason;
  if (event.last_error) {
    const lower = event.last_error.toLowerCase();
    if (lower.includes('disabled') || lower.includes('nonaktif')) {
      reason = 'Endpoint nonaktif';
    } else if (lower.includes('not found') || lower.includes('tidak ditemukan') || lower.includes('tidak ada')) {
      reason = 'Endpoint tidak ditemukan';
    } else {
      const sanitized = event.last_error
        .split('\n')[0]
        .replace(/^HTTP\s+\d{3}\s*[-:]?\s*(?:Gateway Timeout:?|Internal Server Error:?|Bad Gateway:?|Service Unavailable:?)?\s*/i, '')
        .replace(/[\r\n]/g, '')
        .trim();

      // Ensure no English words ("attempt", "on attempt", "failed", "downstream", etc.) leak into the UI
      const hasEnglishLeak = /\b(attempt|attempts|failed|on\s+attempt|downstream|gateway|timeout|server|internal|error|connection|refused)\b/i.test(sanitized);

      if (sanitized && !sanitized.toLowerCase().includes('dalam proses') && !hasEnglishLeak) {
        reason = sanitized.length > 25 ? `${sanitized.slice(0, 25)}...` : sanitized;
      } else {
        reason = defaultStopReason;
      }
    }
  }

  return {
    primaryText: fraction,
    secondaryText: reason,
    rawFraction: fraction,
    isRejected: false,
  };
}


