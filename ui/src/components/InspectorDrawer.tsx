import React, { useState, useEffect } from 'react';
import { 
  X, 
  RotateCw, 
  Copy, 
  Clock, 
  ShieldCheck, 
  ShieldAlert, 
  ShieldOff,
  ArrowRight,
  AlertTriangle,
  HelpCircle,
  ExternalLink,
  Check
} from 'lucide-react';
import { Endpoint, WebhookEvent } from '../types';
import { JsonViewer } from './JsonViewer';
import { 
  formatAbsoluteTime, 
  formatSourceIP, 
  analyzeEventError 
} from '../utils/formatters';

interface InspectorDrawerProps {
  event: WebhookEvent | null;
  endpoints?: Endpoint[];
  onClose: () => void;
  onReplay: (event: WebhookEvent) => void;
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
  // Default tab changed to 'log' for immediate troubleshooting context
  const [activeTab, setActiveTab] = useState<'log' | 'payload' | 'headers'>('log');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showInvalidReplayConfirm, setShowInvalidReplayConfirm] = useState(false);

  useEffect(() => {
    // When a new event is opened, default to Delivery Log for troubleshooting
    setActiveTab('log');
    setShowInvalidReplayConfirm(false);
  }, [event?.id]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && event) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [event, onClose]);

  if (!event) return null;

  const errorAnalysis = analyzeEventError(event);
  const isInvalidSignature = event.is_verified === -1;

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
    const targetUrl = ep?.target_url || `${window.location.origin}/ingest/${event.endpoint_id}`;
    const headersStr = Object.entries(event.headers || {})
      .map(([k, v]) => `-H '${k}: ${v}'`)
      .join(' ');
    const raw = getRawPayloadString();
    return `curl -X POST '${targetUrl}' ${headersStr ? headersStr + ' ' : ''}-d '${raw}'`;
  };

  const handleReplayClick = () => {
    if (isInvalidSignature) {
      setShowInvalidReplayConfirm(true);
    } else {
      onReplay(event);
    }
  };

  const handleConfirmInvalidReplay = () => {
    setShowInvalidReplayConfirm(false);
    onReplay(event);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'DELIVERED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
            Terkirim
          </span>
        );
      case 'RETRYING':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
            Mencoba Ulang
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-50 text-rose-800 border border-rose-200">
            Gagal
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-zinc-100 text-zinc-800 border border-zinc-200">
            Menunggu
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
          className="fixed inset-0 bg-black/20 backdrop-blur-2xs z-30 lg:hidden transition-opacity"
          aria-hidden="true"
        />
      )}

      {/* Detail Panel */}
      <div
        className={`bg-white border-l border-[#e4e4e7] flex flex-col h-full select-text transition-all duration-200 ${
          isSplitView
            ? 'fixed inset-y-0 right-0 w-full sm:w-[460px] z-40 lg:relative lg:inset-auto lg:z-10 lg:w-[440px] xl:w-[480px] lg:shrink-0 lg:shadow-none shadow-2xl'
            : 'fixed inset-y-0 right-0 w-[460px] max-w-full z-40 shadow-xl'
        }`}
        role="region"
        aria-label="Panel Detail Event Webhook"
      >
        {/* Header */}
        <div className="p-3.5 border-b border-[#e4e4e7] flex items-center justify-between gap-3 bg-[#fafafa]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className="font-mono text-xs font-bold text-[#18181b] truncate cursor-pointer hover:underline"
                title={`Event ID lengkap: ${event.id} (klik untuk salin)`}
                onClick={() => copyToClipboard(event.id, 'Event ID')}
              >
                {event.id}
              </span>
              {getStatusBadge(event.status)}
            </div>
            <div className="text-xs text-[#52525b] truncate mt-1 flex items-center gap-1.5 font-medium">
              <span className="text-[#18181b] font-mono">{event.endpoint_id}</span>
              <ArrowRight className="w-3 h-3 text-[#71717a]" />
              <span className="font-mono text-[11px] uppercase text-[#18181b] bg-[#f4f4f5] px-1.5 py-0.5 rounded border border-[#e4e4e7]">
                {event.provider}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Contextual Replay Button */}
            {isInvalidSignature ? (
              <button
                type="button"
                onClick={handleReplayClick}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded-md text-xs font-semibold shadow-2xs transition-colors"
                title="Signature tidak valid. Klik untuk konfirmasi replay."
                aria-label="Picu replay dengan konfirmasi peringatan"
              >
                <RotateCw className="w-3.5 h-3.5 text-rose-600" />
                <span>Replay</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleReplayClick}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#18181b] hover:bg-[#27272a] text-white text-xs font-semibold rounded-md shadow-2xs transition-colors"
                title="Kirim ulang webhook sekarang"
                aria-label="Kirim ulang webhook sekarang"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Replay</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-[#52525b] hover:text-[#18181b] hover:bg-[#e4e4e7] rounded-md transition-colors"
              title="Tutup panel (Esc)"
              aria-label="Tutup panel detail"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Invalid Signature Banner */}
        {isInvalidSignature && (
          <div className="bg-rose-50 border-b border-rose-200 p-3.5 flex items-start gap-2.5 text-xs">
            <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-bold text-rose-900">
                Signature Kriptografis Tidak Cocok
              </div>
              <p className="text-rose-700 mt-0.5 leading-relaxed">
                Signature tidak cocok. Periksa secret di endpoint, lalu replay.
              </p>
              {onNavigateToEndpoint && (
                <button
                  type="button"
                  onClick={() => onNavigateToEndpoint(event.endpoint_id)}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-rose-800 hover:text-rose-950 underline underline-offset-2 transition-colors"
                >
                  <span>Buka Konfigurasi Endpoint</span>
                  <ExternalLink className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Metadata Grid */}
        <div className="grid grid-cols-2 gap-y-2 gap-x-4 p-3.5 border-b border-[#e4e4e7] bg-white text-xs">
          <div>
            <span className="text-[#52525b] font-medium">Provider:</span>
            <span className="ml-2 font-semibold text-[#18181b] uppercase">{event.provider}</span>
          </div>
          <div>
            <span className="text-[#52525b] font-medium">IP Asal:</span>
            <span className="ml-2 font-mono text-[#18181b]">{formatSourceIP(event.source_ip)}</span>
          </div>
          <div>
            <span className="text-[#52525b] font-medium">Signature:</span>
            <span className="ml-2">
              {event.is_verified === 1 ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                  <ShieldCheck className="w-3.5 h-3.5" /> Valid
                </span>
              ) : event.is_verified === -1 ? (
                <span className="inline-flex items-center gap-1 text-rose-700 font-semibold">
                  <ShieldAlert className="w-3.5 h-3.5" /> Tidak Valid
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[#52525b]">
                  <ShieldOff className="w-3.5 h-3.5" /> Dilewati
                </span>
              )}
            </span>
          </div>
          <div>
            <span className="text-[#52525b] font-medium">Percobaan:</span>
            <span className="ml-2 font-mono text-[#18181b]">
              {isInvalidSignature && event.attempts === 0 ? (
                <span className="font-semibold text-rose-700">0 / {event.max_attempts} (Ditolak di gerbang)</span>
              ) : event.attempts >= event.max_attempts ? (
                <span className="font-medium text-[#18181b]">{event.attempts} / {event.max_attempts} (Kuota habis)</span>
              ) : (
                <span className="font-medium text-[#18181b]">{event.attempts} / {event.max_attempts}</span>
              )}
            </span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-[#e4e4e7] bg-[#fafafa] px-3 gap-1">
          <button
            type="button"
            onClick={() => setActiveTab('log')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'log'
                ? 'border-[#18181b] text-[#18181b] font-bold'
                : 'border-transparent text-[#52525b] hover:text-[#18181b]'
            }`}
            aria-selected={activeTab === 'log'}
          >
            Delivery Log & Analisis
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('payload')}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'payload'
                ? 'border-[#18181b] text-[#18181b] font-bold'
                : 'border-transparent text-[#52525b] hover:text-[#18181b]'
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
                ? 'border-[#18181b] text-[#18181b] font-bold'
                : 'border-transparent text-[#52525b] hover:text-[#18181b]'
            }`}
            aria-selected={activeTab === 'headers'}
          >
            Headers ({Object.keys(event.headers || {}).length})
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-auto p-4 bg-white space-y-4">
          {activeTab === 'log' && (
            <div className="space-y-4">
              {/* Section: Kenapa Gagal? */}
              <div className="p-3.5 bg-[#fafafa] border border-[#e4e4e7] rounded-lg space-y-2.5">
                <div className="flex items-center gap-2">
                  <HelpCircle className="w-4 h-4 text-[#18181b] shrink-0" />
                  <h4 className="text-xs font-bold text-[#18181b]">
                    Kenapa Gagal? ({errorAnalysis.title})
                  </h4>
                </div>
                <p className="text-xs text-[#52525b] leading-relaxed">
                  {errorAnalysis.summary}
                </p>
                <div className="pt-2 border-t border-[#e4e4e7]/60">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#52525b]">
                    Langkah Perbaikan yang Disarankan:
                  </span>
                  <ul className="mt-1.5 space-y-1.5 text-xs text-[#18181b]">
                    {errorAnalysis.advice.map((item, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="font-bold text-[#52525b] shrink-0">{idx + 1}.</span>
                        <span className="leading-relaxed">{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Delivery History */}
              <div className="space-y-3">
                <div className="text-xs font-semibold text-[#18181b] pb-1 flex items-center justify-between border-b border-[#f4f4f5]">
                  <span>Riwayat Percobaan Pengiriman</span>
                  <span className="font-mono text-[#52525b] text-[11px] font-normal">
                    {event.attempts} kali dicoba
                  </span>
                </div>

                <div className="relative pl-5 border-l-2 border-[#e4e4e7] space-y-4 ml-2">
                  {event.delivery_log && event.delivery_log.length > 0 ? (
                    event.delivery_log.slice().reverse().map((log, idx) => {
                      const isOk = log.code >= 200 && log.code < 300;
                      return (
                        <div key={idx} className="relative text-xs">
                          <span
                            className={`absolute -left-[27px] top-1 w-3 h-3 rounded-full border-2 border-white ${
                              isOk ? 'bg-emerald-500' : 'bg-rose-500'
                            }`}
                          />
                          <div className="font-semibold text-[#18181b] flex items-center justify-between">
                            <span>Percobaan ke-{log.attempt}</span>
                            <span className="font-mono text-[#52525b] text-[11px]">
                              {formatAbsoluteTime(log.t)}
                            </span>
                          </div>
                          <div className="text-[11px] text-[#52525b] mt-0.5">
                            Status:{' '}
                            <span className={`font-mono font-medium ${isOk ? 'text-emerald-700' : 'text-rose-700'}`}>
                              {log.code ? `HTTP ${log.code}` : 'Connection Timeout'}
                            </span>
                            {' '}· Durasi: <span className="font-mono">{log.ms} ms</span>
                          </div>
                          {log.err && (
                            <div className="mt-1.5 p-2 bg-rose-50 border border-rose-200 rounded text-rose-700 font-mono text-[11px] break-all select-text">
                              {log.err}
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-xs text-[#52525b] py-2">
                      {isInvalidSignature ? (
                        <div className="p-2.5 bg-rose-50/70 border border-rose-200/80 rounded text-rose-900 leading-relaxed">
                          Tidak ada request downstream yang dikirim. Webhook ditolak di gerbang verifikasi signature RelayGate untuk mencegah transmisi payload yang tidak sah.
                        </div>
                      ) : (
                        'Event belum memiliki riwayat pengiriman downstream.'
                      )}
                    </div>
                  )}
                </div>

                {event.status === 'RETRYING' && event.next_retry_at && (
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-center gap-2">
                    <Clock className="w-4 h-4 shrink-0 text-amber-600" />
                    <span>
                      Jadwal pengiriman ulang berikutnya:{' '}
                      <b className="font-mono">{formatAbsoluteTime(event.next_retry_at)}</b>
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

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
                <span className="text-xs text-[#52525b] font-medium">HTTP Request Headers</span>
                <button
                  type="button"
                  onClick={() => {
                    const str = Object.entries(event.headers || {})
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('\n');
                    copyToClipboard(str, 'Semua Headers');
                  }}
                  className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors flex items-center gap-1"
                >
                  {copiedKey === 'Semua Headers' ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span className="text-emerald-700">Disalin!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 text-[#71717a]" />
                      <span>Salin Semua</span>
                    </>
                  )}
                </button>
              </div>
              <div className="divide-y divide-[#f4f4f5] border border-[#e4e4e7] rounded-lg overflow-hidden bg-[#fafafa]">
                {Object.entries(event.headers || {}).length > 0 ? (
                  Object.entries(event.headers || {}).map(([key, val]) => (
                    <div key={key} className="p-2.5 text-xs flex flex-col gap-0.5 hover:bg-white transition-colors">
                      <span className="font-mono font-semibold text-[#52525b] text-[11px]">{key}</span>
                      <span className="font-mono text-[#18181b] break-all select-text">{val}</span>
                    </div>
                  ))
                ) : (
                  <div className="p-4 text-center text-xs text-[#71717a]">
                    Tidak ada headers yang terdata.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Invalid Signature Replay Confirmation Modal */}
      {showInvalidReplayConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white border border-[#e4e4e7] rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-2">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
              <h3 className="text-sm font-bold text-[#18181b]">
                Peringatan: Signature Tidak Valid
              </h3>
            </div>
            <p className="text-xs text-[#52525b] mb-4 leading-relaxed">
              Event ini memiliki signature kriptografis yang tidak cocok dengan secret endpoint.
              Replay hampir pasti akan gagal kembali kecuali konfigurasi secret key pada endpoint telah diperbarui.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowInvalidReplayConfirm(false)}
                className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] rounded-lg transition-colors"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmInvalidReplay}
                className="px-3.5 py-1.5 text-xs font-semibold bg-rose-700 hover:bg-rose-800 text-white rounded-lg transition-colors shadow-xs"
              >
                Tetap Replay
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
