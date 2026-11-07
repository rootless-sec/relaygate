import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  RotateCw,
  Shield,
  Search,
  Pause,
  Play,
  AlertOctagon,
} from 'lucide-react';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { EventsView } from './components/EventsView';
import { InspectorDrawer } from './components/InspectorDrawer';
import { OverviewView } from './components/OverviewView';
import { DeadLetterView } from './components/DeadLetterView';
import { EndpointsView } from './components/EndpointsView';
import { Toast, ToastMessage } from './components/Toast';
import {
  Endpoint,
  NavTab,
  OverviewData,
  ProviderType,
  StatsSummary,
  WebhookEvent,
} from './types';
import {
  fetchEndpoints,
  fetchEvents,
  fetchOverview,
  fetchStats,
  replayEvent,
  bulkReplay,
  createEndpoint,
  updateEndpoint,
} from './api';

export const App: React.FC = () => {
  // Authentication State
  const [userEmail, setUserEmail] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem('relaygate_auth');
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.email || 'admin@relaygate.local';
      }
    } catch {}
    return null;
  });

  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  useEffect(() => {
    const handleExpired = (e: any) => {
      const msg = e?.detail?.message || 'Sesi berakhir';
      setUserEmail(null);
      setSelectedEvent(null);
      setSessionExpiredMessage(msg);
      setToast({ id: Date.now().toString(), message: msg, type: 'error' });
    };
    window.addEventListener('relaygate_session_expired', handleExpired);
    return () => window.removeEventListener('relaygate_session_expired', handleExpired);
  }, []);

  // Navigation State
  const [currentTab, setCurrentTab] = useState<NavTab>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (tab === 'dead' || tab === 'events' || tab === 'overview' || tab === 'endpoints') {
        return tab;
      }
    } catch {}
    return 'events';
  });

  useEffect(() => {
    const handlePopState = () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get('tab');
        if (tab === 'dead' || tab === 'events' || tab === 'overview' || tab === 'endpoints') {
          setCurrentTab(tab);
          setSelectedEvent(null);
        }
      } catch {}
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleTabChange = (tab: NavTab) => {
    setCurrentTab(tab);
    setSelectedEvent(null);
    try {
      const params = new URLSearchParams(window.location.search);
      params.set('tab', tab);
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    } catch {}
  };

  // Data States
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [overviewData, setOverviewData] = useState<OverviewData | null>(null);

  // Drawer & Selection
  const [selectedEvent, setSelectedEvent] = useState<WebhookEvent | null>(null);

  // Real-time Buffer & Live state
  const [isLive, setIsLive] = useState<boolean>(true);
  const [bufferedEvents, setBufferedEvents] = useState<WebhookEvent[]>([]);

  // Toast State
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ id: Date.now().toString(), message, type });
  };

  // 1. Initial Data Loading
  const loadInitialData = useCallback(async () => {
    try {
      const [endpointsData, eventsData, statsData, overview] = await Promise.all([
        fetchEndpoints().catch(() => []),
        fetchEvents({ limit: 100 }).catch(() => ({ events: [], total: 0, page: 1, limit: 100 })),
        fetchStats().catch(() => null),
        fetchOverview().catch(() => null),
      ]);

      setEndpoints(endpointsData);
      setEvents(eventsData.events || []);
      setStats(statsData);
      setOverviewData(overview);

      if (endpointsData.length === 0) {
        seedDefaultEndpoints();
      }
    } catch (err) {
      console.error('Initial data load error:', err);
    }
  }, []);

  const seedDefaultEndpoints = async () => {
    const defaultList = [
      {
        name: 'orders-api',
        provider: 'midtrans' as ProviderType,
        target_url: 'https://api.toko.id/hooks/midtrans',
      },
      {
        name: 'license-svc',
        provider: 'stripe' as ProviderType,
        target_url: 'https://license.toko.id/stripe',
      },
      {
        name: 'billing-hook',
        provider: 'xendit' as ProviderType,
        target_url: 'https://billing.toko.id/xendit',
      },
      {
        name: 'deploy-hook',
        provider: 'github' as ProviderType,
        target_url: 'https://ci.toko.id/github',
      },
    ];
    for (const item of defaultList) {
      try {
        await createEndpoint(item);
      } catch {}
    }
    const freshEndpoints = await fetchEndpoints().catch(() => []);
    setEndpoints(freshEndpoints);
  };

  useEffect(() => {
    if (userEmail) {
      loadInitialData();
    }
  }, [userEmail, loadInitialData]);

  const isLiveRef = useRef(isLive);
  useEffect(() => {
    isLiveRef.current = isLive;
  }, [isLive]);

  // 2. Server-Sent Events (SSE) Stream
  useEffect(() => {
    if (!userEmail) return;

    let eventSource: EventSource | null = null;
    let reconnectTimer: any = null;

    const connectSSE = () => {
      eventSource = new EventSource('/api/v1/stream');

      eventSource.addEventListener('event_created', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          const newEvent: WebhookEvent = payload.event;
          if (!newEvent) return;

          if (isLiveRef.current) {
            setEvents((prev) => [newEvent, ...prev.filter((x) => x.id !== newEvent.id)]);
          } else {
            setBufferedEvents((prev) => [newEvent, ...prev.filter((x) => x.id !== newEvent.id)]);
          }
          refreshStats();
        } catch (err) {
          console.error('SSE event_created error:', err);
        }
      });

      eventSource.addEventListener('event_updated', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data);
          const updatedEvent: WebhookEvent = payload.event;
          if (!updatedEvent) return;

          setEvents((prev) =>
            prev.map((ev) => (ev.id === updatedEvent.id ? { ...ev, ...updatedEvent } : ev))
          );
          setSelectedEvent((prev) =>
            prev?.id === updatedEvent.id ? { ...prev, ...updatedEvent } : prev
          );
          refreshStats();
        } catch (err) {
          console.error('SSE event_updated error:', err);
        }
      });

      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        reconnectTimer = setTimeout(connectSSE, 3000);
      };
    };

    connectSSE();

    return () => {
      if (eventSource) eventSource.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [userEmail]);

  const refreshStats = async () => {
    try {
      const [s, o] = await Promise.all([fetchStats(), fetchOverview()]);
      setStats(s);
      setOverviewData(o);
    } catch {}
  };

  const handleFlushBuffer = () => {
    setEvents((prev) => {
      const bufferedIds = new Set(bufferedEvents.map((e) => e.id));
      return [...bufferedEvents, ...prev.filter((e) => !bufferedIds.has(e.id))];
    });
    setBufferedEvents([]);
  };

  // 3. Replay Actions
  const handleReplaySingle = async (ev: WebhookEvent, fromDrawer = false) => {
    try {
      await replayEvent(ev.id);
      const isRejected = ev.is_verified === -1 || ev.failure_code?.startsWith('SIGNATURE_');
      if (!fromDrawer) {
        if (isRejected) {
          showToast(`Verifikasi ulang dikirim untuk event ${ev.id.slice(0, 8)}`, 'info');
        } else {
          showToast('Dijadwalkan ulang, hingga 5 percobaan', 'info');
        }
      }
      setEvents((prev) =>
        prev.map((item) => (item.id === ev.id ? { ...item, status: 'PENDING' } : item))
      );
      setStats((prev) =>
        prev ? { ...prev, failed_events: Math.max(0, prev.failed_events - 1) } : prev
      );
      if (selectedEvent?.id === ev.id) {
        setSelectedEvent((prev) => (prev ? { ...prev, status: 'PENDING' } : null));
      }
      refreshStats();
    } catch (err: any) {
      showToast(err?.message || 'Gagal memicu replay', 'error');
    }
  };

  const handleBulkReplay = async (targetIds: string[], allFailed: boolean) => {
    try {
      const res = await bulkReplay({ ids: targetIds, all_failed: allFailed });
      setEvents((prev) =>
        prev.map((item) => (targetIds.includes(item.id) ? { ...item, status: 'PENDING' } : item))
      );
      setStats((prev) =>
        prev
          ? { ...prev, failed_events: Math.max(0, prev.failed_events - targetIds.length) }
          : prev
      );
      loadInitialData();
      return res;
    } catch (err: any) {
      showToast(err?.message || 'Gagal bulk replay', 'error');
      throw err;
    }
  };

  // 4. Endpoint Actions
  const handleAddEndpoint = async (data: {
    name: string;
    provider: ProviderType;
    target_url: string;
    secret_key?: string;
  }) => {
    await createEndpoint(data);
    const updated = await fetchEndpoints();
    setEndpoints(updated);
  };

  const handleToggleEndpointActive = async (ep: Endpoint) => {
    try {
      const updated = await updateEndpoint(ep.id, { is_active: !ep.is_active });
      setEndpoints((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      showToast(
        `Endpoint ${ep.name} ${updated.is_active ? 'diaktifkan' : 'dinonaktifkan'}`,
        'info'
      );
    } catch (err: any) {
      showToast(err?.message || 'Gagal mengubah status endpoint', 'error');
    }
  };

  // 5. Global Keyboard Shortcuts
  useEffect(() => {
    if (!userEmail) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        if (e.key === 'Escape') {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        setCurrentTab('events');
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      if (e.key === 'Escape') {
        setSelectedEvent(null);
        return;
      }

      if (currentTab === 'events' && events.length > 0) {
        const currentIndex = events.findIndex((ev) => ev.id === selectedEvent?.id);

        if (e.key === 'j') {
          const nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, events.length - 1);
          setSelectedEvent(events[nextIndex]);
        } else if (e.key === 'k') {
          const prevIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
          setSelectedEvent(events[prevIndex]);
        } else if (e.key === 'Enter') {
          if (!selectedEvent && events.length > 0) {
            setSelectedEvent(events[0]);
          }
        } else if (e.key === 'r' && selectedEvent) {
          handleReplaySingle(selectedEvent);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [userEmail, currentTab, events, selectedEvent]);

  // Auth Logout
  const handleLogout = () => {
    localStorage.removeItem('relaygate_auth');
    setUserEmail(null);
    setSelectedEvent(null);
  };

  if (!userEmail) {
    return (
      <LoginPage
        onLoginSuccess={(email) => {
          setSessionExpiredMessage(null);
          setUserEmail(email);
        }}
        initialError={sessionExpiredMessage}
      />
    );
  }

  const failedEventsCount =
    events.length > 0
      ? events.filter((e) => e.status === 'FAILED').length
      : stats
      ? stats.failed_events
      : 0;
  const totalEventsCount = stats ? stats.total_events : events.length;

  const routeLabel: Record<NavTab, string> = {
    overview: 'relaygate.internal/workspace/overview',
    events: 'relaygate.internal/workspace/events',
    dead: 'relaygate.internal/workspace/dead-letter-queue',
    endpoints: 'relaygate.internal/workspace/endpoints',
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gradient-to-b from-sky-100/45 via-zinc-100/85 to-zinc-100 text-zinc-950 antialiased md:p-1.5 md:gap-1.5">
      {/* Left Sidebar in Aside Outer Frame */}
      <Sidebar
        currentTab={currentTab}
        onTabChange={handleTabChange}
        totalEventsCount={totalEventsCount}
        failedEventsCount={failedEventsCount}
        userEmail={userEmail}
        onLogout={handleLogout}
        endpoints={endpoints}
        isLive={isLive}
      />

      {/* Right Inset Floating Content Canvas (Aside Window Frame) */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0 relative overflow-hidden bg-white md:rounded-[16px] shadow-xs ring-1 ring-zinc-950/[0.08]">
        {/* Top 42px Aside Browser / Command Toolbar */}
        <header className="h-[42px] border-b border-zinc-200/75 flex items-center justify-between px-3 gap-2 shrink-0 bg-white/95 backdrop-blur-xs select-none">
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={loadInitialData}
              className="size-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-950 hover:bg-zinc-100 active:scale-[0.96] transition-all duration-150 cursor-pointer"
              title="Segarkan Data"
              aria-label="Segarkan data"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Center Unified Aside Omnibox Pill */}
          <button
            type="button"
            onClick={() => {
              handleTabChange('events');
              setTimeout(() => searchInputRef.current?.focus(), 60);
            }}
            className="flex-1 max-w-xl mx-auto h-7 rounded-lg bg-zinc-100/80 hover:bg-zinc-200/60 ring-1 ring-inset ring-zinc-950/[0.05] px-2.5 flex items-center justify-between text-xs text-zinc-500 transition-colors cursor-pointer group"
            title="Cari event atau filter (tekan /)"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <Shield className="w-3 h-3 text-zinc-400 shrink-0" />
              <span className="font-mono text-[11px] text-zinc-600 truncate">
                {routeLabel[currentTab]}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Search className="w-3 h-3 text-zinc-400 group-hover:text-zinc-700 transition-colors" />
              <kbd className="px-1.5 py-0.2 text-[10px] font-mono bg-white rounded shadow-2xs ring-1 ring-zinc-950/[0.06] text-zinc-500">
                /
              </kbd>
            </div>
          </button>

          {/* Right Toolbar Controls */}
          <div className="flex items-center gap-1.5 shrink-0">
            {failedEventsCount > 0 && currentTab !== 'dead' && (
              <button
                type="button"
                onClick={() => handleTabChange('dead')}
                className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-rose-50 hover:bg-rose-100/80 text-rose-700 ring-1 ring-rose-200/80 text-[11px] font-semibold tabular-nums active:scale-[0.97] transition-all duration-150 cursor-pointer"
                title="Buka Dead-Letter Queue"
              >
                <AlertOctagon className="w-3 h-3 text-rose-600" />
                <span>{failedEventsCount} DLQ</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsLive(!isLive)}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-white hover:bg-zinc-100 text-zinc-700 ring-1 ring-zinc-950/[0.08] shadow-2xs text-[11px] font-medium active:scale-[0.97] transition-all duration-150 cursor-pointer"
              title={isLive ? 'Jeda stream real-time' : 'Lanjutkan stream real-time'}
            >
              {isLive ? (
                <>
                  <Pause className="w-3 h-3 text-zinc-500" />
                  <span className="hidden sm:inline">Pause Stream</span>
                </>
              ) : (
                <>
                  <Play className="w-3 h-3 text-emerald-600" />
                  <span className="hidden sm:inline">Resume Stream</span>
                </>
              )}
            </button>
          </div>
        </header>

        {/* Active View Content + Split Inspector */}
        <div className="flex-1 flex flex-row min-w-0 min-h-0 relative overflow-hidden">
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
            {currentTab === 'overview' && (
              <OverviewView
                data={overviewData}
                onSelectEvent={(ev) => setSelectedEvent(ev)}
                onNavigate={handleTabChange}
              />
            )}

            {currentTab === 'events' && (
              <EventsView
                events={events}
                stats={stats}
                endpoints={endpoints}
                selectedEventId={selectedEvent?.id || null}
                onSelectEvent={(ev) => setSelectedEvent(ev)}
                onReplayEvent={handleReplaySingle}
                onBulkReplayFailed={() => handleBulkReplay([], true)}
                onBulkReplay={(targetIds, allFailed) => handleBulkReplay(targetIds, allFailed)}
                isLive={isLive}
                onToggleLive={() => setIsLive(!isLive)}
                bufferedCount={bufferedEvents.length}
                onFlushBuffer={handleFlushBuffer}
                searchInputRef={searchInputRef}
              />
            )}

            {currentTab === 'dead' && (
              <DeadLetterView
                events={events}
                endpoints={endpoints}
                selectedEventId={selectedEvent?.id || null}
                onSelectEvent={(ev) => setSelectedEvent(ev)}
                onReplaySingle={handleReplaySingle}
                onBulkReplay={(targetIds, allFailed) => handleBulkReplay(targetIds, allFailed)}
                onNavigateToEndpoint={() => {
                  handleTabChange('endpoints');
                }}
                onToast={(msg, type) => showToast(msg, type)}
              />
            )}

            {currentTab === 'endpoints' && (
              <EndpointsView
                endpoints={endpoints}
                onAddEndpoint={handleAddEndpoint}
                onToggleActive={handleToggleEndpointActive}
                onToast={(msg) => showToast(msg, 'info')}
              />
            )}
          </div>

          {/* Inspector Slide-over / Split Panel */}
          {selectedEvent && (
            <InspectorDrawer
              event={selectedEvent}
              endpoints={endpoints}
              onClose={() => setSelectedEvent(null)}
              onReplay={handleReplaySingle}
              onToast={(msg) => showToast(msg, 'info')}
              onNavigateToEndpoint={() => {
                handleTabChange('endpoints');
              }}
              isSplitView={true}
            />
          )}
        </div>
      </main>

      {/* Toast Feedback */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
};
export default App;
