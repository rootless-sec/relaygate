import React from 'react';
import { 
  BarChart3, 
  AlertTriangle, 
  CheckCircle, 
  Layers, 
  ArrowUpRight,
  TrendingUp
} from 'lucide-react';
import { OverviewData, WebhookEvent } from '../types';

interface OverviewViewProps {
  data: OverviewData | null;
  onSelectEvent: (event: WebhookEvent) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  data,
  onSelectEvent,
}) => {
  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 bg-[#fafafa]">
        <div className="flex flex-col items-center gap-2 text-[#71717a]">
          <div className="w-6 h-6 border-2 border-zinc-400 border-t-zinc-900 rounded-full animate-spin" />
          <span className="text-xs">Memuat ringkasan performa RelayGate...</span>
        </div>
      </div>
    );
  }

  const { stats, throughput, endpoint_breakdown, recent_failed } = data;

  const total = stats.total_events;
  const delivered = stats.delivered_events;
  const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 100;

  // Throughput chart calculation
  const maxTraffic = Math.max(1, ...throughput.map((b) => b.total));
  const chartHeight = 120;
  const barWidth = 22;
  const gap = 34;
  const svgWidth = Math.max(420, 12 * gap + 24);

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 bg-[#fafafa]">
      <div>
        <h2 className="text-base font-bold text-[#18181b] tracking-tight">Overview Ringkasan Sistem</h2>
        <p className="text-xs text-[#71717a]">
          Monitoring real-time throughput ingestion, keandalan pengiriman endpoint, dan deteksi kegagalan webhook.
        </p>
      </div>

      {/* Global Stat Cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-[#71717a] flex items-center justify-between">
            <span>Total Webhook</span>
            <Layers className="w-3.5 h-3.5 text-[#a1a1aa]" />
          </div>
          <div className="text-2xl font-bold text-[#18181b] mt-1">{total}</div>
        </div>

        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-[#71717a] flex items-center justify-between">
            <span>Terkirim (Sukses)</span>
            <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
          </div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">
            {delivered} <span className="text-xs font-semibold text-emerald-600">({deliveryRate}%)</span>
          </div>
        </div>

        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-[#71717a] flex items-center justify-between">
            <span>Retrying</span>
            <TrendingUp className="w-3.5 h-3.5 text-amber-600" />
          </div>
          <div className="text-2xl font-bold text-amber-700 mt-1">{stats.retrying_events}</div>
        </div>

        <div className="bg-white border border-[#e4e4e7] rounded-lg p-3.5 shadow-2xs">
          <div className="text-[11px] font-semibold text-[#71717a] flex items-center justify-between">
            <span>Dead-letter (Gagal)</span>
            <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
          </div>
          <div className="text-2xl font-bold text-rose-700 mt-1">{stats.failed_events}</div>
        </div>
      </div>

      {/* Main Grid: Throughput & Recent Failures */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* SVG Throughput Chart */}
        <div className="lg:col-span-2 bg-white border border-[#e4e4e7] rounded-lg p-4 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-xs font-bold text-[#18181b] flex items-center gap-1.5">
                <BarChart3 className="w-4 h-4 text-[#18181b]" />
                Throughput Webhook, 12 Menit Terakhir
              </div>
              <p className="text-[11px] text-[#71717a] mt-0.5">
                Grafik volume event per menit. Warna merah mengindikasikan lonjakan kegagalan atau retry.
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-[#71717a]">
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 bg-[#18181b] rounded-xs" />
                <span>Total Ingest</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 bg-rose-600 rounded-xs" />
                <span>Gagal / Retry</span>
              </div>
            </div>
          </div>

          <div className="w-full overflow-x-auto pt-2">
            <svg
              viewBox={`0 0 ${svgWidth} 165`}
              className="w-full h-40 select-none overflow-visible"
            >
              {throughput.map((bucket, i) => {
                const totalH = (bucket.total / maxTraffic) * chartHeight;
                const failH = (bucket.failed / maxTraffic) * chartHeight;
                const xPos = 12 + i * gap;

                return (
                  <g key={bucket.index} className="transition-all cursor-pointer">
                    <title>{`${bucket.label}: ${bucket.total} event (${bucket.failed} gagal/retry)`}</title>
                    {/* Background track */}
                    <rect
                      x={xPos}
                      y={140 - chartHeight}
                      width={barWidth}
                      height={chartHeight}
                      rx={3}
                      fill="#f4f4f5"
                    />

                    {/* Total traffic bar */}
                    {totalH > 0 && (
                      <rect
                        x={xPos}
                        y={140 - totalH}
                        width={barWidth}
                        height={totalH}
                        rx={3}
                        fill="#18181b"
                      />
                    )}

                    {/* Failure overlay bar */}
                    {failH > 0 && (
                      <rect
                        x={xPos}
                        y={140 - failH}
                        width={barWidth}
                        height={failH}
                        rx={3}
                        fill="#e11d48"
                      />
                    )}

                    {/* Time label */}
                    <text
                      x={xPos + barWidth / 2}
                      y={156}
                      textAnchor="middle"
                      fontSize={10}
                      fill="#71717a"
                      fontFamily="ui-monospace, monospace"
                    >
                      {bucket.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Recent Failed Events */}
        <div className="bg-white border border-[#e4e4e7] rounded-lg p-4 shadow-2xs flex flex-col">
          <div className="text-xs font-bold text-[#18181b] mb-1 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-rose-600" />
              Event Gagal Terbaru
            </div>
            <span className="text-[11px] text-[#71717a] font-normal">
              {recent_failed.length} ditemukan
            </span>
          </div>
          <p className="text-[11px] text-[#71717a] mb-3">
            Klik event untuk langsung membuka drawer inspeksi payload dan error.
          </p>

          <div className="flex-1 divide-y divide-[#f4f4f5] overflow-y-auto max-h-[170px]">
            {recent_failed.length > 0 ? (
              recent_failed.map((ev) => (
                <div
                  key={ev.id}
                  onClick={() => onSelectEvent(ev)}
                  className="py-2 px-1.5 flex items-center justify-between hover:bg-[#fafafa] rounded cursor-pointer transition-colors group"
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="font-mono text-xs font-bold text-[#18181b] group-hover:underline truncate">
                      {ev.id}
                    </div>
                    <div className="text-[11px] text-[#71717a] truncate mt-0.5">
                      {ev.endpoint_id} · <span className="text-rose-700">{ev.last_error || 'Gagal terkirim'}</span>
                    </div>
                  </div>
                  <ArrowUpRight className="w-3.5 h-3.5 text-[#a1a1aa] group-hover:text-[#18181b] shrink-0" />
                </div>
              ))
            ) : (
              <div className="h-full flex flex-col items-center justify-center p-4 text-[#71717a] text-xs text-center">
                <CheckCircle className="w-6 h-6 text-emerald-600 mb-1" />
                <span>Tidak ada event gagal dalam riwayat terkini. Semua pengiriman berjalan lancar.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Endpoint Breakdown Table */}
      <div className="bg-white border border-[#e4e4e7] rounded-lg p-4 shadow-2xs">
        <div className="text-xs font-bold text-[#18181b] mb-1">
          Distribusi Performa Berdasarkan Endpoint
        </div>
        <p className="text-[11px] text-[#71717a] mb-3">
          Ringkasan statistik perutean webhook dan rasio keberhasilan pengiriman HTTP downstream.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#e4e4e7] text-[11px] font-semibold text-[#71717a] uppercase tracking-wider">
                <th className="py-2 px-3">Endpoint Target</th>
                <th className="py-2 px-3">Provider</th>
                <th className="py-2 px-3 text-right">Total Event</th>
                <th className="py-2 px-3 text-right">Gagal</th>
                <th className="py-2 px-3 text-right">Tingkat Sukses</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f4f4f5]">
              {endpoint_breakdown.length > 0 ? (
                endpoint_breakdown.map((eb) => (
                  <tr key={eb.id} className="hover:bg-[#fafafa] transition-colors">
                    <td className="py-2.5 px-3 font-semibold text-[#18181b]">
                      {eb.name}
                      <span className="block font-mono text-[10px] text-[#71717a] font-normal">{eb.id}</span>
                    </td>
                    <td className="py-2.5 px-3 text-[#71717a] uppercase text-[11px]">
                      {eb.provider}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-right font-medium text-[#18181b]">
                      {eb.total}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-right font-semibold text-rose-700">
                      {eb.failed}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold font-mono ${
                          eb.success_rate >= 90
                            ? 'bg-emerald-50 text-emerald-800'
                            : eb.success_rate >= 70
                            ? 'bg-amber-50 text-amber-800'
                            : 'bg-rose-50 text-rose-800'
                        }`}
                      >
                        {eb.success_rate}%
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[#71717a]">
                    Belum ada endpoint yang terdaftar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
