import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, ArrowRight, User } from 'lucide-react';
import { loginUser, registerUser } from '../api';

interface LoginPageProps {
  onLoginSuccess: (email: string) => void;
}

type AuthMode = 'login' | 'register';

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [mode, setMode] = useState<AuthMode>('login');

  // Form states
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (newMode: AuthMode) => {
    setMode(newMode);
    setError(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Email dan password wajib diisi.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await loginUser(email.trim(), password);
      localStorage.setItem(
        'relaygate_auth',
        JSON.stringify({
          email: res.user.email,
          name: res.user.name,
          loggedInAt: Date.now(),
        })
      );
      onLoginSuccess(res.user.email);
    } catch (err: any) {
      setError(err?.message || 'Email atau password tidak sesuai.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Nama lengkap atau username wajib diisi.');
      return;
    }
    if (!email.trim() || !email.includes('@') || !email.includes('.')) {
      setError('Alamat email tidak valid.');
      return;
    }
    if (password.length < 6) {
      setError('Password minimal 6 karakter.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Konfirmasi password tidak cocok.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await registerUser(name.trim(), email.trim(), password);
      localStorage.setItem(
        'relaygate_auth',
        JSON.stringify({
          email: res.user.email,
          name: res.user.name,
          loggedInAt: Date.now(),
        })
      );
      onLoginSuccess(res.user.email);
    } catch (err: any) {
      setError(err?.message || 'Gagal mendaftarkan akun.');
    } finally {
      setLoading(false);
    }
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
          {mode === 'login' ? (
            <>
              <h1 className="text-xl font-bold tracking-tight text-[#18181b]">
                Masuk ke Dashboard
              </h1>
              <p className="text-xs text-[#71717a] mt-1 leading-relaxed">
                Gunakan akun Anda untuk mengakses control panel webhook di RelayGate.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold tracking-tight text-[#18181b]">
                Buat Akun Baru
              </h1>
              <p className="text-xs text-[#71717a] mt-1 leading-relaxed">
                Daftarkan akun Anda untuk mengelola webhook di RelayGate.
              </p>
            </>
          )}
        </div>

        {/* Tab Toggle */}
        <div className="flex p-1 bg-[#f4f4f5] rounded-lg mb-5 border border-[#ebebee]">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
              mode === 'login'
                ? 'bg-white text-[#18181b] shadow-xs'
                : 'text-[#71717a] hover:text-[#18181b]'
            }`}
          >
            Masuk
          </button>
          <button
            type="button"
            onClick={() => switchMode('register')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
              mode === 'register'
                ? 'bg-white text-[#18181b] shadow-xs'
                : 'text-[#71717a] hover:text-[#18181b]'
            }`}
          >
            Daftar
          </button>
        </div>

        {/* Forms */}
        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label
                className="block text-xs font-semibold text-[#18181b] mb-1.5"
                htmlFor="login-email"
              >
                Alamat Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#71717a]" />
                <input
                  id="login-email"
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
                <label
                  className="block text-xs font-semibold text-[#18181b]"
                  htmlFor="login-password"
                >
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
                  id="login-password"
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
                <span>{error}</span>
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
        ) : (
          <form onSubmit={handleRegister} className="space-y-3.5">
            <div>
              <label
                className="block text-xs font-semibold text-[#18181b] mb-1.5"
                htmlFor="register-name"
              >
                Nama Lengkap / Username
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#71717a]" />
                <input
                  id="register-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="cth. John Doe atau johndoe"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-[#e4e4e7] rounded-lg text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors"
                  autoFocus
                />
              </div>
            </div>

            <div>
              <label
                className="block text-xs font-semibold text-[#18181b] mb-1.5"
                htmlFor="register-email"
              >
                Alamat Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#71717a]" />
                <input
                  id="register-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nama@perusahaan.com"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-[#e4e4e7] rounded-lg text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  className="block text-xs font-semibold text-[#18181b]"
                  htmlFor="register-password"
                >
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
                  id="register-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimal 6 karakter"
                  className="w-full pl-9 pr-10 py-2 text-sm bg-white border border-[#e4e4e7] rounded-lg text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors font-mono"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  className="block text-xs font-semibold text-[#18181b]"
                  htmlFor="register-confirm-password"
                >
                  Konfirmasi Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="text-xs text-[#71717a] hover:text-[#18181b] transition-colors flex items-center gap-1"
                >
                  {showConfirmPassword ? (
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
                  id="register-confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Ulangi password"
                  className="w-full pl-9 pr-10 py-2 text-sm bg-white border border-[#e4e4e7] rounded-lg text-[#18181b] placeholder:text-[#a1a1aa] focus:outline-none focus:border-[#18181b] focus:ring-1 focus:ring-[#18181b] transition-colors font-mono"
                />
              </div>
            </div>

            {error && (
              <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-600 shrink-0" />
                <span>{error}</span>
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
                  Mendaftarkan akun...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  Daftar Akun Baru
                  <ArrowRight className="w-4 h-4" />
                </span>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
