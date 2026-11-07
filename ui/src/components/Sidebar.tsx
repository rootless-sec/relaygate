import React from 'react';
import {
  Activity,
  Layers,
  AlertOctagon,
  Webhook,
  LogOut,
  Plus,
  Globe,
  ShieldCheck,
  Terminal,
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
}) => {
  const navItems: {
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
    {
      id: 'endpoints',
      label: 'Endpoints',
      icon: <Webhook className="w-3.5 h-3.5" />,
    },
  ];

  const quickTiles: {
    id: NavTab;
    title: string;
    icon: React.ReactNode;
    hasAlert?: boolean;
  }[] = [
    {
      id: 'overview',
      title: 'Overview Workspace',
      icon: <Activity className="w-4 h-4" />,
    },
    {
      id: 'events',
      title: 'Semua Webhook Event',
      icon: <Layers className="w-4 h-4" />,
    },
    {
      id: 'dead',
      title: 'Dead-Letter Queue (DLQ)',
      icon: <AlertOctagon className="w-4 h-4" />,
      hasAlert: failedEventsCount > 0,
    },
  ];

  return (
    <aside className="w-56 shrink-0 flex flex-col justify-between select-none text-zinc-900 h-full">
      <div className="flex flex-col min-h-0 flex-1">
        {/* Aside 42px Top Window Chrome Bar */}
        <div className="h-[42px] flex items-center justify-between pl-3 pr-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center gap-1.5 shrink-0" aria-hidden="true">
              <span className="size-2.5 rounded-full bg-zinc-300/90 ring-1 ring-zinc-950/[0.08]" />
              <span className="size-2.5 rounded-full bg-zinc-300/90 ring-1 ring-zinc-950/[0.08]" />
              <span className="size-2.5 rounded-full bg-zinc-300/90 ring-1 ring-zinc-950/[0.08]" />
            </div>

            <button
              type="button"
              onClick={() => onTabChange('overview')}
              className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-zinc-900/[0.05] active:scale-[0.98] transition-all duration-150 min-w-0 cursor-pointer"
              title="RelayGate Control Plane"
            >
              <img
                src="/logo.png"
                alt="RelayGate"
                className="w-4 h-4 object-contain rounded-xs shrink-0"
              />
              <span className="text-xs font-semibold tracking-tight text-zinc-950 truncate">
                RelayGate
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => onTabChange('endpoints')}
            className="size-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-950 hover:bg-zinc-900/[0.06] active:scale-[0.96] transition-all duration-150 cursor-pointer"
            title="Konfigurasi Endpoint"
            aria-label="Buka konfigurasi endpoint"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Aside Signature 3-Column Recessed Quick-Access Tiles */}
        <div className="grid grid-cols-3 gap-1.5 px-2.5 py-1.5 shrink-0">
          {quickTiles.map((tile) => {
            const isTileActive = currentTab === tile.id;
            return (
              <button
                key={tile.id}
                type="button"
                onClick={() => onTabChange(tile.id)}
                title={tile.title}
                className={`relative flex h-9 items-center justify-center rounded-lg transition-all duration-150 active:scale-[0.96] cursor-pointer ${
                  isTileActive
                    ? 'bg-white text-zinc-950 shadow-xs ring-1 ring-zinc-950/[0.08]'
                    : 'bg-zinc-900/[0.05] text-zinc-600 hover:bg-zinc-900/[0.08] hover:text-zinc-950 ring-1 ring-inset ring-zinc-950/[0.04]'
                }`}
              >
                {tile.icon}
                {tile.hasAlert && (
                  <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-rose-600" />
                )}
              </button>
            );
          })}
        </div>

        {/* Section 1: Workspace Navigation */}
        <div className="px-2 pt-2 space-y-0.5 shrink-0">
          <div className="flex h-7 items-center justify-between px-2 text-xs font-medium text-zinc-500">
            <span>Workspace</span>
          </div>

          <nav className="space-y-0.5" aria-label="Navigasi utama">
            {navItems.map((item) => {
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onTabChange(item.id)}
                  className={`w-full flex items-center justify-between h-8 px-2.5 py-1 rounded-lg text-xs transition-all duration-150 active:scale-[0.98] cursor-pointer ${
                    isActive
                      ? 'bg-white text-zinc-950 font-medium shadow-xs ring-1 ring-zinc-950/[0.08]'
                      : 'text-zinc-600 hover:bg-zinc-900/[0.05] hover:text-zinc-950 font-normal'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={isActive ? 'text-zinc-950' : 'text-zinc-500'}>
                      {item.icon}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </div>

                  {item.badge !== undefined && (
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded-md tabular-nums ${
                        item.badgeTone === 'danger'
                          ? isActive
                            ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
                            : 'bg-rose-500/10 text-rose-700'
                          : 'bg-zinc-900/[0.06] text-zinc-700'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Section 2: Active Endpoints (Aside "Today" Tabs Pattern) */}
        <div className="px-2 pt-3 flex-1 min-h-0 flex flex-col">
          <div className="flex h-7 items-center justify-between px-2 text-xs font-medium text-zinc-500 shrink-0">
            <span>Rute Endpoint</span>
            <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
              {endpoints.length}
            </span>
          </div>

          <div className="space-y-0.5 overflow-y-auto pr-0.5 flex-1">
            {endpoints.length > 0 ? (
              endpoints.slice(0, 8).map((ep) => (
                <button
                  key={ep.id}
                  type="button"
                  onClick={() => onTabChange('endpoints')}
                  className="w-full flex items-center justify-between h-8 px-2.5 py-1 rounded-lg text-xs text-zinc-600 hover:bg-zinc-900/[0.05] hover:text-zinc-950 transition-all duration-150 active:scale-[0.98] cursor-pointer group"
                  title={`${ep.name} (${ep.target_url})`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="size-4 rounded bg-white ring-1 ring-zinc-950/[0.08] shadow-2xs flex items-center justify-center text-[9px] font-mono font-semibold uppercase text-zinc-700 shrink-0">
                      {(ep.provider || 'G').slice(0, 1)}
                    </span>
                    <span className="truncate font-medium text-zinc-700 group-hover:text-zinc-950">
                      {ep.name}
                    </span>
                  </div>
                  <span
                    className={`size-1.5 rounded-full shrink-0 ${
                      ep.is_active === false ? 'bg-zinc-300' : 'bg-emerald-500'
                    }`}
                  />
                </button>
              ))
            ) : (
              <div className="px-2.5 py-2 text-[11px] text-zinc-400 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span className="truncate">Belum ada rute terdaftar</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Footer: Live Telemetry Status & Operator Profile */}
      <div className="p-2 space-y-1.5 shrink-0">
        <div className="px-2.5 py-1.5 rounded-lg bg-zinc-900/[0.04] ring-1 ring-inset ring-zinc-950/[0.05] flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-1.5 text-zinc-600 font-medium">
            <Terminal className="w-3.5 h-3.5 text-zinc-500" />
            <span>SSE Stream</span>
          </div>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-tight ${
              isLive
                ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80'
                : 'bg-zinc-200/70 text-zinc-600'
            }`}
          >
            {isLive ? 'Aktif' : 'Dijeda'}
          </span>
        </div>

        <div className="p-2 rounded-xl bg-white/80 ring-1 ring-zinc-950/[0.07] shadow-2xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="size-7 rounded-lg bg-zinc-900 text-white flex items-center justify-center text-xs font-semibold shrink-0">
              {userEmail.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div
                className="text-xs font-medium text-zinc-950 truncate"
                title={userEmail}
              >
                {userEmail}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <ShieldCheck className="w-3 h-3 text-zinc-500 shrink-0" />
                <span className="text-[10px] font-medium text-zinc-500">
                  Operator
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onLogout}
            title="Keluar Sesi"
            aria-label="Keluar Sesi"
            className="size-7 rounded-lg flex items-center justify-center text-zinc-500 hover:text-rose-600 hover:bg-rose-50 active:scale-[0.96] transition-all duration-150 shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
};
