import React from 'react';
import { AlertTriangle, AlertOctagon, CheckCircle, Loader2 } from 'lucide-react';

export interface BulkResultData {
  deliveredCount: number;
  unverifiedCount?: number;
  unverifiedBreakdown?: string;
  deliveryFailedCount?: number;
  deliveryFailedBreakdown?: string;
  failedCount?: number;
  failedBreakdown?: string;
  skippedCount: number;
  skippedBreakdown?: string;
  followUpAdvice?: string;
  inProgressCount?: number;
}

export interface BulkModalState {
  open: boolean;
  isAll?: boolean;
  totalCount: number;
  eligibleIds: string[];
  ineligibleItems: { id: string; reason: string; badgeLabel: string }[];
  inProgress: boolean;
  pollingStatus: string | null;
  resultData: BulkResultData | null;
}

interface BulkReplayModalProps {
  bulkModal: BulkModalState;
  onClose: () => void;
  onConfirm: () => void;
}

export const BulkReplayModal: React.FC<BulkReplayModalProps> = ({
  bulkModal,
  onClose,
  onConfirm,
}) => {
  if (!bulkModal.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
      <div className="w-full max-w-md bg-white border border-zinc-200 rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2.5 mb-2">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <h3 className="text-sm font-bold text-zinc-900">
            {bulkModal.resultData ? 'Hasil replay' : 'Konfirmasi Replay Massal'}
          </h3>
        </div>

        {bulkModal.resultData ? (
          <div className="space-y-3 my-3">
            {(() => {
              const delivered = bulkModal.resultData.deliveredCount ?? 0;
              const unverified = bulkModal.resultData.unverifiedCount ?? 0;
              const deliveryFailed = bulkModal.resultData.deliveryFailedCount ?? (bulkModal.resultData.failedCount ?? 0);
              const skipped = bulkModal.resultData.skippedCount ?? 0;
              const inProgress = bulkModal.resultData.inProgressCount ?? 0;
              const totalN = delivered + unverified + deliveryFailed + skipped + inProgress;
              return (
                <div
                  className="text-xs text-zinc-600 font-medium pb-0.5"
                  data-testid="bulk-total-processed-row"
                >
                  Dari total <b className="text-zinc-900 font-semibold">{totalN} event</b>:
                </div>
              );
            })()}

            <div
              className={`p-3 rounded-lg text-xs leading-relaxed flex items-start gap-2 ${
                bulkModal.resultData.deliveredCount > 0
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-900'
                  : 'bg-zinc-50 border border-zinc-200 text-zinc-700'
              }`}
              data-testid="bulk-delivered-row"
            >
              <CheckCircle
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  bulkModal.resultData.deliveredCount > 0 ? 'text-emerald-600' : 'text-zinc-400'
                }`}
              />
              <span>
                <b className="font-semibold">{bulkModal.resultData.deliveredCount} event</b> lolos verifikasi{bulkModal.resultData.deliveredCount > 0 ? ' dan berhasil terkirim ke downstream.' : '.'}
              </span>
            </div>

            {/* Verification failures: only for rejected verification */}
            {(bulkModal.resultData.unverifiedCount ?? 0) > 0 && (
              <div
                className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 leading-relaxed space-y-1.5"
                data-testid="bulk-unverified-row"
              >
                <div className="flex items-start gap-2">
                  <AlertOctagon className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>
                    <b className="font-semibold">{bulkModal.resultData.unverifiedCount} event</b> tetap gagal verifikasi ({bulkModal.resultData.unverifiedBreakdown}).
                  </span>
                </div>
              </div>
            )}

            {/* Delivery failures: downstream rejected/timeout/error (HTTP 500, etc.) */}
            {(bulkModal.resultData.deliveryFailedCount ?? 0) > 0 && (
              <div
                className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 leading-relaxed space-y-1.5"
                data-testid="bulk-delivery-failed-row"
              >
                <div className="flex items-start gap-2">
                  <AlertOctagon className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>
                    <b className="font-semibold">{bulkModal.resultData.deliveryFailedCount} event</b> tetap gagal kirim ({bulkModal.resultData.deliveryFailedBreakdown}).
                  </span>
                </div>
              </div>
            )}

            {/* Fallback for legacy failedCount */}
            {bulkModal.resultData.unverifiedCount === undefined &&
              bulkModal.resultData.deliveryFailedCount === undefined &&
              (bulkModal.resultData.failedCount ?? 0) > 0 && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 leading-relaxed space-y-1.5">
                  <div className="flex items-start gap-2">
                    <AlertOctagon className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <span>
                      <b className="font-semibold">{bulkModal.resultData.failedCount} event</b> tetap gagal kirim ({bulkModal.resultData.failedBreakdown}).
                    </span>
                  </div>
                </div>
              )}

            {bulkModal.resultData.followUpAdvice && (
              <p className="text-[11px] text-zinc-700 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg leading-relaxed font-medium">
                {bulkModal.resultData.followUpAdvice}
              </p>
            )}

            {bulkModal.resultData.skippedCount > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-950 leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  <b className="font-semibold">{bulkModal.resultData.skippedCount} event</b> dikecualikan otomatis ({bulkModal.resultData.skippedBreakdown}).
                </span>
              </div>
            )}

            {bulkModal.resultData.inProgressCount !== undefined && bulkModal.resultData.inProgressCount > 0 && (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-900 leading-relaxed flex items-start gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600 shrink-0 mt-0.5" />
                <span>
                  <b className="font-semibold">{bulkModal.resultData.inProgressCount} event</b> masih dalam proses retry otomatis di antrean worker.
                </span>
              </div>
            )}

            {bulkModal.resultData.deliveredCount === 0 &&
              (bulkModal.resultData.unverifiedCount ?? 0) === 0 &&
              (bulkModal.resultData.deliveryFailedCount ?? 0) === 0 &&
              (bulkModal.resultData.failedCount ?? 0) === 0 &&
              bulkModal.resultData.skippedCount === 0 &&
              (!bulkModal.resultData.inProgressCount || bulkModal.resultData.inProgressCount === 0) && (
                <div className="p-3 bg-zinc-50 border border-zinc-200 rounded-lg text-xs text-zinc-800">
                  Tidak ada event yang diproses.
                </div>
              )}

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 text-xs font-semibold bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg transition-colors cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-zinc-600 mb-3 leading-relaxed">
              Dari total <b className="text-zinc-900">{bulkModal.totalCount} event</b> yang dipilih:
            </p>

            {/* Eligibility Breakdown */}
            <div className="space-y-2 mb-4 text-xs">
              <div className="p-2.5 bg-emerald-50/70 border border-emerald-200/80 rounded-lg text-emerald-950 flex items-center justify-between">
                <span>Eligible untuk dikirim ulang:</span>
                <b className="font-mono">{bulkModal.eligibleIds.length} event</b>
              </div>

              {bulkModal.ineligibleItems.length > 0 && (
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-950 space-y-1">
                  <div className="flex items-center justify-between font-semibold">
                    <span>Dikecualikan otomatis (tidak eligible):</span>
                    <b className="font-mono">{bulkModal.ineligibleItems.length} event</b>
                  </div>
                  <div className="text-[11px] text-amber-900 font-medium">
                    Penyebab: {(() => {
                      const map = new Map<string, number>();
                      bulkModal.ineligibleItems.forEach((i) =>
                        map.set(i.badgeLabel, (map.get(i.badgeLabel) || 0) + 1)
                      );
                      const parts: string[] = [];
                      map.forEach((c, l) => parts.push(`${c} ${l.toLowerCase()}`));
                      return parts.join(', ');
                    })()}
                  </div>
                </div>
              )}
            </div>

            {bulkModal.inProgress && (
              <div className="p-3 mb-3 bg-zinc-50 border border-zinc-200 rounded-lg text-xs text-zinc-900 flex items-center gap-2.5 animate-in fade-in">
                <Loader2 className="w-4 h-4 animate-spin text-zinc-800 shrink-0" />
                <span className="leading-relaxed">
                  {bulkModal.pollingStatus || 'Sedang memproses replay massal...'}
                </span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={bulkModal.inProgress}
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-semibold bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-900 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={bulkModal.inProgress || bulkModal.eligibleIds.length === 0}
                onClick={onConfirm}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {bulkModal.inProgress ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Memproses Replay...</span>
                  </>
                ) : (
                  <span>Replay {bulkModal.eligibleIds.length} Event Eligible</span>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
