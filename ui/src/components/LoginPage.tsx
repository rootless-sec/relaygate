import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, ArrowRight, ShieldCheck } from 'lucide-react';

interface LoginPageProps {
  onLoginSuccess: (email: string) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('admin@relaygate.local');
  const [password, setPassword] = useState('relaygate123');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Email dan password wajib diisi.');
      return;
    }

    setError(null);
    setLoading(true);

    // Simulate login authentication
    setTimeout(() => {
      setLoading(false);
      if (email.trim() === 'admin@relaygate.local' && password === 'relaygate123') {
        localStorage.setItem('relaygate_auth', JSON.stringify({ email: email.trim(), loggedInAt: Date.now() }));
        onLoginSuccess(email.trim());
      } else {
        setError('Email atau password tidak sesuai.');
      }
    }, 500);
  };

  return (
    <div className="min-h-screen bg-[#fafafa] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white border border-[#e4e4e7] rounded-xl p-8 shadow-sm">
        {/* Header with Logo */}
        <div className="flex flex-col items-center text-center mb-6">
          <img
            src="/logo.png"
            alt="RelayGate"
            className="h-10 mb-4 object-contain"
          />
          <h1 className="text-xl font-bold tracking-tight text-[#18181b]">
            Masuk ke RelayGate
          </h1>
          <p className="text-xs text-[#71717a] mt-1">
            Gunakan akun administrator untuk mengakses control plane webhook.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#18181b] mb-1.5" htmlFor="email-input">
              Alamat Email
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#71717a]" />
              <input
                id="email-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nama@perusahaan.com"
                className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-[#e4e4e7] rounded-lg text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors"
                autoFocus
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-[#18181b]" htmlFor="password-input">
                Password
              </label>
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="text-xs text-[#71717a] hover:text-[#18181b] transition-colors flex items-center gap-1"
              >
                {showPassword ? (
                  <>
                    <EyeOff className="w-3.5 h-3.5" /> Sembunyi
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5" /> Lihat
                  </>
                )}
              </button>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#71717a]" />
              <input
                id="password-input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-9 pr-10 py-2 text-sm bg-white border border-[#e4e4e7] rounded-lg text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors font-mono"
              />
            </div>
          </div>

          {error && (
            <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-600 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 bg-[#18181b] hover:bg-[#27272a] text-white text-sm font-semibold rounded-lg shadow-sm disabled:opacity-60 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#18181b]"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Memeriksa autentikasi...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                Masuk ke Dashboard
                <ArrowRight className="w-4 h-4" />
              </span>
            )}
          </button>
        </form>

        {/* Demo Hint */}
        <div className="mt-6 pt-5 border-t border-[#e4e4e7] text-center">
          <div className="inline-flex items-center gap-1.5 text-xs text-[#71717a] font-medium bg-[#f4f4f5] px-2.5 py-1 rounded-md mb-2">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            Kredensial Bawaan Administrator
          </div>
          <div className="text-xs text-[#71717a] space-y-0.5">
            <div>
              Email: <code className="font-mono text-[#18181b] bg-zinc-100 px-1 py-0.5 rounded">admin@relaygate.local</code>
            </div>
            <div>
              Password: <code className="font-mono text-[#18181b] bg-zinc-100 px-1 py-0.5 rounded">relaygate123</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
