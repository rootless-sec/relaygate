import React from 'react';
import {
  CheckCircle,
  Webhook,
  Flag,
} from 'lucide-react';
import { OverviewData, WebhookEvent, NavTab } from '../types';
import { analyzeEventError, formatRelativeTime } from '../utils/formatters';

interface OverviewViewProps {
  data: OverviewData | null;
  onSelectEvent: (event: WebhookEvent) => void;
  onNavigate?: (tab: NavTab) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  data,
  onSelectEvent,
  onNavigate,
}) => {
  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-white">
        <div className="flex flex-col items-center gap-2 text-zinc-500">
          <div className="w-5 h-5 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
          <span className="text-xs">Memuat ringkasan sistem...</span>
        </div>
      </div>
    );
  }

  const { stats, endpoint_breakdown, recent_failed } = data;

  const total = stats.total_events;
  const delivered = stats.delivered_events;
  const pending = stats.pending_events ?? 0;
  const retrying = stats.retrying_events;
  const failed = stats.failed_events;
  const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 100;

  return (
    <div className="flex-1 overflow-auto px-4 lg:px-7 py-5 space-y-5 bg-white">
      {/* Top Page Heading Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-950 text-balance">
            Overview
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5 text-pretty">
            Ringkasan throughput webhook, keandalan pengiriman rute endpoint, dan insiden DLQ terbaru.
          </p>
        </div>

        {onNavigate && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate('events')}
              className="h-8 px-3 rounded-md bg-white hover:bg-zinc-50 active:scale-[0.97] border border-zinc-200/90 text-zinc-800 text-xs font-medium shadow-2xs transition-transform cursor-pointer tabular-nums"
            >
              Semua Event ({total})
            </button>
            <button
              type="button"
              onClick={() => onNavigate('dead')}
              className="h-8 px-3 rounded-md bg-zinc-900 hover:bg-zinc-800 active:scale-[0.97] text-white text-xs font-medium shadow-2xs transition-transform cursor-pointer tabular-nums"
            >
              Inspeksi DLQ ({failed})
            </button>
          </div>
        )}
      </div>

      {/* Navattic "Session summary" Style Bordered Divided Summary Box */}
      <div className="border border-zinc-200/90 rounded-lg overflow-hidden bg-white shadow-2xs">
        <div className="px-4 py-2.5 bg-zinc-50/90 border-b border-zinc-200/80 flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-700">Ringkasan metrik pengiriman</span>
          <span className="text-[11px] font-mono text-zinc-400">Real-time</span>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-zinc-200/80">
          <div className="p-4 text-center">
            <div className="text-xl font-semibold text-zinc-950 tabular-nums">
              {total}
            </div>
            <div className="text-xs text-zinc-500 mt-1">Total webhook masuk</div>
          </div>

          <div className="p-4 text-center">
            <div className="text-xl font-semibold text-zinc-950 tabular-nums">
              {deliveryRate}%
            </div>
            <div className="text-xs text-zinc-500 mt-1 tabular-nums">
              Tingkat keberhasilan ({delivered} terkirim)
            </div>
          </div>

          <div className="p-4 text-center">
            <div className="text-xl font-semibold text-zinc-950 tabular-nums">
              {pending + retrying}
            </div>
            <div className="text-xs text-zinc-500 mt-1 tabular-nums">
              Antrean & retry ({retrying} aktif)
            </div>
          </div>

          <div className="p-4 text-center">
            <div
              className={`text-xl font-semibold tabular-nums ${
                failed > 0 ? 'text-rose-700' : 'text-zinc-950'
              }`}
            >
              {failed}
            </div>
            <div className="text-xs text-zinc-500 mt-1">Dead-Letter Queue (DLQ)</div>
          </div>
        </div>
      </div>

      {/* Two-Column Split: Endpoint Table + Recent Failed Timeline (Navattic Pattern) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Column: Endpoint Breakdown Table */}
        <div className="lg:col-span-7">
          <div className="border border-zinc-200/90 rounded-lg overflow-hidden bg-white shadow-2xs">
            <div className="px-4 py-2.5 bg-zinc-50/90 border-b border-zinc-200/80 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-700 tabular-nums">
                Keandalan per Endpoint ({endpoint_breakdown.length})
              </span>
            </div>

            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-white border-b border-zinc-200/80 text-[11px] font-medium text-zinc-500">
                <tr className="divide-x divide-zinc-100">
                  <th className="py-2 px-3.5">Endpoint</th>
                  <th className="py-2 px-3.5">Provider</th>
                  <th className="py-2 px-3.5">Terkirim</th>
                  <th className="py-2 px-3.5 text-right">Rasio Sukses</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200/70">
                {endpoint_breakdown.length > 0 ? (
                  endpoint_breakdown.map((ep) => (
                    <tr key={ep.id} className="divide-x divide-zinc-100 hover:bg-zinc-50/60">
                      <td className="py-2.5 px-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="size-6 rounded-full bg-zinc-100 border border-zinc-200/80 flex items-center justify-center text-zinc-600 shrink-0">
                            <Webhook className="w-3 h-3" />
                          </div>
                          <span className="font-medium text-zinc-900">{ep.name}</span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3.5 font-mono text-[11px] uppercase text-zinc-600">
                        {ep.provider}
                      </td>
                      <td className="py-2.5 px-3.5 font-mono text-zinc-600 tabular-nums">
                        {ep.delivered} / {ep.total}
                      </td>
                      <td className="py-2.5 px-3.5 text-right font-mono font-medium text-zinc-900 tabular-nums">
                        {Math.round(ep.success_rate)}%
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-xs text-zinc-500">
                      Belum ada data endpoint tercatat.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Navattic "Conversion Events" Style Incident Timeline Card */}
        <div className="lg:col-span-5">
          <div className="border border-zinc-200/90 rounded-lg overflow-hidden bg-white shadow-2xs">
            <div className="px-4 py-2.5 bg-zinc-50/90 border-b border-zinc-200/80 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-700 tabular-nums">
                Insiden Kegagalan Terbaru ({recent_failed.length})
              </span>
            </div>

            <div className="divide-y divide-zinc-100">
              {recent_failed.length > 0 ? (
                recent_failed.map((ev) => {
                  const analysis = analyzeEventError(ev);
                  return (
                    <div
                      key={ev.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelectEvent(ev)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectEvent(ev);
                        }
                      }}
                      className="px-4 py-3 hover:bg-zinc-50/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-900 outline-none cursor-pointer transition-colors flex items-start justify-between gap-3"
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <div className="size-5 rounded-full bg-zinc-100 border border-zinc-200 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
                          <Flag className="w-2.5 h-2.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-zinc-900">
                              {analysis.badgeLabel}
                            </span>
                            <span className="font-mono text-[11px] text-zinc-500">
                              {ev.id.slice(0, 8)}...
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 truncate mt-0.5">
                            {ev.endpoint_id} · {analysis.title}
                          </p>
                        </div>
                      </div>

                      <span className="text-xs text-zinc-500 whitespace-nowrap shrink-0 tabular-nums">
                        {formatRelativeTime(ev.failed_at || ev.updated_at || ev.created_at)}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="py-12 px-4 text-center flex flex-col items-center justify-center gap-1.5">
                  <CheckCircle className="w-5 h-5 text-emerald-600" />
                  <p className="text-xs font-semibold text-zinc-900">
                    Tidak ada webhook gagal
                  </p>
                  <p className="text-xs text-zinc-500">
                    Semua pengiriman berjalan normal.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
