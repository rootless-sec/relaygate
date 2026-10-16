import React, { useState } from 'react';
import { 
  Network, 
  Plus, 
  Copy, 
  Check, 
  Eye, 
  EyeOff, 
  ExternalLink,
  X
} from 'lucide-react';
import { Endpoint, ProviderType } from '../types';

interface EndpointsViewProps {
  endpoints: Endpoint[];
  onAddEndpoint: (data: { name: string; provider: ProviderType; target_url: string; secret_key?: string }) => Promise<void>;
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
      setError('Nama dan URL target wajib diisi.');
      return;
    }
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      setError('URL target harus diawali dengan http:// atau https://');
      return;
    }

    setError(null);
    setLoading(true);
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
      setProvider('generic');
      setShowAddModal(false);
      onToast('Endpoint baru berhasil didaftarkan');
    } catch (err: any) {
      setError(err?.message || 'Gagal menambahkan endpoint');
    } finally {
      setLoading(false);
    }
  };

  const origin = window.location.origin;

  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col bg-zinc-50">
      {/* Header and Add Button */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Network className="w-5 h-5 text-zinc-900" />
            <h1 className="text-base font-bold text-zinc-900 tracking-tight">Daftar Endpoint Webhook</h1>
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            Arahkan webhook dari penyedia (Stripe, Midtrans, GitHub, Xendit, dll.) ke URL ingest RelayGate. Event akan diverifikasi dan diteruskan ke target URL aplikasi Anda.
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold rounded-lg shadow-2xs transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Tambah Endpoint
        </button>
      </div>

      {/* Endpoints Table */}
      <div className="flex-1 bg-white border border-zinc-200 rounded-lg overflow-auto shadow-2xs">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="sticky top-0 bg-zinc-50 border-b border-zinc-200 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider select-none z-10">
            <tr>
              <th className="py-2.5 px-3">Nama Endpoint</th>
              <th className="py-2.5 px-3">Provider</th>
              <th className="py-2.5 px-3">URL Ingest Publik</th>
              <th className="py-2.5 px-3">Target URL Downstream</th>
              <th className="py-2.5 px-3">Secret Key / Token</th>
              <th className="py-2.5 px-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {endpoints.length > 0 ? (
              endpoints.map((ep) => {
                const ingestUrl = `${origin}/ingest/${ep.id}`;
                const isSecretVisible = visibleSecrets.has(ep.id);

                return (
                  <tr key={ep.id} className="hover:bg-zinc-50 transition-colors">
                    <td className="py-3 px-3 font-semibold text-zinc-900">
                      {ep.name}
                      <span className="block font-mono text-[10px] text-zinc-500 font-normal">{ep.id}</span>
                    </td>

                    <td className="py-3 px-3">
                      <span className="px-2 py-0.5 bg-zinc-100 text-zinc-900 rounded text-[11px] font-mono uppercase font-semibold">
                        {ep.provider}
                      </span>
                    </td>

                    <td className="py-3 px-3 font-mono text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-zinc-900 select-all truncate max-w-[210px]">{ingestUrl}</span>
                        <button
                          onClick={() => copyText(ingestUrl, 'URL Ingest')}
                          title="Salin URL ingest"
                          className="p-1 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors"
                        >
                          {copiedKey === 'URL Ingest' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>

                    <td className="py-3 px-3 font-mono text-[11px] text-zinc-500 max-w-xs truncate">
                      <div className="flex items-center gap-1">
                        <span className="truncate">{ep.target_url}</span>
                        <a
                          href={ep.target_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-zinc-400 hover:text-zinc-900 shrink-0"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </td>

                    <td className="py-3 px-3 font-mono text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-zinc-900 select-all">
                          {isSecretVisible ? ep.secret_key : '••••••••••••••••'}
                        </span>
                        <button
                          onClick={() => toggleShowSecret(ep.id)}
                          title={isSecretVisible ? 'Sembunyikan secret' : 'Lihat secret'}
                          className="p-1 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors"
                        >
                          {isSecretVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={() => copyText(ep.secret_key, 'Secret Key')}
                          title="Salin Secret Key"
                          className="p-1 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 rounded transition-colors"
                        >
                          {copiedKey === 'Secret Key' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>

                    <td className="py-3 px-3 text-center">
                      <button
                        onClick={() => onToggleActive(ep)}
                        title={ep.is_active ? 'Nonaktifkan' : 'Aktifkan'}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                          ep.is_active ? 'bg-zinc-900' : 'bg-zinc-300'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                            ep.is_active ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={6} className="py-16 text-center text-zinc-500">
                  Belum ada endpoint yang terdaftar. Klik tombol Tambah Endpoint untuk memulai.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add Endpoint Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-xs">
          <div className="w-full max-w-md bg-white border border-zinc-200 rounded-xl p-6 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-200 mb-4">
              <div className="flex items-center gap-2">
                <Network className="w-5 h-5 text-zinc-900" />
                <h3 className="text-sm font-bold text-zinc-900">
                  Daftarkan Endpoint Webhook Baru
                </h3>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-zinc-500 hover:text-zinc-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-zinc-900 mb-1">
                  Nama Endpoint
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="mis. payments-api atau stripe-events"
                  className="w-full px-3 py-2 bg-white border border-zinc-200 rounded-lg text-zinc-900 focus:outline-none focus:border-zinc-900"
                  autoFocus
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-900 mb-1">
                  Tipe Provider Webhook
                </label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ProviderType)}
                  className="w-full px-3 py-2 bg-white border border-zinc-200 rounded-lg text-zinc-900 focus:outline-none focus:border-zinc-900"
                >
                  <option value="generic">Generic (Standard HMAC / Raw)</option>
                  <option value="midtrans">Midtrans Payment (SHA512)</option>
                  <option value="stripe">Stripe (v1 Signature Timestamp)</option>
                  <option value="xendit">Xendit (Callback Token)</option>
                  <option value="github">GitHub Webhooks (HMAC-SHA256)</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-zinc-900 mb-1">
                  Target URL Downstream (Aplikasi Internal)
                </label>
                <input
                  type="url"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://api.perusahaan.com/webhook/handler"
                  className="w-full px-3 py-2 bg-white border border-zinc-200 rounded-lg text-zinc-900 font-mono focus:outline-none focus:border-zinc-900"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  RelayGate akan meneruskan request webhook asli ke target URL ini.
                </p>
              </div>

              <div>
                <label className="block font-semibold text-zinc-900 mb-1">
                  {provider === 'xendit' ? 'Callback / Verification Token' : 'Secret Key (HMAC)'} (Opsional)
                </label>
                <input
                  type="text"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder={provider === 'xendit' ? 'Token verifikasi dari dashboard Xendit' : 'whsec_... (kosongkan untuk digenerate otomatis)'}
                  className="w-full px-3 py-2 bg-white border border-zinc-200 rounded-lg text-zinc-900 font-mono focus:outline-none focus:border-zinc-900"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  {provider === 'xendit'
                    ? 'Masukkan verification token dari dashboard Xendit Anda.'
                    : 'Masukkan secret key dari dashboard provider Anda atau kosongkan untuk auto-generate.'}
                </p>
              </div>

              {error && (
                <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 font-medium">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-zinc-200">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-2 font-semibold bg-white hover:bg-zinc-100 border border-zinc-200 text-zinc-900 rounded-lg transition-colors"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 font-semibold bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg transition-colors shadow-xs disabled:opacity-50"
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
