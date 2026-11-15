import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastMessage {
  id: string;
  type?: ToastType;
  title?: string;
  message: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  duration?: number;
}

export interface ToastProps {
  toast: ToastMessage | null;
  onClose: () => void;
  position?: 'bottom-right' | 'bottom-center';
}

export const Toast: React.FC<ToastProps> = ({
  toast,
  onClose,
  position = 'bottom-right',
}) => {
  const [isPaused, setIsPaused] = useState(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Reset paused state when a new toast arrives so timer is not permanently stuck
  useEffect(() => {
    setIsPaused(false);
  }, [toast?.id]);

  // Keyboard accessibility: Escape key to dismiss
  useEffect(() => {
    if (!toast) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPaused(false);
        onCloseRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toast]);

  // Auto-dismiss transient feedback with hover-to-pause; critical error notices remain until dismissed
  useEffect(() => {
    if (!toast || isPaused) return;

    // Critical error notices remain until explicitly dismissed by operator
    if (toast.type === 'error' && !toast.duration) {
      return;
    }

    const timer = toast.duration
      ? setTimeout(() => {
          onCloseRef.current();
        }, toast.duration)
      : setTimeout(() => {
          onCloseRef.current();
        }, 3000);

    return () => clearTimeout(timer);
  }, [toast?.id, isPaused, toast?.type, toast?.duration]);

  if (!toast) return null;

  const type: ToastType = toast.type || 'info';
  const isAlert = type === 'error' || type === 'warning';

  const iconConfigs: Record<
    ToastType,
    {
      icon: React.ReactNode;
      badgeBg: string;
    }
  > = {
    success: {
      icon: <CheckCircle2 className="w-4 h-4 text-emerald-600" />,
      badgeBg: 'bg-emerald-50 border-emerald-200/60',
    },
    error: {
      icon: <AlertCircle className="w-4 h-4 text-rose-600" />,
      badgeBg: 'bg-rose-50 border-rose-200/60',
    },
    warning: {
      icon: <AlertTriangle className="w-4 h-4 text-amber-600" />,
      badgeBg: 'bg-amber-50 border-amber-200/60',
    },
    info: {
      icon: <Info className="w-4 h-4 text-sky-600" />,
      badgeBg: 'bg-sky-50 border-sky-200/60',
    },
  };

  const config = iconConfigs[type] || iconConfigs.info;
  const title =
    toast.title ||
    (typeof toast.message === 'string' &&
    toast.message.toLowerCase().includes('sesi')
      ? 'Sesi Berakhir'
      : undefined);

  const containerPositionClass =
    position === 'bottom-center'
      ? 'fixed bottom-24 left-0 right-0 md:left-56 lg:left-60 pointer-events-none z-50 flex justify-center px-4'
      : 'fixed bottom-24 left-4 right-4 sm:left-auto sm:right-6 sm:w-96 z-50 pointer-events-none flex justify-center sm:justify-end';

  return (
    <section
      role="region"
      aria-label="Notifikasi"
      tabIndex={-1}
      className={containerPositionClass}
    >
      <div
        key={toast.id}
        role={isAlert ? 'alert' : 'status'}
        aria-live={isAlert ? 'assertive' : 'polite'}
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        className="pointer-events-auto w-full max-w-md bg-white border border-zinc-200/90 rounded-xl p-3.5 sm:p-4 shadow-lg shadow-zinc-950/5 flex items-start gap-3 transition-all animate-in fade-in slide-in-from-bottom-3 duration-200 select-none"
      >
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${config.badgeBg}`}
          aria-hidden="true"
        >
          {config.icon}
        </div>

        <div className="flex-1 min-w-0 pr-1">
          {title && (
            <h4 className="text-xs font-semibold text-zinc-900 leading-snug break-words">
              {title}
            </h4>
          )}
          <p
            className={`text-xs leading-relaxed break-words ${
              title ? 'text-zinc-600 mt-0.5' : 'font-medium text-zinc-900'
            }`}
          >
            {toast.message}
          </p>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                setIsPaused(false);
                toast.action?.onClick();
                onClose();
              }}
              className="mt-2 text-xs font-medium text-zinc-900 hover:text-zinc-700 underline underline-offset-2 transition-colors cursor-pointer"
            >
              {toast.action.label}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setIsPaused(false);
            onClose();
          }}
          className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 p-2.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 shrink-0"
          aria-label="Tutup notifikasi"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </section>
  );
};
