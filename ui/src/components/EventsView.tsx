import React, { useState } from 'react';
import { 
  Search, 
  RotateCw, 
  Radio, 
  Layers, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Inbox
} from 'lucide-react';
import { Endpoint, EventStatus, StatsSummary, WebhookEvent } from '../types';

interface EventsViewProps {
  events: WebhookEvent[];
  stats: StatsSummary | null;
  endpoints: Endpoint[];
  selectedEventId: string | null;
  onSelectEvent: (event: WebhookEvent) => void;
  onReplayEvent: (event: WebhookEvent) => void;
  onBulkReplayFailed: () => void;
  isLive: boolean;
  onToggleLive: () => void;
  bufferedCount: number;
  onFlushBuffer: () => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
}

export const EventsView: React.FC<EventsViewProps> = ({
  events,
  stats,
  endpoints,
  selectedEventId,
  onSelectEvent,
  onReplayEvent,
  onBulkReplayFailed,
  isLive,
  onToggleLive,
  bufferedCount,
  onFlushBuffer,
  searchInputRef,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [endpointFilter, setEndpointFilter] = useState<string>('');

  // Filtered event list
  const filteredEvents = events.filter((ev) => {
    if (statusFilter && ev.status !== statusFilter) return false;
    if (endpointFilter && ev.endpoint_id !== endpointFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const rawText = (ev.id + ev.endpoint_id + ev.provider + (ev.payload_raw || '')).toLowerCase();
      if (!rawText.includes(q)) return false;
    }
    return true;
  });

  const getStatusBadge = (status: EventStatus) => {
    switch (status) {
      case 'DELIVERED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
            DELIVERED
          </span>
        );
      case 'RETRYING':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-pulse" />
            RETRYING
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-600" />
            FAILED
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-700 border border-zinc-200">
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

  const failedCount = stats ? stats.failed_events : events.filter((e) => e.status === 'FAILED').length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#fafafa]">
      {/* Metric Stat Cards */}
      <div className="grid grid-cols-4 gap-3 p-4 pb-2">
        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3 shadow-2xs">
          <div className="text-[11px] font-medium text-[#71717a] flex items-center justify-between">
            <span>Total Events</span>
            <Layers className="w-3.5 h-3.5 text-[#a1a1aa]" />
          </div>
          <div className="text-xl font-bold text-[#18181b] mt-1">
            {stats ? stats.total_events : events.length}
          </div>
        </div>

        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3 shadow-2xs">
          <div className="text-[11px] font-medium text-[#71717a] flex items-center justify-between">
            <span>Delivered</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <div className="text-xl font-bold text-emerald-700 mt-1">
            {stats ? stats.delivered_events : events.filter((e) => e.status === 'DELIVERED').length}
          </div>
        </div>

        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3 shadow-2xs">
          <div className="text-[11px] font-medium text-[#71717a] flex items-center justify-between">
            <span>Retrying</span>
            <Clock className="w-3.5 h-3.5 text-amber-600" />
          </div>
          <div className="text-xl font-bold text-amber-700 mt-1">
            {stats ? stats.retrying_events : events.filter((e) => e.status === 'RETRYING').length}
          </div>
        </div>

        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3 shadow-2xs">
          <div className="text-[11px] font-medium text-[#71717a] flex items-center justify-between">
            <span>Dead-letter</span>
            <AlertCircle className="w-3.5 h-3.5 text-rose-600" />
          </div>
          <div className="text-xl font-bold text-rose-700 mt-1">
            {failedCount}
          </div>
        </div>
      </div>

      {/* Filter and Control Bar */}
      <div className="p-4 py-2 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#a1a1aa]" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari event ID, endpoint, payload... ( / )"
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] focus:outline-none focus:border-[#18181b] transition-colors"
        >
          <option value="">Semua status</option>
          <option value="DELIVERED">DELIVERED</option>
          <option value="RETRYING">RETRYING</option>
          <option value="FAILED">FAILED</option>
          <option value="PENDING">PENDING</option>
        </select>

        <select
          value={endpointFilter}
          onChange={(e) => setEndpointFilter(e.target.value)}
          className="px-3 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] focus:outline-none focus:border-[#18181b] transition-colors"
        >
          <option value="">Semua endpoint</option>
          {endpoints.map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={onBulkReplayFailed}
            disabled={failedCount === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-[#f4f4f5] text-[#18181b] border border-[#e4e4e7] rounded-md text-xs font-semibold disabled:opacity-50 transition-colors shadow-2xs"
          >
            <RotateCw className="w-3.5 h-3.5 text-[#71717a]" />
            Replay FAILED ({failedCount})
          </button>

          <button
            onClick={onToggleLive}
            className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-md text-xs font-semibold transition-colors shadow-2xs ${
              isLive
                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                : 'bg-white text-[#71717a] border-[#e4e4e7]'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isLive ? 'bg-emerald-600 animate-ping' : 'bg-[#a1a1aa]'
              }`}
            />
            <span>{isLive ? 'Live Ingest' : 'Dijeda'}</span>
          </button>
        </div>
      </div>

      {/* New Event Notification Banner */}
      {bufferedCount > 0 && (
        <div className="mx-4 mb-2">
          <button
            onClick={onFlushBuffer}
            className="w-full py-1.5 px-3 bg-sky-50 border border-sky-200 text-sky-800 text-xs font-medium rounded-md hover:bg-sky-100 transition-colors flex items-center justify-center gap-2"
          >
            <Radio className="w-3.5 h-3.5 text-sky-600 animate-pulse" />
            <span>{bufferedCount} event baru masuk antrean, klik untuk memuat ke tampilan</span>
          </button>
        </div>
      )}

      {/* Events Table Container */}
      <div className="flex-1 mx-4 mb-4 bg-white border border-[#e4e4e7] rounded-lg overflow-auto shadow-2xs">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-[#fafafa] border-b border-[#e4e4e7] text-[11px] font-semibold text-[#71717a] uppercase tracking-wider select-none z-10">
            <tr>
              <th className="py-2.5 px-3">Status</th>
              <th className="py-2.5 px-3">Waktu</th>
              <th className="py-2.5 px-3">Event ID</th>
              <th className="py-2.5 px-3">Endpoint</th>
              <th className="py-2.5 px-3">Provider</th>
              <th className="py-2.5 px-3 text-center">Signature</th>
              <th className="py-2.5 px-3">Percobaan</th>
              <th className="py-2.5 px-3 text-right">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f4f4f5]">
            {filteredEvents.length > 0 ? (
              filteredEvents.map((ev) => {
                const isSelected = selectedEventId === ev.id;
                return (
                  <tr
                    key={ev.id}
                    onClick={() => onSelectEvent(ev)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[#f4f4f5] border-l-2 border-l-[#18181b]'
                        : 'hover:bg-[#fafafa]'
                    }`}
                  >
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      {getStatusBadge(ev.status)}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#71717a] whitespace-nowrap">
                      {formatTime(ev.created_at)}
                    </td>
                    <td className="py-2.5 px-3 font-mono font-medium text-[#18181b] whitespace-nowrap">
                      {ev.id}
                    </td>
                    <td className="py-2.5 px-3 text-[#18181b] font-medium whitespace-nowrap">
                      {ev.endpoint_id}
                    </td>
                    <td className="py-2.5 px-3 text-[#71717a] uppercase text-[11px] whitespace-nowrap">
                      {ev.provider}
                    </td>
                    <td className="py-2.5 px-3 text-center whitespace-nowrap">
                      {ev.is_verified === 1 ? (
                        <span className="text-emerald-700 font-bold" title="Signature valid">
                          ✓
                        </span>
                      ) : ev.is_verified === -1 ? (
                        <span className="text-rose-700 font-bold" title="Signature tidak valid">
                          ⚠
                        </span>
                      ) : (
                        <span className="text-[#a1a1aa]" title="Signature dilewati">
                          —
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-[#71717a] whitespace-nowrap">
                      <span className="font-mono">
                        {ev.attempts}/{ev.max_attempts}
                      </span>
                      {ev.status === 'RETRYING' && ev.next_retry_at && (
                        <span className="ml-1.5 text-[11px] text-amber-700">
                          (retry {formatTime(ev.next_retry_at)})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onReplayEvent(ev)}
                        title="Kirim ulang webhook (r)"
                        className="px-2 py-0.5 bg-white hover:bg-[#f4f4f5] border border-[#e4e4e7] rounded text-[11px] font-semibold text-[#18181b] transition-colors"
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
                    <Inbox className="w-8 h-8 text-[#a1a1aa]" />
                    <p className="text-sm font-medium">Tidak ada event yang cocok dengan filter.</p>
                    <p className="text-xs text-[#a1a1aa]">Coba ubah kata kunci pencarian atau reset filter.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
