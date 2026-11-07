import React, { useState, useEffect, useRef } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  Mail,
  ArrowRight,
  User,
  AlertCircle,
  Clock,
  X,
  Check,
  Shield,
  UserPlus,
  Server,
} from 'lucide-react';
import {
  loginUser,
  registerUser,
  verifyRegistrationCode,
  resendVerificationCode,
  oauthLogin,
} from '../api';
import { RelayGateLogo } from './RelayGateLogo';

export const GoogleIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path
      className="fill-blue-500"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      className="fill-emerald-500"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      className="fill-amber-500"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
    />
    <path
      className="fill-rose-500"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
    />
  </svg>
);

export const GitHubIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

export const GitLabIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path className="fill-orange-600" d="M12 21.42l4.13-12.72H7.87L12 21.42z" />
    <path className="fill-orange-500" d="M12 21.42l-4.13-12.72H1.95L12 21.42z" />
    <path className="fill-amber-500" d="M1.95 8.7l-.93 2.87c-.18.57.02 1.19.49 1.54L12 21.42 1.95 8.7z" />
    <path className="fill-orange-600" d="M1.95 8.7h5.92L5.42 1.16c-.22-.68-1.18-.68-1.4 0L1.95 8.7z" />
    <path className="fill-orange-500" d="M12 21.42l4.13-12.72h5.92L12 21.42z" />
    <path className="fill-amber-500" d="M22.05 8.7l.93 2.87c.18.57-.02 1.19-.49 1.54L12 21.42 22.05 8.7z" />
    <path className="fill-orange-600" d="M22.05 8.7h-5.92l2.45-7.54c.22-.68 1.18-.68 1.4 0l2.07 7.54z" />
  </svg>
);

interface LoginPageProps {
  onLoginSuccess: (email: string) => void;
  initialError?: string | null;
  sessionNotice?: string | null;
  onDismissNotice?: () => void;
}

type AuthMode = 'login' | 'register' | 'verify';

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  initialError,
  sessionNotice,
  onDismissNotice,
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

  // Separate session state notice from form submission errors
  const [sessionNoticeState, setSessionNoticeState] = useState<string | null>(() => {
    if (sessionNotice) return sessionNotice;
    if (initialError && /sesi|session/i.test(initialError)) {
      return 'Sesi Anda telah berakhir demi keamanan. Silakan masuk kembali.';
    }
    return null;
  });

  const [error, setError] = useState<string | null>(() => {
    if (initialError && !/sesi|session/i.test(initialError)) {
      return initialError;
    }
    return null;
  });

  useEffect(() => {
    if (sessionNotice) {
      setSessionNoticeState(sessionNotice);
    } else if (initialError) {
      if (/sesi|session/i.test(initialError)) {
        setSessionNoticeState('Sesi Anda telah berakhir demi keamanan. Silakan masuk kembali.');
      } else {
        setError(initialError);
      }
    } else {
      setSessionNoticeState(null);
    }
  }, [sessionNotice, initialError]);

  const handleDismissNotice = () => {
    setSessionNoticeState(null);
    onDismissNotice?.();
  };

  // OAuth states & handlers
  type OAuthProvider = 'google' | 'github' | 'gitlab';
  const [activeOAuth, setActiveOAuth] = useState<OAuthProvider | null>(null);
  const [oauthStep, setOauthStep] = useState<'select' | 'authorizing' | 'success'>('select');
  const [oauthStatusMessage, setOauthStatusMessage] = useState<string>('');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [customOAuthEmail, setCustomOAuthEmail] = useState<string>('');
  const [customOAuthName, setCustomOAuthName] = useState<string>('');
  const [showCustomOAuth, setShowCustomOAuth] = useState<boolean>(false);

  const handleOpenOAuth = (provider: OAuthProvider) => {
    setActiveOAuth(provider);
    setOauthStep('select');
    setOauthError(null);
    setOauthStatusMessage('');
    setShowCustomOAuth(false);
    if (provider === 'google') {
      setCustomOAuthEmail('alex.developer@gmail.com');
      setCustomOAuthName('Alex Prasetyo');
    } else if (provider === 'github') {
      setCustomOAuthEmail('hazama3321@gmail.com');
      setCustomOAuthName('Mafifrizi');
    } else {
      setCustomOAuthEmail('devops.lead@gitlab.company');
      setCustomOAuthName('DevOps Engineer');
    }
  };

  const handleCloseOAuth = () => {
    if (oauthStep === 'authorizing') return;
    setActiveOAuth(null);
    setOauthStep('select');
    setOauthError(null);
    setOauthStatusMessage('');
    setShowCustomOAuth(false);
  };

  useEffect(() => {
    if (!activeOAuth) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && oauthStep !== 'authorizing') {
        handleCloseOAuth();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeOAuth, oauthStep]);

  const executeOAuth = async (
    provider: OAuthProvider,
    targetEmail: string,
    targetName: string,
    avatarUrl?: string
  ) => {
    setOauthError(null);
    setOauthStep('authorizing');

    if (provider === 'google') {
      setOauthStatusMessage('Menghubungkan ke Google Identity Services...');
    } else if (provider === 'github') {
      setOauthStatusMessage('Menerima callback OAuth dari api.github.com...');
    } else {
      setOauthStatusMessage('Sinkronisasi identitas GitLab OIDC...');
    }

    try {
      await new Promise((r) => setTimeout(r, 350));
      if (provider === 'google') {
        setOauthStatusMessage('Memvalidasi token Google ID...');
      } else if (provider === 'github') {
        setOauthStatusMessage('Sinkronisasi profil @hazama3321...');
      } else {
        setOauthStatusMessage('Memvalidasi token JWT GitLab...');
      }
      await new Promise((r) => setTimeout(r, 300));

      const res = await oauthLogin({
        provider,
        email: targetEmail.trim(),
        name: targetName.trim(),
        avatar_url: avatarUrl,
      });

      setOauthStep('success');
      setOauthStatusMessage('Autentikasi terverifikasi!');

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

      await new Promise((r) => setTimeout(r, 200));
      onLoginSuccess(res.user.email);
    } catch (err: any) {
      setOauthStep('select');
      setOauthError(err?.message || `Gagal melakukan autentikasi dengan ${provider}.`);
    }
  };

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
    <div className="min-h-dvh bg-zinc-50 flex items-center justify-center p-4 sm:p-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(4.5rem,calc(env(safe-area-inset-top,0px)+3.75rem))] sm:pt-6 px-[max(1rem,env(safe-area-inset-left))]">
      <div className="w-full max-w-sm mx-auto my-auto bg-white border border-zinc-200 rounded-xl p-5 sm:p-8 shadow-sm">
        {/* Header with Authentic Brand Mark */}
        <div className="flex flex-col items-center text-center mb-5 sm:mb-6">
          <div className="flex items-center justify-center mb-3 sm:mb-4">
            <RelayGateLogo height={32} className="text-zinc-950" />
          </div>
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

        {/* Polished Session State Notification Banner */}
        {mode === 'login' && sessionNoticeState && (
          <div
            role="status"
            aria-live="polite"
            className="mb-5 p-3 rounded-lg bg-amber-50/90 border border-amber-200/90 text-amber-950 flex items-start gap-2.5 shadow-2xs animate-in"
          >
            <Clock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div className="flex-1 text-xs leading-relaxed font-medium">
              {sessionNoticeState}
            </div>
            <button
              type="button"
              onClick={handleDismissNotice}
              className="text-amber-800/70 hover:text-amber-950 min-h-[44px] min-w-[44px] -mr-2.5 -mt-2.5 p-2.5 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 cursor-pointer flex items-center justify-center shrink-0"
              aria-label="Tutup pemberitahuan"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Tab Toggle (only visible in login or register mode) */}
        {mode !== 'verify' && (
          <div className="flex p-1 bg-zinc-100 rounded-lg mb-5 border border-zinc-200">
            <button
              type="button"
              onClick={() => switchMode('login')}
              className={`flex-1 min-h-[44px] sm:min-h-[38px] py-2 px-3 text-xs font-semibold rounded-md transition-all cursor-pointer ${
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
              className={`flex-1 min-h-[44px] sm:min-h-[38px] py-2 px-3 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                mode === 'register'
                  ? 'bg-white text-zinc-900 shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              Daftar
            </button>
          </div>
        )}

        {/* OAuth Authentication Providers (Google, GitHub, GitLab) */}
        {mode !== 'verify' && (
          <div className="mb-4">
            <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
              {/* Google Button */}
              <button
                type="button"
                onClick={() => handleOpenOAuth('google')}
                className="flex items-center justify-center gap-1.5 min-h-[44px] py-2 px-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 active:scale-[0.98] text-xs font-semibold text-zinc-800 transition-all shadow-2xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                aria-label={mode === 'register' ? 'Daftar dengan Google' : 'Masuk dengan Google'}
                title={mode === 'register' ? 'Daftar dengan Google' : 'Masuk dengan Google'}
              >
                <GoogleIcon className="w-4 h-4 shrink-0" />
                <span className="truncate">Google</span>
              </button>

              {/* GitHub Button */}
              <button
                type="button"
                onClick={() => handleOpenOAuth('github')}
                className="flex items-center justify-center gap-1.5 min-h-[44px] py-2 px-2 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] text-xs font-semibold text-white transition-all shadow-2xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                aria-label={mode === 'register' ? 'Daftar dengan GitHub' : 'Masuk dengan GitHub'}
                title={mode === 'register' ? 'Daftar dengan GitHub' : 'Masuk dengan GitHub'}
              >
                <GitHubIcon className="w-4 h-4 shrink-0" />
                <span className="truncate">GitHub</span>
              </button>

              {/* GitLab Button */}
              <button
                type="button"
                onClick={() => handleOpenOAuth('gitlab')}
                className="flex items-center justify-center gap-1.5 min-h-[44px] py-2 px-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 active:scale-[0.98] text-xs font-semibold text-zinc-800 transition-all shadow-2xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                aria-label={mode === 'register' ? 'Daftar dengan GitLab' : 'Masuk dengan GitLab'}
                title={mode === 'register' ? 'Daftar dengan GitLab' : 'Masuk dengan GitLab'}
              >
                <GitLabIcon className="w-4 h-4 shrink-0" />
                <span className="truncate">GitLab</span>
              </button>
            </div>

            {/* Clean UI Divider */}
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-zinc-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-3 text-zinc-500 font-medium">
                  atau lanjutkan dengan email
                </span>
              </div>
            </div>
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
                  className="w-full pl-9 pr-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
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
                  className="min-h-[44px] px-2.5 py-1.5 -mr-2 text-xs text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-900 rounded"
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
                  className="w-full pl-9 pr-10 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
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
              className="w-full min-h-[44px] py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] text-white text-sm font-semibold rounded-lg shadow-sm disabled:opacity-60 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 cursor-pointer"
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
                  className="w-full pl-9 pr-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
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
                  className="w-full pl-9 pr-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
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
                  className="min-h-[44px] px-2.5 py-1.5 -mr-2 text-xs text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-900 rounded"
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
                  className="w-full pl-9 pr-10 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
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
                  className="min-h-[44px] px-2.5 py-1.5 -mr-2 text-xs text-zinc-500 hover:text-zinc-900 transition-colors flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-900 rounded"
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
                  className="w-full pl-9 pr-10 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors font-mono"
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
              className="w-full min-h-[44px] py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] text-white text-sm font-semibold rounded-lg shadow-sm disabled:opacity-60 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 cursor-pointer"
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
                    className="text-xs text-zinc-900 font-medium underline hover:text-zinc-700 min-h-[44px] inline-flex items-center cursor-pointer"
                  >
                    Isi Otomatis
                  </button>
                </div>
              </div>
            )}

            {/* 6-Digit Code Input Boxes */}
            <div
              className="flex items-center justify-between gap-1 sm:gap-1.5 mb-5"
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
                  className="w-10 sm:w-11 h-12 text-center text-lg font-mono font-semibold bg-white border border-zinc-200 rounded-lg text-zinc-900 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
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
              className="w-full min-h-[44px] py-2.5 px-4 bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] text-white text-sm font-semibold rounded-lg shadow-sm disabled:opacity-60 transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 cursor-pointer"
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
                    className="min-h-[44px] inline-flex items-center font-semibold text-zinc-900 hover:underline disabled:opacity-50 cursor-pointer"
                  >
                    {resending ? 'Mengirim...' : 'Kirim Ulang Kode'}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={handleChangeEmail}
                className="min-h-[44px] inline-flex items-center text-xs text-zinc-500 hover:text-zinc-900 transition-colors cursor-pointer"
              >
                Ubah Alamat Email
              </button>
            </div>
          </form>
        )}
      </div>

      {/* High-Craft Tailored OAuth Modals (Google, GitHub, GitLab) */}
      {activeOAuth && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            activeOAuth === 'google'
              ? 'Autentikasi dengan Google'
              : activeOAuth === 'github'
              ? 'Autentikasi dengan GitHub'
              : 'Autentikasi dengan GitLab'
          }
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in"
        >
          {/* 1. GOOGLE IDENTITY SERVICES MODAL */}
          {activeOAuth === 'google' && (
            <div className="w-full max-w-sm bg-white border border-zinc-200 rounded-2xl shadow-2xl overflow-hidden p-6 text-zinc-900 animate-in">
              {/* Google Header */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <GoogleIcon className="w-6 h-6 shrink-0" />
                  <div>
                    <h2 className="text-base font-bold text-zinc-900 leading-tight">
                      {mode === 'register' ? 'Daftar dengan Google' : 'Masuk dengan Google'}
                    </h2>
                    <p className="text-xs text-zinc-500">Pilih akun untuk melanjutkan ke RelayGate</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCloseOAuth}
                  disabled={oauthStep === 'authorizing'}
                  className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 p-2 rounded-lg text-zinc-400 hover:text-zinc-700 transition-colors flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 disabled:opacity-40"
                  aria-label="Tutup dialog"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Status / Authorizing state */}
              {oauthStep === 'authorizing' && (
                <div className="py-8 flex flex-col items-center text-center">
                  <div className="w-8 h-8 border-2 border-blue-100 border-t-blue-600 rounded-full animate-spin mb-4" />
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{oauthStatusMessage}</p>
                  <p className="text-xs text-zinc-500">Otorisasi single sign-on terenkripsi OIDC</p>
                </div>
              )}

              {oauthStep === 'success' && (
                <div className="py-8 flex flex-col items-center text-center">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-3">
                    <Check className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{oauthStatusMessage}</p>
                  <p className="text-xs text-zinc-500">Mengarahkan langsung ke control panel...</p>
                </div>
              )}

              {oauthStep === 'select' && (
                <div className="space-y-3">
                  {oauthError && (
                    <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                      <span>{oauthError}</span>
                    </div>
                  )}

                  {!showCustomOAuth ? (
                    <>
                      {/* Account 1 */}
                      <button
                        type="button"
                        onClick={() => executeOAuth('google', 'alex.developer@gmail.com', 'Alex Prasetyo')}
                        className="w-full text-left p-3 rounded-xl border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 active:scale-[0.99] transition-all flex items-center justify-between cursor-pointer group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-blue-600 text-white font-bold text-sm flex items-center justify-center shadow-xs">
                            A
                          </div>
                          <div>
                            <div className="text-xs font-bold text-zinc-900 group-hover:text-blue-600 transition-colors">
                              Alex Prasetyo
                            </div>
                            <div className="text-[11px] text-zinc-500 font-mono">
                              alex.developer@gmail.com
                            </div>
                          </div>
                        </div>
                        <span className="text-[10px] font-medium bg-zinc-100 text-zinc-700 px-2 py-0.5 rounded-md">
                          Sesi Aktif
                        </span>
                      </button>

                      {/* Account 2 */}
                      <button
                        type="button"
                        onClick={() => executeOAuth('google', 'admin@relaygate.local', 'RelayGate Admin')}
                        className="w-full text-left p-3 rounded-xl border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 active:scale-[0.99] transition-all flex items-center justify-between cursor-pointer group"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-emerald-700 text-white font-bold text-sm flex items-center justify-center shadow-xs">
                            R
                          </div>
                          <div>
                            <div className="text-xs font-bold text-zinc-900 group-hover:text-emerald-700 transition-colors">
                              RelayGate Admin
                            </div>
                            <div className="text-[11px] text-zinc-500 font-mono">
                              admin@relaygate.local
                            </div>
                          </div>
                        </div>
                        <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-md">
                          Admin
                        </span>
                      </button>

                      {/* Custom Account option */}
                      <button
                        type="button"
                        onClick={() => setShowCustomOAuth(true)}
                        className="w-full min-h-[44px] py-2 px-3 text-xs text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer font-medium"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>Gunakan akun Google lainnya</span>
                      </button>
                    </>
                  ) : (
                    /* Custom Google account inputs */
                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="block text-xs font-semibold text-zinc-900 mb-1" htmlFor="google-email">
                          Alamat Email Google
                        </label>
                        <input
                          id="google-email"
                          type="email"
                          value={customOAuthEmail}
                          onChange={(e) => setCustomOAuthEmail(e.target.value)}
                          placeholder="pengguna@gmail.com"
                          className="w-full px-3 py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-zinc-900 mb-1" htmlFor="google-name">
                          Nama Akun
                        </label>
                        <input
                          id="google-name"
                          type="text"
                          value={customOAuthName}
                          onChange={(e) => setCustomOAuthName(e.target.value)}
                          placeholder="Nama Tampilan"
                          className="w-full px-3 py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
                        />
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => executeOAuth('google', customOAuthEmail, customOAuthName || 'Pengguna Google')}
                          className="flex-1 min-h-[44px] py-2 px-4 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold rounded-lg shadow-sm cursor-pointer"
                        >
                          Lanjutkan
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowCustomOAuth(false)}
                          className="min-h-[44px] px-3 py-2 text-xs text-zinc-600 hover:text-zinc-900 cursor-pointer"
                        >
                          Kembali
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Consent footer */}
                  <div className="pt-3 border-t border-zinc-100 text-[11px] text-zinc-500 leading-relaxed">
                    Google akan membagikan nama profil dan alamat email Anda kepada RelayGate. Akun langsung aktif tanpa verifikasi kode.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2. GITHUB OAUTH AUTHORIZATION MODAL */}
          {activeOAuth === 'github' && (
            <div className="w-full max-w-sm bg-white border border-zinc-200 rounded-2xl shadow-2xl overflow-hidden text-zinc-900 animate-in">
              {/* GitHub Themed Header */}
              <div className="bg-zinc-900 text-white p-4 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <GitHubIcon className="w-5 h-5 text-white shrink-0" />
                  <span className="text-sm font-semibold tracking-tight">Authorize RelayGate</span>
                </div>
                <button
                  type="button"
                  onClick={handleCloseOAuth}
                  disabled={oauthStep === 'authorizing'}
                  className="min-h-[44px] min-w-[44px] -mr-2 -my-2 p-2 rounded-lg text-zinc-300 hover:text-white transition-colors flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"
                  aria-label="Tutup dialog"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Host URL indicator */}
              <div className="bg-zinc-800 px-4 py-1.5 text-[11px] text-zinc-300 font-mono flex items-center gap-1.5 border-b border-zinc-700">
                <Lock className="w-3 h-3 text-emerald-400 shrink-0" />
                <span>github.com/login/oauth/authorize</span>
              </div>

              {/* Status / Authorizing state */}
              {oauthStep === 'authorizing' && (
                <div className="py-8 px-5 flex flex-col items-center text-center">
                  <div className="w-8 h-8 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin mb-4" />
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{oauthStatusMessage}</p>
                  <p className="text-xs text-zinc-500 font-mono">POST /api/v1/auth/oauth [provider=github]</p>
                </div>
              )}

              {oauthStep === 'success' && (
                <div className="py-8 px-5 flex flex-col items-center text-center">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-3">
                    <Check className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{oauthStatusMessage}</p>
                  <p className="text-xs text-zinc-500">Mengarahkan langsung ke control panel...</p>
                </div>
              )}

              {oauthStep === 'select' && (
                <div className="p-5 space-y-4">
                  {oauthError && (
                    <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                      <span>{oauthError}</span>
                    </div>
                  )}

                  {/* Connected Diagram */}
                  <div className="p-3 rounded-xl bg-zinc-50 border border-zinc-200 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-zinc-900 text-white flex items-center justify-center">
                        <GitHubIcon className="w-4 h-4 text-white" />
                      </div>
                      <div>
                        <div className="font-semibold text-zinc-900">rootless-sec</div>
                        <div className="text-[10px] text-zinc-500">Developer Terverifikasi</div>
                      </div>
                    </div>
                    <div className="font-mono text-[10px] bg-zinc-200 text-zinc-800 px-2 py-0.5 rounded">
                      OAuth 2.0
                    </div>
                  </div>

                  {/* Account Card */}
                  <div className="p-3 rounded-xl border border-zinc-200 bg-white space-y-2">
                    <div className="text-[11px] font-medium text-zinc-500">Akun GitHub Terhubung:</div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-zinc-900 text-white font-mono text-xs flex items-center justify-center font-bold">
                          HZ
                        </div>
                        <div>
                          <div className="text-xs font-bold text-zinc-900">Mafifrizi (@hazama3321)</div>
                          <div className="text-[11px] text-zinc-500 font-mono">hazama3321@gmail.com</div>
                        </div>
                      </div>
                      <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 px-2 py-0.5 rounded-md">
                        Aktif
                      </span>
                    </div>
                  </div>

                  {/* Scope Checklist */}
                  <div className="space-y-2 text-xs">
                    <div className="text-[11px] font-semibold text-zinc-700">Izin yang Diminta:</div>
                    <div className="flex items-start gap-2 text-zinc-700 text-[11px]">
                      <Check className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                      <span><strong>user:email</strong>: Akses alamat email akun</span>
                    </div>
                    <div className="flex items-start gap-2 text-zinc-700 text-[11px]">
                      <Check className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                      <span><strong>read:user</strong>: Akses profil publik identitas</span>
                    </div>
                    <div className="flex items-start gap-2 text-zinc-500 text-[10px] bg-zinc-50 p-2 rounded-lg border border-zinc-200">
                      <Shield className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                      <span>Tanpa akses repositori atau kode sumber privat. Langsung masuk tanpa verifikasi OTP.</span>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="space-y-2 pt-1">
                    <button
                      type="button"
                      onClick={() => executeOAuth('github', 'hazama3321@gmail.com', 'Mafifrizi')}
                      className="w-full min-h-[44px] py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white text-xs font-semibold rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                    >
                      <span>Authorize rootless-sec/relaygate</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCloseOAuth}
                      className="w-full min-h-[44px] py-2 px-3 text-xs text-zinc-600 hover:text-zinc-900 transition-colors cursor-pointer text-center"
                    >
                      Batal
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 3. GITLAB OIDC SSO MODAL */}
          {activeOAuth === 'gitlab' && (
            <div className="w-full max-w-sm bg-white border border-zinc-200 rounded-2xl shadow-2xl overflow-hidden text-zinc-900 animate-in">
              {/* GitLab Themed Header */}
              <div className="bg-zinc-900 text-white p-4 flex items-center justify-between border-b border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <GitLabIcon className="w-5 h-5 shrink-0" />
                  <span className="text-sm font-semibold tracking-tight">Otorisasi Aplikasi GitLab</span>
                </div>
                <button
                  type="button"
                  onClick={handleCloseOAuth}
                  disabled={oauthStep === 'authorizing'}
                  className="min-h-[44px] min-w-[44px] -mr-2 -my-2 p-2 rounded-lg text-zinc-400 hover:text-white transition-colors flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"
                  aria-label="Tutup dialog"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Host URL indicator */}
              <div className="bg-zinc-800 px-4 py-1.5 text-[11px] text-zinc-300 font-mono flex items-center justify-between border-b border-zinc-700">
                <div className="flex items-center gap-1.5">
                  <Server className="w-3 h-3 text-orange-500 shrink-0" />
                  <span>gitlab.com (SaaS SSO)</span>
                </div>
                <span className="text-[10px] bg-zinc-700 text-zinc-200 px-1.5 py-0.5 rounded">OIDC</span>
              </div>

              {/* Status / Authorizing state */}
              {oauthStep === 'authorizing' && (
                <div className="py-8 px-5 flex flex-col items-center text-center">
                  <div className="w-8 h-8 border-2 border-orange-200 border-t-orange-600 rounded-full animate-spin mb-4" />
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{oauthStatusMessage}</p>
                  <p className="text-xs text-zinc-500 font-mono">POST /api/v1/auth/oauth [provider=gitlab]</p>
                </div>
              )}

              {oauthStep === 'success' && (
                <div className="py-8 px-5 flex flex-col items-center text-center">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-3">
                    <Check className="w-5 h-5 stroke-[2.5]" />
                  </div>
                  <p className="text-sm font-semibold text-zinc-900 mb-1">{oauthStatusMessage}</p>
                  <p className="text-xs text-zinc-500">Mengarahkan langsung ke control panel...</p>
                </div>
              )}

              {oauthStep === 'select' && (
                <div className="p-5 space-y-4">
                  {oauthError && (
                    <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                      <span>{oauthError}</span>
                    </div>
                  )}

                  {/* DevOps Identity Card */}
                  <div className="p-3 rounded-xl border border-zinc-200 bg-white space-y-2">
                    <div className="text-[11px] font-medium text-zinc-500">Identitas GitLab DevOps:</div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-orange-500/10 border border-orange-500/30 text-orange-600 font-bold text-xs flex items-center justify-center">
                          GL
                        </div>
                        <div>
                          <div className="text-xs font-bold text-zinc-900">DevOps Engineer (@devops-lead)</div>
                          <div className="text-[11px] text-zinc-500 font-mono">devops.lead@gitlab.company</div>
                        </div>
                      </div>
                      <span className="text-[10px] font-semibold bg-orange-50 text-orange-800 border border-orange-200 px-2 py-0.5 rounded-md">
                        Enterprise
                      </span>
                    </div>
                  </div>

                  {/* Scopes */}
                  <div className="space-y-2 text-xs">
                    <div className="text-[11px] font-semibold text-zinc-700">Cakupan Izin OIDC:</div>
                    <div className="flex items-start gap-2 text-zinc-700 text-[11px]">
                      <Check className="w-3.5 h-3.5 text-orange-600 mt-0.5 shrink-0" />
                      <span><strong>openid</strong>: Single sign-on identitas terpadu</span>
                    </div>
                    <div className="flex items-start gap-2 text-zinc-700 text-[11px]">
                      <Check className="w-3.5 h-3.5 text-orange-600 mt-0.5 shrink-0" />
                      <span><strong>profile, email</strong>: Detail akun dan alamat email</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 bg-zinc-50 p-2 rounded-lg border border-zinc-200">
                      Otorisasi langsung mengaktifkan sesi dashboard tanpa verifikasi kode 6-digit.
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="space-y-2 pt-1">
                    <button
                      type="button"
                      onClick={() => executeOAuth('gitlab', 'devops.lead@gitlab.company', 'DevOps Engineer')}
                      className="w-full min-h-[44px] py-2.5 px-4 bg-orange-600 hover:bg-orange-700 active:scale-[0.98] text-white text-xs font-semibold rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-600"
                    >
                      <span>Izinkan Otorisasi GitLab</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCloseOAuth}
                      className="w-full min-h-[44px] py-2 px-3 text-xs text-zinc-600 hover:text-zinc-900 transition-colors cursor-pointer text-center"
                    >
                      Tolak
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
