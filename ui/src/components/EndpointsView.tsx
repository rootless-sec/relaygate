import React, { useState } from 'react';
import {
  Network,
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  X,
} from 'lucide-react';
import { Endpoint, ProviderType } from '../types';

interface EndpointsViewProps {
  endpoints: Endpoint[];
  onAddEndpoint: (data: {
    name: string;
    provider: ProviderType;
    target_url: string;
    secret_key?: string;
  }) => Promise<void>;
  onToggleActive: (endpoint: Endpoint) => Promise<void>;
  onToast: (message: string) => void;
}

export const EndpointsView: React.FC<EndpointsViewProps> = ({
  endpoints,
  onAddEndpoint,
  onToggleActive,
  onToast,
}) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderType>('generic');
  const [targetUrl, setTargetUrl] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const toggleShowSecret = (id: string) => {
    const next = new Set(visibleSecrets);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setVisibleSecrets(next);
  };

  const copyText = (text: string, label: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 1500);
      onToast(`${label} disalin ke clipboard`);
    } catch {
      onToast(`Gagal menyalin ${label}`);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !targetUrl.trim()) {
      setError('Nama dan Target URL wajib diisi.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onAddEndpoint({
        name: name.trim(),
        provider,
        target_url: targetUrl.trim(),
        secret_key: secretKey.trim() || undefined,
      });
      setName('');
      setTargetUrl('');
      setSecretKey('');
      setShowAddModal(false);
      onToast('Endpoint berhasil ditambahkan');
    } catch (err: any) {
      setError(err?.message || 'Gagal menambahkan endpoint');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-5 space-y-5 bg-zinc-50/50">
      {/* Header Card */}
      <div className="bg-white rounded-2xl p-4 ring-1 ring-zinc-950/[0.08] shadow-2xs flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Network className="w-4 h-4 text-zinc-900" />
            <h1 className="text-base font-semibold text-zinc-950 tracking-tight">
              Konfigurasi Endpoint Webhook
            </h1>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            Kelola rute tujuan downstream dan rahasia verifikasi signature untuk setiap provider.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 h-8 px-3.5 bg-zinc-950 hover:bg-zinc-800 text-white rounded-lg text-xs font-medium shadow-2xs active:scale-[0.97] transition-all duration-150 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Tambah Endpoint</span>
        </button>
      </div>

      {/* Endpoints Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {endpoints.map((ep) => {
          const ingestUrl = `${window.location.origin}/webhooks/${ep.id}`;
          const isSecretVisible = visibleSecrets.has(ep.id);

          return (
            <div
              key={ep.id}
              className="bg-white ring-1 ring-zinc-950/[0.08] rounded-xl p-4 shadow-2xs flex flex-col justify-between space-y-3.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="size-8 rounded-lg bg-zinc-100 ring-1 ring-zinc-950/[0.06] flex items-center justify-center font-mono text-[11px] font-semibold uppercase text-zinc-800 shrink-0">
                    {ep.provider.slice(0, 2)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-950 truncate">
                        {ep.name}
                      </h3>
                      <span className="px-1.5 py-0.5 rounded bg-zinc-100 ring-1 ring-zinc-950/[0.06] font-mono text-[10px] font-semibold uppercase text-zinc-700">
                        {ep.provider}
                      </span>
                    </div>
                    <p className="text-[11px] font-mono text-zinc-400 mt-0.5">
                      ID: <span className="text-zinc-600">{ep.id}</span>
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onToggleActive(ep)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    ep.is_active
                      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80'
                      : 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200'
                  }`}
                >
                  {ep.is_active ? 'Aktif' : 'Nonaktif'}
                </button>
              </div>

              {/* Ingest URL */}
              <div className="p-2.5 rounded-lg bg-zinc-50/80 ring-1 ring-inset ring-zinc-950/[0.06] space-y-1">
                <div className="flex items-center justify-between text-[11px] text-zinc-500 font-medium">
                  <span>URL Ingest Webhook</span>
                  <button
                    type="button"
                    onClick={() => copyText(ingestUrl, `URL Ingest ${ep.name}`)}
                    className="inline-flex items-center gap-1 text-zinc-700 hover:text-zinc-950 cursor-pointer"
                  >
                    {copiedKey === `URL Ingest ${ep.name}` ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span className="text-emerald-700">Disalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Salin</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="font-mono text-xs text-zinc-900 truncate select-all">
                  {ingestUrl}
                </div>
              </div>

              {/* Target Downstream URL */}
              <div className="space-y-1 text-xs">
                <span className="text-[11px] text-zinc-500 font-medium flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" />
                  <span>Target Downstream</span>
                </span>
                <div className="font-mono text-zinc-800 truncate">{ep.target_url}</div>
              </div>

              {/* Secret Key */}
              <div className="pt-2.5 border-t border-zinc-100 flex items-center justify-between text-xs">
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] text-zinc-500 font-medium">Secret / Token: </span>
                  <span className="font-mono text-zinc-800 ml-1">
                    {ep.secret_key
                      ? isSecretVisible
                        ? ep.secret_key
                        : '••••••••••••••••'
                      : '(tidak diatur)'}
                  </span>
                </div>
                {ep.secret_key && (
                  <button
                    type="button"
                    onClick={() => toggleShowSecret(ep.id)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-950 px-2 py-0.5 rounded hover:bg-zinc-100 cursor-pointer"
                  >
                    {isSecretVisible ? (
                      <>
                        <EyeOff className="w-3 h-3" />
                        <span>Sembunyikan</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3 h-3" />
                        <span>Tampilkan</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Endpoint Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white ring-1 ring-zinc-950/[0.08] rounded-2xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-950 tracking-tight">
                Tambah Endpoint Baru
              </h2>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="size-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {error && (
              <div className="mb-3 p-2.5 rounded-lg bg-rose-50 ring-1 ring-rose-200 text-xs text-rose-800">
                {error}
              </div>
            )}

            <form onSubmit={handleCreate} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-zinc-700 font-medium mb-1">Nama Endpoint</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="orders-service"
                  className="w-full h-9 px-3 bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-zinc-700 font-medium mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ProviderType)}
                  className="w-full h-9 px-3 bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 focus:outline-none"
                >
                  <option value="generic">Generic (HMAC-SHA256)</option>
                  <option value="stripe">Stripe</option>
                  <option value="xendit">Xendit</option>
                  <option value="midtrans">Midtrans</option>
                  <option value="github">GitHub</option>
                </select>
              </div>

              <div>
                <label className="block text-zinc-700 font-medium mb-1">Target URL Downstream</label>
                <input
                  type="url"
                  required
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://api.internal.id/webhooks"
                  className="w-full h-9 px-3 font-mono bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-zinc-700 font-medium mb-1">
                  Secret Key / Callback Token (Opsional)
                </label>
                <input
                  type="text"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder="whsec_..."
                  className="w-full h-9 px-3 font-mono bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 focus:outline-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="h-8 px-3.5 bg-white hover:bg-zinc-100 ring-1 ring-zinc-950/[0.08] text-zinc-900 rounded-lg font-medium active:scale-[0.97] transition-all duration-150 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="h-8 px-4 bg-zinc-950 hover:bg-zinc-800 text-white rounded-lg font-medium active:scale-[0.97] transition-all duration-150 disabled:opacity-50 cursor-pointer"
                >
                  {loading ? 'Menyimpan...' : 'Simpan Endpoint'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
