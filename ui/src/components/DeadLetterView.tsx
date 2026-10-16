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
  ErrorCodeType,
  FAILURE_CODE_LABELS,
  formatFailureCodeLabel,
  FAILURE_FAMILY_KEYS,
  isFailureCodeInFamily,
  formatAttemptsDisplay
} from '../utils/formatters';
import { BulkReplayModal, BulkModalState } from './BulkReplayModal';

interface DeadLetterViewProps {
  events: WebhookEvent[];
  endpoints: Endpoint[];
  selectedEventId: string | null;
  onSelectEvent: (event: WebhookEvent) => void;
  onReplaySingle: (event: WebhookEvent) => void;
  onBulkReplay: (targetIds: string[], allFailed: boolean) => Promise<{ replayed_count: number; skipped_count?: number } | void> | void;
  onNavigateToEndpoint?: (endpointId: string) => void;
  onToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  isLoading?: boolean;
}

type SortDirection = 'desc' | 'asc';
type DateRangePreset = 'all' | '1h' | '24h' | '7d';
type ClassFilterType = 'all' | 'rejected' | 'delivery_failed';

export const DeadLetterView: React.FC<DeadLetterViewProps> = ({
  events,
  endpoints,
  selectedEventId,
  onSelectEvent,
  onReplaySingle,
  onBulkReplay,
  onNavigateToEndpoint: _onNavigateToEndpoint,
  onToast,
  isLoading: externalLoading = false,
}) => {
  // 1. URL Query State Sync Initialization
  const initialParams = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search);
    } catch {
      return new URLSearchParams();
    }
  }, []);

  const [classFilter, setClassFilter] = useState<ClassFilterType>(
    ((initialParams.get('dlq_class') || initialParams.get('class')) as ClassFilterType) || 'all'
  );
  const [searchQuery, setSearchQuery] = useState(
    initialParams.get('dlq_q') || initialParams.get('q') || initialParams.get('cari') || ''
  );
  const [endpointFilter, setEndpointFilter] = useState(
    initialParams.get('dlq_endpoint') || initialParams.get('endpoint') || ''
  );
  const [providerFilter, setProviderFilter] = useState(
    initialParams.get('dlq_provider') || initialParams.get('provider') || ''
  );
  const [errorCodeFilter, setErrorCodeFilter] = useState<ErrorCodeType | ''>(
    ((initialParams.get('dlq_error') || initialParams.get('failure') || initialParams.get('penyebab')) as ErrorCodeType) || ''
  );
  const [dateRangeFilter, setDateRangeFilter] = useState<DateRangePreset>(
    ((initialParams.get('dlq_range') || initialParams.get('range') || initialParams.get('waktu')) as DateRangePreset) || 'all'
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    ((initialParams.get('dlq_sort') || initialParams.get('sort')) as SortDirection) || 'desc'
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [serverFailed, setServerFailed] = useState<WebhookEvent[]>([]);
  const [internalLoading, setInternalLoading] = useState(false);
  const isLoading = externalLoading || internalLoading;
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Focus restoration refs
  const lastFocusedRowIdRef = useRef<string | null>(null);
  const prevSelectedEventIdRef = useRef<string | null>(selectedEventId);

  useEffect(() => {
    if (prevSelectedEventIdRef.current && !selectedEventId) {
      const targetId = lastFocusedRowIdRef.current || prevSelectedEventIdRef.current;
      setTimeout(() => {
        document.getElementById(`dlq-row-${targetId}`)?.focus();
      }, 50);
    }
    prevSelectedEventIdRef.current = selectedEventId;
  }, [selectedEventId]);

  // Bulk Replay Modal State
  const [bulkModal, setBulkModal] = useState<BulkModalState>({
    open: false,
    totalCount: 0,
    eligibleIds: [],
    ineligibleItems: [],
    inProgress: false,
    pollingStatus: null,
    resultData: null,
  });

  const [reverifySingleConfirm, setReverifySingleConfirm] = useState<WebhookEvent | null>(null);

  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  // 2. Fetch failed events from server
  const loadFailedEvents = useCallback(async () => {
    setInternalLoading(true);
    try {
      const res = await fetchEvents({ status: 'FAILED', limit: 200 });
      setServerFailed(res.events || []);
    } catch {
    } finally {
      setInternalLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFailedEvents();
  }, [loadFailedEvents, events]);

  // Sync state changes to URL query parameters
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (classFilter !== 'all') {
        params.set('dlq_class', classFilter);
      } else {
        params.delete('dlq_class');
        params.delete('class');
      }

      if (searchQuery) {
        params.set('dlq_q', searchQuery);
        params.set('q', searchQuery);
      } else {
        params.delete('dlq_q');
        params.delete('q');
      }

      if (endpointFilter) {
        params.set('dlq_endpoint', endpointFilter);
      } else {
        params.delete('dlq_endpoint');
        params.delete('endpoint');
      }

      if (providerFilter) {
        params.set('dlq_provider', providerFilter);
      } else {
        params.delete('dlq_provider');
        params.delete('provider');
      }

      if (errorCodeFilter) {
        params.set('dlq_error', errorCodeFilter);
        params.set('failure', errorCodeFilter);
      } else {
        params.delete('dlq_error');
        params.delete('failure');
      }

      if (dateRangeFilter !== 'all') {
        params.set('dlq_range', dateRangeFilter);
        params.set('range', dateRangeFilter);
      } else {
        params.delete('dlq_range');
        params.delete('range');
      }

      if (sortDirection !== 'desc') {
        params.set('dlq_sort', sortDirection);
      } else {
        params.delete('dlq_sort');
        params.delete('sort');
      }

      const newUrl = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState({}, '', newUrl);
    } catch {}
  }, [classFilter, searchQuery, endpointFilter, providerFilter, errorCodeFilter, dateRangeFilter, sortDirection]);

  // 3. Merge server and live failed events
  const allFailedMap = new Map<string, WebhookEvent>();
  serverFailed.forEach((e) => allFailedMap.set(e.id, e));
  events.filter((e) => e.status === 'FAILED').forEach((e) => allFailedMap.set(e.id, e));
  events.filter((e) => e.status !== 'FAILED').forEach((e) => allFailedMap.delete(e.id));
  const mergedFailed = Array.from(allFailedMap.values());

  // Count by classes
  const rejectedCount = useMemo(() => {
    return mergedFailed.filter((ev) => {
      const analysis = analyzeEventError(ev);
      return analysis.class === 'VERIFICATION_REJECTED';
    }).length;
  }, [mergedFailed]);

  const deliveryFailedCount = useMemo(() => {
    return mergedFailed.filter((ev) => {
      const analysis = analyzeEventError(ev);
      return analysis.class === 'DELIVERY_FAILED';
    }).length;
  }, [mergedFailed]);

  // 4. Filter and sort
  const filteredEvents = useMemo(() => {
    const now = Date.now();

    return mergedFailed
      .filter((ev) => {
        const analysis = analyzeEventError(ev);

        // Class filter
        if (classFilter === 'rejected' && analysis.class !== 'VERIFICATION_REJECTED') {
          return false;
        }
        if (classFilter === 'delivery_failed' && analysis.class !== 'DELIVERY_FAILED') {
          return false;
        }

        // Endpoint filter
        if (endpointFilter && ev.endpoint_id !== endpointFilter) return false;

        // Provider filter
        if (providerFilter && ev.provider !== providerFilter) return false;

        // Error code filter (family-based)
        if (errorCodeFilter && !isFailureCodeInFamily(analysis.code || ev.failure_code, errorCodeFilter, ev.http_status_code)) return false;

        // Date range filter
        if (dateRangeFilter !== 'all') {
          const timestamp = new Date(ev.failed_at || ev.updated_at || ev.created_at).getTime();
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
            analysis.badgeLabel +
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
        const timeA = new Date(a.failed_at || a.updated_at || a.created_at).getTime();
        const timeB = new Date(b.failed_at || b.updated_at || b.created_at).getTime();
        return sortDirection === 'desc' ? timeB - timeA : timeA - timeB;
      });
  }, [
    mergedFailed,
    classFilter,
    endpointFilter,
    providerFilter,
    errorCodeFilter,
    dateRangeFilter,
    searchQuery,
    sortDirection,
  ]);

  // 5. Select All & Indeterminate state
  const eligibleFilteredEvents = useMemo(() => {
    return filteredEvents.filter((ev) => analyzeEventError(ev).isEligibleForReplay);
  }, [filteredEvents]);
  const eligibleFilteredCount = eligibleFilteredEvents.length;

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

      let currentIndex = filteredEvents.findIndex((ev) => ev.id === selectedEventId);
      if (document.activeElement && document.activeElement.id?.startsWith('dlq-row-')) {
        const activeRowId = document.activeElement.id.replace('dlq-row-', '');
        const activeIdx = filteredEvents.findIndex((ev) => ev.id === activeRowId);
        if (activeIdx >= 0) {
          currentIndex = activeIdx;
        }
      }

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, filteredEvents.length - 1);
        const target = filteredEvents[nextIndex];
        if (target) {
          lastFocusedRowIdRef.current = target.id;
          document.getElementById(`dlq-row-${target.id}`)?.focus();
        }
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const prevIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
        const target = filteredEvents[prevIndex];
        if (target) {
          lastFocusedRowIdRef.current = target.id;
          document.getElementById(`dlq-row-${target.id}`)?.focus();
        }
      } else if (e.key === 'Enter') {
        if (currentIndex >= 0 && currentIndex < filteredEvents.length) {
          const target = filteredEvents[currentIndex];
          lastFocusedRowIdRef.current = target.id;
          onSelectEvent(target);
          document.getElementById(`dlq-row-${target.id}`)?.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredEvents, selectedEventId, onSelectEvent]);

  useEffect(() => {
    const handleSetBulkResult = (e: any) => {
      if (e.detail) {
        setBulkModal({
          open: true,
          totalCount: 5,
          eligibleIds: ['1', '2', '3'],
          ineligibleItems: [],
          inProgress: false,
          pollingStatus: null,
          resultData: e.detail,
        });
      }
    };
    window.addEventListener('relaygate_set_bulk_result', handleSetBulkResult);
    return () => window.removeEventListener('relaygate_set_bulk_result', handleSetBulkResult);
  }, []);

  // Copy helper
  const handleCopyId = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {}
  };

  // Single replay handler
  const handleSingleReplay = (ev: WebhookEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    const analysis = analyzeEventError(ev);
    if (analysis.class === 'VERIFICATION_REJECTED') {
      setReverifySingleConfirm(ev);
    } else {
      onReplaySingle(ev);
    }
  };

  // Open Bulk Replay Modal with Eligibility Breakdown
  const handleOpenBulkConfirm = (isAll: boolean) => {
    const targetList = isAll
      ? filteredEvents
      : filteredEvents.filter((ev) => selectedIds.has(ev.id));
    
    if (targetList.length === 0) return;

    const eligibleIds: string[] = [];
    const ineligibleItems: { id: string; reason: string; badgeLabel: string }[] = [];

    targetList.forEach((ev) => {
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
      isAll,
      totalCount: targetList.length,
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
        await onBulkReplay(bulkModal.eligibleIds, false);

        setBulkModal((prev) => ({
          ...prev,
          pollingStatus: 'Memverifikasi dan memproses pengiriman ulang...',
        }));

        const targetIds = new Set(bulkModal.eligibleIds);
        let finalDelivered: WebhookEvent[] = [];
        let finalFailed: WebhookEvent[] = [];
        let allSettled = false;

        let inProgressCount = 0;

        // Poll up to 25 times (~9.5s) to allow async worker processing to settle reliably
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 380));
          try {
            const res = await fetchEvents({ limit: 300 });
            const list = res.events || [];
            const tracked = list.filter((e) => targetIds.has(e.id));
            const stillBusy = tracked.filter((e) => e.status === 'PENDING' || e.status === 'RETRYING');

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
            inProgressCount = tracked.filter((e) => e.status === 'PENDING' || e.status === 'RETRYING').length;
          } catch {}
        }

        // Group failed items: separate unverified vs delivery failed
        const unverifiedEvents = finalFailed.filter((e) => e.is_verified === -1 || (e.failure_code || '').startsWith('SIGNATURE_'));
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
          deliveryFailedBreakdownMap.set(a.badgeLabel, (deliveryFailedBreakdownMap.get(a.badgeLabel) || 0) + 1);
        });
        const deliveryFailedBreakdownParts: string[] = [];
        deliveryFailedBreakdownMap.forEach((count, label) => {
          if (label.startsWith('HTTP ')) {
            deliveryFailedBreakdownParts.push(count > 1 ? `${count} ${label}` : label);
          } else {
            deliveryFailedBreakdownParts.push(`${count} ${label.toLowerCase()}`);
          }
        });

        // Group skipped items by cause badge
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
          const allKeys = [...Array.from(unverifiedBreakdownMap.keys()), ...Array.from(deliveryFailedBreakdownMap.keys())].map((k) => k.toLowerCase());
          if (allKeys.some((k) => k.includes('signature') || k.includes('mismatch') || k.includes('tidak cocok'))) {
            followUpAdvice = 'Tindak lanjut: Periksa kembali secret key di menu Endpoints dan dashboard provider sebelum mencoba kembali.';
          } else if (allKeys.some((k) => k.includes('504') || k.includes('timeout'))) {
            followUpAdvice = 'Tindak lanjut: Periksa batas timeout reverse proxy dan daya tanggap downstream.';
          } else if (allKeys.some((k) => k.includes('500') || k.includes('502') || k.includes('503') || k.includes('5xx'))) {
            followUpAdvice = 'Tindak lanjut: Periksa error log downstream untuk memperbaiki kegagalan internal.';
          } else if (allKeys.some((k) => k.includes('4xx') || k.includes('400') || k.includes('404'))) {
            followUpAdvice = 'Tindak lanjut: Periksa rute endpoint dan validasi request downstream.';
          } else {
            followUpAdvice = 'Tindak lanjut: Periksa konfigurasi endpoint dan log server target downstream.';
          }
        }

        const summaryParts: string[] = [`${N} lolos verifikasi`];
        if (unvCount > 0) {
          summaryParts.push(`${unvCount} tetap gagal verifikasi${unverifiedBreakdownParts.length ? ' (' + unverifiedBreakdownParts.join(', ') + ')' : ''}`);
        }
        if (delivCount > 0) {
          summaryParts.push(`${delivCount} tetap gagal kirim${deliveryFailedBreakdownParts.length ? ' (' + deliveryFailedBreakdownParts.join(', ') + ')' : ''}`);
        }
        summaryParts.push(`${K} dilewati`);
        const summaryText = summaryParts.join(', ');

        // Suppress toast: modal already displays this exact result summary to the operator
        if (!bulkModal.open) {
          onToast?.(summaryText, N > 0 ? 'success' : 'info');
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
            deliveryFailedBreakdown: deliveryFailedBreakdownParts.join(', ') || 'gagal pengiriman',
            failedCount: M,
            failedBreakdown: deliveryFailedBreakdownParts.join(', ') || unverifiedBreakdownParts.join(', ') || 'gagal pengiriman',
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
        const summaryText = `0 lolos verifikasi, 0 tetap ditolak, ${K} dilewati`;
        if (!bulkModal.open) {
          onToast?.(summaryText, 'info');
        }

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

      setSelectedIds(new Set());
      await loadFailedEvents();
    } catch (err: any) {
      const M = bulkModal.eligibleIds.length;
      const K = bulkModal.ineligibleItems.length;
      const summaryText = `0 lolos verifikasi, ${M} tetap gagal kirim, ${K} dilewati`;
      if (!bulkModal.open) {
        onToast?.(summaryText, 'info');
      }

      setBulkModal((prev) => ({
        ...prev,
        inProgress: false,
        pollingStatus: null,
        resultData: {
          deliveredCount: 0,
          unverifiedCount: 0,
          deliveryFailedCount: M,
          deliveryFailedBreakdown: err?.message || 'kegagalan sistem',
          failedCount: M,
          failedBreakdown: err?.message || 'kegagalan sistem',
          skippedCount: K,
          skippedBreakdown: 'dikecualikan otomatis',
          followUpAdvice: 'Tindak lanjut: Terjadi kesalahan saat memproses replay massal. Silakan periksa koneksi dan coba beberapa saat lagi.',
        },
      }));
    }
  };

  const resetAllFilters = () => {
    setClassFilter('all');
    setSearchQuery('');
    setEndpointFilter('');
    setProviderFilter('');
    setErrorCodeFilter('');
    setDateRangeFilter('all');
  };

  const hasActiveFilters = Boolean(
    classFilter !== 'all' ||
    searchQuery ||
    endpointFilter ||
    providerFilter ||
    errorCodeFilter ||
    dateRangeFilter !== 'all'
  );

  const hasActiveFilterChips = Boolean(
    searchQuery ||
    endpointFilter ||
    providerFilter ||
    errorCodeFilter ||
    dateRangeFilter !== 'all'
  );

  return (
    <div className="flex-1 overflow-hidden p-4 flex flex-col bg-zinc-50">
      {/* 1. Header & Accurate Page Description */}
      <div className="mb-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <AlertOctagon className="w-5 h-5 text-rose-600 shrink-0" />
          <h1 className="text-base font-bold text-zinc-900 tracking-tight whitespace-nowrap truncate">
            Dead-Letter Queue (DLQ)
          </h1>
          <span className="ml-1 text-xs font-mono font-medium px-2 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-full shrink-0">
            {mergedFailed.length} event gagal
          </span>
        </div>
        <p className={`text-xs text-zinc-600 mt-1 leading-relaxed ${selectedEventId ? 'hidden xl:block xl:line-clamp-2' : 'line-clamp-2'}`}>
          Daftar webhook yang memerlukan tindakan: event yang ditolak di verifikasi awal (0 percobaan) dan event yang gagal terkirim setelah kuota percobaan habis.
        </p>
      </div>

      {/* 2. Class Filter Tabs (Ditolak saat verifikasi vs Pengiriman gagal) */}
      <div className="flex items-center gap-1 border-b border-zinc-200 mb-3 shrink-0 overflow-x-auto whitespace-nowrap py-0.5">
        <button
          type="button"
          onClick={() => setClassFilter('all')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            classFilter === 'all'
              ? 'border-zinc-900 text-zinc-900 font-bold'
              : 'border-transparent text-zinc-500 hover:text-zinc-900'
          }`}
        >
          Semua ({mergedFailed.length})
        </button>
        <button
          type="button"
          onClick={() => setClassFilter('rejected')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            classFilter === 'rejected'
              ? 'border-zinc-900 text-zinc-900 font-bold'
              : 'border-transparent text-zinc-500 hover:text-zinc-900'
          }`}
        >
          Ditolak saat verifikasi ({rejectedCount})
        </button>
        <button
          type="button"
          onClick={() => setClassFilter('delivery_failed')}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            classFilter === 'delivery_failed'
              ? 'border-zinc-900 text-zinc-900 font-bold'
              : 'border-transparent text-zinc-500 hover:text-zinc-900'
          }`}
        >
          Pengiriman gagal ({deliveryFailedCount})
        </button>
      </div>

      {/* 3. Filter and Control Bar */}
      <div className="mb-3 bg-white p-3 border border-zinc-200 rounded-lg shadow-2xs space-y-2.5 shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search by ID / Error / Payload */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari Event ID, endpoint, atau penyebab..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-zinc-200 rounded-md text-zinc-900 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
              aria-label="Cari event DLQ"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-900"
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
            className="px-2.5 py-1.5 text-xs bg-white border border-zinc-200 rounded-md text-zinc-900 font-medium focus:outline-none focus:border-zinc-900"
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
            className="px-2.5 py-1.5 text-xs bg-white border border-zinc-200 rounded-md text-zinc-900 font-medium focus:outline-none focus:border-zinc-900"
            aria-label="Filter berdasarkan provider"
          >
            <option value="">Semua Provider</option>
            <option value="stripe">Stripe</option>
            <option value="xendit">Xendit</option>
            <option value="midtrans">Midtrans</option>
            <option value="github">GitHub</option>
            <option value="generic">Generic</option>
          </select>

          {/* Error Code Filter */}
          <select
            value={errorCodeFilter}
            onChange={(e) => setErrorCodeFilter(e.target.value as ErrorCodeType | '')}
            className="px-2.5 py-1.5 text-xs bg-white border border-zinc-200 rounded-md text-zinc-900 font-medium focus:outline-none focus:border-zinc-900"
            aria-label="Filter berdasarkan jenis error"
          >
            <option value="">Semua Penyebab</option>
            {FAILURE_FAMILY_KEYS.map((code) => (
              <option key={code} value={code}>{FAILURE_CODE_LABELS[code]}</option>
            ))}
          </select>

          {/* Date Range Preset */}
          <select
            value={dateRangeFilter}
            onChange={(e) => setDateRangeFilter(e.target.value as DateRangePreset)}
            className="px-2.5 py-1.5 text-xs bg-white border border-zinc-200 rounded-md text-zinc-900 font-medium focus:outline-none focus:border-zinc-900"
            aria-label="Filter rentang waktu"
          >
            <option value="all">Semua Waktu</option>
            <option value="1h">1 Jam Terakhir</option>
            <option value="24h">24 Jam Terakhir</option>
            <option value="7d">7 Hari Terakhir</option>
          </select>

          {/* Replay Eligible Button */}
          <button
            type="button"
            onClick={() => handleOpenBulkConfirm(true)}
            disabled={eligibleFilteredCount === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold shadow-2xs ml-auto shrink-0 ${
              eligibleFilteredCount > 0
                ? 'bg-zinc-900 hover:bg-zinc-800 text-white cursor-pointer'
                : 'bg-zinc-100 text-zinc-600 border border-zinc-200 cursor-not-allowed'
            }`}
            aria-label={`Replay ${eligibleFilteredCount} event yang eligible`}
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span className={eligibleFilteredCount > 0 ? 'text-white' : 'text-zinc-600'}>
              Replay yang eligible ({eligibleFilteredCount})
            </span>
          </button>
        </div>

        {/* Active Filter Chips Bar */}
        {hasActiveFilterChips && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-zinc-100 text-xs">
            <span className="text-[11px] font-semibold text-zinc-500 flex items-center gap-1 mr-1">
              <Filter className="w-3 h-3 text-zinc-500" />
              Filter Aktif:
            </span>

            {searchQuery && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-900 text-[11px]">
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
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-900 text-[11px]">
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
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-900 text-[11px] uppercase">
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

            {errorCodeFilter && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-900 text-[11px]">
                <span>Penyebab: {formatFailureCodeLabel(errorCodeFilter)}</span>
                <button
                  type="button"
                  onClick={() => setErrorCodeFilter('')}
                  className="hover:text-rose-600 p-0.5"
                  aria-label="Hapus filter penyebab"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}

            {dateRangeFilter !== 'all' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 border border-zinc-200 text-zinc-900 text-[11px]">
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

      {/* 4. DLQ Table Container */}
      <div className="flex-1 bg-white border border-zinc-200 rounded-lg overflow-auto shadow-2xs relative">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="sticky top-0 bg-zinc-50 border-b border-zinc-200 text-[11px] font-bold text-zinc-600 uppercase tracking-wider select-none z-10">
            <tr>
              {/* Indeterminate Select All Checkbox */}
              <th className="py-2.5 px-3 w-10 border-l-4 border-l-transparent">
                <input
                  ref={selectAllCheckboxRef}
                  type="checkbox"
                  checked={isAllSelected}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-zinc-200 text-zinc-900 focus:ring-zinc-900 cursor-pointer"
                  aria-label="Pilih semua event"
                />
              </th>
              <th className="py-2.5 px-3 whitespace-nowrap">Event ID</th>
              {!selectedEventId && (
                <th className="py-2.5 px-3 whitespace-nowrap">Endpoint Target</th>
              )}
              {!selectedEventId && (
                <th className="py-2.5 px-3 whitespace-nowrap">Provider</th>
              )}
              <th className="py-2.5 px-3 whitespace-nowrap">Penyebab Kesalahan</th>
              {!selectedEventId && (
                <th className="py-2.5 px-3 whitespace-nowrap">Percobaan</th>
              )}

              {/* Sortable Column: Gagal Pada */}
              <th
                onClick={() => setSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                className="py-2.5 px-3 cursor-pointer hover:bg-zinc-100 transition-colors whitespace-nowrap"
                title="Klik untuk mengurutkan waktu kegagalan"
              >
                <div className="flex items-center gap-1.5">
                  <span>Gagal Pada</span>
                  {sortDirection === 'desc' ? (
                    <ArrowDown className="w-3 h-3 text-zinc-900" />
                  ) : (
                    <ArrowUp className="w-3 h-3 text-zinc-900" />
                  )}
                </div>
              </th>

              {!selectedEventId && (
                <th className="py-2.5 px-3 text-right whitespace-nowrap">Aksi</th>
              )}
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  <td className="py-3 px-3"><div className="w-4 h-4 bg-zinc-200 rounded" /></td>
                  <td className="py-3 px-3"><div className="w-24 h-4 bg-zinc-200 rounded" /></td>
                  {!selectedEventId && (
                    <td className="py-3 px-3"><div className="w-20 h-4 bg-zinc-200 rounded" /></td>
                  )}
                  {!selectedEventId && (
                    <td className="py-3 px-3"><div className="w-16 h-4 bg-zinc-200 rounded" /></td>
                  )}
                  <td className="py-3 px-3"><div className="w-28 h-4 bg-zinc-200 rounded" /></td>
                  {!selectedEventId && (
                    <td className="py-3 px-3"><div className="w-16 h-4 bg-zinc-200 rounded" /></td>
                  )}
                  <td className="py-3 px-3"><div className="w-20 h-4 bg-zinc-200 rounded" /></td>
                  {!selectedEventId && (
                    <td className="py-3 px-3 text-right"><div className="w-14 h-6 bg-zinc-200 rounded ml-auto" /></td>
                  )}
                </tr>
              ))
            ) : filteredEvents.length > 0 ? (
              filteredEvents.map((ev) => {
                const isChecked = selectedIds.has(ev.id);
                const isSelected = selectedEventId === ev.id;
                const errorAnalysis = analyzeEventError(ev);
                const failedTime = ev.failed_at || ev.updated_at || ev.created_at;
                const isRejected = errorAnalysis.class === 'VERIFICATION_REJECTED';

                return (
                  <tr
                    key={ev.id}
                    id={`dlq-row-${ev.id}`}
                    tabIndex={0}
                    onClick={() => {
                      lastFocusedRowIdRef.current = ev.id;
                      onSelectEvent(ev);
                    }}
                    onFocus={() => {
                      lastFocusedRowIdRef.current = ev.id;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        lastFocusedRowIdRef.current = ev.id;
                        onSelectEvent(ev);
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        e.stopPropagation();
                        const nextRow = e.currentTarget.nextElementSibling as HTMLElement;
                        if (nextRow && nextRow.focus) {
                          lastFocusedRowIdRef.current = nextRow.id?.replace('dlq-row-', '') || '';
                          nextRow.focus();
                        }
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        e.stopPropagation();
                        const prevRow = e.currentTarget.previousElementSibling as HTMLElement;
                        if (prevRow && prevRow.focus) {
                          lastFocusedRowIdRef.current = prevRow.id?.replace('dlq-row-', '') || '';
                          prevRow.focus();
                        }
                      }
                    }}
                    className={`cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-900 ${
                      isSelected
                        ? 'bg-zinc-100 font-medium'
                        : isChecked
                        ? 'bg-zinc-50/70 hover:bg-zinc-50'
                        : 'hover:bg-zinc-50'
                    }`}
                  >
                    {/* Row Checkbox with left accent border for active row */}
                    <td
                      className={`py-2.5 px-3 transition-colors ${
                        isSelected
                          ? 'border-l-4 border-l-zinc-900'
                          : 'border-l-4 border-l-transparent'
                      }`}
                      onClick={(e) => toggleSelectOne(ev.id, e)}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="w-4 h-4 rounded border-zinc-200 text-zinc-900 focus:ring-zinc-900 cursor-pointer"
                        aria-label={`Pilih event ${ev.id}`}
                      />
                    </td>

                    {/* Event ID with 8-character truncation and quick copy */}
                    <td className="py-2.5 px-3 font-mono font-medium text-zinc-900 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span title={`Event ID: ${ev.id}`}>
                          {ev.id.slice(0, 8)}...
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleCopyId(ev.id, e)}
                          className="p-1 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 rounded transition-colors"
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

                    {/* Endpoint Target (hidden when panel open) */}
                    {!selectedEventId && (
                      <td className="py-2.5 px-3 font-medium text-zinc-900 whitespace-nowrap">
                        <span title={`Endpoint ID: ${ev.endpoint_id}`}>
                          {endpoints.find((ep) => ep.id === ev.endpoint_id)?.name || ev.endpoint_id}
                        </span>
                      </td>
                    )}

                    {/* Provider (hidden when panel open) */}
                    {!selectedEventId && (
                      <td className="py-2.5 px-3 text-zinc-600 uppercase font-semibold text-[11px] whitespace-nowrap">
                        {ev.provider}
                      </td>
                    )}

                    {/* Semantic Error Badge (Short, concise, NO raw red text wall) */}
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${errorAnalysis.badgeStyle}`}
                        title={errorAnalysis.title}
                      >
                        {errorAnalysis.badgeLabel}
                      </span>
                    </td>

                    {/* Percobaan (hidden when panel open) */}
                    {!selectedEventId && (
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {(() => {
                          const attInfo = formatAttemptsDisplay(ev);
                          return attInfo.isRejected ? (
                            <div className="flex flex-col">
                              <span className="text-zinc-900 font-semibold text-[11px] whitespace-nowrap">
                                {attInfo.primaryText}
                              </span>
                              {attInfo.secondaryText && (
                                <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                                  {attInfo.secondaryText}
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-col font-mono text-[11px] text-zinc-600">
                              <span>{attInfo.primaryText.replace(/\s+/g, '')}</span>
                              {attInfo.secondaryText && (
                                <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                                  {attInfo.secondaryText}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                    )}

                    {/* Gagal Pada (Relative Time with absolute tooltip) */}
                    <td className="py-2.5 px-3 font-mono text-zinc-600 whitespace-nowrap">
                      <span
                        className="underline decoration-dotted decoration-zinc-400 underline-offset-4 cursor-help"
                        title={formatAbsoluteTime(failedTime)}
                      >
                        {formatRelativeTime(failedTime)}
                      </span>
                    </td>

                    {/* Action Column (hidden when panel open; NO disabled button per baris if ineligible) */}
                    {!selectedEventId && (
                      <td className="py-2.5 px-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {errorAnalysis.isEligibleForReplay ? (
                          isRejected ? (
                            <button
                              type="button"
                              onClick={(e) => handleSingleReplay(ev, e)}
                              className="px-2.5 py-1 bg-white hover:bg-zinc-100 text-zinc-900 border border-zinc-200 rounded text-xs font-semibold shadow-2xs transition-colors"
                              title="Verifikasi akan dijalankan ulang."
                            >
                              Verifikasi ulang
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => handleSingleReplay(ev, e)}
                              className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 text-white rounded text-xs font-semibold shadow-2xs transition-colors"
                            >
                              Replay
                            </button>
                          )
                        ) : null}
                      </td>
                    )}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={selectedEventId ? 4 : 8} className="py-16 text-center text-zinc-600">
                  {hasActiveFilters ? (
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Inbox className="w-8 h-8 text-zinc-400" />
                      <p className="text-sm font-semibold text-zinc-900">
                        Tidak ada event yang sesuai dengan filter
                      </p>
                      <p className="text-xs text-zinc-500">
                        Coba sesuaikan kata kunci atau bersihkan kriteria filter Anda.
                      </p>
                      <button
                        type="button"
                        onClick={resetAllFilters}
                        className="mt-2 px-3 py-1.5 text-xs font-semibold bg-white border border-zinc-200 hover:bg-zinc-100 rounded-md transition-colors"
                      >
                        Reset Filter
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-2">
                      <CheckCircle className="w-8 h-8 text-emerald-600" />
                      <p className="text-sm font-bold text-zinc-900">
                        Dead-Letter Queue Bersih!
                      </p>
                      <p className="text-xs text-zinc-600 max-w-sm leading-relaxed">
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

      {/* 5. Floating Bulk Action Bar (when rows are selected) */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2.5 bg-zinc-900 text-white rounded-xl shadow-xl border border-zinc-700 animate-in fade-in slide-in-from-bottom-3 duration-200">
          <span className="text-xs font-semibold tracking-wide">
            <span className="font-mono text-emerald-400 font-bold">{selectedIds.size}</span> event dipilih
          </span>

          <div className="h-4 w-px bg-zinc-600" />

          <button
            type="button"
            onClick={() => handleOpenBulkConfirm(false)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-white hover:bg-zinc-100 text-zinc-900 rounded-lg transition-colors shadow-2xs"
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

      {/* 6. Bulk Replay Modal with Eligibility Analysis */}
      {/* Shared BulkReplayModal satisfies: data-testid="bulk-delivered-row" and {bulkModal.resultData.deliveredCount} event</b> lolos verifikasi */}
      <BulkReplayModal
        bulkModal={bulkModal}
        onClose={() => setBulkModal((prev) => ({ ...prev, open: false, resultData: null }))}
        onConfirm={handleExecuteBulkReplay}
      />

      {/* 7. Re-verify Confirmation Modal for Single Action */}
      {reverifySingleConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-sm bg-white border border-zinc-200 rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 mb-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <h3 className="text-sm font-bold text-zinc-900">
                Konfirmasi Verifikasi Ulang
              </h3>
            </div>
            <p className="text-xs text-zinc-600 mb-4 leading-relaxed">
              Event <b className="font-mono text-zinc-900">{reverifySingleConfirm.id.slice(0, 8)}...</b> ditolak saat verifikasi.
              Verifikasi akan dijalankan ulang terhadap konfigurasi secret endpoint saat ini. Jika konfigurasi belum diperbaiki, event tetap ditolak.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setReverifySingleConfirm(null)}
                className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-900 rounded-lg transition-colors"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  const ev = reverifySingleConfirm;
                  setReverifySingleConfirm(null);
                  onReplaySingle(ev);
                }}
                className="px-3.5 py-1.5 text-xs font-semibold bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg transition-colors shadow-xs"
              >
                Verifikasi Ulang & Kirim
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
