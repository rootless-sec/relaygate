import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  RotateCw, 
  Copy, 
  Clock, 
  ShieldCheck, 
  ShieldOff,
  ArrowRight,
  AlertTriangle,
  AlertOctagon,
  ExternalLink,
  Check,
  CheckCircle,
  Loader2,
  Eye,
  EyeOff
} from 'lucide-react';
import { Endpoint, WebhookEvent } from '../types';
import { fetchEvent } from '../api';
import { JsonViewer } from './JsonViewer';
import { 
  formatAbsoluteTime, 
  formatRelativeTime,
  formatSourceIP, 
  analyzeEventError,
  isSensitiveHeader,
  formatFailureCodeLabel,
  formatAttemptsDisplay
} from '../utils/formatters';

interface InspectorDrawerProps {
  event: WebhookEvent | null;
  endpoints?: Endpoint[];
  onClose: () => void;
  onReplay: (event: WebhookEvent, fromDrawer?: boolean) => void;
  onToast: (message: string) => void;
  onNavigateToEndpoint?: (endpointId: string) => void;
  isSplitView?: boolean;
}

export const InspectorDrawer: React.FC<InspectorDrawerProps> = ({
  event,
  endpoints = [],
  onClose,
  onReplay,
  onToast,
  onNavigateToEndpoint,
  isSplitView = true,
}) => {
  const [activeTab, setActiveTab] = useState<'payload' | 'headers'>('payload');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [unmaskedHeaders, setUnmaskedHeaders] = useState<Set<string>>(new Set());
  const [revealedHeaders, setRevealedHeaders] = useState<Record<string, string>>({});
  const [showReverifyConfirm, setShowReverifyConfirm] = useState(false);
  const [replayInProgress, setReplayInProgress] = useState(false);
  const [replayInlineResult, setReplayInlineResult] = useState<{
    status: 'success' | 'still_failed' | 'info';
    message: string;
  } | null>(null);

  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveTab('payload');
    setUnmaskedHeaders(new Set());
    setRevealedHeaders({});
    setShowReverifyConfirm(false);
    setReplayInProgress(false);
    setReplayInlineResult(null);
    if (event) {
      setTimeout(() => drawerRef.current?.focus(), 50);
    }
  }, [event?.id]);

  // Track status transitions when SSE updates the active event
  useEffect(() => {
    if (!event) return;
    if (event.status === 'DELIVERED') {
      setReplayInProgress(false);
      setReplayInlineResult(null);
    } else if (event.status === 'PENDING') {
      setReplayInProgress(false);
      setReplayInlineResult(null);
    } else if (replayInProgress) {
      if (event.status === 'FAILED') {
        setReplayInProgress(false);
        const analysis = analyzeEventError(event);
        const isVerifRejected = event.is_verified === -1;
        setReplayInlineResult({
          status: 'still_failed',
          message: isVerifRejected
            ? `Replay selesai: Event tetap ditolak (${analysis.badgeLabel.toLowerCase()}).`
            : `Replay selesai: Pengiriman downstream gagal (${analysis.badgeLabel}).`,
        });
      }
    }
  }, [event?.status, event?.is_verified, replayInProgress]);

  const handleClose = () => {
    const evId = event?.id;
    onClose();
    if (evId) {
      setTimeout(() => {
        document.getElementById(`dlq-row-${evId}`)?.focus();
      }, 30);
    }
  };

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && event) {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [event, onClose]);

  if (!event) return null;

  const errorAnalysis = analyzeEventError(event);
  const isRejected = (event.is_verified === -1 || errorAnalysis.class === 'VERIFICATION_REJECTED') && event.status !== 'DELIVERED';

  const copyToClipboard = (text: string, label: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 1500);
      onToast(`${label} disalin ke clipboard`);
    } catch {
      onToast(`Gagal menyalin ${label}`);
    }
  };

  const getRawPayloadString = (): string => {
    if (event.payload_raw) return event.payload_raw;
    if (event.payload_json) return JSON.stringify(event.payload_json);
    if (typeof event.payload === 'string') {
      try {
        return atob(event.payload);
      } catch {
        return event.payload;
      }
    }
    return '{}';
  };

  const formattedPayload = () => {
    if (event.payload_json) {
      return JSON.stringify(event.payload_json, null, 2);
    }
    const raw = getRawPayloadString();
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw || '{}';
    }
  };

  const curlCommand = () => {
    const ep = endpoints.find((e) => e.id === event.endpoint_id);
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8080';
    const targetUrl = ep?.target_url || `${origin}/ingest/${event.endpoint_id}`;
    const headersStr = Object.entries(event.headers || {})
      .map(([k, v]) => {
        const val = isSensitiveHeader(k) ? '<TOKEN>' : v;
        return `-H '${k}: ${val}'`;
      })
      .join(' ');
    const raw = getRawPayloadString();
    return `curl -X POST '${targetUrl}' ${headersStr ? headersStr + ' ' : ''}-d '${raw}'`;
  };

  const handleReplayClick = () => {
    if (isRejected) {
      setShowReverifyConfirm(true);
    } else {
      triggerReplayAction();
    }
  };

  const triggerReplayAction = () => {
    setShowReverifyConfirm(false);
    setReplayInProgress(true);
    if (!isRejected) {
      setReplayInlineResult({
        status: 'info',
        message: 'Dijadwalkan ulang, hingga 5 percobaan pengiriman downstream.',
      });
    } else {
      setReplayInlineResult(null);
    }
    onReplay(event, true);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'DELIVERED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
            <CheckCircle className="w-3 h-3 text-emerald-600" />
            <span>Terkirim</span>
          </span>
        );
      case 'RETRYING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
            <Clock className="w-3 h-3 text-amber-600" />
            <span>Menunggu</span>
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-50 text-rose-800 border border-rose-200">
            <AlertOctagon className="w-3 h-3 text-rose-600" />
            <span>Gagal</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-zinc-100 text-zinc-800 border border-zinc-200">
            <Clock className="w-3 h-3 text-zinc-500" />
            <span>Menunggu</span>
          </span>
        );
    }
  };

  return (
    <>
      {/* Mobile Backdrop Scrim */}
      {isSplitView && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-black/20 backdrop-blur-2xs z-30 xl:hidden transition-opacity"
          aria-hidden="true"
        />
      )}

      {/* Detail Panel */}
      <div
        ref={drawerRef}
        tabIndex={-1}
        className={`bg-white border-l border-zinc-200 flex flex-col h-full select-text transition-all duration-200 outline-none ${
          isSplitView
            ? 'fixed inset-y-0 right-0 w-full sm:w-[460px] z-40 xl:relative xl:inset-auto xl:z-10 xl:w-[480px] xl:shrink-0 xl:shadow-none shadow-2xl'
            : 'fixed inset-y-0 right-0 w-[460px] max-w-full z-40 shadow-xl'
        }`}
        role="region"
        aria-label="Panel Detail Event Webhook"
      >
        {/* 1. Header: ID singkat + copy, endpoint -> provider, status badge, action, close */}
        <div className="p-3.5 border-b border-zinc-200 bg-zinc-50">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 font-mono text-xs font-bold text-zinc-900 truncate">
                  <span title={`Event ID: ${event.id}`}>
                    {event.id.slice(0, 10)}...
                  </span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(event.id, 'Event ID')}
                    className="p-1 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 rounded transition-colors"
                    title="Salin Event ID lengkap"
                    aria-label="Salin Event ID"
                  >
                    {copiedKey === 'Event ID' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
                {getStatusBadge(event.status)}
              </div>
              <div className="text-xs text-zinc-600 truncate mt-1 flex items-center gap-1.5 font-medium">
                <span className="text-zinc-900 font-mono">{event.endpoint_id}</span>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <span className="font-mono text-[11px] uppercase text-zinc-900 bg-zinc-100 px-1.5 py-0.5 rounded border border-zinc-200">
                  {event.provider}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Contextual Action Button: Rule: 1 status = 1 penanda di header. Sembunyikan jika tidak ada aksi */}
              {event.status === 'DELIVERED' || event.status === 'PENDING' || event.status === 'RETRYING' || !errorAnalysis.isEligibleForReplay ? null : isRejected ? (
                <button
                  type="button"
                  onClick={handleReplayClick}
                  disabled={replayInProgress}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-zinc-100 text-zinc-900 border border-zinc-200 rounded-md text-xs font-semibold shadow-2xs transition-colors disabled:opacity-50"
                  title="Verifikasi akan dijalankan ulang. Jika konfigurasi belum diperbaiki, event tetap ditolak."
                  aria-label="Verifikasi ulang dan kirim webhook"
                >
                  {replayInProgress ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-900" />
                  ) : (
                    <RotateCw className="w-3.5 h-3.5 text-zinc-600" />
                  )}
                  <span>Verifikasi ulang & kirim</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleReplayClick}
                  disabled={replayInProgress}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold rounded-md shadow-2xs transition-colors disabled:opacity-50"
                  title="Kirim ulang webhook sekarang"
                  aria-label="Kirim ulang webhook sekarang"
                >
                  {replayInProgress ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RotateCw className="w-3.5 h-3.5" />
                  )}
                  <span>Replay</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleClose}
                className="p-1.5 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200 rounded-md transition-colors"
                title="Tutup panel (Esc)"
                aria-label="Tutup panel detail"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Helper text for disabled button (dedup: clean replacement of yellow callout) */}
          {!errorAnalysis.isEligibleForReplay && event.status !== 'DELIVERED' && event.status !== 'PENDING' && event.status !== 'RETRYING' && (
            <p className="text-[11px] text-zinc-500 mt-2 text-right leading-relaxed">
              {errorAnalysis.ineligibleHelperText || 'Tidak bisa diverifikasi ulang karena data signature pada request tidak lengkap.'}
            </p>
          )}
        </div>

        {/* Inline Replay In-Flight / Result Banner */}
        {replayInProgress && (
          <div className="p-3 bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-900 flex items-center gap-2 animate-in fade-in duration-150">
            <Loader2 className="w-4 h-4 animate-spin text-zinc-900 shrink-0" />
            <span>Sedang memproses pengiriman ulang...</span>
          </div>
        )}

        {replayInlineResult && !replayInProgress && event.status !== 'PENDING' && event.status !== 'RETRYING' && event.status !== 'DELIVERED' && replayInlineResult.status !== 'still_failed' && (
          <div
            className={`p-3 border-b text-xs flex items-center justify-between gap-2 animate-in fade-in duration-150 ${
              replayInlineResult.status === 'info'
                ? 'bg-blue-50 border-blue-200 text-blue-900'
                : 'bg-rose-50 border-rose-200 text-rose-900'
            }`}
          >
            <div className="flex items-center gap-2">
              {replayInlineResult.status === 'info' ? (
                <Clock className="w-4 h-4 text-blue-600 shrink-0" />
              ) : (
                <AlertOctagon className="w-4 h-4 text-rose-600 shrink-0" />
              )}
              <span className="leading-relaxed">{replayInlineResult.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setReplayInlineResult(null)}
              className="p-0.5 text-zinc-500 hover:text-zinc-800"
              aria-label="Tutup notifikasi"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* 2. SATU Blok Diagnosis Tunggal */}
        {event.status === 'DELIVERED' ? (
          <div className="p-4 border-b border-zinc-200 bg-emerald-50/40" data-testid="diagnosis-delivered">
            <div className="flex items-center gap-2 text-xs text-emerald-900 font-semibold">
              <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>Lolos verifikasi dan terkirim ke downstream (HTTP {event.http_status_code || 200})</span>
            </div>
          </div>
        ) : event.status === 'PENDING' || event.status === 'RETRYING' ? (
          <div className="p-4 border-b border-zinc-200 bg-zinc-50 space-y-2" data-testid={event.status === 'PENDING' ? "diagnosis-pending" : "diagnosis-retrying"}>
            <div className="flex items-center gap-2 text-xs">
              <Clock className="w-4 h-4 text-zinc-500 shrink-0" />
              <span className="text-zinc-900 font-medium">
                {event.status === 'PENDING'
                  ? (event.attempts ?? 0) === 0 && !event.http_status_code && !(event.last_error || '').trim()
                    ? 'Event menunggu giliran dikirim ke downstream'
                    : 'Event dijadwalkan ulang untuk pengiriman downstream'
                  : 'Event sedang mencoba ulang pengiriman downstream'}
              </span>
            </div>
            {event.http_status_code ? (
              <p className="text-xs text-zinc-500" data-testid="last-failure-notice">
                Kegagalan terakhir:{' '}
                <span className="font-mono font-medium text-zinc-700">
                  {`HTTP ${event.http_status_code}`}
                </span>
              </p>
            ) : event.failure_code ? (
              <p className="text-xs text-zinc-500" data-testid="last-failure-notice">
                Kegagalan terakhir:{' '}
                <span className="font-mono font-medium text-zinc-700">
                  {formatFailureCodeLabel(event.failure_code)}
                </span>
              </p>
            ) : null}
            {event.last_error && (
              <details
                data-testid="technical-details"
                className="mt-2 pt-2 border-t border-zinc-200/60 group"
              >
                <summary className="text-[11px] font-semibold text-zinc-500 hover:text-zinc-900 cursor-pointer select-none">
                  Detail Teknis (Pesan Error Terakhir)
                </summary>
                <div
                  className="mt-2 p-2.5 bg-white border border-zinc-200 rounded text-xs font-mono text-zinc-900 whitespace-pre-wrap select-text leading-relaxed"
                  style={{ overflowWrap: 'anywhere' }}
                >
                  {event.last_error}
                </div>
              </details>
            )}
          </div>
        ) : (
          <div className="p-4 border-b border-zinc-200 bg-zinc-50 space-y-2.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-bold text-zinc-900 leading-tight">
                  {errorAnalysis.title}
                </h3>
                {errorAnalysis.summary && (
                  <p className="text-xs text-zinc-600 mt-1.5 leading-relaxed">
                    {errorAnalysis.summary}
                  </p>
                )}
              </div>
            </div>

            {/* HEADER_MISSING exact line: expected vs received header names (no values) */}
            {errorAnalysis.code === 'SIGNATURE_HEADER_MISSING' && (
              <div className="p-2.5 bg-white border border-zinc-200 rounded text-xs leading-relaxed">
                <span className="text-zinc-500 font-medium">Header diharapkan: </span>
                <span className="font-mono font-semibold text-zinc-900">{errorAnalysis.expectedHeader}. </span>
                <span className="text-zinc-500 font-medium">Header diterima: </span>
                <span className="font-mono text-zinc-600">{errorAnalysis.receivedHeadersList || '(tidak ada)'}</span>
              </div>
            )}

            {/* Remediation Steps (Max 3 imperative command sentences) */}
            <div className="pt-2 border-t border-zinc-200/60">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Langkah Perbaikan:
              </span>
              <ul className="mt-1.5 space-y-1.5 text-xs text-zinc-900">
                {errorAnalysis.advice.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="font-bold text-zinc-500 shrink-0">{idx + 1}.</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Endpoint Configuration Link */}
            {onNavigateToEndpoint && isRejected && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => onNavigateToEndpoint(event.endpoint_id)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-900 hover:text-black underline underline-offset-2 transition-colors"
                >
                  <span>Buka Konfigurasi Endpoint</span>
                  <ExternalLink className="w-3 h-3 text-zinc-500" />
                </button>
              </div>
            )}

            {/* Foldable Raw Error Section (default closed, overflow-wrap: anywhere) */}
            <details
              data-testid="technical-details"
              className="mt-2 pt-2 border-t border-zinc-200/60 group"
            >
              <summary className="text-[11px] font-semibold text-zinc-500 hover:text-zinc-900 cursor-pointer select-none">
                Detail Teknis (Pesan Error Asli)
              </summary>
              <div
                className="mt-2 p-2.5 bg-white border border-zinc-200 rounded text-xs font-mono text-zinc-900 whitespace-pre-wrap select-text leading-relaxed"
                style={{ overflowWrap: 'anywhere' }}
              >
                {event.last_error || 'Tidak ada detail pesan error tercatat.'}
              </div>
            </details>
          </div>
        )}

        {/* 3. Grid Metadata Info (Provider, IP Asal, Waktu per status, Percobaan, Signature) */}
        <div className="grid grid-cols-2 gap-y-2.5 gap-x-4 p-3.5 border-b border-zinc-200 bg-white text-xs">
          <div>
            <span className="text-zinc-500 font-medium">Provider:</span>
            <span className="ml-2 font-semibold text-zinc-900 uppercase">{event.provider}</span>
          </div>
          <div>
            <span className="text-zinc-500 font-medium">IP Asal:</span>
            <span className="ml-2 font-mono text-zinc-900">{formatSourceIP(event.source_ip)}</span>
          </div>
          {/*
            Sumber nilai timestamp waktu per status:
            - DELIVERED: Terkirim pada -> event.updated_at (internal/worker/worker.go:384 via internal/storage/storage.go:804) fallback event.created_at
            - PENDING: Dijadwalkan pada -> event.updated_at (internal/api/handlers.go:303 via internal/storage/storage.go:804) fallback event.created_at
            - FAILED: Gagal pada -> event.failed_at (internal/worker/worker.go:344, 415 via internal/storage/storage.go:830) fallback event.updated_at / event.created_at
          */}
          <div>
            <span className="text-zinc-500 font-medium">
              {event.status === 'DELIVERED'
                ? 'Terkirim pada:'
                : event.status === 'PENDING' || event.status === 'RETRYING'
                ? 'Dijadwalkan pada:'
                : 'Gagal pada:'}
            </span>
            <span
              className="ml-2 font-mono text-zinc-900 underline decoration-dotted decoration-zinc-400 underline-offset-4 cursor-help"
              title={formatAbsoluteTime(
                event.status === 'DELIVERED'
                  ? (event.updated_at || event.created_at)
                  : event.status === 'PENDING'
                  ? (event.updated_at || event.created_at)
                  : event.status === 'RETRYING'
                  ? (event.next_retry_at || event.updated_at || event.created_at)
                  : (event.failed_at || event.updated_at || event.created_at)
              )}
            >
              {formatRelativeTime(
                event.status === 'DELIVERED'
                  ? (event.updated_at || event.created_at)
                  : event.status === 'PENDING'
                  ? (event.updated_at || event.created_at)
                  : event.status === 'RETRYING'
                  ? (event.next_retry_at || event.updated_at || event.created_at)
                  : (event.failed_at || event.updated_at || event.created_at)
              )}
            </span>
          </div>
          {(() => {
            const attemptsInfo = formatAttemptsDisplay(event);
            return (
              <div>
                <span className="text-zinc-500 font-medium whitespace-nowrap">Percobaan:</span>
                <span className="ml-2">
                  {attemptsInfo.isRejected ? (
                    <span className="inline-flex flex-col">
                      <span className="font-semibold text-zinc-900 text-xs whitespace-nowrap" data-testid="attempts-count">
                        {attemptsInfo.primaryText}
                      </span>
                      {attemptsInfo.secondaryText && (
                        <span className="text-[10px] text-zinc-500 whitespace-nowrap" data-testid="attempts-stop-reason">
                          {attemptsInfo.secondaryText}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex flex-col">
                      <span
                        className={`font-mono text-xs whitespace-nowrap ${
                          event.status === 'DELIVERED' ? 'text-emerald-700 font-medium' : 'text-zinc-900 font-medium'
                        }`}
                        data-testid="attempts-count"
                      >
                        {attemptsInfo.primaryText}
                      </span>
                      {attemptsInfo.secondaryText && (
                        <span
                          className={`text-[10px] whitespace-nowrap ${
                            event.status === 'RETRYING' ? 'text-amber-700 font-medium' : 'text-zinc-500'
                          }`}
                          data-testid="attempts-stop-reason"
                        >
                          {attemptsInfo.secondaryText}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </div>
            );
          })()}
          {/* Signature row only for delivered or delivery failed (!isRejected && event.status !== 'PENDING') */}
          {(event.status === 'DELIVERED' || (!isRejected && event.status !== 'PENDING')) && (
            <div>
              <span className="text-zinc-500 font-medium">
                {event.verification_kind === 'static_token' || event.provider?.toLowerCase() === 'xendit' ? 'Token:' : 'Signature:'}
              </span>
              <span className="ml-2">
                {event.is_verified === 1 ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                    <ShieldCheck className="w-3.5 h-3.5" /> Valid
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-zinc-500">
                    <ShieldOff className="w-3.5 h-3.5" /> Dilewati
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {/* 4. Sticky Navigation Tabs (Payload Data | Headers) */}
        <div className="sticky top-0 bg-zinc-50 z-10 flex border-b border-zinc-200 px-3 gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('payload')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'payload'
                ? 'border-zinc-900 text-zinc-900 font-bold'
                : 'border-transparent text-zinc-500 hover:text-zinc-900'
            }`}
            aria-selected={activeTab === 'payload'}
          >
            Payload Data
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('headers')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'headers'
                ? 'border-zinc-900 text-zinc-900 font-bold'
                : 'border-transparent text-zinc-500 hover:text-zinc-900'
            }`}
            aria-selected={activeTab === 'headers'}
          >
            Headers ({Object.keys(event.headers || {}).length})
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-auto p-4 bg-white">
          {activeTab === 'payload' && (
            <JsonViewer
              jsonString={formattedPayload()}
              rawString={event.payload_raw}
              curlCommand={curlCommand()}
              onToast={onToast}
            />
          )}

          {activeTab === 'headers' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between pb-1">
                <span className="text-xs text-zinc-500 font-medium">HTTP Request Headers</span>
                <button
                  type="button"
                  onClick={() => {
                    const str = Object.entries(event.headers || {})
                      .map(([k, v]) => {
                        const val = isSensitiveHeader(k) && !unmaskedHeaders.has(k) ? '<TOKEN>' : (revealedHeaders[k] || v);
                        return `${k}: ${val}`;
                      })
                      .join('\n');
                    copyToClipboard(str, 'Semua Headers');
                  }}
                  className="px-2 py-1 text-[11px] font-medium bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded transition-colors flex items-center gap-1"
                >
                  {copiedKey === 'Semua Headers' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-emerald-700">Disalin!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-zinc-500" />
                      <span>Salin Semua</span>
                    </>
                  )}
                </button>
              </div>
              <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-lg overflow-hidden bg-zinc-50">
                {Object.entries(event.headers || {}).length > 0 ? (
                  Object.entries(event.headers || {}).map(([key, val]) => {
                    const sensitive = isSensitiveHeader(key);
                    const isUnmasked = unmaskedHeaders.has(key);
                    const rawVal = revealedHeaders[key] || val;
                    const displayVal = sensitive && !isUnmasked ? '••••••••••••••••••••••••••••••••' : rawVal;

                    return (
                      <div key={key} className="p-2.5 text-xs flex flex-col gap-1 hover:bg-white transition-colors">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold text-zinc-500 text-[11px] flex items-center gap-1.5">
                            <span>{key}</span>
                            {sensitive && (
                              <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 uppercase">
                                Sensitif
                              </span>
                            )}
                          </span>
                          {sensitive && (
                            <button
                              type="button"
                              onClick={async () => {
                                if (unmaskedHeaders.has(key)) {
                                  setUnmaskedHeaders((prev) => {
                                    const next = new Set(prev);
                                    next.delete(key);
                                    return next;
                                  });
                                } else {
                                  if (!revealedHeaders[key]) {
                                    try {
                                      const detail = await fetchEvent(event.id, true);
                                      if (detail && detail.headers) {
                                        setRevealedHeaders(detail.headers);
                                      }
                                    } catch {}
                                  }
                                  setUnmaskedHeaders((prev) => {
                                    const next = new Set(prev);
                                    next.add(key);
                                    return next;
                                  });
                                }
                              }}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-900 px-1.5 py-0.5 rounded hover:bg-zinc-200 transition-colors"
                              aria-label={isUnmasked ? `Sembunyikan ${key}` : `Tampilkan ${key}`}
                            >
                              {isUnmasked ? (
                                <>
                                  <EyeOff className="w-3 h-3 text-zinc-500" />
                                  <span>Sembunyikan</span>
                                </>
                              ) : (
                                <>
                                  <Eye className="w-3 h-3 text-zinc-500" />
                                  <span>Tampilkan</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                        <span
                          className={`font-mono select-text text-xs ${
                            sensitive && !isUnmasked ? 'text-zinc-400 tracking-widest' : 'text-zinc-900'
                          }`}
                          style={{ overflowWrap: 'anywhere' }}
                        >
                          {displayVal}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="p-4 text-center text-xs text-zinc-500">
                    Tidak ada headers yang terdata.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Re-verify & Replay Confirmation Modal */}
      {showReverifyConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white border border-zinc-200 rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <h3 className="text-sm font-bold text-zinc-900">
                Konfirmasi Verifikasi Ulang
              </h3>
            </div>
            <p className="text-xs text-zinc-600 mb-4 leading-relaxed">
              Verifikasi akan dijalankan ulang terhadap konfigurasi secret endpoint saat ini.
              Jika konfigurasi belum diperbaiki, event tetap ditolak.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowReverifyConfirm(false)}
                className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-900 rounded-lg transition-colors"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={triggerReplayAction}
                className="px-3.5 py-1.5 text-xs font-semibold bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg transition-colors shadow-xs"
              >
                Verifikasi Ulang & Kirim
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
