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

export type ErrorCategoryType = 'signature' | 'http5xx' | 'http4xx' | 'timeout' | 'network' | 'other';

export interface ErrorAnalysis {
  type: ErrorCategoryType;
  badgeLabel: string;
  badgeStyle: string;
  title: string;
  summary: string;
  advice: string[];
}

/**
 * Categorize error and provide root-cause explanation + remediation advice.
 */
export function analyzeEventError(event: WebhookEvent): ErrorAnalysis {
  const errMsg = (event.last_error || '').toLowerCase();
  const statusCode = event.http_status_code || 0;

  // 1. Signature Invalid
  if (event.is_verified === -1 || errMsg.includes('signature') || errMsg.includes('cryptographic')) {
    return {
      type: 'signature',
      badgeLabel: 'Signature Invalid',
      badgeStyle: 'bg-rose-50 text-rose-700 border-rose-200',
      title: 'Validasi Signature Kriptografis Gagal',
      summary:
        'Payload atau header signature tidak cocok dengan secret key yang terdaftar di RelayGate. Gateway menolak event di gerbang masuk demi keamanan downstream.',
      advice: [
        'Buka menu Endpoints dan pastikan secret key sama persis dengan yang dikonfigurasi di penyedia webhook.',
        'Periksa apakah penyedia webhook memperbarui signing key atau menggunakan format algoritma berbeda.',
        'Setelah secret key endpoint diselaraskan, lakukan replay untuk memverifikasi ulang.',
      ],
    };
  }

  // 2. HTTP 5xx Server Error
  if (statusCode >= 500) {
    return {
      type: 'http5xx',
      badgeLabel: `HTTP ${statusCode}`,
      badgeStyle: 'bg-rose-50 text-rose-700 border-rose-200',
      title: `Server Tujuan Mengembalikan Internal Error (${statusCode})`,
      summary: `Aplikasi downstream menerima request tetapi mengalami error internal saat memproses webhook.`,
      advice: [
        'Periksa log aplikasi server downstream pada timestamp saat kegagalan terjadi.',
        'Pastikan service database, cache, atau antrean di downstream tidak sedang overload.',
        'Setelah bug di downstream diperbaiki atau beban server menurun, picu replay.',
      ],
    };
  }

  // 3. HTTP 4xx Client Error
  if (statusCode >= 400) {
    return {
      type: 'http4xx',
      badgeLabel: `HTTP ${statusCode}`,
      badgeStyle: 'bg-amber-50 text-amber-700 border-amber-200',
      title: `Request Ditolak oleh Server Tujuan (${statusCode})`,
      summary: `Server downstream menolak webhook (contoh: 404 Not Found, 401 Unauthorized, 422 Unprocessable Entity).`,
      advice: [
        'Periksa apakah Target URL endpoint masih valid dan aktif.',
        'Pastikan server tujuan tidak memerlukan header otentikasi tambahan yang belum dikonfigurasi.',
        'Verifikasi bahwa struktur skema JSON payload sesuai dengan yang diharapkan downstream.',
      ],
    };
  }

  // 4. Timeout
  if (errMsg.includes('timeout') || errMsg.includes('deadline exceeded')) {
    return {
      type: 'timeout',
      badgeLabel: 'Timeout',
      badgeStyle: 'bg-amber-50 text-amber-700 border-amber-200',
      title: 'Koneksi Downstream Mengalami Timeout',
      summary: 'RelayGate tidak menerima respons dari target endpoint dalam batas waktu batas tunggu pengiriman.',
      advice: [
        'Periksa latensi jaringan dan daya tanggap server downstream.',
        'Pastikan endpoint downstream memproses webhook secara asinkron agar tidak memblokir koneksi HTTP.',
        'Coba kirim ulang (replay) saat jaringan sudah kembali stabil.',
      ],
    };
  }

  // 5. Network / Dial Connection Refused
  if (
    errMsg.includes('connection refused') ||
    errMsg.includes('dial tcp') ||
    errMsg.includes('no such host') ||
    errMsg.includes('network')
  ) {
    return {
      type: 'network',
      badgeLabel: 'Koneksi Gagal',
      badgeStyle: 'bg-rose-50 text-rose-700 border-rose-200',
      title: 'Gagal Menghubungi Host Downstream',
      summary: 'Koneksi jaringan TCP ditolak atau host server downstream tidak dapat dijangkau.',
      advice: [
        'Pastikan domain atau IP target URL dapat diakses publik dari jaringan RelayGate.',
        'Periksa aturan firewall, security group, atau reverse proxy (Nginx/Cloudflare) di downstream.',
        'Pastikan port target server downstream sedang membuka listener aktif.',
      ],
    };
  }

  // 6. Other / General Failure
  return {
    type: 'other',
    badgeLabel: 'Gagal Terkirim',
    badgeStyle: 'bg-zinc-100 text-zinc-700 border-zinc-200',
    title: 'Pengiriman Webhook Gagal',
    summary: event.last_error || 'Terjadi kesalahan saat worker mencoba mengirim webhook ke endpoint.',
    advice: [
      'Buka tab Delivery Log untuk melihat riwayat rincian percobaan dan pesan kesalahan lengkap.',
      'Periksa apakah target URL dan konfigurasi endpoint masih aktif.',
      'Gunakan tombol Copy as cURL untuk menguji request langsung dari terminal lokal Anda.',
    ],
  };
}
