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
import { UserProfile } from '../api';

interface SidebarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  totalEventsCount: number;
  failedEventsCount: number;
  userEmail: string;
  currentUser?: UserProfile | null;
  onOpenProfile?: () => void;
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
  currentUser,
  onOpenProfile,
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
      <div className="w-12 shrink-0 bg-zinc-50/60 border-r border-zinc-200/70 flex flex-col items-center justify-between py-3">
        <div className="flex flex-col items-center gap-2.5">
          <button
            type="button"
            onClick={() => onTabChange('overview')}
            className="size-8 rounded-lg flex items-center justify-center text-zinc-950 hover:bg-zinc-200/60 active:scale-[0.97] transition-transform cursor-pointer"
            title="RelayGate"
            aria-label="RelayGate Overview"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-5 text-zinc-950"
              aria-hidden="true"
            >
              <path
                d="M12 2.75L19.5 7.08V15.75L12 20.08L4.5 15.75V7.08L12 2.75Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <rect
                x="9.5"
                y="8.9"
                width="5"
                height="5"
                rx="0.8"
                fill="currentColor"
              />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => onTabChange('events')}
            className="size-8 rounded-lg bg-zinc-950 text-white font-mono text-[10px] font-bold flex items-center justify-center shadow-2xs active:scale-[0.97] transition-transform cursor-pointer"
            title="RelayGate Workspace"
            aria-label="RelayGate Workspace Events"
          >
            RG
          </button>

          <button
            type="button"
            onClick={() => onTabChange('endpoints')}
            className={`size-8 rounded-lg border flex items-center justify-center shadow-2xs active:scale-[0.97] transition-transform cursor-pointer ${
              currentTab === 'endpoints'
                ? 'bg-zinc-100 border-zinc-300 text-zinc-950'
                : 'bg-white border-zinc-200/90 text-zinc-700 hover:bg-zinc-50'
            }`}
            title="Rute Endpoint"
            aria-label="Rute Endpoint"
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
            className="size-8 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/60 active:scale-[0.97] flex items-center justify-center transition-transform cursor-pointer"
            title="Cari event ( / )"
            aria-label="Cari event"
          >
            <Search className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onToggleLive}
            className="size-8 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/60 active:scale-[0.97] flex items-center justify-center transition-transform cursor-pointer"
            title={isLive ? 'Stream Aktif' : 'Stream Dijeda'}
            aria-label="Status stream"
          >
            <Radio className={`w-3.5 h-3.5 ${isLive ? 'text-emerald-600' : 'text-zinc-400'}`} />
          </button>

          <button
            type="button"
            onClick={onOpenProfile}
            className="size-7 rounded-full bg-zinc-200 text-zinc-800 font-semibold text-[11px] flex items-center justify-center ring-1 ring-zinc-300 hover:ring-zinc-400 overflow-hidden cursor-pointer transition-transform active:scale-95"
            title="Kelola Profil & Keamanan Akun"
            aria-label="Kelola Profil & Keamanan Akun"
          >
            {currentUser?.avatar_url ? (
              <img
                src={currentUser.avatar_url}
                alt={currentUser.name || userEmail}
                className="w-full h-full object-cover"
              />
            ) : (
              (currentUser?.name || userEmail).slice(0, 1).toUpperCase()
            )}
          </button>
        </div>
      </div>

      {/* Secondary Navigation Column (Navattic Pattern) */}
      <div className="hidden md:flex w-44 lg:w-52 flex-col justify-between h-full bg-white">
        <div className="flex flex-col min-h-0 flex-1">
          {/* Top Brand / Product Title */}
          <div className="h-12 px-4 flex items-center justify-between shrink-0">
            <span className="text-sm font-semibold text-zinc-950 truncate">
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
                      <span className="text-[10px] font-mono uppercase text-zinc-400 ml-1.5 shrink-0">
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
          <div className="px-3 py-1.5 rounded-full border border-zinc-200/90 bg-white shadow-2xs flex items-center justify-between text-xs font-medium text-zinc-800">
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

          <div className="flex items-center gap-1.5 w-full">
            <button
              type="button"
              onClick={onOpenProfile}
              title="Kelola Profil & Keamanan Akun"
              aria-label="Buka Pengaturan Profil"
              className="flex-1 min-w-0 h-8 px-2 rounded-md text-xs font-medium text-zinc-700 hover:text-zinc-950 hover:bg-zinc-100 flex items-center gap-2 transition-colors cursor-pointer text-left"
            >
              <div className="size-5 rounded-full bg-zinc-200 text-zinc-800 text-[10px] font-semibold flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-zinc-300">
                {currentUser?.avatar_url ? (
                  <img
                    src={currentUser.avatar_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  (currentUser?.name || userEmail).slice(0, 1).toUpperCase()
                )}
              </div>
              <span className="truncate text-[11px]" title={currentUser?.name ? `${currentUser.name} (${userEmail})` : userEmail}>
                {currentUser?.name || userEmail}
              </span>
            </button>
            <button
              type="button"
              onClick={onLogout}
              title="Keluar Sesi"
              aria-label="Keluar Sesi"
              className="size-8 rounded-md text-zinc-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition-colors cursor-pointer shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
