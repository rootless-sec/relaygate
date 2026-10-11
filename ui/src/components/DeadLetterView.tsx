import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  AlertOctagon, 
  RotateCw, 
  Check, 
  Copy, 
  Search, 
  X, 
  AlertTriangle, 
  CheckCircle, 
  ArrowDown, 
  ArrowUp, 
  Filter, 
  Inbox
} from 'lucide-react';
import { Endpoint, WebhookEvent } from '../types';
import { fetchEvents } from '../api';
import { 
  formatRelativeTime, 
  formatAbsoluteTime, 
  analyzeEventError,
  ErrorCategoryType 
} from '../utils/formatters';

interface DeadLetterViewProps {
  events: WebhookEvent[];
  endpoints: Endpoint[];
  selectedEventId: string | null;
  onSelectEvent: (event: WebhookEvent) => void;
  onReplaySingle: (event: WebhookEvent) => void;
  onBulkReplay: (targetIds: string[], allFailed: boolean) => void | Promise<void>;
  onNavigateToEndpoint?: (endpointId: string) => void;
}

type SortDirection = 'desc' | 'asc';
type DateRangePreset = 'all' | '1h' | '24h' | '7d';

export const DeadLetterView: React.FC<DeadLetterViewProps> = ({
  events,
  endpoints,
  selectedEventId,
  onSelectEvent,
  onReplaySingle,
  onBulkReplay,
}) => {
  // 1. URL Query State Sync Initialization
  const initialParams = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search);
    } catch {
      return new URLSearchParams();
    }
  }, []);

  const [searchQuery, setSearchQuery] = useState(initialParams.get('dlq_q') || '');
  const [endpointFilter, setEndpointFilter] = useState(initialParams.get('dlq_endpoint') || '');
  const [providerFilter, setProviderFilter] = useState(initialParams.get('dlq_provider') || '');
  const [errorTypeFilter, setErrorTypeFilter] = useState<ErrorCategoryType | ''>(
    (initialParams.get('dlq_error') as ErrorCategoryType) || ''
  );
  const [dateRangeFilter, setDateRangeFilter] = useState<DateRangePreset>(
    (initialParams.get('dlq_range') as DateRangePreset) || 'all'
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    (initialParams.get('dlq_sort') as SortDirection) || 'desc'
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [serverFailed, setServerFailed] = useState<WebhookEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Modals
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    count: number;
    isAll: boolean;
    hasInvalidSignature: boolean;
  }>({ open: false, count: 0, isAll: false, hasInvalidSignature: false });

  const [invalidSingleConfirm, setInvalidSingleConfirm] = useState<WebhookEvent | null>(null);

  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  // 2. Fetch failed events from server
  const loadFailedEvents = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchEvents({ status: 'FAILED', limit: 200 });
      setServerFailed(res.events || []);
    } catch {
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFailedEvents();
  }, [loadFailedEvents, events]);

  // Sync state changes to URL query parameters
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (searchQuery) params.set('dlq_q', searchQuery);
      else params.delete('dlq_q');

      if (endpointFilter) params.set('dlq_endpoint', endpointFilter);
      else params.delete('dlq_endpoint');

      if (providerFilter) params.set('dlq_provider', providerFilter);
      else params.delete('dlq_provider');

      if (errorTypeFilter) params.set('dlq_error', errorTypeFilter);
      else params.delete('dlq_error');

      if (dateRangeFilter !== 'all') params.set('dlq_range', dateRangeFilter);
      else params.delete('dlq_range');

      if (sortDirection !== 'desc') params.set('dlq_sort', sortDirection);
      else params.delete('dlq_sort');

      const newUrl = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState({}, '', newUrl);
    } catch {}
  }, [searchQuery, endpointFilter, providerFilter, errorTypeFilter, dateRangeFilter, sortDirection]);

  // 3. Merge server and live failed events
  const allFailedMap = new Map<string, WebhookEvent>();
  serverFailed.forEach((e) => allFailedMap.set(e.id, e));
  events.filter((e) => e.status === 'FAILED').forEach((e) => allFailedMap.set(e.id, e));
  events.filter((e) => e.status !== 'FAILED').forEach((e) => allFailedMap.delete(e.id));
  const mergedFailed = Array.from(allFailedMap.values());

  // 4. Filter and sort
  const filteredEvents = useMemo(() => {
    const now = Date.now();

    return mergedFailed
      .filter((ev) => {
        // Endpoint filter
        if (endpointFilter && ev.endpoint_id !== endpointFilter) return false;

        // Provider filter
        if (providerFilter && ev.provider !== providerFilter) return false;

        // Error type filter
        if (errorTypeFilter) {
          const analysis = analyzeEventError(ev);
          if (analysis.type !== errorTypeFilter) return false;
        }

        // Date range filter
        if (dateRangeFilter !== 'all') {
          const timestamp = new Date(ev.updated_at || ev.created_at).getTime();
          const diffMs = now - timestamp;
          if (dateRangeFilter === '1h' && diffMs > 60 * 60 * 1000) return false;
          if (dateRangeFilter === '24h' && diffMs > 24 * 60 * 60 * 1000) return false;
          if (dateRangeFilter === '7d' && diffMs > 7 * 24 * 60 * 60 * 1000) return false;
        }

        // Search query
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase().trim();
          const target = (
            ev.id +
            ' ' +
            ev.endpoint_id +
            ' ' +
            ev.provider +
            ' ' +
            (ev.last_error || '') +
            ' ' +
            (ev.payload_raw || '')
          ).toLowerCase();
          if (!target.includes(q)) return false;
        }

        return true;
      })
      .sort((a, b) => {
        const timeA = new Date(a.updated_at || a.created_at).getTime();
        const timeB = new Date(b.updated_at || b.created_at).getTime();
        return sortDirection === 'desc' ? timeB - timeA : timeA - timeB;
      });
  }, [
    mergedFailed,
    endpointFilter,
    providerFilter,
    errorTypeFilter,
    dateRangeFilter,
    searchQuery,
    sortDirection,
  ]);

  // 5. Select All & Indeterminate state
  const isAllSelected =
    filteredEvents.length > 0 && filteredEvents.every((e) => selectedIds.has(e.id));
  const isIndeterminate =
    selectedIds.size > 0 && !isAllSelected && filteredEvents.some((e) => selectedIds.has(e.id));

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = isIndeterminate;
    }
  }, [isIndeterminate]);

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEvents.map((e) => e.id)));
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

  // Keyboard navigation for active row (ArrowUp, ArrowDown, j, k)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (filteredEvents.length === 0) return;

      const currentIndex = filteredEvents.findIndex((ev) => ev.id === selectedEventId);

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, filteredEvents.length - 1);
        onSelectEvent(filteredEvents[nextIndex]);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const prevIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
        onSelectEvent(filteredEvents[prevIndex]);
      } else if (e.key === 'Enter') {
        if (!selectedEventId && filteredEvents.length > 0) {
          onSelectEvent(filteredEvents[0]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredEvents, selectedEventId, onSelectEvent]);

  // Copy helper
  const handleCopyId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  };

  // Single replay handler with invalid signature check
  const handleSingleReplay = (ev: WebhookEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    if (ev.is_verified === -1) {
      setInvalidSingleConfirm(ev);
    } else {
      onReplaySingle(ev);
    }
  };

  // Bulk Replay Modal
  const handleOpenBulkConfirm = (isAll: boolean) => {
    const targetList = isAll
      ? filteredEvents
      : filteredEvents.filter((ev) => selectedIds.has(ev.id));
    const count = targetList.length;
    if (count === 0) return;

    const hasInvalid = targetList.some((e) => e.is_verified === -1);
    setConfirmModal({ open: true, count, isAll, hasInvalidSignature: hasInvalid });
  };

  const handleExecuteBulkReplay = async () => {
    const isAll = confirmModal.isAll;
    setConfirmModal({ open: false, count: 0, isAll: false, hasInvalidSignature: false });

    if (isAll) {
      await onBulkReplay([], true);
      setSelectedIds(new Set());
    } else {
      await onBulkReplay(Array.from(selectedIds), false);
      setSelectedIds(new Set());
    }
    setTimeout(loadFailedEvents, 300);
  };

  const resetAllFilters = () => {
    setSearchQuery('');
    setEndpointFilter('');
    setProviderFilter('');
    setErrorTypeFilter('');
    setDateRangeFilter('all');
  };

  const hasActiveFilters = Boolean(
    searchQuery ||
    endpointFilter ||
    providerFilter ||
    errorTypeFilter ||
    dateRangeFilter !== 'all'
  );

  return (
    <div className="flex-1 overflow-hidden p-4 flex flex-col bg-[#fafafa]">
      {/* Header Description */}
      <div className="mb-3 shrink-0">
        <div className="flex items-center gap-2">
          <AlertOctagon className="w-5 h-5 text-rose-600" />
          <h2 className="text-base font-bold text-[#18181b] tracking-tight">
            Dead-Letter Queue (DLQ)
          </h2>
          <span className="ml-1 text-xs font-mono font-medium px-2 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-full">
            {mergedFailed.length} event gagal
          </span>
        </div>
        <p className="text-xs text-[#52525b] mt-1 leading-relaxed">
          Event webhook yang ditolak atau gagal dikirim setelah seluruh kuota percobaan habis.
          Periksa akar penyebab kegagalan di bawah, lalu picu replay setelah konfigurasi atau downstream diperbaiki.
        </p>
      </div>

      {/* Filter and Control Bar */}
      <div className="mb-3 bg-white p-3 border border-[#e4e4e7] rounded-lg shadow-2xs space-y-2.5 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search by ID / Payload */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#71717a]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari Event ID, endpoint, atau error..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] placeholder:text-[#71717a] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors"
              aria-label="Cari event DLQ"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[#71717a] hover:text-[#18181b]"
                aria-label="Hapus kata kunci pencarian"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Endpoint Filter */}
          <select
            value={endpointFilter}
            onChange={(e) => setEndpointFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] font-medium focus:outline-none focus:border-[#18181b]"
            aria-label="Filter berdasarkan endpoint"
          >
            <option value="">Semua Endpoint</option>
            {endpoints.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {ep.name} ({ep.id})
              </option>
            ))}
          </select>

          {/* Provider Filter */}
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] font-medium focus:outline-none focus:border-[#18181b]"
            aria-label="Filter berdasarkan provider"
          >
            <option value="">Semua Provider</option>
            <option value="midtrans">Midtrans</option>
            <option value="stripe">Stripe</option>
            <option value="xendit">Xendit</option>
            <option value="github">GitHub</option>
            <option value="generic">Generic</option>
          </select>

          {/* Error Type Filter */}
          <select
            value={errorTypeFilter}
            onChange={(e) => setErrorTypeFilter(e.target.value as ErrorCategoryType | '')}
            className="px-2.5 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] font-medium focus:outline-none focus:border-[#18181b]"
            aria-label="Filter berdasarkan jenis error"
          >
            <option value="">Semua Jenis Error</option>
            <option value="signature">Signature Invalid</option>
            <option value="http5xx">HTTP 5xx (Server Error)</option>
            <option value="http4xx">HTTP 4xx (Client Error)</option>
            <option value="timeout">Timeout</option>
            <option value="network">Koneksi / Jaringan</option>
          </select>

          {/* Date Range Preset */}
          <select
            value={dateRangeFilter}
            onChange={(e) => setDateRangeFilter(e.target.value as DateRangePreset)}
            className="px-2.5 py-1.5 text-xs bg-white border border-[#e4e4e7] rounded-md text-[#18181b] font-medium focus:outline-none focus:border-[#18181b]"
            aria-label="Filter rentang waktu"
          >
            <option value="all">Semua Waktu</option>
            <option value="1h">1 Jam Terakhir</option>
            <option value="24h">24 Jam Terakhir</option>
            <option value="7d">7 Hari Terakhir</option>
          </select>

          {/* Replay All Button */}
          <button
            type="button"
            onClick={() => handleOpenBulkConfirm(true)}
            disabled={filteredEvents.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#18181b] hover:bg-[#27272a] text-white rounded-md text-xs font-semibold disabled:opacity-40 transition-colors shadow-2xs ml-auto shrink-0"
            aria-label="Replay semua event yang terfilter"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Replay Semua ({filteredEvents.length})</span>
          </button>
        </div>

        {/* Active Filter Chips Bar */}
        {hasActiveFilters && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[#f4f4f5] text-xs">
            <span className="text-[11px] font-semibold text-[#52525b] flex items-center gap-1 mr-1">
              <Filter className="w-3 h-3 text-[#71717a]" />
              Filter Aktif:
            </span>

            {searchQuery && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] text-[11px]">
                <span>Cari: &ldquo;{searchQuery}&rdquo;</span>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="hover:text-rose-600 p-0.5"
                  aria-label="Hapus filter pencarian"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {endpointFilter && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] text-[11px]">
                <span>Endpoint: {endpoints.find((ep) => ep.id === endpointFilter)?.name || endpointFilter}</span>
                <button
                  type="button"
                  onClick={() => setEndpointFilter('')}
                  className="hover:text-rose-600 p-0.5"
                  aria-label="Hapus filter endpoint"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {providerFilter && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] text-[11px] uppercase">
                <span>Provider: {providerFilter}</span>
                <button
                  type="button"
                  onClick={() => setProviderFilter('')}
                  className="hover:text-rose-600 p-0.5"
                  aria-label="Hapus filter provider"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {errorTypeFilter && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] text-[11px]">
                <span>Error: {errorTypeFilter}</span>
                <button
                  type="button"
                  onClick={() => setErrorTypeFilter('')}
                  className="hover:text-rose-600 p-0.5"
                  aria-label="Hapus filter jenis error"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {dateRangeFilter !== 'all' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] text-[11px]">
                <span>Rentang: {dateRangeFilter}</span>
                <button
                  type="button"
                  onClick={() => setDateRangeFilter('all')}
                  className="hover:text-rose-600 p-0.5"
                  aria-label="Hapus filter rentang waktu"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            <button
              type="button"
              onClick={resetAllFilters}
              className="text-[11px] font-semibold text-rose-700 hover:text-rose-900 underline underline-offset-2 ml-1"
            >
              Reset Semua Filter
            </button>
          </div>
        )}
      </div>

      {/* DLQ Table Container */}
      <div className="flex-1 bg-white border border-[#e4e4e7] rounded-lg overflow-auto shadow-2xs relative">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="sticky top-0 bg-[#fafafa] border-b border-[#e4e4e7] text-[11px] font-bold text-[#52525b] uppercase tracking-wider select-none z-10">
            <tr>
              {/* Select All Checkbox */}
              <th className="py-2.5 px-3 w-10">
                <input
                  ref={selectAllCheckboxRef}
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-[#e4e4e7] text-[#18181b] focus:ring-[#18181b] cursor-pointer"
                  aria-label="Pilih semua event"
                />
              </th>
              <th className="py-2.5 px-3 whitespace-nowrap">Event ID</th>
              <th className="py-2.5 px-3 whitespace-nowrap">Endpoint Target</th>
              <th className="py-2.5 px-3 whitespace-nowrap">Provider</th>
              <th className="py-2.5 px-3 whitespace-nowrap">Jenis Kesalahan</th>
              <th className="py-2.5 px-3 whitespace-nowrap">Percobaan</th>

              {/* Sortable Column: Gagal Pada */}
              <th
                onClick={() => setSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                className="py-2.5 px-3 cursor-pointer hover:bg-[#f4f4f5] transition-colors whitespace-nowrap"
                title="Klik untuk mengurutkan waktu kegagalan"
              >
                <div className="flex items-center gap-1.5">
                  <span>Gagal Pada</span>
                  {sortDirection === 'desc' ? (
                    <ArrowDown className="w-3 h-3 text-[#18181b]" />
                  ) : (
                    <ArrowUp className="w-3 h-3 text-[#18181b]" />
                  )}
                </div>
              </th>

              <th className="py-2.5 px-3 text-right whitespace-nowrap">Aksi</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-[#f4f4f5]">
            {isLoading ? (
              // Skeleton Loading State
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  <td className="py-3 px-3"><div className="w-4 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3"><div className="w-24 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3"><div className="w-20 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3"><div className="w-16 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3"><div className="w-32 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3"><div className="w-16 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3"><div className="w-20 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3 text-right"><div className="w-14 h-6 bg-zinc-200 rounded ml-auto" /></td>
                </tr>
              ))
            ) : filteredEvents.length > 0 ? (
              filteredEvents.map((ev) => {
                const isChecked = selectedIds.has(ev.id);
                const isSelected = selectedEventId === ev.id;
                const errorAnalysis = analyzeEventError(ev);
                const failedTime = ev.updated_at || ev.created_at;
                const isInvalidSig = ev.is_verified === -1;

                return (
                  <tr
                    key={ev.id}
                    onClick={() => onSelectEvent(ev)}
                    className={`cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[#f4f4f5] border-l-2 border-l-[#18181b]'
                        : isChecked
                        ? 'bg-zinc-50/70 hover:bg-[#fafafa]'
                        : 'hover:bg-[#fafafa]'
                    }`}
                  >
                    {/* Row Checkbox */}
                    <td className="py-2.5 px-3" onClick={(e) => toggleSelectOne(ev.id, e)}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="w-4 h-4 rounded border-[#e4e4e7] text-[#18181b] focus:ring-[#18181b] cursor-pointer"
                        aria-label={`Pilih event ${ev.id}`}
                      />
                    </td>

                    {/* Event ID with 8-character truncation and Quick Copy */}
                    <td className="py-2.5 px-3 font-mono font-medium text-[#18181b] whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span title={`Event ID: ${ev.id}`}>
                          {ev.id.slice(0, 8)}...
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleCopyId(ev.id, e)}
                          className="p-1 text-[#71717a] hover:text-[#18181b] hover:bg-[#e4e4e7] rounded transition-colors"
                          title="Salin Event ID lengkap"
                          aria-label={`Salin Event ID ${ev.id}`}
                        >
                          {copiedId === ev.id ? (
                            <Check className="w-3 h-3 text-emerald-600" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    </td>

                    {/* Endpoint Target */}
                    <td className="py-2.5 px-3 font-medium text-[#18181b] whitespace-nowrap">
                      <span title={`Endpoint ID: ${ev.endpoint_id}`}>
                        {endpoints.find((ep) => ep.id === ev.endpoint_id)?.name || ev.endpoint_id}
                      </span>
                    </td>

                    {/* Provider */}
                    <td className="py-2.5 px-3 text-[#52525b] uppercase font-semibold text-[11px] whitespace-nowrap">
                      {ev.provider}
                    </td>

                    {/* Semantic Error Badge (Eliminates wall of red text) */}
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${errorAnalysis.badgeStyle}`}
                          title={`Detail Kesalahan: ${ev.last_error || errorAnalysis.summary}`}
                        >
                          {errorAnalysis.badgeLabel}
                        </span>
                        {ev.last_error && (
                          <span
                            className="text-[#71717a] text-[11px] max-w-[180px] xl:max-w-xs truncate font-mono hidden md:inline-block"
                            title={ev.last_error}
                          >
                            {ev.last_error}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Percobaan with Truthful Status */}
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      {isInvalidSig && ev.attempts === 0 ? (
                        <span
                          className="text-rose-700 font-semibold text-[11px]"
                          title="Ditolak di gerbang verifikasi signature sebelum dikirim"
                        >
                          Ditolak (signature)
                        </span>
                      ) : ev.attempts >= ev.max_attempts ? (
                        <span
                          className="font-mono text-[#52525b]"
                          title="Seluruh kuota percobaan telah habis"
                        >
                          {ev.attempts}/{ev.max_attempts} <span className="text-[10px] text-[#71717a]">(habis)</span>
                        </span>
                      ) : (
                        <span className="font-mono text-[#52525b]">
                          {ev.attempts}/{ev.max_attempts}
                        </span>
                      )}
                    </td>

                    {/* Gagal Pada (Relative Time with absolute tooltip) */}
                    <td className="py-2.5 px-3 font-mono text-[#52525b] whitespace-nowrap">
                      <span
                        className="underline decoration-dotted decoration-[#a1a1aa] underline-offset-4 cursor-help"
                        title={formatAbsoluteTime(failedTime)}
                      >
                        {formatRelativeTime(failedTime)}
                      </span>
                    </td>

                    {/* Action Column */}
                    <td className="py-2.5 px-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {isInvalidSig ? (
                        <button
                          type="button"
                          onClick={(e) => handleSingleReplay(ev, e)}
                          className="px-2.5 py-1 bg-white hover:bg-rose-50 text-rose-700 border border-rose-300 rounded text-xs font-semibold shadow-2xs transition-colors"
                          title="Signature tidak valid. Klik untuk konfirmasi replay."
                        >
                          Replay
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => handleSingleReplay(ev, e)}
                          className="px-2.5 py-1 bg-white hover:bg-[#f4f4f5] text-[#18181b] border border-[#e4e4e7] rounded text-xs font-semibold shadow-2xs transition-colors"
                        >
                          Replay
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              // Empty States
              <tr>
                <td colSpan={8} className="py-16 text-center text-[#52525b]">
                  {hasActiveFilters ? (
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Inbox className="w-8 h-8 text-[#a1a1aa]" />
                      <p className="text-sm font-semibold text-[#18181b]">
                        Tidak ada event yang sesuai dengan filter
                      </p>
                      <p className="text-xs text-[#71717a]">
                        Coba sesuaikan kata kunci atau bersihkan kriteria filter Anda.
                      </p>
                      <button
                        type="button"
                        onClick={resetAllFilters}
                        className="mt-2 px-3 py-1.5 text-xs font-semibold bg-white border border-[#e4e4e7] hover:bg-[#f4f4f5] rounded-md transition-colors"
                      >
                        Reset Filter
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-2">
                      <CheckCircle className="w-8 h-8 text-emerald-600" />
                      <p className="text-sm font-bold text-[#18181b]">
                        Dead-Letter Queue Bersih!
                      </p>
                      <p className="text-xs text-[#52525b] max-w-sm leading-relaxed">
                        Tidak ada webhook berstatus gagal. Seluruh event berhasil terkirim ke target endpoint masing-masing.
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Floating Bulk Action Bar (when rows are selected) */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2.5 bg-[#18181b] text-white rounded-xl shadow-xl border border-zinc-700 animate-in fade-in slide-in-from-bottom-3 duration-200">
          <span className="text-xs font-semibold tracking-wide">
            <span className="font-mono text-emerald-400 font-bold">{selectedIds.size}</span> event dipilih
          </span>

          <div className="h-4 w-px bg-zinc-600" />

          <button
            type="button"
            onClick={() => handleOpenBulkConfirm(false)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-white hover:bg-zinc-100 text-[#18181b] rounded-lg transition-colors shadow-2xs"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Replay Terpilih</span>
          </button>

          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="px-2.5 py-1 text-xs font-medium text-zinc-300 hover:text-white transition-colors"
          >
            Batal
          </button>
        </div>
      )}

      {/* Bulk Replay Confirmation Modal */}
      {confirmModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white border border-[#e4e4e7] rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <h3 className="text-sm font-bold text-[#18181b]">
                Konfirmasi Replay Massal
              </h3>
            </div>

            <p className="text-xs text-[#52525b] mb-3 leading-relaxed">
              Apakah Anda yakin ingin memicu replay segera untuk{' '}
              <b className="text-[#18181b]">{confirmModal.count} event</b> status FAILED?
            </p>

            {confirmModal.hasInvalidSignature && (
              <div className="mb-4 p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>
                  <b>Perhatian:</b> Sebagian event yang dipilih memiliki signature tidak valid. Event tersebut kemungkinan akan gagal lagi kecuali secret endpoint telah diselaraskan.
                </span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() =>
                  setConfirmModal({
                    open: false,
                    count: 0,
                    isAll: false,
                    hasInvalidSignature: false,
                  })
                }
                className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] rounded-lg transition-colors"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleExecuteBulkReplay}
                className="px-3.5 py-1.5 text-xs font-semibold bg-[#18181b] hover:bg-[#27272a] text-white rounded-lg transition-colors shadow-xs"
              >
                Ya, Replay Sekarang
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invalid Signature Single Replay Confirmation Modal */}
      {invalidSingleConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white border border-[#e4e4e7] rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-2">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
              <h3 className="text-sm font-bold text-[#18181b]">
                Peringatan: Signature Tidak Valid
              </h3>
            </div>
            <p className="text-xs text-[#52525b] mb-4 leading-relaxed">
              Event <b className="font-mono text-[#18181b]">{invalidSingleConfirm.id.slice(0, 8)}...</b> memiliki signature kriptografis yang tidak cocok dengan secret endpoint.
              Replay hampir pasti akan gagal kembali kecuali konfigurasi secret key pada endpoint telah diperbarui.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setInvalidSingleConfirm(null)}
                className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-[#f4f4f5] border border-[#e4e4e7] text-[#18181b] rounded-lg transition-colors"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  const ev = invalidSingleConfirm;
                  setInvalidSingleConfirm(null);
                  onReplaySingle(ev);
                }}
                className="px-3.5 py-1.5 text-xs font-semibold bg-rose-700 hover:bg-rose-800 text-white rounded-lg transition-colors shadow-xs"
              >
                Tetap Replay
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
