import React from 'react';
import { 
  Activity, 
  Layers, 
  AlertOctagon, 
  Network, 
  LogOut 
} from 'lucide-react';
import { NavTab } from '../types';

interface SidebarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  totalEventsCount: number;
  failedEventsCount: number;
  userEmail: string;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  totalEventsCount,
  failedEventsCount,
  userEmail,
  onLogout,
}) => {
  const navItems = [
    {
      id: 'overview' as NavTab,
      label: 'Overview',
      icon: Activity,
    },
    {
      id: 'events' as NavTab,
      label: 'Events',
      icon: Layers,
      count: totalEventsCount,
    },
    {
      id: 'dead' as NavTab,
      label: 'Dead Letter',
      icon: AlertOctagon,
      count: failedEventsCount,
      alert: failedEventsCount > 0,
    },
    {
      id: 'endpoints' as NavTab,
      label: 'Endpoints',
      icon: Network,
    },
  ];

  return (
    <aside className="w-56 bg-white border-r border-zinc-200 flex flex-col h-full shrink-0 select-none">
      {/* Brand Logo */}
      <div className="p-4 pb-3 flex items-center justify-between border-b border-zinc-100">
        <img
          src="/logo.png"
          alt="RelayGate"
          className="h-7 w-auto object-contain"
        />
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-2 py-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-zinc-100 text-zinc-900 font-semibold shadow-xs'
                  : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Icon className={`w-4 h-4 ${isActive ? 'text-zinc-900' : 'text-zinc-500'}`} />
                <span>{item.label}</span>
              </div>
              {item.count !== undefined && (
                <span
                  className={`text-[11px] px-1.5 py-0.2 rounded-md font-mono ${
                    item.alert
                      ? 'bg-rose-100 text-rose-700 font-bold'
                      : isActive
                      ? 'bg-zinc-200 text-zinc-900'
                      : 'bg-zinc-100 text-zinc-700'
                  }`}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>


      {/* User Session Footer */}
      <div className="p-3 border-t border-zinc-200 flex items-center justify-between gap-2 bg-white">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-zinc-900 truncate" title={userEmail}>
            {userEmail}
          </div>
          <div className="text-[10px] text-zinc-500">Administrator</div>
        </div>
        <button
          onClick={onLogout}
          title="Keluar dari sesi"
          className="p-1.5 text-zinc-500 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
