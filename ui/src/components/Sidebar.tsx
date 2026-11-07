import React from 'react';
import {
  LayoutDashboard,
  Layers,
  AlertOctagon,
  Webhook,
  LogOut,
  X,
} from 'lucide-react';
import { NavTab, Endpoint } from '../types';
import { UserProfile } from '../api';
import { RelayGateIcon } from './RelayGateLogo';

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
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
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
  isMobileOpen = false,
  onCloseMobile,
}) => {
  const drawerRef = React.useRef<HTMLElement | null>(null);

  // Keyboard accessibility: Escape to close and focus entry per Production UI Rule 6
  React.useEffect(() => {
    if (!isMobileOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseMobile?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const timer = setTimeout(() => {
      drawerRef.current?.focus();
    }, 40);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [isMobileOpen, onCloseMobile]);

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
      icon: <LayoutDashboard className="w-3.5 h-3.5" />,
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

  const renderNavButton = (
    item: {
      id: NavTab;
      label: string;
      icon: React.ReactNode;
      badge?: number;
      badgeTone?: 'neutral' | 'danger';
    },
    isMobile = false
  ) => {
    const isActive = currentTab === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => {
          onTabChange(item.id);
          if (isMobile) onCloseMobile?.();
        }}
        className={`w-full flex items-center justify-between ${
          isMobile ? 'min-h-[44px] h-11' : 'h-8'
        } px-2.5 rounded-md text-xs transition-colors cursor-pointer ${
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
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden md:flex w-56 lg:w-60 shrink-0 flex-col justify-between select-none bg-white border-r border-zinc-200/80 h-full">
        <div className="flex flex-col min-h-0 flex-1">
          {/* Brand & Workspace Title */}
          <div className="h-14 px-4 flex items-center justify-between shrink-0 border-b border-zinc-200/80">
            <div className="flex items-center gap-2.5 min-w-0">
              <RelayGateIcon size={24} className="text-zinc-950 shrink-0" />
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
              {analyzeItems.map((item) => renderNavButton(item, false))}
            </div>

            {/* Group: Monitor */}
            <div className="space-y-1">
              <div className="px-2.5 text-[11px] font-medium text-zinc-400">
                Monitor
              </div>
              <div className="space-y-0.5">
                {queueItems.map((item) => renderNavButton(item, false))}
              </div>
            </div>

            {/* Group: Manage */}
            <div className="space-y-1">
              <div className="px-2.5 text-[11px] font-medium text-zinc-400">
                Manage
              </div>
              <div className="space-y-0.5">
                {manageItems.map((item) => renderNavButton(item, false))}
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
                  ((currentUser?.name || userEmail || 'A').slice(0, 1).toUpperCase())
                )}
              </div>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="truncate text-xs font-medium text-zinc-900 leading-tight" title={currentUser?.name ? `${currentUser.name} (${userEmail})` : userEmail}>
                  {currentUser?.name || (userEmail.startsWith('admin@') ? 'Administrator' : userEmail)}
                </span>
                <span className="truncate text-[10px] text-zinc-400 leading-tight">
                  {currentUser?.role === 'admin' || userEmail.startsWith('admin@') ? 'Administrator' : 'Viewer'}
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

      {/* Mobile Drawer Overlay */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-zinc-950/40 backdrop-blur-2xs animate-in"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside
            ref={drawerRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            className="relative z-10 w-72 max-w-[85vw] h-full bg-white border-r border-zinc-200 flex flex-col justify-between shadow-2xl animate-in focus:outline-none"
            aria-label="Navigasi mobile"
          >
            <div className="flex flex-col min-h-0 flex-1">
              <div className="h-14 px-4 flex items-center justify-between shrink-0 border-b border-zinc-200/80">
                <div className="flex items-center gap-2.5 min-w-0">
                  <RelayGateIcon size={24} className="text-zinc-950 shrink-0" />
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-semibold text-zinc-950 truncate leading-tight">
                      RelayGate
                    </span>
                    <span className="text-[10px] text-zinc-400 font-medium truncate leading-tight">
                      Webhook Gateway
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onCloseMobile}
                  className="min-h-[44px] min-w-[44px] rounded-lg text-zinc-500 hover:text-zinc-950 hover:bg-zinc-100 flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                  aria-label="Tutup menu navigasi"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <nav className="p-3 space-y-4 overflow-y-auto flex-1" aria-label="Navigasi utama mobile">
                <div className="space-y-0.5">
                  {analyzeItems.map((item) => renderNavButton(item, true))}
                </div>
                <div className="space-y-1">
                  <div className="px-2.5 text-[11px] font-medium text-zinc-400">
                    Monitor
                  </div>
                  <div className="space-y-0.5">
                    {queueItems.map((item) => renderNavButton(item, true))}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="px-2.5 text-[11px] font-medium text-zinc-400">
                    Manage
                  </div>
                  <div className="space-y-0.5">
                    {manageItems.map((item) => renderNavButton(item, true))}
                  </div>
                </div>
              </nav>
            </div>

            <div className="p-3 shrink-0 border-t border-zinc-100 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div className="flex items-center gap-1.5 w-full">
                <button
                  type="button"
                  onClick={() => {
                    onCloseMobile?.();
                    onOpenProfile?.();
                  }}
                  title="Kelola Profil & Keamanan Akun"
                  aria-label="Buka Pengaturan Profil"
                  className="flex-1 min-w-0 min-h-[44px] px-2 rounded-lg text-xs font-medium text-zinc-700 hover:text-zinc-950 hover:bg-zinc-100 flex items-center gap-2.5 transition-colors cursor-pointer text-left"
                >
                  <div className="size-6 rounded-full bg-zinc-200 text-zinc-800 text-[10px] font-semibold flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-zinc-300">
                    {currentUser?.avatar_url ? (
                      <img
                        src={currentUser.avatar_url}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      ((currentUser?.name || userEmail || 'A').slice(0, 1).toUpperCase())
                    )}
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate text-xs font-medium text-zinc-900 leading-tight">
                      {currentUser?.name || (userEmail.startsWith('admin@') ? 'Administrator' : userEmail)}
                    </span>
                    <span className="truncate text-[10px] text-zinc-400 leading-tight">
                      {currentUser?.role === 'admin' || userEmail.startsWith('admin@') ? 'Administrator' : 'Viewer'}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onCloseMobile?.();
                    onLogout();
                  }}
                  title="Keluar Sesi"
                  aria-label="Keluar Sesi"
                  className="min-h-[44px] min-w-[44px] rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </>
  );
};
export default Sidebar;
