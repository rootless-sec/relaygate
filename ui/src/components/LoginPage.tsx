import React, { useState, useEffect, useRef } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  Mail,
  User,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ArrowLeft,
  RefreshCw,
  Shield,
  Terminal,
} from 'lucide-react';
import {
  loginUser,
  registerUser,
  verifyRegistrationCode,
  resendVerificationCode,
} from '../api';

interface LoginPageProps {
  onLoginSuccess: (email: string) => void;
  initialError?: string | null;
}

type AuthMode = 'login' | 'register' | 'verify';

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  initialError,
}) => {
  const [mode, setMode] = useState<AuthMode>('login');

  // Form states
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // OTP verification states
  const [otp, setOtp] = useState<string[]>(['', '', '', '', '', '']);
  const [countdown, setCountdown] = useState<number>(60);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resending, setResending] = useState<boolean>(false);
  const otpInputs = useRef<(HTMLInputElement | null)[]>([]);

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError || null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialError) {
      setError(initialError);
    }
  }, [initialError]);

  // Countdown timer for resend OTP
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    if (mode === 'verify' && countdown > 0) {
      timer = setInterval(() => {
        setCountdown((prev) => prev - 1);
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [mode, countdown]);

  const switchMode = (newMode: AuthMode) => {
    setMode(newMode);
    setError(null);
    setInfoMessage(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Email dan password wajib diisi.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await loginUser(email.trim(), password);
      const resolvedEmail = res.user?.email || email.trim();
      localStorage.setItem(
        'relaygate_auth',
        JSON.stringify({
          email: resolvedEmail,
          name: res.user?.name || 'Operator',
          token: res.token,
        })
      );
      onLoginSuccess(resolvedEmail);
    } catch (err: any) {
      const msg = err?.message || 'Gagal masuk. Periksa kembali kredensial Anda.';
      if (msg.toLowerCase().includes('belum diverifikasi')) {
        setInfoMessage('Akun belum diverifikasi. Masukkan 6 digit kode OTP Anda.');
        setMode('verify');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Password minimal 8 karakter.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Konfirmasi password tidak cocok.');
      return;
    }

    setLoading(true);
    try {
      const res = await registerUser(
        name.trim() || email.split('@')[0],
        email.trim(),
        password
      );
      if (res.dev_code) {
        setDevCode(res.dev_code);
      }
      setInfoMessage(res.message || 'Kode verifikasi 6 digit telah dikirim.');
      setOtp(['', '', '', '', '', '']);
      setCountdown(60);
      setMode('verify');
      setTimeout(() => otpInputs.current[0]?.focus(), 50);
    } catch (err: any) {
      setError(err?.message || 'Gagal mendaftarkan akun.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otp.join('').trim();
    if (code.length !== 6) {
      setError('Masukkan 6 digit kode verifikasi secara lengkap.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await verifyRegistrationCode(email.trim(), code);
      const resolvedEmail = res.user?.email || email.trim();
      localStorage.setItem(
        'relaygate_auth',
        JSON.stringify({
          email: resolvedEmail,
          name: res.user?.name || name.trim() || 'Operator',
          token: res.token,
        })
      );
      onLoginSuccess(resolvedEmail);
    } catch (err: any) {
      setError(err?.message || 'Kode verifikasi tidak valid.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || resending) return;
    setResending(true);
    setError(null);
    try {
      const res = await resendVerificationCode(email.trim());
      if (res.dev_code) {
        setDevCode(res.dev_code);
      }
      setInfoMessage(res.message || 'Kode verifikasi baru telah dikirim.');
      setOtp(['', '', '', '', '', '']);
      setCountdown(60);
      otpInputs.current[0]?.focus();
    } catch (err: any) {
      setError(err?.message || 'Gagal mengirim ulang kode verifikasi.');
    } finally {
      setResending(false);
    }
  };

  const handleOtpChange = (index: number, val: string) => {
    const cleaned = val.replace(/\D/g, '');
    if (!cleaned) {
      const next = [...otp];
      next[index] = '';
      setOtp(next);
      return;
    }

    if (cleaned.length > 1) {
      const chars = cleaned.slice(0, 6).split('');
      const next = [...otp];
      chars.forEach((c, i) => {
        if (index + i < 6) next[index + i] = c;
      });
      setOtp(next);
      otpInputs.current[Math.min(index + chars.length, 5)]?.focus();
      return;
    }

    const next = [...otp];
    next[index] = cleaned;
    setOtp(next);
    if (index < 5) {
      otpInputs.current[index + 1]?.focus();
    }
  };

  return (
    <div className="min-h-screen w-screen bg-gradient-to-b from-sky-200/50 via-sky-50/40 to-zinc-100 flex flex-col justify-between p-4 sm:p-6 select-none">
      {/* Top Aside Header Bar */}
      <header className="w-full max-w-5xl mx-auto flex items-center justify-between py-2">
        <div className="flex items-center gap-2.5">
          <img
            src="/logo.png"
            alt="RelayGate Logo"
            className="w-7 h-7 object-contain rounded-lg shadow-2xs ring-1 ring-zinc-950/[0.08] bg-white p-0.5"
          />
          <span className="text-sm font-semibold tracking-tight text-zinc-950">
            RelayGate
          </span>
        </div>

        <span className="px-2.5 py-1 rounded-full bg-white/80 ring-1 ring-zinc-950/[0.08] shadow-2xs text-[11px] font-medium text-zinc-600">
          Webhook Control Plane
        </span>
      </header>

      {/* Center Aside Window Showcase Card */}
      <div className="w-full max-w-md mx-auto my-auto py-6">
        <div className="text-center mb-5">
          <h1 className="text-2xl font-medium text-zinc-950 tracking-tight text-balance">
            {mode === 'login' && 'Masuk ke Dashboard'}
            {mode === 'register' && 'Buat Akun Baru'}
            {mode === 'verify' && 'Verifikasi Email Anda'}
          </h1>
          <p className="text-xs text-zinc-600 mt-1.5 leading-relaxed">
            {mode === 'login' &&
              'Kelola rute webhook, verifikasi signature, dan antrean DLQ'}
            {mode === 'register' &&
              'Daftarkan email untuk mengakses control plane webhook'}
            {mode === 'verify' &&
              `Masukkan 6 digit kode OTP yang dikirim ke ${email}`}
          </p>
        </div>

        {/* Aside Elevated Browser Window Frame */}
        <div className="bg-white/95 backdrop-blur-md rounded-2xl shadow-xl ring-1 ring-zinc-950/[0.08] overflow-hidden">
          <div className="h-9 px-3.5 bg-zinc-50/90 border-b border-zinc-200/70 flex items-center justify-between">
            <div className="flex items-center gap-1.5" aria-hidden="true">
              <span className="size-2.5 rounded-full bg-zinc-300/90 ring-1 ring-zinc-950/[0.08]" />
              <span className="size-2.5 rounded-full bg-zinc-300/90 ring-1 ring-zinc-950/[0.08]" />
              <span className="size-2.5 rounded-full bg-zinc-300/90 ring-1 ring-zinc-950/[0.08]" />
            </div>

            <div className="h-5 px-2.5 rounded-md bg-zinc-200/50 ring-1 ring-inset ring-zinc-950/[0.05] flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
              <Shield className="w-2.5 h-2.5 text-zinc-400" />
              <span>relaygate.internal/auth/{mode}</span>
            </div>

            <div className="w-10" />
          </div>

          <div className="p-6">
            {mode !== 'verify' && (
              <div className="grid grid-cols-2 p-1 bg-zinc-900/[0.05] rounded-xl mb-5 ring-1 ring-inset ring-zinc-950/[0.04]">
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className={`py-1.5 text-xs font-medium rounded-lg transition-all duration-150 cursor-pointer ${
                    mode === 'login'
                      ? 'bg-white text-zinc-950 shadow-xs ring-1 ring-zinc-950/[0.08]'
                      : 'text-zinc-600 hover:text-zinc-950'
                  }`}
                >
                  Masuk
                </button>
                <button
                  type="button"
                  onClick={() => switchMode('register')}
                  className={`py-1.5 text-xs font-medium rounded-lg transition-all duration-150 cursor-pointer ${
                    mode === 'register'
                      ? 'bg-white text-zinc-950 shadow-xs ring-1 ring-zinc-950/[0.08]'
                      : 'text-zinc-600 hover:text-zinc-950'
                  }`}
                >
                  Daftar Akun
                </button>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mb-4 p-3 rounded-xl bg-rose-50 ring-1 ring-rose-200 text-xs text-rose-800 flex items-start gap-2"
              >
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{error}</span>
              </div>
            )}

            {infoMessage && (
              <div
                role="status"
                className="mb-4 p-3 rounded-xl bg-emerald-50 ring-1 ring-emerald-200 text-xs text-emerald-900 flex items-start gap-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{infoMessage}</span>
              </div>
            )}

            {mode === 'verify' && devCode && (
              <div className="mb-4 p-3 rounded-xl bg-zinc-50 ring-1 ring-zinc-200/80 text-xs text-zinc-700 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-900 flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-zinc-500" />
                    Preview Kode OTP Lokal
                  </span>
                  <button
                    type="button"
                    onClick={() => setOtp(devCode.slice(0, 6).split(''))}
                    className="text-[11px] font-semibold text-zinc-900 underline cursor-pointer"
                  >
                    Isi Otomatis
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500">
                  Kode OTP:{' '}
                  <code className="font-mono font-bold text-zinc-950 bg-white px-1.5 py-0.5 rounded border border-zinc-200 tabular-nums">
                    {devCode}
                  </code>
                </p>
              </div>
            )}

            {mode === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1.5">
                    Email
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="nama@perusahaan.com"
                      className="w-full h-9 pl-9 pr-3 text-xs bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 placeholder:text-zinc-400 focus:outline-none transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Masukkan password"
                      className="w-full h-9 pl-9 pr-9 text-xs bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 placeholder:text-zinc-400 focus:outline-none transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-700 rounded cursor-pointer"
                      aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                    >
                      {showPassword ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-9 bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium rounded-full shadow-xs active:scale-[0.98] transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer mt-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Memverifikasi...</span>
                    </>
                  ) : (
                    <span>Masuk</span>
                  )}
                </button>
              </form>
            )}

            {mode === 'register' && (
              <form onSubmit={handleRegister} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">
                    Nama Lengkap
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Nama Operator"
                      className="w-full h-9 pl-9 pr-3 text-xs bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 placeholder:text-zinc-400 focus:outline-none transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">
                    Email
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="nama@perusahaan.com"
                      className="w-full h-9 pl-9 pr-3 text-xs bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 placeholder:text-zinc-400 focus:outline-none transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimal 8 karakter"
                      className="w-full h-9 pl-9 pr-9 text-xs bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 placeholder:text-zinc-400 focus:outline-none transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-700 rounded cursor-pointer"
                      aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                    >
                      {showPassword ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-1">
                    Konfirmasi Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Ulangi password"
                      className="w-full h-9 pl-9 pr-9 text-xs bg-zinc-50/70 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 placeholder:text-zinc-400 focus:outline-none transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((prev) => !prev)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-700 rounded cursor-pointer"
                      aria-label={
                        showConfirmPassword
                          ? 'Sembunyikan konfirmasi password'
                          : 'Tampilkan konfirmasi password'
                      }
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-9 bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium rounded-full shadow-xs active:scale-[0.98] transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer mt-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Mendaftarkan...</span>
                    </>
                  ) : (
                    <span>Daftar & Kirim Kode Verifikasi</span>
                  )}
                </button>
              </form>
            )}

            {mode === 'verify' && (
              <form onSubmit={handleVerify} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 mb-2 text-center">
                    Kode Verifikasi 6 Digit
                  </label>
                  <div className="flex items-center justify-between gap-2">
                    {otp.map((digit, index) => (
                      <input
                        key={index}
                        ref={(el) => {
                          otpInputs.current[index] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={digit}
                        onChange={(e) => handleOtpChange(index, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Backspace' && !otp[index] && index > 0) {
                            otpInputs.current[index - 1]?.focus();
                          }
                        }}
                        aria-label={`Digit ke-${index + 1}`}
                        className="w-11 h-11 text-center text-sm font-mono font-bold bg-zinc-50 focus:bg-white rounded-xl ring-1 ring-zinc-950/[0.08] focus:ring-2 focus:ring-zinc-950 text-zinc-950 focus:outline-none tabular-nums"
                      />
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || otp.join('').length !== 6}
                  className="w-full h-9 bg-zinc-950 hover:bg-zinc-800 text-white text-xs font-medium rounded-full shadow-xs active:scale-[0.98] transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Memverifikasi...</span>
                    </>
                  ) : (
                    <span>Verifikasi & Masuk</span>
                  )}
                </button>

                <div className="flex items-center justify-between pt-2 border-t border-zinc-100 text-xs">
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="inline-flex items-center gap-1 text-zinc-500 hover:text-zinc-900 font-medium cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Kembali</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={countdown > 0 || resending}
                    className="inline-flex items-center gap-1 font-medium text-zinc-900 hover:text-zinc-700 disabled:text-zinc-400 cursor-pointer tabular-nums"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>
                      {countdown > 0 ? `Kirim ulang (${countdown}d)` : 'Kirim Ulang Kode'}
                    </span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>

      <footer className="w-full max-w-5xl mx-auto text-center py-2 text-[11px] text-zinc-500">
        RelayGate · Self-Hosted Webhook Ingestion & Replay Engine
      </footer>
    </div>
  );
};
