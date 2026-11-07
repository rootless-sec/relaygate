import React from 'react';
import {
  Activity,
  Layers,
  AlertOctagon,
  Webhook,
  LogOut,
  Search,
  LayoutGrid,
  Radio,
} from 'lucide-react';
import { NavTab, Endpoint } from '../types';

interface SidebarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  totalEventsCount: number;
  failedEventsCount: number;
  userEmail: string;
  onLogout: () => void;
  endpoints?: Endpoint[];
  isLive?: boolean;
  onToggleLive?: () => void;
  onFocusSearch?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  totalEventsCount,
  failedEventsCount,
  userEmail,
  onLogout,
  endpoints = [],
  isLive = true,
  onToggleLive,
  onFocusSearch,
}) => {
  const analyzeItems: {
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    badgeTone?: 'neutral' | 'danger';
  }[] = [
    {
      id: 'overview',
      label: 'Overview',
      icon: <Activity className="w-3.5 h-3.5" />,
    },
  ];

  const queueItems: {
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    badgeTone?: 'neutral' | 'danger';
  }[] = [
    {
      id: 'events',
      label: 'Events',
      icon: <Layers className="w-3.5 h-3.5" />,
      badge: totalEventsCount > 0 ? totalEventsCount : undefined,
      badgeTone: 'neutral',
    },
    {
      id: 'dead',
      label: 'Dead-letter (DLQ)',
      icon: <AlertOctagon className="w-3.5 h-3.5" />,
      badge: failedEventsCount > 0 ? failedEventsCount : undefined,
      badgeTone: 'danger',
    },
  ];

  const manageItems: {
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }[] = [
    {
      id: 'endpoints',
      label: 'Endpoints',
      icon: <Webhook className="w-3.5 h-3.5" />,
      badge: endpoints.length > 0 ? endpoints.length : undefined,
    },
  ];

  const renderNavButton = (item: {
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
    badgeTone?: 'neutral' | 'danger';
  }) => {
    const isActive = currentTab === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => onTabChange(item.id)}
        className={`w-full flex items-center justify-between h-8 px-2.5 rounded-md text-xs transition-colors cursor-pointer ${
          isActive
            ? 'bg-zinc-100/90 text-zinc-950 font-semibold'
            : 'text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950 font-medium'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={isActive ? 'text-zinc-950' : 'text-zinc-500'}>
            {item.icon}
          </span>
          <span className="truncate">{item.label}</span>
        </div>

        {item.badge !== undefined && (
          <span
            className={`px-1.5 py-0.5 text-[10px] font-mono font-medium rounded tabular-nums ${
              item.badgeTone === 'danger'
                ? 'bg-rose-50 text-rose-700 border border-rose-200/80'
                : 'bg-zinc-100 text-zinc-600'
            }`}
          >
            {item.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="flex h-full shrink-0 select-none bg-white border-r border-zinc-200/80">
      {/* Far-Left Narrow Workspace Icon Rail (Navattic Pattern) */}
      <div className="w-12 shrink-0 bg-zinc-50/50 border-r border-zinc-200/70 flex flex-col items-center justify-between py-3">
        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={() => onTabChange('overview')}
            className="size-8 rounded-lg flex items-center justify-center hover:bg-zinc-200/50 transition-colors cursor-pointer"
            title="RelayGate"
          >
            <span className="w-5 h-5 overflow-hidden flex items-center justify-start">
              <img
                src="/logo.png"
                alt="RelayGate"
                className="h-5 w-auto max-w-none"
              />
            </span>
          </button>

          <button
            type="button"
            onClick={() => onTabChange('events')}
            className="size-8 rounded-lg bg-zinc-950 text-white font-mono text-[10px] font-bold tracking-tight flex items-center justify-center shadow-2xs cursor-pointer"
            title="RelayGate Workspace"
          >
            RG
          </button>

          <button
            type="button"
            onClick={() => onTabChange('endpoints')}
            className="size-8 rounded-lg bg-white border border-zinc-200/90 text-zinc-700 hover:bg-zinc-50 flex items-center justify-center shadow-2xs transition-colors cursor-pointer"
            title="Rute Endpoint"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (onFocusSearch) {
                onFocusSearch();
              } else {
                onTabChange('events');
              }
            }}
            className="size-8 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/50 flex items-center justify-center transition-colors cursor-pointer"
            title="Cari event ( / )"
            aria-label="Cari event"
          >
            <Search className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onToggleLive}
            className="size-8 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/50 flex items-center justify-center transition-colors cursor-pointer"
            title={isLive ? 'Stream Aktif' : 'Stream Dijeda'}
            aria-label="Status stream"
          >
            <Radio className={`w-3.5 h-3.5 ${isLive ? 'text-emerald-600' : 'text-zinc-400'}`} />
          </button>

          <div
            className="size-7 rounded-full bg-zinc-200 text-zinc-800 font-semibold text-[11px] flex items-center justify-center ring-1 ring-zinc-300"
            title={userEmail}
          >
            {userEmail.slice(0, 1).toUpperCase()}
          </div>
        </div>
      </div>

      {/* Secondary Navigation Column (Navattic Pattern) */}
      <div className="w-52 flex flex-col justify-between h-full bg-white">
        <div className="flex flex-col min-h-0 flex-1">
          {/* Top Brand / Product Title */}
          <div className="h-12 px-4 flex items-center justify-between shrink-0">
            <span className="text-sm font-semibold text-zinc-950 tracking-tight truncate">
              Webhook Gateway
            </span>
          </div>

          <nav className="px-2.5 space-y-4 overflow-y-auto flex-1" aria-label="Navigasi utama">
            {/* Primary Overview Item */}
            <div className="space-y-0.5">
              {analyzeItems.map(renderNavButton)}
            </div>

            {/* Group: Monitor */}
            <div className="space-y-1">
              <div className="px-2.5 text-[11px] font-medium text-zinc-400">
                Monitor
              </div>
              <div className="space-y-0.5">
                {queueItems.map(renderNavButton)}
              </div>
            </div>

            {/* Group: Manage */}
            <div className="space-y-1">
              <div className="px-2.5 text-[11px] font-medium text-zinc-400">
                Manage
              </div>
              <div className="space-y-0.5">
                {manageItems.map(renderNavButton)}
              </div>
            </div>

            {/* Active Routes Quick List */}
            {endpoints.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="px-2.5 text-[11px] font-medium text-zinc-400">
                  Rute Aktif
                </div>
                <div className="space-y-0.5">
                  {endpoints.slice(0, 5).map((ep) => (
                    <button
                      key={ep.id}
                      type="button"
                      onClick={() => onTabChange('endpoints')}
                      className="w-full flex items-center justify-between h-7 px-2.5 rounded-md text-xs text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950 transition-colors cursor-pointer"
                      title={`${ep.name} (${ep.target_url})`}
                    >
                      <span className="truncate font-mono text-[11px]">{ep.name}</span>
                      <span className="text-[10px] font-mono uppercase text-zinc-400">
                        {ep.provider}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </nav>
        </div>

        {/* Bottom Status Pill & Operator Sign-Out (Navattic Footer Pattern) */}
        <div className="p-3 space-y-2 shrink-0 border-t border-zinc-100">
          <div className="px-3 py-1.5 rounded-lg border border-zinc-200 bg-white shadow-2xs flex items-center justify-between text-xs font-medium text-zinc-800">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`size-2.5 rounded-full border-2 shrink-0 ${
                  isLive ? 'border-emerald-600 bg-emerald-500/20' : 'border-zinc-400 bg-zinc-100'
                }`}
              />
              <span className="truncate text-[11px]">
                {isLive ? 'SSE Stream aktif' : 'SSE Stream dijeda'}
              </span>
            </div>
            <span className="text-[10px] font-mono text-zinc-400 tabular-nums">
              v1
            </span>
          </div>

          <button
            type="button"
            onClick={onLogout}
            title="Keluar Sesi"
            aria-label="Keluar Sesi"
            className="w-full h-8 px-2.5 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 flex items-center justify-between transition-colors cursor-pointer"
          >
            <span className="truncate" title={userEmail}>
              {userEmail}
            </span>
            <LogOut className="w-3.5 h-3.5 text-zinc-400 shrink-0 ml-2" />
          </button>
        </div>
      </div>
    </aside>
  );
};
