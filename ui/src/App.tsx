import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  WebhookEvent 
} from './types';
import { 
  fetchEndpoints, 
  fetchEvents, 
  fetchOverview, 
  fetchStats, 
  replayEvent, 
  bulkReplay,
  createEndpoint,
  updateEndpoint 
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

      // If no endpoints exist yet (brand new database), auto-seed the canonical demo endpoints
      if (endpointsData.length === 0) {
        seedDefaultEndpoints();
      }
    } catch (err) {
      console.error('Initial data load error:', err);
    }
  }, []);

  const seedDefaultEndpoints = async () => {
    const defaultList = [
      { name: 'orders-api', provider: 'midtrans' as ProviderType, target_url: 'https://api.toko.id/hooks/midtrans' },
      { name: 'license-svc', provider: 'stripe' as ProviderType, target_url: 'https://license.toko.id/stripe' },
      { name: 'billing-hook', provider: 'xendit' as ProviderType, target_url: 'https://billing.toko.id/xendit' },
      { name: 'deploy-hook', provider: 'github' as ProviderType, target_url: 'https://ci.toko.id/github' },
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
          setSelectedEvent((prev) => (prev?.id === updatedEvent.id ? { ...prev, ...updatedEvent } : prev));
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
  const handleReplaySingle = async (ev: WebhookEvent) => {
    try {
      await replayEvent(ev.id);
      showToast(`Replay dikirim untuk event ${ev.id}`, 'success');
      setEvents((prev) =>
        prev.map((item) =>
          item.id === ev.id ? { ...item, status: 'PENDING', http_status_code: 0, last_error: '' } : item
        )
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
      showToast(`${res.replayed_count} event berhasil di-replay`, 'success');
      loadInitialData();
    } catch (err: any) {
      showToast(err?.message || 'Gagal bulk replay', 'error');
    }
  };

  // 4. Endpoint Actions
  const handleAddEndpoint = async (data: { name: string; provider: ProviderType; target_url: string; secret_key?: string }) => {
    await createEndpoint(data);
    const updated = await fetchEndpoints();
    setEndpoints(updated);
  };

  const handleToggleEndpointActive = async (ep: Endpoint) => {
    try {
      const updated = await updateEndpoint(ep.id, { is_active: !ep.is_active });
      setEndpoints((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      showToast(`Endpoint ${ep.name} ${updated.is_active ? 'diaktifkan' : 'dinonaktifkan'}`, 'info');
    } catch (err: any) {
      showToast(err?.message || 'Gagal mengubah status endpoint', 'error');
    }
  };

  // 5. Global Keyboard Shortcuts
  useEffect(() => {
    if (!userEmail) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is currently typing in an input or select
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
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
    return <LoginPage onLoginSuccess={(email) => setUserEmail(email)} />;
  }

  const failedEventsCount = stats ? stats.failed_events : events.filter((e) => e.status === 'FAILED').length;
  const totalEventsCount = stats ? stats.total_events : events.length;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#fafafa] text-[#18181b] antialiased">
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onTabChange={handleTabChange}
        totalEventsCount={totalEventsCount}
        failedEventsCount={failedEventsCount}
        userEmail={userEmail}
        onLogout={handleLogout}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-row min-w-0 min-h-0 relative overflow-hidden bg-[#fafafa]">
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {currentTab === 'overview' && (
            <OverviewView
              data={overviewData}
              onSelectEvent={(ev) => setSelectedEvent(ev)}
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
      </main>

      {/* Toast Feedback */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
};
