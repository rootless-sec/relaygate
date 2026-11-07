import React, { useState } from 'react';
import {
  Search,
  RotateCw,
  Radio,
  Inbox,
  Pause,
  Play,
  ListFilter,
  X,
  Webhook,
} from 'lucide-react';
import { Endpoint, EventStatus, StatsSummary, WebhookEvent } from '../types';
import { BulkReplayModal, BulkModalState } from './BulkReplayModal';
import { analyzeEventError, formatAttemptsDisplay } from '../utils/formatters';
import { fetchEvents } from '../api';

interface EventsViewProps {
  events: WebhookEvent[];
  stats: StatsSummary | null;
  endpoints: Endpoint[];
  selectedEventId: string | null;
  onSelectEvent: (event: WebhookEvent) => void;
  onReplayEvent: (event: WebhookEvent) => void;
  onBulkReplayFailed: () => void;
  onBulkReplay?: (
    targetIds: string[],
    allFailed: boolean
  ) => Promise<{ replayed_count: number; skipped_count?: number } | void> | void;
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
  onBulkReplay,
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

  const [bulkModal, setBulkModal] = useState<BulkModalState>({
    open: false,
    totalCount: 0,
    eligibleIds: [],
    ineligibleItems: [],
    inProgress: false,
    pollingStatus: null,
    resultData: null,
  });

  const failedEvents = events.filter((e) => e.status === 'FAILED');
  const eligibleEvents = failedEvents.filter((e) => analyzeEventError(e).isEligibleForReplay);
  const eligibleCount = eligibleEvents.length;

  const handleOpenBulkModal = () => {
    const eligibleIds: string[] = [];
    const ineligibleItems: { id: string; reason: string; badgeLabel: string }[] = [];

    failedEvents.forEach((ev) => {
      const analysis = analyzeEventError(ev);
      if (!analysis.isEligibleForReplay) {
        ineligibleItems.push({
          id: ev.id,
          reason: analysis.ineligibleReason || 'Event tidak eligible untuk diputar ulang',
          badgeLabel: analysis.badgeLabel,
        });
      } else {
        eligibleIds.push(ev.id);
      }
    });

    setBulkModal({
      open: true,
      totalCount: failedEvents.length,
      eligibleIds,
      ineligibleItems,
      inProgress: false,
      pollingStatus: null,
      resultData: null,
    });
  };

  const handleExecuteBulkReplay = async () => {
    setBulkModal((prev) => ({
      ...prev,
      inProgress: true,
      pollingStatus: 'Mengirim perintah replay massal...',
    }));

    try {
      if (bulkModal.eligibleIds.length > 0) {
        if (onBulkReplay) {
          await onBulkReplay(bulkModal.eligibleIds, false);
        } else {
          onBulkReplayFailed();
        }

        setBulkModal((prev) => ({
          ...prev,
          pollingStatus: 'Memverifikasi dan memproses pengiriman ulang...',
        }));

        const targetIds = new Set(bulkModal.eligibleIds);
        let finalDelivered: WebhookEvent[] = [];
        let finalFailed: WebhookEvent[] = [];
        let allSettled = false;
        let inProgressCount = 0;

        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 380));
          try {
            const res = await fetchEvents({ limit: 300 });
            const list = res.events || [];
            const tracked = list.filter((e) => targetIds.has(e.id));
            const stillBusy = tracked.filter(
              (e) => e.status === 'PENDING' || e.status === 'RETRYING'
            );

            if (tracked.length >= targetIds.size && stillBusy.length === 0) {
              allSettled = true;
              finalDelivered = tracked.filter((e) => e.status === 'DELIVERED');
              finalFailed = tracked.filter((e) => e.status === 'FAILED');
              break;
            } else if (tracked.length > 0) {
              setBulkModal((prev) => ({
                ...prev,
                pollingStatus: `Memproses pengiriman ulang (${tracked.length - stillBusy.length}/${targetIds.size} selesai)...`,
              }));
            }
          } catch {}
        }

        if (!allSettled) {
          try {
            const res = await fetchEvents({ limit: 300 });
            const list = res.events || [];
            const tracked = list.filter((e) => targetIds.has(e.id));
            finalDelivered = tracked.filter((e) => e.status === 'DELIVERED');
            finalFailed = tracked.filter((e) => e.status === 'FAILED');
            inProgressCount = tracked.filter(
              (e) => e.status === 'PENDING' || e.status === 'RETRYING'
            ).length;
          } catch {}
        }

        const unverifiedEvents = finalFailed.filter(
          (e) => e.is_verified === -1 || (e.failure_code || '').startsWith('SIGNATURE_')
        );
        const deliveryFailedEvents = finalFailed.filter((e) => !unverifiedEvents.includes(e));

        const unverifiedBreakdownMap = new Map<string, number>();
        unverifiedEvents.forEach((ev) => {
          const a = analyzeEventError(ev);
          unverifiedBreakdownMap.set(a.badgeLabel, (unverifiedBreakdownMap.get(a.badgeLabel) || 0) + 1);
        });
        const unverifiedBreakdownParts: string[] = [];
        unverifiedBreakdownMap.forEach((count, label) => {
          unverifiedBreakdownParts.push(`${count} ${label.toLowerCase()}`);
        });

        const deliveryFailedBreakdownMap = new Map<string, number>();
        deliveryFailedEvents.forEach((ev) => {
          const a = analyzeEventError(ev);
          deliveryFailedBreakdownMap.set(
            a.badgeLabel,
            (deliveryFailedBreakdownMap.get(a.badgeLabel) || 0) + 1
          );
        });
        const deliveryFailedBreakdownParts: string[] = [];
        deliveryFailedBreakdownMap.forEach((count, label) => {
          if (label.startsWith('HTTP ')) {
            deliveryFailedBreakdownParts.push(count > 1 ? `${count} ${label}` : label);
          } else {
            deliveryFailedBreakdownParts.push(`${count} ${label.toLowerCase()}`);
          }
        });

        const skippedBreakdownMap = new Map<string, number>();
        bulkModal.ineligibleItems.forEach((item) => {
          skippedBreakdownMap.set(item.badgeLabel, (skippedBreakdownMap.get(item.badgeLabel) || 0) + 1);
        });
        const skippedBreakdownParts: string[] = [];
        skippedBreakdownMap.forEach((count, label) => {
          skippedBreakdownParts.push(`${count} ${label.toLowerCase()}`);
        });

        const N = finalDelivered.length;
        const unvCount = unverifiedEvents.length;
        const delivCount = deliveryFailedEvents.length;
        const M = finalFailed.length;
        const K = bulkModal.ineligibleItems.length;

        let followUpAdvice = '';
        if (M > 0) {
          const allKeys = [
            ...Array.from(unverifiedBreakdownMap.keys()),
            ...Array.from(deliveryFailedBreakdownMap.keys()),
          ].map((k) => k.toLowerCase());
          if (
            allKeys.some(
              (k) => k.includes('signature') || k.includes('mismatch') || k.includes('tidak cocok')
            )
          ) {
            followUpAdvice =
              'Tindak lanjut: Periksa kembali secret key di menu Endpoints dan dashboard provider sebelum mencoba kembali.';
          } else if (allKeys.some((k) => k.includes('504') || k.includes('timeout'))) {
            followUpAdvice =
              'Tindak lanjut: Periksa batas timeout reverse proxy dan daya tanggap downstream.';
          } else if (
            allKeys.some(
              (k) => k.includes('500') || k.includes('502') || k.includes('503') || k.includes('5xx')
            )
          ) {
            followUpAdvice =
              'Tindak lanjut: Periksa error log downstream untuk memperbaiki kegagalan internal.';
          } else if (allKeys.some((k) => k.includes('4xx') || k.includes('400') || k.includes('404'))) {
            followUpAdvice =
              'Tindak lanjut: Periksa rute endpoint dan validasi request downstream.';
          } else {
            followUpAdvice =
              'Tindak lanjut: Periksa konfigurasi endpoint dan log server target downstream.';
          }
        }

        setBulkModal((prev) => ({
          ...prev,
          inProgress: false,
          pollingStatus: null,
          resultData: {
            deliveredCount: N,
            unverifiedCount: unvCount,
            unverifiedBreakdown: unverifiedBreakdownParts.join(', ') || 'gagal verifikasi',
            deliveryFailedCount: delivCount,
            deliveryFailedBreakdown:
              deliveryFailedBreakdownParts.join(', ') || 'gagal pengiriman',
            failedCount: M,
            failedBreakdown:
              deliveryFailedBreakdownParts.join(', ') ||
              unverifiedBreakdownParts.join(', ') ||
              'gagal pengiriman',
            skippedCount: K,
            skippedBreakdown: skippedBreakdownParts.join(', ') || 'tidak eligible',
            followUpAdvice,
            inProgressCount,
          },
        }));
      } else {
        const skippedBreakdownMap = new Map<string, number>();
        bulkModal.ineligibleItems.forEach((item) => {
          skippedBreakdownMap.set(item.badgeLabel, (skippedBreakdownMap.get(item.badgeLabel) || 0) + 1);
        });
        const skippedBreakdownParts: string[] = [];
        skippedBreakdownMap.forEach((count, label) => {
          skippedBreakdownParts.push(`${count} ${label.toLowerCase()}`);
        });

        const K = bulkModal.ineligibleItems.length;
        setBulkModal((prev) => ({
          ...prev,
          inProgress: false,
          pollingStatus: null,
          resultData: {
            deliveredCount: 0,
            failedCount: 0,
            failedBreakdown: '',
            skippedCount: K,
            skippedBreakdown: skippedBreakdownParts.join(', ') || 'tidak eligible',
          },
        }));
      }
    } catch {
      setBulkModal((prev) => ({
        ...prev,
        inProgress: false,
        pollingStatus: null,
        open: false,
      }));
    }
  };

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
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/80">
            Terkirim
          </span>
        );
      case 'RETRYING':
        return (
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200/80">
            Mencoba Ulang
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200/80">
            Gagal
          </span>
        );
      default:
        return (
          <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 text-zinc-700 border border-zinc-200">
            Menunggu
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

  const totalCount = stats ? stats.total_events : events.length;
  const deliveredCount = stats
    ? stats.delivered_events
    : events.filter((e) => e.status === 'DELIVERED').length;
  const pendingCount = stats
    ? stats.pending_events ?? events.filter((e) => e.status === 'PENDING').length
    : events.filter((e) => e.status === 'PENDING').length;
  const retryingCount = stats
    ? stats.retrying_events
    : events.filter((e) => e.status === 'RETRYING').length;
  const failedCount = stats
    ? stats.failed_events
    : events.filter((e) => e.status === 'FAILED').length;

  const activeFilterCount =
    (searchQuery ? 1 : 0) + (statusFilter ? 1 : 0) + (endpointFilter ? 1 : 0);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-white px-7 py-5 overflow-hidden">
      {/* Top Heading + Unified Horizontal Summary Strip */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-zinc-950 tracking-tight whitespace-nowrap truncate">
            Semua Webhook Event
          </h1>
          <p
            className={`text-xs text-zinc-500 mt-0.5 ${
              selectedEventId ? 'hidden xl:block' : 'block'
            }`}
          >
            Aliran webhook masuk beserta status verifikasi signature dan pengiriman downstream.
          </p>
        </div>

        {/* Single-Border Divided Summary Strip (Navattic / Linktree Pattern) */}
        <div
          className="inline-flex items-center border border-zinc-200/90 rounded-lg bg-white divide-x divide-zinc-200/80 shadow-2xs shrink-0"
          data-testid="events-kpi-grid"
        >
          <div className="px-3.5 py-2 flex items-baseline gap-2" data-testid="kpi-total">
            <span
              className="text-sm font-semibold text-zinc-950 tabular-nums"
              data-testid="kpi-total-value"
            >
              {totalCount}
            </span>
            <span className="text-[11px] text-zinc-500">Total</span>
          </div>

          <div className="px-3.5 py-2 flex items-baseline gap-2" data-testid="kpi-delivered">
            <span
              className="text-sm font-semibold text-emerald-700 tabular-nums"
              data-testid="kpi-delivered-value"
            >
              {deliveredCount}
            </span>
            <span className="text-[11px] text-zinc-500">Delivered</span>
          </div>

          <div className="px-3.5 py-2 flex items-baseline gap-2" data-testid="kpi-pending">
            <span
              className="text-sm font-semibold text-zinc-900 tabular-nums"
              data-testid="kpi-pending-value"
            >
              {pendingCount}
            </span>
            <span className="text-[11px] text-zinc-500">
              <span>Menunggu</span>
            </span>
          </div>

          <div className="px-3.5 py-2 flex items-baseline gap-2" data-testid="kpi-retrying">
            <span
              className="text-sm font-semibold text-amber-700 tabular-nums"
              data-testid="kpi-retrying-value"
            >
              {retryingCount}
            </span>
            <span className="text-[11px] text-zinc-500">Retrying</span>
          </div>

          <div className="px-3.5 py-2 flex items-baseline gap-2" data-testid="kpi-failed">
            <span
              className="text-sm font-semibold text-rose-700 tabular-nums"
              data-testid="kpi-failed-value"
            >
              {failedCount}
            </span>
            <span className="text-[11px] text-zinc-500">Gagal</span>
          </div>
        </div>
      </div>

      {/* Navattic 2-Row Search & Filter Well */}
      <div className="space-y-2.5 pb-3.5 shrink-0">
        {/* Row 1: Search Input + Filter Count Button + Right Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <div className="relative w-64 max-w-full">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Cari event ID, endpoint..."
                className="w-full h-8 pl-8 pr-3 text-xs bg-white border border-zinc-200/90 rounded-md text-zinc-900 placeholder:text-zinc-400 shadow-2xs focus:outline-none focus:border-zinc-900 transition-colors"
              />
            </div>

            <div className="inline-flex items-center gap-1.5 h-8 px-2.5 bg-white border border-zinc-200/90 rounded-md text-xs font-medium text-zinc-700 shadow-2xs select-none">
              <ListFilter className="w-3.5 h-3.5 text-zinc-500" />
              <span>Filter</span>
              <span className="px-1.5 py-0.2 rounded bg-zinc-100 text-zinc-700 font-mono text-[11px] tabular-nums">
                {activeFilterCount}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleOpenBulkModal}
              disabled={eligibleCount === 0}
              className={`flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-semibold shadow-2xs transition-colors ${
                eligibleCount > 0
                  ? 'bg-zinc-900 hover:bg-zinc-800 text-white cursor-pointer'
                  : 'bg-zinc-100 text-zinc-600 border border-zinc-200 cursor-not-allowed'
              }`}
              aria-label={`Replay ${eligibleCount} event yang eligible`}
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span className={eligibleCount > 0 ? 'text-white' : 'text-zinc-600'}>
                Replay yang eligible ({eligibleCount})
              </span>
            </button>

            <button
              type="button"
              onClick={onToggleLive}
              title={isLive ? 'Jeda stream real-time' : 'Lanjutkan stream real-time'}
              className="flex items-center gap-1.5 h-8 px-3 bg-white hover:bg-zinc-50 text-zinc-800 border border-zinc-200/90 rounded-md text-xs font-medium shadow-2xs transition-colors cursor-pointer"
            >
              {isLive ? (
                <>
                  <Pause className="w-3.5 h-3.5 text-zinc-500" />
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

        {/* Row 2: Navattic Recessed Gray Filter Well (`Events: [Engaged x | v]  x Clear`) */}
        <div className="bg-zinc-50/90 border border-zinc-200/70 rounded-lg px-3 py-2 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 h-7 px-2.5 bg-white border border-zinc-200/90 rounded-md text-xs shadow-2xs">
            <span className="text-zinc-500">Status:</span>
            <select
              value={statusFilter}
              onChange={(e) => handleStatusFilterChange(e.target.value)}
              className="bg-transparent text-xs font-medium text-zinc-900 focus:outline-none cursor-pointer"
              aria-label="Filter status event"
            >
              <option value="">Semua status</option>
              <option value="DELIVERED">Terkirim</option>
              <option value="RETRYING">Mencoba Ulang</option>
              <option value="FAILED">Gagal</option>
              <option value="PENDING">Menunggu</option>
            </select>
          </div>

          <div className="inline-flex items-center gap-1.5 h-7 px-2.5 bg-white border border-zinc-200/90 rounded-md text-xs shadow-2xs">
            <span className="text-zinc-500">Endpoint:</span>
            <select
              value={endpointFilter}
              onChange={(e) => handleEndpointFilterChange(e.target.value)}
              className="bg-transparent text-xs font-medium text-zinc-900 focus:outline-none cursor-pointer"
              aria-label="Filter endpoint event"
            >
              <option value="">Semua endpoint</option>
              {endpoints.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.name}
                </option>
              ))}
            </select>
          </div>

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => {
                handleSearchChange('');
                handleStatusFilterChange('');
                handleEndpointFilterChange('');
              }}
              className="inline-flex items-center gap-1 h-7 px-2 text-xs font-medium text-zinc-600 hover:text-zinc-950 transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Buffered Real-time Notification Banner */}
      {bufferedCount > 0 && (
        <div className="mb-3 shrink-0">
          <button
            onClick={onFlushBuffer}
            className="w-full py-1.5 px-3 bg-sky-50 border border-sky-200 text-sky-800 text-xs font-medium rounded-md hover:bg-sky-100 transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <Radio className="w-3.5 h-3.5 text-sky-600" />
            <span>{bufferedCount} event baru masuk antrean, klik untuk memuat ke tampilan</span>
          </button>
        </div>
      )}

      {/* Navattic Bordered Grid Table */}
      <div className="flex-1 border border-zinc-200/90 rounded-lg bg-white overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-zinc-50/95 border-b border-zinc-200/90 text-xs font-medium text-zinc-600 select-none z-10">
            <tr className="divide-x divide-zinc-200/60">
              <th className="py-2.5 px-3.5 whitespace-nowrap">Event ID</th>
              <th className="py-2.5 px-3.5 whitespace-nowrap">Status</th>
              <th className="py-2.5 px-3.5 whitespace-nowrap">Waktu</th>
              {!selectedEventId && (
                <th className="py-2.5 px-3.5 whitespace-nowrap">Endpoint</th>
              )}
              {!selectedEventId && (
                <th className="py-2.5 px-3.5 whitespace-nowrap">Provider</th>
              )}
              {!selectedEventId && (
                <th className="py-2.5 px-3.5 text-center whitespace-nowrap">Signature</th>
              )}
              {!selectedEventId && (
                <th className="py-2.5 px-3.5 whitespace-nowrap">Percobaan</th>
              )}
              {!selectedEventId && (
                <th className="py-2.5 px-3.5 text-right whitespace-nowrap">Aksi</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200/70">
            {paginatedEvents.length > 0 ? (
              paginatedEvents.map((ev) => {
                const isSelected = selectedEventId === ev.id;
                return (
                  <tr
                    key={ev.id}
                    id={`event-row-${ev.id}`}
                    onClick={() => onSelectEvent(ev)}
                    className={`cursor-pointer transition-colors divide-x divide-zinc-100 ${
                      isSelected ? 'bg-zinc-100/80' : 'hover:bg-zinc-50/70'
                    }`}
                  >
                    {/* Navattic Avatar + Two-Line Primary Cell */}
                    <td className="py-3 px-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="size-7 rounded-full bg-zinc-100 border border-zinc-200/80 flex items-center justify-center text-zinc-600 shrink-0">
                          <Webhook className="w-3.5 h-3.5" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span
                            className="font-mono font-medium text-zinc-900 text-xs"
                            title={ev.id}
                          >
                            {selectedEventId ? `${ev.id.slice(0, 10)}...` : ev.id}
                          </span>
                          <span className="text-[11px] text-zinc-500 truncate">
                            {ev.endpoint_id} · {ev.provider}
                          </span>
                        </div>
                      </div>
                    </td>

                    <td className="py-3 px-3.5 whitespace-nowrap">
                      {getStatusBadge(ev.status)}
                    </td>

                    <td className="py-3 px-3.5 font-mono text-zinc-600 whitespace-nowrap tabular-nums">
                      {formatTime(ev.created_at)}
                    </td>

                    {!selectedEventId && (
                      <td className="py-3 px-3.5 text-zinc-800 font-medium whitespace-nowrap">
                        {ev.endpoint_id}
                      </td>
                    )}

                    {!selectedEventId && (
                      <td className="py-3 px-3.5 text-zinc-500 uppercase font-mono text-[11px] whitespace-nowrap">
                        {ev.provider}
                      </td>
                    )}

                    {!selectedEventId && (
                      <td className="py-3 px-3.5 text-center whitespace-nowrap">
                        {ev.is_verified === 1 ? (
                          <span className="text-emerald-700 font-bold" title="Signature valid">
                            ✓
                          </span>
                        ) : ev.is_verified === -1 ? (
                          <span className="text-rose-700 font-bold" title="Signature tidak valid">
                            ⚠
                          </span>
                        ) : (
                          <span className="text-zinc-400" title="Signature dilewati">
                            -
                          </span>
                        )}
                      </td>
                    )}

                    {!selectedEventId && (
                      <td className="py-3 px-3.5 text-zinc-600 whitespace-nowrap tabular-nums">
                        {(() => {
                          const attInfo = formatAttemptsDisplay(ev);
                          return attInfo.isRejected ? (
                            <div className="flex flex-col">
                              <span className="text-zinc-900 font-medium text-xs whitespace-nowrap">
                                {attInfo.primaryText}
                              </span>
                              {attInfo.secondaryText && (
                                <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                                  {attInfo.secondaryText}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              <span className="font-mono text-xs text-zinc-700 tabular-nums">
                                {attInfo.primaryText.replace(/\s+/g, '')}
                              </span>
                              {attInfo.secondaryText && (
                                <span
                                  className={`text-[11px] whitespace-nowrap ${
                                    ev.status === 'RETRYING'
                                      ? 'text-amber-700 font-medium'
                                      : 'text-zinc-500'
                                  }`}
                                >
                                  {attInfo.secondaryText}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                    )}

                    {!selectedEventId && (
                      <td
                        className="py-3 px-3.5 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => onReplayEvent(ev)}
                          title="Kirim ulang webhook (r)"
                          className="px-2.5 py-1 bg-white hover:bg-zinc-50 border border-zinc-200/90 rounded-md text-xs font-medium text-zinc-800 shadow-2xs transition-colors cursor-pointer"
                        >
                          Replay
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={selectedEventId ? 3 : 8} className="py-16 text-center text-zinc-500">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <Inbox className="w-7 h-7 text-zinc-400" />
                    <p className="text-sm font-medium text-zinc-800">
                      Tidak ada event yang cocok dengan filter.
                    </p>
                    <p className="text-xs text-zinc-500">
                      Coba ubah kata kunci pencarian atau reset filter.
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Navattic Bottom Pagination Row (`[25 v] rows per page`) */}
      {totalItems > 0 && (
        <div className="pt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600 select-none shrink-0 tabular-nums">
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              aria-label="Baris per halaman"
              className="h-7 px-2 bg-white border border-zinc-200/90 rounded-md text-xs font-medium text-zinc-800 shadow-2xs focus:outline-none cursor-pointer"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span className="text-zinc-500">baris per halaman</span>
            <span className="text-zinc-400 mx-1">·</span>
            <span className="text-zinc-500">
              Menampilkan <b className="text-zinc-900">{startIndex + 1}</b> -{' '}
              <b className="text-zinc-900">{Math.min(startIndex + pageSize, totalItems)}</b> dari{' '}
              <b className="text-zinc-900">{totalItems}</b>
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={validPage <= 1}
              className="h-7 px-2.5 bg-white hover:bg-zinc-50 border border-zinc-200/90 rounded-md text-xs font-medium text-zinc-800 shadow-2xs disabled:opacity-40 transition-colors cursor-pointer"
            >
              Sebelumnya
            </button>
            <span className="px-2 font-mono text-xs text-zinc-600 tabular-nums">
              {validPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={validPage >= totalPages}
              className="h-7 px-2.5 bg-white hover:bg-zinc-50 border border-zinc-200/90 rounded-md text-xs font-medium text-zinc-800 shadow-2xs disabled:opacity-40 transition-colors cursor-pointer"
            >
              Berikutnya
            </button>
          </div>
        </div>
      )}

      {/* Shared Bulk Replay Modal */}
      <BulkReplayModal
        bulkModal={bulkModal}
        onClose={() => setBulkModal((prev) => ({ ...prev, open: false, resultData: null }))}
        onConfirm={handleExecuteBulkReplay}
      />
    </div>
  );
};
