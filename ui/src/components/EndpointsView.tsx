import React, { useState } from 'react';
import {
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  X,
  Webhook,
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
    <div className="flex-1 overflow-auto px-4 lg:px-7 py-5 space-y-4 bg-white">
      {/* Page Heading Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-950 tracking-tight text-balance">
            Endpoints
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5 text-pretty">
            Kelola rute tujuan downstream dan secret verifikasi signature untuk setiap provider.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 h-8 px-3 bg-zinc-900 hover:bg-zinc-800 text-white rounded-md text-xs font-medium shadow-2xs transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Tambah Endpoint</span>
        </button>
      </div>

      {/* Navattic Bordered Grid Table for Endpoints */}
      <div className="border border-zinc-200/90 rounded-lg bg-white overflow-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-zinc-50/95 border-b border-zinc-200/90 text-xs font-medium text-zinc-600 select-none">
            <tr className="divide-x divide-zinc-200/60">
              <th className="py-2.5 px-3.5 whitespace-nowrap">Endpoint</th>
              <th className="py-2.5 px-3.5 whitespace-nowrap">Provider</th>
              <th className="py-2.5 px-3.5 whitespace-nowrap">URL Ingest Webhook</th>
              <th className="py-2.5 px-3.5 whitespace-nowrap">Target Downstream</th>
              <th className="py-2.5 px-3.5 whitespace-nowrap">Secret / Token</th>
              <th className="py-2.5 px-3.5 text-right whitespace-nowrap">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200/70">
            {endpoints.map((ep) => {
              const ingestUrl = `${window.location.origin}/webhooks/${ep.id}`;
              const isSecretVisible = visibleSecrets.has(ep.id);

              return (
                <tr key={ep.id} className="divide-x divide-zinc-100 hover:bg-zinc-50/70">
                  <td className="py-3 px-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <div className="size-7 rounded-full bg-zinc-100 border border-zinc-200/80 flex items-center justify-center text-zinc-600 shrink-0">
                        <Webhook className="w-3.5 h-3.5" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="font-medium text-zinc-900 text-xs">
                          {ep.name}
                        </span>
                        <span className="text-[11px] font-mono text-zinc-500">
                          {ep.id}
                        </span>
                      </div>
                    </div>
                  </td>

                  <td className="py-3 px-3.5 whitespace-nowrap">
                    <span className="px-2 py-0.5 rounded bg-zinc-100 border border-zinc-200/80 font-mono text-[11px] font-medium uppercase text-zinc-700">
                      {ep.provider}
                    </span>
                  </td>

                  <td className="py-3 px-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-zinc-700 truncate max-w-[240px]">
                        {ingestUrl}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyText(ingestUrl, `URL Ingest ${ep.name}`)}
                        className="p-1 text-zinc-400 hover:text-zinc-900 rounded transition-colors cursor-pointer"
                        title="Salin URL Ingest"
                        aria-label={`Salin URL Ingest ${ep.name}`}
                      >
                        {copiedKey === `URL Ingest ${ep.name}` ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </td>

                  <td className="py-3 px-3.5 font-mono text-zinc-700 whitespace-nowrap">
                    {ep.target_url}
                  </td>

                  <td className="py-3 px-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-zinc-700">
                        {ep.secret_key
                          ? isSecretVisible
                            ? ep.secret_key
                            : '••••••••••••••••'
                          : '(tidak diatur)'}
                      </span>
                      {ep.secret_key && (
                        <button
                          type="button"
                          onClick={() => toggleShowSecret(ep.id)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600 hover:text-zinc-950 px-1.5 py-0.5 rounded hover:bg-zinc-100 cursor-pointer"
                          title={isSecretVisible ? 'Sembunyikan secret' : 'Tampilkan secret'}
                          aria-label={
                            isSecretVisible
                              ? `Sembunyikan secret ${ep.name}`
                              : `Tampilkan secret ${ep.name}`
                          }
                        >
                          {isSecretVisible ? (
                            <EyeOff className="w-3 h-3" />
                          ) : (
                            <Eye className="w-3 h-3" />
                          )}
                        </button>
                      )}
                    </div>
                  </td>

                  <td className="py-3 px-3.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onToggleActive(ep)}
                      className={`px-2.5 py-0.5 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                        ep.is_active
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200/80'
                          : 'bg-zinc-100 text-zinc-600 border-zinc-200'
                      }`}
                    >
                      {ep.is_active ? 'Aktif' : 'Nonaktif'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Add Endpoint Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white border border-zinc-200 rounded-xl p-5 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-950 tracking-tight">
                Tambah Endpoint Baru
              </h2>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="size-7 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 cursor-pointer"
                aria-label="Tutup modal tambah endpoint"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {error && (
              <div className="mb-3 p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
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
                  className="w-full h-8 px-3 bg-white rounded-md border border-zinc-200 focus:border-zinc-900 text-zinc-950 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-zinc-700 font-medium mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ProviderType)}
                  className="w-full h-8 px-3 bg-white rounded-md border border-zinc-200 focus:border-zinc-900 text-zinc-950 focus:outline-none"
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
                  className="w-full h-8 px-3 font-mono bg-white rounded-md border border-zinc-200 focus:border-zinc-900 text-zinc-950 focus:outline-none"
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
                  className="w-full h-8 px-3 font-mono bg-white rounded-md border border-zinc-200 focus:border-zinc-900 text-zinc-950 focus:outline-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="h-8 px-3.5 bg-white hover:bg-zinc-50 border border-zinc-200 text-zinc-900 rounded-md font-medium transition-colors cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="h-8 px-4 bg-zinc-900 hover:bg-zinc-800 text-white rounded-md font-medium transition-colors disabled:opacity-50 cursor-pointer"
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
