import React from 'react';
import {
  Activity,
  Layers,
  AlertOctagon,
  Webhook,
  LogOut,
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
    <aside className="w-56 lg:w-60 shrink-0 flex flex-col justify-between select-none bg-white border-r border-zinc-200/80 h-full">
      <div className="flex flex-col min-h-0 flex-1">
        {/* Brand & Workspace Title */}
        <div className="h-12 px-4 flex items-center justify-between shrink-0 border-b border-zinc-100">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="size-7 rounded-lg bg-zinc-950 text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-2xs">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4 text-white"
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
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-semibold text-zinc-950 truncate leading-tight">
                RelayGate
              </span>
              <span className="text-[10px] text-zinc-400 font-medium truncate leading-tight">
                Webhook Gateway
              </span>
            </div>
          </div>
        </div>

        <nav className="p-3 space-y-4 overflow-y-auto flex-1" aria-label="Navigasi utama">
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
        </nav>
      </div>

      {/* Bottom Operator Profile & Sign-Out */}
      <div className="p-3 shrink-0 border-t border-zinc-100">
        <div className="flex items-center gap-1.5 w-full">
          <button
            type="button"
            onClick={onOpenProfile}
            title="Kelola Profil & Keamanan Akun"
            aria-label="Buka Pengaturan Profil"
            className="flex-1 min-w-0 h-9 px-2 rounded-lg text-xs font-medium text-zinc-700 hover:text-zinc-950 hover:bg-zinc-100 flex items-center gap-2.5 transition-colors cursor-pointer text-left"
          >
            <div className="size-6 rounded-full bg-zinc-200 text-zinc-800 text-[10px] font-semibold flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-zinc-300">
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
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate text-xs font-medium text-zinc-900 leading-tight" title={currentUser?.name ? `${currentUser.name} (${userEmail})` : userEmail}>
                {currentUser?.name || userEmail}
              </span>
              <span className="truncate text-[10px] text-zinc-400 leading-tight">
                {currentUser?.role === 'admin' ? 'Administrator' : 'Viewer'}
              </span>
            </div>
          </button>
          <button
            type="button"
            onClick={onLogout}
            title="Keluar Sesi"
            aria-label="Keluar Sesi"
            className="size-8 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition-colors cursor-pointer shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
};
export default Sidebar;
