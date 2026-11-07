import React from 'react';
import {
  BarChart3,
  AlertTriangle,
  CheckCircle,
  Layers,
  ArrowUpRight,
  TrendingUp,
  Clock,
  Webhook,
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
      <div className="flex-1 flex items-center justify-center p-8 bg-zinc-50/50">
        <div className="flex flex-col items-center gap-2 text-zinc-500">
          <div className="w-6 h-6 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
          <span className="text-xs">Memuat ringkasan performa RelayGate...</span>
        </div>
      </div>
    );
  }

  const { stats, throughput, endpoint_breakdown, recent_failed } = data;

  const total = stats.total_events;
  const delivered = stats.delivered_events;
  const pending = stats.pending_events ?? 0;
  const retrying = stats.retrying_events;
  const failed = stats.failed_events;
  const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 100;

  const maxTraffic = Math.max(1, ...throughput.map((b) => b.total));

  return (
    <div className="flex-1 overflow-auto p-5 space-y-5 bg-zinc-50/50">
      {/* Aside Workspace Header Card */}
      <div className="rounded-2xl bg-white ring-1 ring-zinc-950/[0.08] shadow-2xs p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-zinc-950 tracking-tight">
            Overview Ringkasan Sistem
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Monitoring real-time throughput ingestion, keandalan pengiriman endpoint, dan deteksi kegagalan webhook.
          </p>
        </div>

        {onNavigate && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onNavigate('events')}
              className="h-8 px-3 rounded-lg bg-zinc-100/80 hover:bg-zinc-200/70 text-zinc-800 text-xs font-medium flex items-center gap-1.5 active:scale-[0.97] transition-all duration-150 cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5 text-zinc-500" />
              <span>Semua Event ({total})</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('dead')}
              className="h-8 px-3 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium flex items-center gap-1.5 active:scale-[0.97] transition-all duration-150 cursor-pointer"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span>Inspeksi DLQ ({failed})</span>
            </button>
          </div>
        )}
      </div>

      {/* Aside "Recent Tasks" Style 4-Column Metric Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white ring-1 ring-zinc-950/[0.08] rounded-xl p-4 shadow-2xs flex flex-col justify-between">
          <div className="text-xs font-medium text-zinc-500 flex items-center justify-between">
            <span>Total Webhook</span>
            <div className="size-7 rounded-lg bg-zinc-100/80 ring-1 ring-zinc-950/[0.06] flex items-center justify-center">
              <Layers className="w-3.5 h-3.5 text-zinc-700" />
            </div>
          </div>
          <div className="text-2xl font-semibold text-zinc-950 mt-3 tabular-nums tracking-tight">
            {total}
          </div>
          <div className="text-[11px] text-zinc-500 mt-1 tabular-nums">
            {delivered} terkirim · {pending + retrying} antrean
          </div>
        </div>

        <div className="bg-white ring-1 ring-zinc-950/[0.08] rounded-xl p-4 shadow-2xs flex flex-col justify-between">
          <div className="text-xs font-medium text-zinc-500 flex items-center justify-between">
            <span>Tingkat Keberhasilan</span>
            <div className="size-7 rounded-lg bg-emerald-50 ring-1 ring-emerald-200/70 flex items-center justify-center">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
            </div>
          </div>
          <div className="text-2xl font-semibold text-emerald-700 mt-3 tabular-nums tracking-tight">
            {deliveryRate}%
          </div>
          <div className="mt-2 w-full bg-zinc-100 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-emerald-600 h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.min(100, Math.max(0, deliveryRate))}%` }}
            />
          </div>
        </div>

        <div className="bg-white ring-1 ring-zinc-950/[0.08] rounded-xl p-4 shadow-2xs flex flex-col justify-between">
          <div className="text-xs font-medium text-zinc-500 flex items-center justify-between">
            <span>Antrean & Retry</span>
            <div className="size-7 rounded-lg bg-amber-50 ring-1 ring-amber-200/70 flex items-center justify-center">
              <Clock className="w-3.5 h-3.5 text-amber-600" />
            </div>
          </div>
          <div className="text-2xl font-semibold text-zinc-950 mt-3 tabular-nums tracking-tight">
            {pending + retrying}
          </div>
          <div className="text-[11px] text-zinc-500 mt-1 tabular-nums">
            {pending} menunggu · {retrying} mencoba ulang
          </div>
        </div>

        <div className="bg-white ring-1 ring-zinc-950/[0.08] rounded-xl p-4 shadow-2xs flex flex-col justify-between">
          <div className="text-xs font-medium text-zinc-500 flex items-center justify-between">
            <span>Dead-Letter (DLQ)</span>
            <div className="size-7 rounded-lg bg-rose-50 ring-1 ring-rose-200/70 flex items-center justify-center">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
            </div>
          </div>
          <div className="text-2xl font-semibold text-rose-700 mt-3 tabular-nums tracking-tight">
            {failed}
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">
            {failed > 0 ? 'Memerlukan tindakan operator' : 'Antrean gagal bersih'}
          </div>
        </div>
      </div>

      {/* Aside Two-Column Split: Benchmark Bars + Endpoint Breakdown & Recent DLQ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: Aside Benchmark-Style Endpoint Performance & Throughput */}
        <div className="lg:col-span-6 space-y-4">
          <div className="bg-white ring-1 ring-zinc-950/[0.08] rounded-xl p-4 shadow-2xs space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Webhook className="w-3.5 h-3.5 text-zinc-600" />
                <h2 className="text-xs font-semibold text-zinc-950 tracking-tight">
                  Keandalan Pengiriman per Endpoint
                </h2>
              </div>
              <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
                {endpoint_breakdown.length} rute
              </span>
            </div>

            <div className="space-y-3">
              {endpoint_breakdown.length > 0 ? (
                endpoint_breakdown.map((ep) => (
                  <div key={ep.id} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 ring-1 ring-zinc-950/[0.06] font-mono text-[10px] font-semibold uppercase text-zinc-700">
                          {ep.provider}
                        </span>
                        <span className="font-medium text-zinc-900 truncate">{ep.name}</span>
                      </div>
                      <span className="font-mono text-[11px] text-zinc-600 tabular-nums shrink-0">
                        {ep.delivered}/{ep.total} ({Math.round(ep.success_rate)}%)
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-md bg-zinc-100 overflow-hidden ring-1 ring-inset ring-zinc-950/[0.04]">
                      <div
                        className="h-full bg-zinc-900 rounded-md transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.max(4, ep.success_rate))}%` }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-6 text-center text-xs text-zinc-500">
                  Belum ada data endpoint tercatat.
                </div>
              )}
            </div>
          </div>

          {/* Throughput Bar Chart */}
          <div className="bg-white ring-1 ring-zinc-950/[0.08] rounded-xl p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-3.5 h-3.5 text-zinc-600" />
                <h2 className="text-xs font-semibold text-zinc-950 tracking-tight">
                  Distribusi Volume Trafik
                </h2>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-xs bg-zinc-900" /> Total
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-xs bg-rose-500" /> Gagal
                </span>
              </div>
            </div>

            <div className="h-28 flex items-end gap-2 pt-2 px-1">
              {throughput.map((bucket) => {
                const totalHeightPct = Math.max(6, Math.round((bucket.total / maxTraffic) * 100));
                const failedHeightPct =
                  bucket.total > 0 ? Math.round((bucket.failed / maxTraffic) * 100) : 0;
                return (
                  <div
                    key={bucket.index}
                    className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end"
                  >
                    <div className="w-full flex-1 flex items-end justify-center gap-0.5">
                      <div
                        className="w-2.5 bg-zinc-900 rounded-t-xs transition-all duration-300"
                        style={{ height: `${totalHeightPct}%` }}
                        title={`${bucket.label}: ${bucket.total} total`}
                      />
                      {bucket.failed > 0 && (
                        <div
                          className="w-2.5 bg-rose-500 rounded-t-xs transition-all duration-300"
                          style={{ height: `${Math.max(8, failedHeightPct)}%` }}
                          title={`${bucket.label}: ${bucket.failed} gagal`}
                        />
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-zinc-400 tabular-nums truncate max-w-full">
                      {bucket.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: Aside Vault Style Recent Failed Events */}
        <div className="lg:col-span-6 bg-white ring-1 ring-zinc-950/[0.08] rounded-xl shadow-2xs flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
              <h2 className="text-xs font-semibold text-zinc-950 tracking-tight">
                Insiden Kegagalan Terbaru (DLQ)
              </h2>
            </div>
            <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
              {recent_failed.length} ditampilkan
            </span>
          </div>

          <div className="divide-y divide-zinc-100 flex-1">
            {recent_failed.length > 0 ? (
              recent_failed.map((ev) => {
                const analysis = analyzeEventError(ev);
                return (
                  <div
                    key={ev.id}
                    onClick={() => onSelectEvent(ev)}
                    className="px-4 py-3 hover:bg-zinc-50/90 cursor-pointer transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="size-8 rounded-lg bg-rose-50 ring-1 ring-rose-200/70 flex items-center justify-center font-mono text-[10px] font-semibold uppercase text-rose-700 shrink-0 mt-0.5">
                        {ev.provider.slice(0, 2)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-semibold text-zinc-950">
                            {ev.id.slice(0, 8)}...
                          </span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${analysis.badgeStyle}`}
                          >
                            {analysis.badgeLabel}
                          </span>
                          <span className="text-[11px] font-mono text-zinc-500 truncate">
                            {ev.endpoint_id}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-600 truncate mt-1">
                          {analysis.title}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col items-end shrink-0 gap-1">
                      <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
                        {formatRelativeTime(ev.failed_at || ev.updated_at || ev.created_at)}
                      </span>
                      <span className="text-[11px] font-medium text-zinc-700 flex items-center gap-0.5">
                        <span>Inspeksi</span>
                        <ArrowUpRight className="w-3 h-3" />
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-16 px-4 text-center flex flex-col items-center justify-center gap-2">
                <CheckCircle className="w-6 h-6 text-emerald-600" />
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
  );
};
