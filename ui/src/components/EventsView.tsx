import React, { useState } from 'react';
import { 
  Search, 
  RotateCw, 
  Radio, 
  Layers, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Inbox,
  Pause,
  Play
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
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Reset page when filter changes
  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    setCurrentPage(1);
  };
  const handleStatusFilterChange = (val: string) => {
    setStatusFilter(val);
    setCurrentPage(1);
  };
  const handleEndpointFilterChange = (val: string) => {
    setEndpointFilter(val);
    setCurrentPage(1);
  };

  // Filtered event list
  const filteredEvents = events.filter((ev) => {
    if (statusFilter && ev.status !== statusFilter) return false;
    if (endpointFilter && ev.endpoint_id !== endpointFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const rawText = (
        ev.id +
        ' ' +
        ev.endpoint_id +
        ' ' +
        ev.provider +
        ' ' +
        (ev.payload_raw || '') +
        ' ' +
        (ev.payload_json ? JSON.stringify(ev.payload_json) : '')
      ).toLowerCase();
      if (!rawText.includes(q)) return false;
    }
    return true;
  });

  const totalItems = filteredEvents.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const validPage = Math.min(currentPage, totalPages);
  const startIndex = (validPage - 1) * pageSize;
  const paginatedEvents = filteredEvents.slice(startIndex, startIndex + pageSize);

  const getStatusBadge = (status: EventStatus) => {
    switch (status) {
      case 'DELIVERED':
        return (
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-emerald-50 text-emerald-700 border border-emerald-200">
            DELIVERED
          </span>
        );
      case 'RETRYING':
        return (
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-amber-50 text-amber-700 border border-amber-200">
            RETRYING
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-rose-50 text-rose-700 border border-rose-200">
            FAILED
          </span>
        );
      default:
        return (
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide bg-zinc-100 text-zinc-700 border border-zinc-200">
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
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Cari event ID, endpoint, payload... ( / )"
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => handleStatusFilterChange(e.target.value)}
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
          onChange={(e) => handleEndpointFilterChange(e.target.value)}
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
            title={isLive ? 'Jeda stream real-time' : 'Lanjutkan stream real-time'}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-[#f4f4f5] text-[#18181b] border border-[#e4e4e7] rounded-md text-xs font-semibold transition-colors shadow-2xs"
          >
            {isLive ? (
              <>
                <Pause className="w-3.5 h-3.5 text-[#71717a]" />
                <span>Pause Stream</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 text-emerald-600" />
                <span>Resume Stream</span>
              </>
            )}
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
            <Radio className="w-3.5 h-3.5 text-sky-600" />
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
            {paginatedEvents.length > 0 ? (
              paginatedEvents.map((ev) => {
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

        {/* Pagination Toolbar */}
        {totalItems > 0 && (
          <div className="border-t border-[#e4e4e7] bg-[#fafafa] px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#71717a] select-none sticky bottom-0">
            <div className="flex items-center gap-2">
              <span>
                Menampilkan <b className="text-[#18181b]">{startIndex + 1}</b> -{' '}
                <b className="text-[#18181b]">{Math.min(startIndex + pageSize, totalItems)}</b> dari{' '}
                <b className="text-[#18181b]">{totalItems}</b> event
              </span>
              <div className="flex items-center gap-1 ml-2">
                <span>Per halaman:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="bg-white border border-[#e4e4e7] rounded px-1.5 py-0.5 text-xs text-[#18181b] focus:outline-none"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={validPage <= 1}
                className="px-2 py-1 bg-white hover:bg-[#f4f4f5] border border-[#e4e4e7] rounded text-xs font-semibold text-[#18181b] disabled:opacity-40 transition-colors"
              >
                Sebelumnya
              </button>
              <span className="px-2 font-mono text-[11px]">
                {validPage} / {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={validPage >= totalPages}
                className="px-2 py-1 bg-white hover:bg-[#f4f4f5] border border-[#e4e4e7] rounded text-xs font-semibold text-[#18181b] disabled:opacity-40 transition-colors"
              >
                Berikutnya
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
