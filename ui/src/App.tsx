import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  RotateCw,
  Pause,
  Play,
  AlertOctagon,
  ChevronDown,
  Layers,
  Activity,
  Webhook,
} from 'lucide-react';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { EventsView } from './components/EventsView';
import { InspectorDrawer } from './components/InspectorDrawer';
import { OverviewView } from './components/OverviewView';
import { DeadLetterView } from './components/DeadLetterView';
import { EndpointsView } from './components/EndpointsView';
import { ProfileModal } from './components/ProfileModal';
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
  fetchProfile,
  fetchStats,
  replayEvent,
  bulkReplay,
  createEndpoint,
  updateEndpoint,
  logoutUser,
  UserProfile,
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
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(() => {
    try {
      const stored = localStorage.getItem('relaygate_auth');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.user) return parsed.user;
        if (parsed.email) {
          return {
            id: parsed.id || '',
            email: parsed.email,
            name: parsed.name || (parsed.email.startsWith('admin@') ? 'Administrator' : parsed.email),
            role: parsed.role || (parsed.email.startsWith('admin@') ? 'admin' : 'viewer'),
            created_at: '',
          };
        }
      }
    } catch {}
    return null;
  });
  const [showProfileModal, setShowProfileModal] = useState<boolean>(false);

  useEffect(() => {
    const handleExpired = (e: any) => {
      const msg = e?.detail?.message || 'Sesi berakhir';
      setUserEmail(null);
      setCurrentUser(null);
      setShowProfileModal(false);
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
    } catch (err) {
      console.error('Initial data load error:', err);
    }
  }, []);

  useEffect(() => {
    if (userEmail) {
      loadInitialData();
      fetchProfile()
        .then((profile) => setCurrentUser(profile))
        .catch(() => {});
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
  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch {}
    localStorage.removeItem('relaygate_auth');
    setUserEmail(null);
    setCurrentUser(null);
    setShowProfileModal(false);
    setSelectedEvent(null);
  };

  if (!userEmail) {
    return (
      <LoginPage
        onLoginSuccess={(email) => {
          setSessionExpiredMessage(null);
          setUserEmail(email);
          fetchProfile().then((p) => setCurrentUser(p)).catch(() => {});
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

  const breadcrumbMeta: Record<
    NavTab,
    { group: string; title: string; icon: React.ReactNode }
  > = {
    overview: {
      group: 'Workspace',
      title: 'Overview Sistem',
      icon: <Activity className="w-3.5 h-3.5 text-zinc-500" />,
    },
    events: {
      group: 'Monitor',
      title: 'Semua Webhook Event',
      icon: <Layers className="w-3.5 h-3.5 text-zinc-500" />,
    },
    dead: {
      group: 'Monitor',
      title: 'Dead-Letter Queue',
      icon: <AlertOctagon className="w-3.5 h-3.5 text-rose-600" />,
    },
    endpoints: {
      group: 'Manage',
      title: 'Rute Endpoint',
      icon: <Webhook className="w-3.5 h-3.5 text-zinc-500" />,
    },
  };

  const activeBreadcrumb = breadcrumbMeta[currentTab];

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-white text-zinc-900 antialiased">
      {/* Left Workspace Navigation Sidebar */}
      <Sidebar
        currentTab={currentTab}
        onTabChange={handleTabChange}
        totalEventsCount={totalEventsCount}
        failedEventsCount={failedEventsCount}
        userEmail={userEmail}
        currentUser={currentUser}
        onOpenProfile={() => setShowProfileModal(true)}
        onLogout={handleLogout}
        endpoints={endpoints}
        isLive={isLive}
        onToggleLive={() => setIsLive(!isLive)}
        onFocusSearch={() => {
          handleTabChange('events');
          setTimeout(() => searchInputRef.current?.focus(), 60);
        }}
      />

      {/* Main Content Canvas */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0 relative overflow-hidden bg-white">
        {/* Top 48px Breadcrumb Header Bar (Navattic Pattern: "Section / [Active View v]") */}
        <header className="h-12 border-b border-zinc-200/80 flex items-center justify-between px-4 lg:px-7 gap-3 shrink-0 bg-white select-none">
          <div className="flex items-center gap-2.5 min-w-0 text-xs">
            <span className="text-zinc-500 font-medium">{activeBreadcrumb.group}</span>
            <span className="text-zinc-300">/</span>

            {/* Navattic View Selector Pill */}
            <div className="relative inline-flex items-center shrink-0">
              <div className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-zinc-200/90 bg-white text-xs font-medium text-zinc-800 shadow-2xs whitespace-nowrap">
                {activeBreadcrumb.icon}
                <span className="whitespace-nowrap">{activeBreadcrumb.title}</span>
                <ChevronDown className="w-3 h-3 text-zinc-400 ml-0.5 shrink-0" />
              </div>
              <select
                aria-label="Pilih tampilan workspace"
                value={currentTab}
                onChange={(e) => handleTabChange(e.target.value as NavTab)}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              >
                <option value="overview">Overview Sistem</option>
                <option value="events">Semua Webhook Event</option>
                <option value="dead">Dead-Letter Queue (DLQ)</option>
                <option value="endpoints">Rute Endpoint</option>
              </select>
            </div>
          </div>

          {/* Right Utility Controls */}
          <div className="flex items-center gap-2 shrink-0">
            {failedEventsCount > 0 && currentTab !== 'dead' && (
              <button
                type="button"
                onClick={() => handleTabChange('dead')}
                className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-rose-50 hover:bg-rose-100/80 active:scale-[0.97] text-rose-700 border border-rose-200/80 text-xs font-medium tabular-nums transition-transform cursor-pointer"
                title="Buka Dead-Letter Queue"
              >
                <AlertOctagon className="w-3.5 h-3.5 text-rose-600" />
                <span>{failedEventsCount} gagal</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsLive(!isLive)}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-white hover:bg-zinc-50 active:scale-[0.97] text-zinc-700 border border-zinc-200/90 shadow-2xs text-xs font-medium transition-transform cursor-pointer"
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

            <button
              type="button"
              onClick={loadInitialData}
              className="size-7 rounded-md border border-zinc-200/90 bg-white hover:bg-zinc-50 active:scale-[0.97] flex items-center justify-center text-zinc-600 hover:text-zinc-900 shadow-2xs transition-transform cursor-pointer"
              title="Segarkan Data"
              aria-label="Segarkan data"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Active View Content + Split Floating Inspector */}
        <div className="flex-1 flex flex-row min-w-0 min-h-0 relative overflow-hidden bg-white">
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

          {/* Floating Inspector Slide-over / Split Card (Navattic Pattern) */}
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

      {/* Profile & Account Settings Modal */}
      {showProfileModal && (
        <ProfileModal
          isOpen={showProfileModal}
          onClose={() => setShowProfileModal(false)}
          currentUser={currentUser}
          onProfileUpdated={(updated) => {
            setCurrentUser(updated);
            if (updated.email) setUserEmail(updated.email);
            try {
              const stored = localStorage.getItem('relaygate_auth');
              if (stored) {
                const parsed = JSON.parse(stored);
                parsed.user = { ...parsed.user, ...updated };
                localStorage.setItem('relaygate_auth', JSON.stringify(parsed));
              }
            } catch {}
          }}
          onToast={(msg, type) => showToast(msg, type)}
        />
      )}

      {/* Toast Feedback */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
};
export default App;
