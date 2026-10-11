import React, { useState } from 'react';
import { 
  AlertOctagon, 
  RotateCw, 
  CheckSquare, 
  Square, 
  CheckCircle, 
  AlertTriangle 
} from 'lucide-react';
import { Endpoint, WebhookEvent } from '../types';

interface DeadLetterViewProps {
  events: WebhookEvent[];
  endpoints: Endpoint[];
  onSelectEvent: (event: WebhookEvent) => void;
  onReplaySingle: (event: WebhookEvent) => void;
  onBulkReplay: (targetIds: string[], allFailed: boolean) => void;
}

export const DeadLetterView: React.FC<DeadLetterViewProps> = ({
  events,
  endpoints,
  onSelectEvent,
  onReplaySingle,
  onBulkReplay,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [endpointFilter, setEndpointFilter] = useState('');
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    count: number;
    isAll: boolean;
  }>({ open: false, count: 0, isAll: false });

  // Filter for FAILED status only
  const failedEvents = events.filter((ev) => {
    if (ev.status !== 'FAILED') return false;
    if (endpointFilter && ev.endpoint_id !== endpointFilter) return false;
    return true;
  });

  const allSelected = failedEvents.length > 0 && failedEvents.every((e) => selectedIds.has(e.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(failedEvents.map((e) => e.id)));
    }
  };

  const toggleSelectOne = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleOpenConfirm = (isAll: boolean) => {
    const count = isAll ? failedEvents.length : selectedIds.size;
    if (count === 0) return;
    setConfirmModal({ open: true, count, isAll });
  };

  const handleExecuteReplay = () => {
    if (confirmModal.isAll) {
      onBulkReplay([], true);
      setSelectedIds(new Set());
    } else {
      onBulkReplay(Array.from(selectedIds), false);
      setSelectedIds(new Set());
    }
    setConfirmModal({ open: false, count: 0, isAll: false });
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
    <div className="flex-1 overflow-auto p-4 flex flex-col bg-[#fafafa]">
      {/* Header Description */}
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <AlertOctagon className="w-5 h-5 text-rose-600" />
          <h2 className="text-base font-bold text-[#18181b] tracking-tight">Dead-Letter Queue (DLQ)</h2>
        </div>
        <p className="text-xs text-[#71717a] mt-0.5">
          Event webhook yang gagal dikirim setelah seluruh kuota percobaan habis. Periksa log kesalahan di bawah, kemudian picu replay.
        </p>
      </div>

      {/* Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 bg-white p-3 border border-[#e4e4e7] rounded-lg shadow-2xs">
        <div className="flex items-center gap-2">
          <select
            value={endpointFilter}
            onChange={(e) => setEndpointFilter(e.target.value)}
            className="px-3 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] focus:outline-none focus:border-[#18181b]"
          >
            <option value="">Semua endpoint</option>
            {endpoints.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.name}
              </option>
            ))}
          </select>

          <span className="text-xs text-[#71717a] font-mono">
            {failedEvents.length} event gagal terdata
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => handleOpenConfirm(false)}
            disabled={selectedIds.size === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-[#f4f4f5] text-[#18181b] border border-[#e4e4e7] rounded-md text-xs font-semibold disabled:opacity-40 transition-colors shadow-2xs"
          >
            <RotateCw className="w-3.5 h-3.5 text-[#71717a]" />
            Replay Terpilih ({selectedIds.size})
          </button>

          <button
            onClick={() => handleOpenConfirm(true)}
            disabled={failedEvents.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#18181b] hover:bg-[#27272a] text-white rounded-md text-xs font-semibold disabled:opacity-40 transition-colors shadow-2xs"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Replay Semua ({failedEvents.length})
          </button>
        </div>
      </div>

      {/* DLQ Table */}
      <div className="flex-1 bg-white border border-[#e4e4e7] rounded-lg overflow-auto shadow-2xs">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="sticky top-0 bg-[#fafafa] border-b border-[#e4e4e7] text-[11px] font-semibold text-[#71717a] uppercase tracking-wider select-none z-10">
            <tr>
              <th className="py-2.5 px-3 w-10">
                <button
                  onClick={toggleSelectAll}
                  className="flex items-center justify-center text-[#71717a] hover:text-[#18181b]"
                >
                  {allSelected ? (
                    <CheckSquare className="w-4 h-4 text-[#18181b]" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                </button>
              </th>
              <th className="py-2.5 px-3">Event ID</th>
              <th className="py-2.5 px-3">Endpoint Target</th>
              <th className="py-2.5 px-3">Provider</th>
              <th className="py-2.5 px-3">Kesalahan Terakhir</th>
              <th className="py-2.5 px-3">Percobaan</th>
              <th className="py-2.5 px-3">Waktu</th>
              <th className="py-2.5 px-3 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f4f4f5]">
            {failedEvents.length > 0 ? (
              failedEvents.map((ev) => {
                const isChecked = selectedIds.has(ev.id);
                return (
                  <tr
                    key={ev.id}
                    onClick={() => onSelectEvent(ev)}
                    className="hover:bg-[#fafafa] cursor-pointer transition-colors"
                  >
                    <td className="py-2 px-3" onClick={(e) => toggleSelectOne(ev.id, e)}>
                      <button className="flex items-center justify-center text-[#71717a] hover:text-[#18181b]">
                        {isChecked ? (
                          <CheckSquare className="w-4 h-4 text-[#18181b]" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                    </td>
                    <td className="py-2.5 px-3 font-mono font-medium text-[#18181b]">
                      {ev.id}
                    </td>
                    <td className="py-2.5 px-3 font-medium text-[#18181b]">
                      {ev.endpoint_id}
                    </td>
                    <td className="py-2.5 px-3 text-[#71717a] uppercase text-[11px]">
                      {ev.provider}
                    </td>
                    <td className="py-2.5 px-3 text-rose-700 font-mono text-[11px] max-w-xs truncate">
                      {ev.http_status_code ? `HTTP ${ev.http_status_code} · ` : ''}
                      {ev.last_error || 'Gagal terkirim'}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#71717a]">
                      {ev.attempts}/{ev.max_attempts}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#71717a]">
                      {formatTime(ev.created_at)}
                    </td>
                    <td className="py-2.5 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onReplaySingle(ev)}
                        className="px-2.5 py-1 bg-white hover:bg-[#f4f4f5] text-[#18181b] border border-[#e4e4e7] rounded text-xs font-semibold shadow-2xs transition-colors"
                      >
                        Replay
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={8} className="py-16 text-center text-[#71717a]">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <CheckCircle className="w-8 h-8 text-emerald-600" />
                    <p className="text-sm font-semibold text-[#18181b]">
                      Dead-letter queue kosong!
                    </p>
                    <p className="text-xs text-[#71717a]">
                      Seluruh pengiriman webhook berhasil terkirim ke target endpoint masing-masing.
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Confirmation Modal */}
      {confirmModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white border border-[#e4e4e7] rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <h3 className="text-sm font-bold text-[#18181b]">
                Konfirmasi Replay Webhook
              </h3>
            </div>
            <p className="text-xs text-[#71717a] mb-5 leading-relaxed">
              Apakah Anda yakin ingin memicu replay segera untuk{' '}
              <b className="text-[#18181b]">{confirmModal.count} event</b> status FAILED? Event akan diproses ulang oleh worker pool.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmModal({ open: false, count: 0, isAll: false })}
                className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] rounded-lg transition-colors"
              >
                Batal
              </button>
              <button
                onClick={handleExecuteReplay}
                className="px-3.5 py-1.5 text-xs font-semibold bg-[#18181b] hover:bg-[#27272a] text-white rounded-lg transition-colors shadow-xs"
              >
                Ya, Replay Sekarang
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
