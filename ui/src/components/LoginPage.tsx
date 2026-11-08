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
  ChevronRight,
  UserPlus,
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

export function getOAuthProviderUrl(provider: 'google' | 'github' | 'gitlab'): string {
  const env = (typeof import.meta !== 'undefined' && (import.meta as any).env) || {};
  switch (provider) {
    case 'google':
      if (env.VITE_GOOGLE_AUTH_URL) return env.VITE_GOOGLE_AUTH_URL;
      if (env.VITE_GOOGLE_CLIENT_ID) {
        return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(env.VITE_GOOGLE_CLIENT_ID)}&response_type=code&scope=openid%20profile%20email&prompt=select_account`;
      }
      return 'https://accounts.google.com/signin';
    case 'github':
      if (env.VITE_GITHUB_AUTH_URL) return env.VITE_GITHUB_AUTH_URL;
      if (env.VITE_GITHUB_CLIENT_ID) {
        return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(env.VITE_GITHUB_CLIENT_ID)}&scope=read:user%20user:email`;
      }
      return 'https://github.com/login';
    case 'gitlab':
      if (env.VITE_GITLAB_AUTH_URL) return env.VITE_GITLAB_AUTH_URL;
      if (env.VITE_GITLAB_CLIENT_ID) {
        return `https://gitlab.com/oauth/authorize?client_id=${encodeURIComponent(env.VITE_GITLAB_CLIENT_ID)}&scope=read_user%20openid%20profile%20email&response_type=code`;
      }
      return 'https://gitlab.com/users/sign_in';
  }
}

export const GOOGLE_ACCOUNTS = [
  {
    name: 'MUHAMMAD AFIF RIZI',
    email: 'suhendisuhendi224@gmail.com',
    initial: 'M',
    color: 'bg-blue-600',
  },
  {
    name: 'Ghost noir / Mafifrizi',
    email: 'hazama3321@gmail.com',
    initial: 'G',
    color: 'bg-emerald-600',
  },
  {
    name: 'Ares',
    email: 'ares.dragon016@gmail.com',
    initial: 'A',
    color: 'bg-amber-600',
  },
];

export const GITHUB_ACCOUNTS = [
  {
    name: 'Mafifrizi',
    email: 'hazama3321@gmail.com',
    username: 'Mafifrizi',
    initial: 'M',
  },
];

export const GITLAB_ACCOUNTS = [
  {
    name: 'Mafifrizi',
    email: 'hazama3321@gmail.com',
    initial: 'M',
  },
];

interface LoginPageProps {
  onLoginSuccess: (email: string) => void;
  initialError?: string | null;
  sessionNotice?: string | null;
  onDismissNotice?: () => void;
  initialMode?: 'login' | 'register';
}

type AuthMode = 'login' | 'register' | 'verify';

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  initialError,
  sessionNotice,
  onDismissNotice,
  initialMode,
}) => {
  const [mode, setMode] = useState<AuthMode>(() => {
    if (initialMode) return initialMode;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('auth') === 'register') return 'register';
    } catch {}
    return 'login';
  });

  useEffect(() => {
    if (initialMode && mode !== 'verify') {
      setMode(initialMode);
    }
  }, [initialMode]);

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

  // OAuth Account Chooser Modal state
  const [activeOAuthModal, setActiveOAuthModal] = useState<'google' | 'github' | 'gitlab' | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [isCustomAccount, setIsCustomAccount] = useState(false);
  const [customOauthEmail, setCustomOauthEmail] = useState('');
  const [customOauthName, setCustomOauthName] = useState('');

  // Close OAuth modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeOAuthModal) {
        setActiveOAuthModal(null);
        setIsCustomAccount(false);
        setOauthError(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeOAuthModal]);

  const handleOAuthClick = (provider: 'google' | 'github' | 'gitlab', e?: React.MouseEvent) => {
    e?.preventDefault();
    setActiveOAuthModal(provider);
    setIsCustomAccount(false);
    setCustomOauthEmail('');
    setCustomOauthName('');
    setOauthError(null);
  };

  const handleCloseOAuthModal = () => {
    if (oauthLoading) return;
    setActiveOAuthModal(null);
    setIsCustomAccount(false);
    setOauthError(null);
  };

  const handleSelectOAuthAccount = async (
    provider: 'google' | 'github' | 'gitlab',
    accountEmail: string,
    accountName?: string
  ) => {
    const cleanEmail = accountEmail.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      setOauthError('Alamat email tidak valid.');
      return;
    }

    setOauthLoading(true);
    setOauthError(null);

    try {
      const res = await oauthLogin({
        provider,
        email: cleanEmail,
        name: (accountName || cleanEmail.split('@')[0]).trim(),
      });

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
      setActiveOAuthModal(null);
      setIsCustomAccount(false);
      onLoginSuccess(res.user.email);
    } catch (err: any) {
      setOauthError(err?.message || `Gagal autentikasi via ${provider}. Silakan coba lagi.`);
    } finally {
      setOauthLoading(false);
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
    <div className="relative min-h-dvh bg-zinc-50 flex items-center justify-center p-4 sm:p-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(4.5rem,calc(env(safe-area-inset-top,0px)+3.75rem))] sm:pt-6 px-[max(1rem,env(safe-area-inset-left))]">
      {/* Sleek Floating Toast / Notification Popup for Session Expiration */}
      {sessionNoticeState && (
        <aside
          role="status"
          aria-live="polite"
          aria-label="Pemberitahuan sesi"
          className="fixed top-[4.5rem] left-4 right-4 sm:top-6 sm:left-auto sm:right-6 sm:w-96 z-50 p-4 rounded-xl bg-white/95 backdrop-blur-md border border-amber-200/80 shadow-lg text-zinc-900 animate-in fade-in slide-in-from-top-3 duration-200 flex items-start gap-3"
        >
          <div className="w-8 h-8 rounded-lg bg-amber-50 border border-amber-200/60 flex items-center justify-center shrink-0 text-amber-700">
            <Clock className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0 pr-1">
            <h4 className="text-xs font-semibold text-zinc-900 leading-snug">
              Sesi Berakhir
            </h4>
            <p className="text-xs text-zinc-600 mt-0.5 leading-relaxed">
              {sessionNoticeState}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismissNotice}
            className="text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100/60 min-h-[44px] min-w-[44px] -mr-2 -mt-2 p-2.5 rounded-lg transition-colors flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 shrink-0"
            aria-label="Tutup pemberitahuan"
          >
            <X className="w-4 h-4" />
          </button>
        </aside>
      )}

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
              <a
                href={getOAuthProviderUrl('google')}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => handleOAuthClick('google', e)}
                className="flex items-center justify-center gap-1.5 min-h-[44px] py-2 px-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 active:scale-[0.98] text-xs font-semibold text-zinc-800 transition-all shadow-2xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                aria-label={mode === 'register' ? 'Daftar dengan Google' : 'Masuk dengan Google'}
                title={mode === 'register' ? 'Daftar dengan Google' : 'Masuk dengan Google'}
              >
                <GoogleIcon className="w-4 h-4 shrink-0" />
                <span className="truncate">Google</span>
              </a>

              {/* GitHub Button */}
              <a
                href={getOAuthProviderUrl('github')}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => handleOAuthClick('github', e)}
                className="flex items-center justify-center gap-1.5 min-h-[44px] py-2 px-2 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] text-xs font-semibold text-white transition-all shadow-2xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                aria-label={mode === 'register' ? 'Daftar dengan GitHub' : 'Masuk dengan GitHub'}
                title={mode === 'register' ? 'Daftar dengan GitHub' : 'Masuk dengan GitHub'}
              >
                <GitHubIcon className="w-4 h-4 shrink-0" />
                <span className="truncate">GitHub</span>
              </a>

              {/* GitLab Button */}
              <a
                href={getOAuthProviderUrl('gitlab')}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => handleOAuthClick('gitlab', e)}
                className="flex items-center justify-center gap-1.5 min-h-[44px] py-2 px-2 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 active:scale-[0.98] text-xs font-semibold text-zinc-800 transition-all shadow-2xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                aria-label={mode === 'register' ? 'Daftar dengan GitLab' : 'Masuk dengan GitLab'}
                title={mode === 'register' ? 'Daftar dengan GitLab' : 'Masuk dengan GitLab'}
              >
                <GitLabIcon className="w-4 h-4 shrink-0" />
                <span className="truncate">GitLab</span>
              </a>
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
                  className="w-full pl-9 pr-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                />
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2 animate-in"
              >
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
                  Memverifikasi...
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
          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label
                className="block text-xs font-semibold text-zinc-900 mb-1.5"
                htmlFor="reg-name"
              >
                Nama Lengkap / Username
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="reg-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nama Lengkap"
                  className="w-full pl-9 pr-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                  autoFocus
                />
              </div>
            </div>

            <div>
              <label
                className="block text-xs font-semibold text-zinc-900 mb-1.5"
                htmlFor="reg-email"
              >
                Alamat Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  id="reg-email"
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
                  htmlFor="reg-password"
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
                  id="reg-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimal 6 karakter"
                  className="w-full pl-9 pr-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  className="block text-xs font-semibold text-zinc-900"
                  htmlFor="reg-confirm"
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
                  id="reg-confirm"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Ketik ulang password"
                  className="w-full pl-9 pr-3 py-2.5 sm:py-2 min-h-[44px] text-base sm:text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                />
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2 animate-in"
              >
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
                  Mendaftarkan...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  Lanjutkan Verifikasi Email
                  <ArrowRight className="w-4 h-4" />
                </span>
              )}
            </button>
          </form>
        ) : (
          /* OTP Verification Mode */
          <form onSubmit={handleVerify} className="space-y-4">
            {/* Dev preview code helper */}
            {devCode && (
              <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 text-xs text-zinc-700">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-zinc-900">Local Dev Preview:</span>
                  <span className="font-mono text-[10px] bg-zinc-200 text-zinc-800 px-1.5 py-0.5 rounded">
                    SMTP Mock
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mb-2">
                  Kode verifikasi 6-digit dikirimkan (karena SMTP eksternal tidak aktif di local):
                </p>
                <div className="flex items-center justify-between bg-white border border-zinc-200 rounded p-1.5 font-mono text-sm tracking-widest text-zinc-900 font-bold">
                  <span>{devCode}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const digits = devCode.split('');
                      setOtp(digits);
                    }}
                    className="min-h-[44px] px-2 text-xs font-sans font-medium text-zinc-600 hover:text-zinc-900 underline cursor-pointer"
                  >
                    Isi Otomatis
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-zinc-900 mb-2 text-center">
                Masukkan 6-Digit Kode Verifikasi
              </label>
              <div
                className="flex items-center justify-center gap-2 sm:gap-2.5"
                onPaste={handleOtpPaste}
              >
                {otp.map((digit, idx) => (
                  <input
                    key={idx}
                    ref={(el) => (otpInputs.current[idx] = el)}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    className="w-10 h-12 sm:w-11 sm:h-12 text-center text-lg sm:text-xl font-bold font-mono bg-white border border-zinc-200 rounded-lg text-zinc-900 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 transition-colors"
                    autoFocus={idx === 0}
                  />
                ))}
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2 animate-in"
              >
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || otp.join('').length < 6}
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

      {/* OAuth In-App Authentic Account Chooser Modal */}
      {activeOAuthModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            activeOAuthModal === 'google'
              ? 'Pilih akun Google'
              : activeOAuthModal === 'github'
              ? 'Pilih akun GitHub'
              : 'Pilih akun GitLab'
          }
          className="fixed inset-0 z-50 bg-zinc-950/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-[420px] bg-white border border-zinc-200 rounded-2xl p-5 sm:p-6 shadow-xl relative animate-in zoom-in-95 duration-150 text-left">
            {/* Modal Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2.5">
                {activeOAuthModal === 'google' && <GoogleIcon className="w-6 h-6 shrink-0" />}
                {activeOAuthModal === 'github' && <GitHubIcon className="w-6 h-6 shrink-0 text-zinc-900" />}
                {activeOAuthModal === 'gitlab' && <GitLabIcon className="w-6 h-6 shrink-0" />}
                <div>
                  <h3 className="text-base font-bold text-zinc-900 leading-snug">
                    {activeOAuthModal === 'google'
                      ? 'Pilih akun'
                      : activeOAuthModal === 'github'
                      ? 'Masuk dengan GitHub'
                      : 'Masuk dengan GitLab'}
                  </h3>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {activeOAuthModal === 'google'
                      ? 'Lanjutkan ke RelayGate'
                      : 'Lanjutkan ke RelayGate Control Panel'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseOAuthModal}
                disabled={oauthLoading}
                className="text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 min-h-[44px] min-w-[44px] -mr-2 -mt-2 p-2.5 rounded-lg transition-colors flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 disabled:opacity-40"
                aria-label="Tutup pemilih akun"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Error banner inside modal */}
            {oauthError && (
              <div
                role="alert"
                className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-center gap-2 animate-in"
              >
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{oauthError}</span>
              </div>
            )}

            {/* Account List or Custom Input */}
            {!isCustomAccount ? (
              <div className="space-y-1 divide-y divide-zinc-100">
                {/* Account list for Google */}
                {activeOAuthModal === 'google' && (
                  <div className="space-y-1">
                    {GOOGLE_ACCOUNTS.map((acc) => (
                      <button
                        key={acc.email}
                        type="button"
                        disabled={oauthLoading}
                        onClick={() => handleSelectOAuthAccount('google', acc.email, acc.name)}
                        className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-50 active:bg-zinc-100 text-left transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 min-h-[52px] disabled:opacity-60"
                      >
                        <div
                          className={`w-9 h-9 rounded-full ${acc.color} text-white font-bold flex items-center justify-center text-sm shrink-0`}
                        >
                          {acc.initial}
                        </div>
                        <div className="flex-1 min-w-0 pr-2">
                          <div className="text-xs font-semibold text-zinc-900 truncate group-hover:text-zinc-950">
                            {acc.name}
                          </div>
                          <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                            {acc.email}
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-zinc-400 group-hover:text-zinc-700 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Account list for GitHub */}
                {activeOAuthModal === 'github' && (
                  <div className="space-y-1">
                    {GITHUB_ACCOUNTS.map((acc) => (
                      <button
                        key={acc.email}
                        type="button"
                        disabled={oauthLoading}
                        onClick={() => handleSelectOAuthAccount('github', acc.email, acc.name)}
                        className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-50 active:bg-zinc-100 text-left transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 min-h-[52px] disabled:opacity-60"
                      >
                        <div className="w-9 h-9 rounded-full bg-zinc-900 text-white font-bold flex items-center justify-center text-sm shrink-0">
                          {acc.initial}
                        </div>
                        <div className="flex-1 min-w-0 pr-2">
                          <div className="text-xs font-semibold text-zinc-900 truncate group-hover:text-zinc-950">
                            {acc.name}
                          </div>
                          <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                            {acc.email}
                          </div>
                        </div>
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-zinc-100 text-zinc-700 shrink-0">
                          GitHub
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Account list for GitLab */}
                {activeOAuthModal === 'gitlab' && (
                  <div className="space-y-1">
                    {GITLAB_ACCOUNTS.map((acc) => (
                      <button
                        key={acc.email}
                        type="button"
                        disabled={oauthLoading}
                        onClick={() => handleSelectOAuthAccount('gitlab', acc.email, acc.name)}
                        className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-50 active:bg-zinc-100 text-left transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 min-h-[52px] disabled:opacity-60"
                      >
                        <div className="w-9 h-9 rounded-full bg-orange-600 text-white font-bold flex items-center justify-center text-sm shrink-0">
                          {acc.initial}
                        </div>
                        <div className="flex-1 min-w-0 pr-2">
                          <div className="text-xs font-semibold text-zinc-900 truncate group-hover:text-zinc-950">
                            {acc.name}
                          </div>
                          <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                            {acc.email}
                          </div>
                        </div>
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200/60 shrink-0">
                          GitLab
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {/* "Gunakan akun lain" row */}
                <div className="pt-1">
                  <button
                    type="button"
                    disabled={oauthLoading}
                    onClick={() => {
                      setIsCustomAccount(true);
                      setOauthError(null);
                    }}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-50 active:bg-zinc-100 text-left transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 min-h-[52px] disabled:opacity-60"
                  >
                    <div className="w-9 h-9 rounded-full border border-dashed border-zinc-300 text-zinc-600 flex items-center justify-center shrink-0 group-hover:border-zinc-400 group-hover:text-zinc-900">
                      <UserPlus className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-zinc-800 group-hover:text-zinc-950">
                        {activeOAuthModal === 'google'
                          ? 'Gunakan akun lain'
                          : activeOAuthModal === 'github'
                          ? 'Gunakan akun GitHub lain'
                          : 'Gunakan akun GitLab lain'}
                      </div>
                      <div className="text-[11px] text-zinc-400 mt-0.5">
                        Masukkan email atau username kustom
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-zinc-400 group-hover:text-zinc-700 shrink-0" />
                  </button>
                </div>
              </div>
            ) : (
              /* Custom Account Input Form */
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (activeOAuthModal) {
                    handleSelectOAuthAccount(activeOAuthModal, customOauthEmail, customOauthName);
                  }
                }}
                className="space-y-3 pt-1"
              >
                <div>
                  <label className="block text-xs font-semibold text-zinc-900 mb-1">
                    Alamat Email
                  </label>
                  <input
                    type="email"
                    required
                    value={customOauthEmail}
                    onChange={(e) => setCustomOauthEmail(e.target.value)}
                    placeholder="nama@email.com"
                    autoFocus
                    className="w-full px-3 py-2 min-h-[44px] text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-900 mb-1">
                    Nama / Username (opsional)
                  </label>
                  <input
                    type="text"
                    value={customOauthName}
                    onChange={(e) => setCustomOauthName(e.target.value)}
                    placeholder="Nama Lengkap"
                    className="w-full px-3 py-2 min-h-[44px] text-sm bg-white border border-zinc-200 rounded-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
                  />
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCustomAccount(false);
                      setOauthError(null);
                    }}
                    disabled={oauthLoading}
                    className="flex-1 min-h-[44px] px-3 py-2 text-xs font-semibold text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors cursor-pointer"
                  >
                    Kembali
                  </button>
                  <button
                    type="submit"
                    disabled={oauthLoading || !customOauthEmail.trim()}
                    className="flex-1 min-h-[44px] px-3 py-2 text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {oauthLoading ? 'Memproses...' : 'Lanjutkan'}
                  </button>
                </div>
              </form>
            )}

            {/* Privacy notice / footer matching authentic OAuth prompt */}
            <div className="mt-4 pt-3 border-t border-zinc-100 text-[11px] text-zinc-400 leading-relaxed">
              {activeOAuthModal === 'google'
                ? 'Untuk melanjutkan, Google akan membagikan nama, alamat email, dan preferensi bahasa Anda dengan RelayGate.'
                : activeOAuthModal === 'github'
                ? 'Autentikasi ini menghubungkan profil GitHub Anda ke sesi operator RelayGate secara aman.'
                : 'Autentikasi ini menghubungkan profil GitLab Anda ke sesi operator RelayGate secara aman.'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
