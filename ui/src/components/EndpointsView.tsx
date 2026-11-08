import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Copy,
  Check,
  Eye,
  EyeOff,
  X,
  Webhook,
  ChevronDown,
  Loader2,
  AlertCircle,
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

  const openAddModalBtnRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const handleOpenModal = () => {
    setError(null);
    setShowAddModal(true);
  };

  const handleCloseModal = () => {
    setShowAddModal(false);
    setError(null);
    setTimeout(() => {
      openAddModalBtnRef.current?.focus();
    }, 40);
  };

  useEffect(() => {
    if (showAddModal) {
      setTimeout(() => {
        const nameInput = document.getElementById('endpoint-name') as HTMLInputElement | null;
        if (nameInput) {
          nameInput.focus();
        } else {
          modalRef.current?.focus();
        }
      }, 50);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleCloseModal();
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [showAddModal]);

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
    const trimmedName = name.trim();
    const trimmedUrl = targetUrl.trim();

    if (!trimmedName || !trimmedUrl) {
      setError('Nama dan Target URL wajib diisi.');
      return;
    }

    try {
      const parsed = new URL(trimmedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('Target URL harus menggunakan protokol http:// atau https://');
        return;
      }
    } catch {
      setError('Format Target URL tidak valid. Gunakan URL lengkap (cth: https://api.internal.id/webhooks)');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onAddEndpoint({
        name: trimmedName,
        provider,
        target_url: trimmedUrl,
        secret_key: secretKey.trim() || undefined,
      });
      setName('');
      setTargetUrl('');
      setSecretKey('');
      setShowAddModal(false);
      onToast('Endpoint berhasil ditambahkan');
      setTimeout(() => {
        openAddModalBtnRef.current?.focus();
      }, 40);
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
          ref={openAddModalBtnRef}
          type="button"
          onClick={handleOpenModal}
          className="flex items-center gap-1.5 h-8 px-3 bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] text-white rounded-md text-xs font-medium shadow-2xs transition-all cursor-pointer"
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
            {endpoints.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 px-4 text-center">
                  <div className="flex flex-col items-center justify-center space-y-2">
                    <div className="size-9 rounded-full bg-zinc-100 border border-zinc-200/80 flex items-center justify-center text-zinc-400">
                      <Webhook className="w-4 h-4" />
                    </div>
                    <p className="text-xs font-medium text-zinc-900">Belum ada endpoint terdaftar</p>
                    <p className="text-xs text-zinc-500 max-w-sm">
                      Klik tombol "Tambah Endpoint" di atas untuk mendaftarkan rute webhook downstream baru.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              endpoints.map((ep) => {
                const origin = typeof window !== 'undefined' ? window.location.origin : '';
                const ingestUrl = `${origin}/ingest/${ep.id}`;
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
                        <div className="flex items-center gap-1">
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
                          <button
                            type="button"
                            onClick={() => copyText(ep.secret_key!, `Secret Key ${ep.name}`)}
                            className="p-1 text-zinc-400 hover:text-zinc-900 rounded transition-colors cursor-pointer"
                            title="Salin Secret Key"
                            aria-label={`Salin Secret Key ${ep.name}`}
                          >
                            {copiedKey === `Secret Key ${ep.name}` ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
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
            }))}
          </tbody>
        </table>
      </div>

      {/* Add Endpoint Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-zinc-950/20 backdrop-blur-sm overflow-y-auto animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              handleCloseModal();
            }
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-endpoint-modal-title"
        >
          <div
            ref={modalRef}
            tabIndex={-1}
            className="w-full max-w-md max-h-[calc(100dvh-2rem)] flex flex-col bg-white border border-zinc-200/90 rounded-xl shadow-xl shadow-zinc-950/5 animate-in zoom-in-95 duration-150 outline-none my-auto"
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between p-5 sm:p-6 pb-0">
              <div>
                <h2 id="add-endpoint-modal-title" className="text-sm font-semibold text-zinc-950 tracking-tight">
                  Tambah Endpoint Baru
                </h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Konfigurasikan rute downstream dan secret verifikasi signature.
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
                className="size-7 -mr-1 -mt-1 rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 active:scale-[0.98] transition-all cursor-pointer"
                aria-label="Tutup modal tambah endpoint"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Form Scrollable Area */}
            <div className="p-5 sm:p-6 pt-4 overflow-y-auto">
              {error && (
                <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200/80 text-xs text-rose-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleCreate} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="endpoint-name" className="block text-xs font-medium text-zinc-700">
                    Nama Endpoint
                  </label>
                  <input
                    id="endpoint-name"
                    type="text"
                    required
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="orders-service"
                    className="w-full h-10 px-3 text-sm bg-white rounded-lg border border-zinc-200/90 text-zinc-950 placeholder:text-zinc-400 placeholder:font-normal focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 focus:outline-none transition-colors shadow-2xs"
                  />
                  <p className="text-[11px] text-zinc-500">
                    Identifier unik untuk menandai rute layanan tujuan.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="endpoint-provider" className="block text-xs font-medium text-zinc-700">
                    Provider
                  </label>
                  <div className="relative">
                    <select
                      id="endpoint-provider"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value as ProviderType)}
                      className="w-full h-10 py-2 pl-3 pr-9 text-sm bg-white rounded-lg border border-zinc-200/90 text-zinc-900 appearance-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 focus:outline-none cursor-pointer transition-colors shadow-2xs"
                    >
                      <option value="generic">Generic (HMAC-SHA256)</option>
                      <option value="stripe">Stripe</option>
                      <option value="shopify">Shopify</option>
                      <option value="xendit">Xendit</option>
                      <option value="midtrans">Midtrans</option>
                      <option value="github">GitHub</option>
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    Format verifikasi signature webhook yang diharapkan.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="endpoint-target-url" className="block text-xs font-medium text-zinc-700">
                    Target URL Downstream
                  </label>
                  <input
                    id="endpoint-target-url"
                    type="url"
                    required
                    value={targetUrl}
                    onChange={(e) => {
                      setTargetUrl(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="https://api.internal.id/webhooks"
                    className="w-full h-10 px-3 text-sm bg-white rounded-lg border border-zinc-200/90 text-zinc-950 placeholder:text-zinc-400 placeholder:font-normal focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 focus:outline-none transition-colors shadow-2xs"
                  />
                  <p className="text-[11px] text-zinc-500">
                    URL tujuan backend internal yang akan menerima webhook via HTTP POST.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="endpoint-secret-key" className="block text-xs font-medium text-zinc-700">
                    Secret Key / Callback Token <span className="text-zinc-400 font-normal">(Opsional)</span>
                  </label>
                  <input
                    id="endpoint-secret-key"
                    type="text"
                    value={secretKey}
                    onChange={(e) => {
                      setSecretKey(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder="whsec_..."
                    className="w-full h-10 px-3 text-sm bg-white rounded-lg border border-zinc-200/90 text-zinc-950 placeholder:text-zinc-400 placeholder:font-normal focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 focus:outline-none transition-colors shadow-2xs"
                  />
                  <p className="text-[11px] text-zinc-500">
                    Kunci rahasia untuk memverifikasi HMAC signature payload webhook.
                  </p>
                </div>

                <div className="pt-3 flex items-center justify-end gap-2.5 border-t border-zinc-100">
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    className="h-9 px-4 bg-white hover:bg-zinc-50 active:scale-[0.98] border border-zinc-200/90 text-zinc-700 hover:text-zinc-950 rounded-lg text-xs font-medium shadow-2xs transition-all cursor-pointer"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="h-9 px-4 bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] text-white rounded-lg text-xs font-medium shadow-2xs transition-all disabled:opacity-50 disabled:pointer-events-none cursor-pointer flex items-center gap-1.5"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Menyimpan...</span>
                      </>
                    ) : (
                      <span>Simpan Endpoint</span>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
