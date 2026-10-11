import React, { useState, useEffect } from 'react';
import { 
  X, 
  RotateCw, 
  Copy, 
  Terminal, 
  Check, 
  Clock, 
  ShieldCheck, 
  ShieldAlert, 
  ShieldOff,
  ArrowRight
} from 'lucide-react';
import { WebhookEvent } from '../types';

interface InspectorDrawerProps {
  event: WebhookEvent | null;
  onClose: () => void;
  onReplay: (event: WebhookEvent) => void;
  onToast: (message: string) => void;
}

export const InspectorDrawer: React.FC<InspectorDrawerProps> = ({
  event,
  onClose,
  onReplay,
  onToast,
}) => {
  const [activeTab, setActiveTab] = useState<'payload' | 'headers' | 'log'>('payload');
  const [isPretty, setIsPretty] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab('payload');
  }, [event?.id]);

  if (!event) return null;

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

  const formattedPayload = () => {
    if (event.payload_json) {
      return JSON.stringify(event.payload_json, null, 2);
    }
    try {
      const parsed = JSON.parse(event.payload_raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return event.payload_raw || '{}';
    }
  };

  const curlCommand = () => {
    const headersStr = Object.entries(event.headers || {})
      .map(([k, v]) => `-H '${k}: ${v}'`)
      .join(' ');
    const raw = event.payload_raw || JSON.stringify(event.payload_json || {});
    return `curl -X POST 'https://example.com/target' ${headersStr} -d '${raw}'`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'DELIVERED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
            DELIVERED
          </span>
        );
      case 'RETRYING':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-pulse" />
            RETRYING
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-600" />
            FAILED
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-700 border border-zinc-200">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
            PENDING
          </span>
        );
    }
  };

  const formatTime = (isoString?: string) => {
    if (!isoString) return '-';
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString('id-ID', { hour12: false });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-[460px] max-w-full bg-white border-l border-[#e4e4e7] shadow-xl z-40 flex flex-col transition-transform duration-200">
      {/* Header */}
      <div className="p-4 border-b border-[#e4e4e7] flex items-center justify-between gap-3 bg-[#fafafa]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold text-[#18181b] truncate">
              {event.id}
            </span>
            {getStatusBadge(event.status)}
          </div>
          <div className="text-xs text-[#71717a] truncate mt-0.5 flex items-center gap-1">
            <span>{event.endpoint_id}</span>
            <ArrowRight className="w-3 h-3 text-[#a1a1aa]" />
            <span className="font-mono text-[11px] text-[#18181b]">{event.provider}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onReplay(event)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#18181b] hover:bg-[#27272a] text-white text-xs font-semibold rounded-md shadow-2xs transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Replay
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-[#71717a] hover:text-[#18181b] hover:bg-[#e4e4e7] rounded-md transition-colors"
            title="Tutup (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Metadata Grid */}
      <div className="grid grid-cols-2 gap-y-2 gap-x-4 p-4 border-b border-[#e4e4e7] bg-white text-xs">
        <div>
          <span className="text-[#71717a]">Provider:</span>
          <span className="ml-2 font-medium text-[#18181b] uppercase">{event.provider}</span>
        </div>
        <div>
          <span className="text-[#71717a]">IP Asal:</span>
          <span className="ml-2 font-mono text-[#18181b]">{event.source_ip || '-'}</span>
        </div>
        <div>
          <span className="text-[#71717a]">Signature:</span>
          <span className="ml-2">
            {event.is_verified === 1 ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                <ShieldCheck className="w-3.5 h-3.5" /> Valid
              </span>
            ) : event.is_verified === -1 ? (
              <span className="inline-flex items-center gap-1 text-rose-700 font-bold">
                <ShieldAlert className="w-3.5 h-3.5" /> Tidak Valid
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[#71717a]">
                <ShieldOff className="w-3.5 h-3.5" /> Dilewati
              </span>
            )}
          </span>
        </div>
        <div>
          <span className="text-[#71717a]">Percobaan:</span>
          <span className="ml-2 font-mono font-medium text-[#18181b]">
            {event.attempts} / {event.max_attempts}
          </span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-[#e4e4e7] bg-[#fafafa] px-3 gap-1">
        <button
          onClick={() => setActiveTab('payload')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === 'payload'
              ? 'border-[#18181b] text-[#18181b] font-semibold'
              : 'border-transparent text-[#71717a] hover:text-[#18181b]'
          }`}
        >
          Payload Data
        </button>
        <button
          onClick={() => setActiveTab('headers')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === 'headers'
              ? 'border-[#18181b] text-[#18181b] font-semibold'
              : 'border-transparent text-[#71717a] hover:text-[#18181b]'
          }`}
        >
          Headers ({Object.keys(event.headers || {}).length})
        </button>
        <button
          onClick={() => setActiveTab('log')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === 'log'
              ? 'border-[#18181b] text-[#18181b] font-semibold'
              : 'border-transparent text-[#71717a] hover:text-[#18181b]'
          }`}
        >
          Delivery Log ({event.delivery_log?.length || (event.attempts > 0 ? event.attempts : 1)})
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-auto p-4 bg-white">
        {activeTab === 'payload' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs text-[#71717a] font-medium">JSON Body</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setIsPretty(!isPretty)}
                  className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors"
                >
                  {isPretty ? 'Raw' : 'Pretty'}
                </button>
                <button
                  onClick={() => copyToClipboard(formattedPayload(), 'Payload')}
                  className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors flex items-center gap-1"
                >
                  {copiedKey === 'Payload' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                  Copy
                </button>
                <button
                  onClick={() => copyToClipboard(curlCommand(), 'cURL')}
                  className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors flex items-center gap-1"
                >
                  {copiedKey === 'cURL' ? <Check className="w-3 h-3 text-emerald-600" /> : <Terminal className="w-3 h-3" />}
                  Copy as cURL
                </button>
              </div>
            </div>
            <pre className="p-3 bg-[#fafafa] border border-[#e4e4e7] rounded-lg text-xs font-mono text-[#18181b] overflow-auto max-h-[460px] whitespace-pre-wrap word-break-break-all select-text">
              {isPretty ? formattedPayload() : event.payload_raw || JSON.stringify(event.payload_json || {})}
            </pre>
          </div>
        )}

        {activeTab === 'headers' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs text-[#71717a] font-medium">HTTP Request Headers</span>
              <button
                onClick={() => {
                  const str = Object.entries(event.headers || {})
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n');
                  copyToClipboard(str, 'Semua Headers');
                }}
                className="px-2 py-1 text-[11px] font-medium bg-[#f4f4f5] hover:bg-[#e4e4e7] text-[#18181b] rounded transition-colors flex items-center gap-1"
              >
                <Copy className="w-3 h-3" />
                Copy semua
              </button>
            </div>
            <div className="divide-y divide-[#f4f4f5] border border-[#e4e4e7] rounded-lg overflow-hidden bg-[#fafafa]">
              {Object.entries(event.headers || {}).map(([key, val]) => (
                <div key={key} className="p-2.5 text-xs flex flex-col gap-0.5 hover:bg-white transition-colors">
                  <span className="font-mono font-semibold text-[#71717a] text-[11px]">{key}</span>
                  <span className="font-mono text-[#18181b] break-all select-text">{val}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'log' && (
          <div className="space-y-3">
            <div className="text-xs text-[#71717a] font-medium pb-1 flex items-center justify-between">
              <span>Riwayat Percobaan Pengiriman</span>
              <span className="font-mono">{event.attempts} kali dicoba</span>
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
                        <span className="font-mono text-[#71717a] font-normal text-[11px]">
                          {formatTime(log.t)}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#71717a] mt-0.5">
                        Status:{' '}
                        <span className={`font-mono font-medium ${isOk ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {log.code ? `HTTP ${log.code}` : 'Connection Timeout'}
                        </span>
                        {' '}· Durasi: <span className="font-mono">{log.ms} ms</span>
                      </div>
                      {log.err && (
                        <div className="mt-1 p-2 bg-rose-50 border border-rose-200 rounded text-rose-700 font-mono text-[11px]">
                          {log.err}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="text-xs text-[#71717a]">
                  Event baru masuk dalam antrean atau belum ada riwayat percobaan.
                </div>
              )}
            </div>

            {event.status === 'RETRYING' && event.next_retry_at && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-center gap-2">
                <Clock className="w-4 h-4 shrink-0 text-amber-600" />
                <span>
                  Jadwal pengiriman ulang berikutnya:{' '}
                  <b className="font-mono">{formatTime(event.next_retry_at)}</b>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
