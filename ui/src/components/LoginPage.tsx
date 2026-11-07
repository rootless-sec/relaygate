import React, { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Lock, Mail, ArrowRight, User, AlertCircle } from 'lucide-react';
import { loginUser, registerUser, verifyRegistrationCode, resendVerificationCode } from '../api';

interface LoginPageProps {
  onLoginSuccess: (email: string) => void;
  initialError?: string | null;
}

type AuthMode = 'login' | 'register' | 'verify';

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess, initialError }) => {
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
          token: res.token,
          email: res.user.email,
          name: res.user.name,
          role: res.user.role,
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
      setDevCode(res.dev_code || null);
      setOtp(['', '', '', '', '', '']);
      setCountdown(60);
      setMode('verify');
      setTimeout(() => {
        otpInputs.current[0]?.focus();
      }, 50);
    } catch (err: any) {
      setError(err?.message || 'Gagal mendaftarkan akun.');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, val: string) => {
    const cleaned = val.replace(/\D/g, '');
    if (!cleaned) {
      const newOtp = [...otp];
      newOtp[index] = '';
      setOtp(newOtp);
      return;
    }

    const char = cleaned.slice(-1);
    const newOtp = [...otp];
    newOtp[index] = char;
    setOtp(newOtp);

    if (index < 5 && char) {
      otpInputs.current[index + 1]?.focus();
      otpInputs.current[index + 1]?.select();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!otp[index] && index > 0) {
        e.preventDefault();
        const prevIndex = index - 1;
        const newOtp = [...otp];
        newOtp[prevIndex] = '';
        setOtp(newOtp);
        otpInputs.current[prevIndex]?.focus();
        otpInputs.current[prevIndex]?.select();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      otpInputs.current[index - 1]?.focus();
      otpInputs.current[index - 1]?.select();
    } else if (e.key === 'ArrowRight' && index < 5) {
      e.preventDefault();
      otpInputs.current[index + 1]?.focus();
      otpInputs.current[index + 1]?.select();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasteData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasteData) return;

    const newOtp = [...otp];
    for (let i = 0; i < 6; i++) {
      newOtp[i] = i < pasteData.length ? pasteData[i] : '';
    }
    setOtp(newOtp);

    const nextIdx = Math.min(pasteData.length, 5);
    otpInputs.current[nextIdx]?.focus();
    otpInputs.current[nextIdx]?.select();
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otp.join('');
    if (code.length < 6) {
      setError('Masukkan 6-digit kode verifikasi lengkap.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const res = await verifyRegistrationCode(email.trim(), code);
      localStorage.setItem(
        'relaygate_auth',
        JSON.stringify({
          token: res.token,
          email: res.user.email,
          name: res.user.name,
          role: res.user.role,
          loggedInAt: Date.now(),
        })
      );
      onLoginSuccess(res.user.email);
    } catch (err: any) {
      setError(err?.message || 'Kode verifikasi tidak valid atau telah kedaluwarsa.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || resending) return;

    setError(null);
    setResending(true);
    try {
      const res = await resendVerificationCode(email.trim());
      setCountdown(60);
      if (res.dev_code) {
        setDevCode(res.dev_code);
      }
      setOtp(['', '', '', '', '', '']);
      otpInputs.current[0]?.focus();
    } catch (err: any) {
      setError(err?.message || 'Gagal mengirim ulang kode verifikasi.');
    } finally {
      setResending(false);
    }
  };

  const handleChangeEmail = () => {
    setMode('register');
    setError(null);
    setDevCode(null);
    setOtp(['', '', '', '', '', '']);
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white border border-zinc-200 rounded-xl p-8 shadow-sm">
        {/* Header with Logo */}
        <div className="flex flex-col items-center text-center mb-6">
          <img
            src="/logo.png"
            alt="RelayGate"
            className="h-10 mb-4 object-contain"
          />
          {mode === 'login' ? (
            <>
              <h1 className="text-xl font-bold tracking-tight text-zinc-900">
                Masuk ke Dashboard
              </h1>
              <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                Gunakan akun Anda untuk mengakses control panel webhook di RelayGate.
              </p>
            </>
          ) : mode === 'register' ? (
            <>
              <h1 className="text-xl font-bold tracking-tight text-zinc-900">
                Buat Akun Baru
              </h1>
              <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                Daftarkan akun Anda untuk mengelola webhook di RelayGate.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold tracking-tight text-zinc-900">
                Verifikasi Alamat Email
              </h1>
              <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                Masukkan 6-digit kode verifikasi yang dikirimkan ke email Anda.
              </p>
              <p className="text-xs font-semibold text-zinc-900 mt-0.5">
                {email}
              </p>
            </>
          )}
        </div>

        {/* Tab Toggle (only visible in login or register mode) */}
        {mode !== 'verify' && (
          <div className="flex p-1 bg-zinc-100 rounded-lg mb-5 border border-zinc-200">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
                mode === 'login'
                  ? 'bg-white text-zinc-900 shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Masuk
            </button>
            <button
              type="button"
              onClick={() => switchMode('register')}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
                mode === 'register'
                  ? 'bg-white text-zinc-900 shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Daftar
            </button>
          </div>
        )}

        {/* Forms */}
        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label
                className="block text-xs font-semibold text-zinc-900 mb-1.5"
                htmlFor="login-email"
              >
                Alamat Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nama@perusahaan.com"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                  autoFocus
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  className="block text-xs font-semibold text-zinc-900"
                  htmlFor="login-password"
                >
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-xs text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-1"
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
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-10 py-2 text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
                />
              </div>
            </div>

            {error && (
              <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-semibold rounded-lg shadow-sm disabled:opacity-60 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900"
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
        ) : mode === 'register' ? (
          <form onSubmit={handleRegister} className="space-y-3.5">
            <div>
              <label
                className="block text-xs font-semibold text-zinc-900 mb-1.5"
                htmlFor="register-name"
              >
                Nama Lengkap / Username
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="register-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="cth. John Doe atau johndoe"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                  autoFocus
                />
              </div>
            </div>

            <div>
              <label
                className="block text-xs font-semibold text-zinc-900 mb-1.5"
                htmlFor="register-email"
              >
                Alamat Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="register-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nama@perusahaan.com"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  className="block text-xs font-semibold text-zinc-900"
                  htmlFor="register-password"
                >
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-xs text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-1"
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
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="register-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimal 6 karakter"
                  className="w-full pl-9 pr-10 py-2 text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  className="block text-xs font-semibold text-zinc-900"
                  htmlFor="register-confirm-password"
                >
                  Konfirmasi Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="text-xs text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-1"
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
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="register-confirm-password"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Ulangi password"
                  className="w-full pl-9 pr-10 py-2 text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
                />
              </div>
            </div>

            {error && (
              <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-semibold rounded-lg shadow-sm disabled:opacity-60 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Mengirimkan kode verifikasi...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  Daftar Akun Baru
                  <ArrowRight className="w-4 h-4" />
                </span>
              )}
            </button>
          </form>
        ) : (
          /* OTP Verification View */
          <form onSubmit={handleVerify}>
            {/* Dev Mock Helper (Shown only when backend operates without SMTP configuration) */}
            {devCode && (
              <div className="mb-4 p-3 rounded-lg bg-zinc-100 border border-zinc-200 text-xs text-zinc-900">
                <div className="text-[11px] font-medium text-zinc-500 mb-1">
                  Mode Dev / Lokal (SMTP belum disetel):
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-bold tracking-widest text-zinc-900">
                    {devCode}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const digits = devCode.split('').slice(0, 6);
                      const newOtp = ['', '', '', '', '', ''];
                      for (let i = 0; i < 6; i++) {
                        newOtp[i] = digits[i] || '';
                      }
                      setOtp(newOtp);
                      otpInputs.current[5]?.focus();
                      otpInputs.current[5]?.select();
                    }}
                    className="text-xs text-zinc-900 font-medium underline hover:text-zinc-700"
                  >
                    Isi Otomatis
                  </button>
                </div>
              </div>
            )}

            {/* 6-Digit Code Input Boxes */}
            <div
              className="flex items-center justify-between gap-1.5 mb-5"
              onPaste={handleOtpPaste}
            >
              {otp.map((digit, idx) => (
                <input
                  key={idx}
                  ref={(el) => (otpInputs.current[idx] = el)}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={2}
                  value={digit}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => handleOtpChange(idx, e.target.value)}
                  onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                  onPaste={handleOtpPaste}
                  className="w-11 h-12 text-center text-lg font-mono font-semibold bg-white border border-zinc-200 rounded-lg text-zinc-900 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                />
              ))}
            </div>

            {error && (
              <div className="mb-4 p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-semibold rounded-lg shadow-sm disabled:opacity-60 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Memverifikasi kode...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  Verifikasi & Masuk ke Dashboard
                  <ArrowRight className="w-4 h-4" />
                </span>
              )}
            </button>

            {/* Resend and Navigation links */}
            <div className="mt-4 pt-4 border-t border-zinc-200 flex flex-col items-center gap-2.5 text-xs text-zinc-500">
              <div className="flex items-center gap-1.5">
                <span>Belum menerima kode?</span>
                {countdown > 0 ? (
                  <span className="text-zinc-400 font-medium">
                    Kirim ulang dalam {countdown}s
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resending}
                    className="font-semibold text-zinc-900 hover:underline disabled:opacity-50"
                  >
                    {resending ? 'Mengirim...' : 'Kirim Ulang Kode'}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={handleChangeEmail}
                className="text-xs text-zinc-500 hover:text-zinc-900 transition-colors"
              >
                Ubah Alamat Email
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
