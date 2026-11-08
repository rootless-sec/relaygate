import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  ArrowDown,
  Check,
  Copy,
  Lock,
  Mail,
  Menu,
  Plus,
  RotateCcw,
  Shield,
  Terminal,
  X,
  Layers,
  KeyRound,
  Clock,
  PauseCircle,
  GitBranch,
  HardDrive,
  Sliders,
} from 'lucide-react';
import { RelayGateIcon, RelayGateLogo } from './RelayGateLogo';

interface LandingPageProps {
  onOpenLogin: () => void;
  onOpenRegister: () => void;
}

type OsTabId = 'linux' | 'windows' | 'mac' | 'docker' | 'curl';

const OS_TABS: { id: OsTabId; label: string }[] = [
  { id: 'linux', label: 'Linux' },
  { id: 'windows', label: 'Windows' },
  { id: 'mac', label: 'macOS' },
  { id: 'docker', label: 'Docker' },
  { id: 'curl', label: 'cURL Test' },
];

const WORKSPACE_STEPS = [
  {
    id: 'stream',
    label: 'Live event stream',
    body: 'Watch inbound deliveries arrive over Server-Sent Events (SSE) in real time via /api/v1/stream. Pause the stream at any moment to inspect a burst without losing buffered frames.',
    image: '/shots/stream.png',
  },
  {
    id: 'inspector',
    label: 'Payload & header inspector',
    body: 'Open any delivery in a side drawer to examine raw JSON bodies, response status codes, and automatically masked credential headers.',
    image: '/shots/inspector.png',
  },
  {
    id: 'dlq',
    label: 'Dead-letter triage',
    body: 'Filter failed deliveries by failure family. RelayGate separates unrecoverable signature defects from retryable downstream timeouts.',
    image: '/shots/dlq.png',
  },
  {
    id: 'endpoints',
    label: 'Endpoint routing',
    body: 'Register target URLs, rotate signing secrets, and tune per-route concurrency and timeout budgets from one table.',
    image: '/shots/endpoints.png',
  },
];

const FAQ_ITEMS = [
  {
    q: 'What is RelayGate?',
    a: 'RelayGate is a self-hosted webhook ingestion gateway and dispatch engine compiled into a single Go binary. It verifies cryptographic signatures at the edge, persists payloads in an embedded SQLite WAL queue, and fans out deliveries to downstream services with automatic exponential backoff.',
  },
  {
    q: 'Which webhook providers does RelayGate verify?',
    a: 'Stripe (v1 timestamped HMAC-SHA256), GitHub (X-Hub-Signature-256), Shopify (Base64 HMAC-SHA256), Xendit (constant-time static callback token), Midtrans (SHA-512 order digest), and any standard HMAC-SHA256 or static token sender.',
  },
  {
    q: 'Does RelayGate require Redis, Postgres, or Kafka?',
    a: 'No. RelayGate embeds SQLite in Write-Ahead Logging (WAL) mode directly inside the binary. Every verified delivery is fsynced to local disk before returning HTTP 202 Accepted, eliminating external broker failure modes.',
  },
  {
    q: 'How does dead-letter replay distinguish request defects from downstream outages?',
    a: 'RelayGate classifies every failure into one of 8 canonical failure families. Downstream 5xx errors and network timeouts can be replayed immediately with a reset 5-attempt quota, whereas missing signature headers or expired timestamps are flagged with clear remediation guidance.',
  },
  {
    q: 'How does email verification work if SMTP is not configured for local development?',
    a: 'RelayGate includes a local dev email preview mode. When SMTP credentials are not configured, the 6-digit OTP verification code is output directly to the server logs and returned in dev preview headers, allowing complete local authentication testing without external mail dependencies.',
  },
  {
    q: 'Do webhook payloads or signing secrets leave my server?',
    a: 'RelayGate has no external cloud dependency. All raw payloads, endpoint signing secrets, and delivery audit logs remain on your machine inside your local SQLite database.',
  },
  {
    q: 'How does RelayGate protect sensitive HTTP headers?',
    a: 'Headers matching Authorization, Token, Signature, or Secret are masked at the API boundary by default. Exporting a delivery as a cURL command automatically substitutes <TOKEN> placeholders so secrets never leak into shell history.',
  },
];

export { RelayGateIcon, RelayGateLogo };

export function RelayGateMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return <RelayGateIcon size={size} className={className} />;
}

export function ProviderMark({ provider, size = 20 }: { provider: string; size?: number }) {
  switch (provider) {
    case 'stripe':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
        </svg>
      );
    case 'github':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
      );
    case 'shopify':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M15.337 3.415c-.193-.015-.386.058-.502.212-.116.154-.463.656-.463.656s-.811-.193-1.158-.154c-.039-.656-.309-1.467-.888-1.969-.695-.618-1.621-.695-2.394-.309-.772.386-1.351 1.197-1.66 2.162-.965.309-1.621.502-1.699.54-.54.193-.579.232-.656.772-.077.54-1.467 11.312-1.467 11.312L14.72 18.5l4.826-1.081S15.8 3.801 15.762 3.608c-.039-.193-.232-.178-.425-.193zm-3.282.811c-.54.154-1.12.347-1.699.54.232-.695.656-1.313 1.235-1.583.232-.116.463-.154.656-.116-.039.386-.116.772-.192 1.159z" />
        </svg>
      );
    case 'xendit':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M4 4h5.2l4.8 6.4L18.8 4H24l-7.4 9.6L24 23.2h-5.2L14 16.8l-4.8 6.4H4l7.4-9.6L4 4z" />
        </svg>
      );
    case 'midtrans':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M3 5h3.5v14H3V5zm7.25 3.5h3.5V19h-3.5V8.5zM17.5 5H21v14h-3.5V5z" />
        </svg>
      );
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2L4 5.5v6.1c0 5.1 3.4 9.8 8 10.9 4.6-1.1 8-5.8 8-10.9V5.5L12 2zm0 3.2l5 2.2v4.2c0 3.6-2.3 7.1-5 8.1-2.7-1-5-4.5-5-8.1V7.4l5-2.2z" />
        </svg>
      );
  }
}

function TiltFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, gx: 50, gy: 50, active: false });

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setTilt({
      rx: (0.5 - py) * 4,
      ry: (px - 0.5) * 4,
      gx: Math.round(px * 100),
      gy: Math.round(py * 100),
      active: true,
    });
  };

  const handleLeave = () => {
    setTilt({ rx: 0, ry: 0, gx: 50, gy: 50, active: false });
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={{ perspective: 1100 }}
    >
      <div
        style={{
          position: 'relative',
          transformStyle: 'preserve-3d',
          transform: `rotateX(${tilt.rx.toFixed(2)}deg) rotateY(${tilt.ry.toFixed(2)}deg)`,
          transition: tilt.active ? 'transform 80ms linear' : 'transform 350ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function MagneticBrand({
  href = '#top',
  onClick,
  children,
  className = '',
}: {
  href?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);

  const handlePointerMove = (e: React.PointerEvent<HTMLAnchorElement>) => {
    if (e.pointerType === 'touch') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width - 0.5) * 12;
    const y = ((e.clientY - rect.top) / rect.height - 0.5) * 8;
    setOffset({ x, y });
    setActive(true);
  };

  const handlePointerLeave = () => {
    setOffset({ x: 0, y: 0 });
    setActive(false);
  };

  const isExternal = href.startsWith('http://') || href.startsWith('https://');

  return (
    <a
      href={href}
      onClick={onClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={className}
      rel={isExternal ? 'noopener noreferrer' : undefined}
      target={isExternal ? '_blank' : undefined}
      style={{
        transform: `translate3d(${offset.x.toFixed(1)}px, ${offset.y.toFixed(1)}px, 0)`,
        transition: active ? 'transform 0.08s linear' : 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {children}
    </a>
  );
}

function CopyCommand({
  prompt = '$',
  command,
  small = false,
  copyable = true,
}: {
  prompt?: string;
  command: string;
  small?: boolean;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(command);
      }
    } catch {
      // Fallback handled silently
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`copy ${small ? 'copy--sm' : ''}`.trim()} data-status={copied ? 'copied' : 'idle'}>
      <code>
        <span className="copy__prompt">{prompt} </span>
        {command}
      </code>
      {copyable && (
        <>
          <button
            type="button"
            className="copy__btn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : 'Copy command'}
          >
            {copied ? <Check className="w-4 h-4 text-zinc-900" /> : <Copy className="w-4 h-4" />}
          </button>
          <span className="copy__feedback" role="status" aria-live="polite">
            {copied ? 'Copied to clipboard' : ''}
          </span>
        </>
      )}
    </div>
  );
}


interface ProductDashboardPreviewProps {
  onOpenConsole?: () => void;
}

export function ProductDashboardPreview({ onOpenConsole }: ProductDashboardPreviewProps) {
  return (
    <div
      data-testid="dashboard-window-preview"
      className="w-full max-w-[1240px] mx-auto mt-6 text-left rounded-2xl border border-zinc-200/90 bg-white shadow-xs overflow-hidden group"
    >
      {/* Window Header / Browser Chrome */}
      <div className="bg-zinc-50 border-b border-zinc-200 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 shrink-0" aria-hidden="true">
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
          </div>
          {/* Address Bar Pill */}
          <button
            type="button"
            onClick={onOpenConsole}
            className="flex items-center gap-2 px-3 py-1 rounded-md bg-white hover:bg-zinc-100/80 border border-zinc-200/80 text-zinc-600 font-mono text-[11px] sm:text-xs shadow-2xs min-w-0 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
            title="Buka Console Dashboard"
          >
            <Lock className="w-3 h-3 text-zinc-400 shrink-0" />
            <span className="text-zinc-800 font-medium truncate">http://127.0.0.1:8080/dashboard</span>
          </button>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500 shrink-0">
          <RelayGateIcon size={14} className="text-zinc-900 shrink-0" />
          <span className="rg-engine-live-dot inline-block shrink-0" aria-hidden="true" />
          <span className="text-zinc-700 font-medium">Engine Online (UID 1000) · SQLite WAL</span>
        </div>
      </div>

      {/* Window Body: Authentic High-Resolution Retina Dashboard Screenshot */}
      <div
        className="relative bg-zinc-100 overflow-hidden cursor-pointer"
        onClick={onOpenConsole}
        role={onOpenConsole ? "button" : undefined}
        tabIndex={onOpenConsole ? 0 : undefined}
        onKeyDown={(e) => {
          if (onOpenConsole && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onOpenConsole();
          }
        }}
        aria-label={onOpenConsole ? "Buka Console Interaktif RelayGate" : undefined}
      >
        <img
          src="/shots/dashboard.png"
          alt="RelayGate Live Production Dashboard"
          width={2844}
          height={1536}
          className="w-full h-auto object-cover object-top block transition-transform duration-300 group-hover:scale-[1.005]"
          loading="eager"
          decoding="async"
        />

        {/* Subtle Interactive Overlay on Hover / Action */}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none flex items-end justify-center pb-6 sm:pb-8">
          {onOpenConsole && (
            <div
              className="pointer-events-auto min-h-[44px] px-4 py-2 rounded-lg bg-zinc-950/90 hover:bg-zinc-950 text-white font-medium text-xs sm:text-sm shadow-lg backdrop-blur-sm transition-all duration-150 inline-flex items-center gap-2 cursor-pointer active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
            >
              <span>Buka Console Interaktif</span>
              <ArrowUpRight className="w-3.5 h-3.5 text-zinc-300" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const RELAYGATE_SYSTEMD_SERVICE = `[Unit]
Description=RelayGate Webhook Ingestion Engine
After=network.target

[Service]
Type=simple
User=relaygate
Group=relaygate
WorkingDirectory=/var/lib/relaygate
ExecStart=/usr/local/bin/relaygate -addr :8080 -db /var/lib/relaygate/relaygate.db -workers 10
Restart=always
RestartSec=3s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target`;

const RELAYGATE_CROSS_COMPILE = 'CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o relaygate-linux-amd64 ./cmd/relaygate';

const downloadTextFile = (filename: string, text: string) => {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export function LandingPage({ onOpenLogin, onOpenRegister }: LandingPageProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeWsStep, setActiveWsStep] = useState(0);
  const [activeOsTab, setActiveOsTab] = useState<OsTabId>('linux');
  const [expandedAsset, setExpandedAsset] = useState<'binary' | 'service' | null>(null);
  const [copiedService, setCopiedService] = useState(false);
  const [copiedCrossBuild, setCopiedCrossBuild] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isNavHovered, setIsNavHovered] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [detailsTab, setDetailsTab] = useState<'ingress' | 'persistence' | 'dispatch'>('ingress');
  const wsStepsRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    if (typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(min-width: 768px)');
      setIsDesktop(mql.matches);
      const handleMql = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
      mql.addEventListener('change', handleMql);
      return () => {
        window.removeEventListener('scroll', handleScroll);
        mql.removeEventListener('change', handleMql);
      };
    }
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const items = Array.from(wsStepsRef.current?.children ?? []);
    if (items.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idx = items.indexOf(entry.target as Element);
            if (idx >= 0) setActiveWsStep(idx);
          }
        }
      },
      { rootMargin: '-36% 0px -64% 0px' }
    );
    items.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const scrollToSection = (id: string) => {
    setMobileMenuOpen(false);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="rg-landing min-h-screen text-zinc-900 selection:bg-zinc-900 selection:text-white">
      {/* =====================================================================
          TOP HEADER & HERO SECTION
          Subtle Cool-Tinted Soft Blue Canvas & Clean Dashboard Window Preview Centerpiece
      ===================================================================== */}
      <div className="relative overflow-hidden rg-canvas-pattern pt-20">
        <header className="nav-fixed w-full">
          <div className="nav__wrap px-4 sm:px-6">
            <div
              className={`nav__isle ${
                isScrolled
                  ? `is-glass py-2 px-3 shadow-sm ${isDesktop ? 'is-center' : 'justify-between'}`
                  : 'is-top py-3.5 border-b border-zinc-200/80 bg-white/80 backdrop-blur-sm'
              }`}
              onMouseEnter={() => setIsNavHovered(true)}
              onMouseLeave={() => setIsNavHovered(false)}
              style={{
                maxWidth: isScrolled
                  ? (isDesktop ? (isNavHovered ? 'min(920px, calc(100vw - 32px))' : 168) : '100%')
                  : 1240,
                transition: 'max-width 0.45s cubic-bezier(0.22, 1, 0.36, 1), padding 0.35s ease, background-color 0.3s ease',
              }}
            >
              {isScrolled && (
                <span
                  className="nav__isle-glass"
                  aria-hidden="true"
                  style={{
                    opacity: isScrolled ? 1 : 0,
                    transform: isScrolled ? 'scale(1)' : 'scale(0.965)',
                  }}
                />
              )}

              <MagneticBrand
                href="#top"
                className="brand flex items-center gap-2.5 text-zinc-950 font-semibold text-base tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded-lg py-1 select-none flex-none"
              >
                <RelayGateMark size={22} className="text-zinc-950 flex-none" />
                <span className="font-bold tracking-tight">RelayGate</span>
              </MagneticBrand>

              <div
                className={`nav__chrome ${
                  isScrolled && !isNavHovered
                    ? 'max-w-0 opacity-0 pointer-events-none'
                    : 'max-w-[780px] opacity-100 pointer-events-auto'
                }`}
                style={{
                  transition: 'max-width 0.45s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease, filter 0.3s ease',
                  filter: isScrolled && !isNavHovered ? 'blur(8px)' : 'blur(0px)',
                }}
              >
                <div
                  className="nav__chrome-inner flex items-center shrink-0"
                  style={{
                    transform: isScrolled && !isNavHovered ? 'translateX(-18px)' : 'translateX(0)',
                    transition: 'transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                >
                  <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-2.5 lg:gap-5 xl:gap-6 ml-3 lg:ml-6 mr-2.5 lg:mr-4 shrink-0">
                    <a
                      href="#native"
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToSection('native');
                      }}
                      className="navlink"
                    >
                      Engine
                    </a>
                    <a
                      href="#product"
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToSection('product');
                      }}
                      className="navlink"
                    >
                      Product
                    </a>
                    <a
                      href="#workspace"
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToSection('workspace');
                      }}
                      className="navlink"
                    >
                      Workspace
                    </a>
                    <a
                      href="#download"
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToSection('download');
                      }}
                      className="navlink"
                    >
                      Deploy
                    </a>
                    <a
                      href="#faq"
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToSection('faq');
                      }}
                      className="navlink"
                    >
                      Questions
                    </a>
                  </nav>

                  <div className="hidden md:flex items-center shrink-0">
                    <button
                      type="button"
                      onClick={onOpenLogin}
                      className="min-h-[44px] px-3.5 lg:px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer shadow-xs shrink-0 whitespace-nowrap"
                    >
                      Sign in
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex md:hidden items-center gap-2 ml-2">
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen((prev) => !prev)}
                  aria-expanded={mobileMenuOpen}
                  aria-label="Toggle navigation menu"
                  className="min-h-[44px] px-3 py-1.5 rounded-lg bg-zinc-100 border border-zinc-200 text-zinc-900 inline-flex items-center gap-1.5 text-xs font-medium active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                >
                  {mobileMenuOpen ? <X className="w-3.5 h-3.5" /> : <Menu className="w-3.5 h-3.5" />}
                  <span>Menu</span>
                </button>
              </div>
            </div>
          </div>
        </header>

        {mobileMenuOpen && (
          <div className="md:hidden relative z-30 mx-4 sm:mx-6 mb-4 p-4 rounded-xl bg-white border border-zinc-200 space-y-3 shadow-sm">
            <nav aria-label="Mobile navigation" className="flex flex-col space-y-1">
              {[
                { label: 'Engine', id: 'native' },
                { label: 'Product', id: 'product' },
                { label: 'Workspace', id: 'workspace' },
                { label: 'Deploy', id: 'download' },
                { label: 'Questions', id: 'faq' },
              ].map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToSection(item.id);
                  }}
                  className="min-h-[44px] px-3 flex items-center rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-100"
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="pt-2 border-t border-zinc-200">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onOpenLogin();
                }}
                className="w-full min-h-[44px] px-4 py-2.5 rounded-lg text-xs font-semibold text-white bg-zinc-900 active:scale-[0.97] flex items-center justify-center cursor-pointer shadow-xs"
              >
                Sign in
              </button>
            </div>
          </div>
        )}

        {/* Hero Copy Stack */}
        <section id="top" className="relative z-20 max-w-[920px] mx-auto px-4 sm:px-6 pt-8 sm:pt-10 pb-6 text-center flex flex-col items-center">
          <button
            type="button"
            onClick={() => scrollToSection('native')}
            className="group min-h-[36px] inline-flex items-center gap-2.5 pl-1.5 pr-3.5 py-1 rounded-full bg-zinc-100 hover:bg-zinc-200/80 border border-zinc-200/90 transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer"
          >
            <span className="px-2 py-0.5 rounded-full bg-zinc-900 text-white text-[11px] font-bold tracking-tight">
              New
            </span>
            <span className="text-[12px] font-medium text-zinc-800">
              Webhook gateway
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-zinc-500 group-hover:translate-x-0.5 transition-transform" />
          </button>

          <h1 className="mt-5 text-[clamp(2.5rem,4.5vw,4.125rem)] font-bold tracking-[-0.035em] leading-[1.06] text-zinc-950">
            Every webhook.
            <br />
            Zero dropped events.
          </h1>

          <p className="mt-4 text-[15px] sm:text-[16px] leading-[1.55] text-zinc-600 max-w-[54ch]">
            RelayGate verifies cryptographic signatures at the edge, buffers deliveries in an embedded SQLite WAL queue, and dispatches to downstream services with exponential backoff and dead-letter isolation.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onOpenLogin}
              className="min-h-[44px] px-5 py-2.5 rounded-lg text-[13px] font-semibold text-white bg-zinc-900 hover:bg-zinc-800 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer shadow-xs"
            >
              Open Console
            </button>
            <button
              type="button"
              onClick={() => scrollToSection('native')}
              className="min-h-[44px] px-5 py-2.5 rounded-lg text-[13px] font-medium text-zinc-800 bg-white hover:bg-zinc-100 border border-zinc-200 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer"
            >
              Explore Engine
            </button>
          </div>
        </section>

        {/* Authentic Product Centerpiece: Live Dashboard Window Preview */}
        <section className="relative z-10 px-4 sm:px-6 pb-12">
          <ProductDashboardPreview onOpenConsole={onOpenLogin} />
        </section>
      </div>

      {/* =====================================================================
          BODY SECTIONS: Monochrome & High-Luminance Optical White
      ===================================================================== */}
      <main>
        {/* 1. Supported Signature Standards Strip */}
        <section className="agents rg-container" id="agents">
          <div className="agents__row">
            {[
              { id: 'stripe', name: 'Stripe v1' },
              { id: 'github', name: 'GitHub SHA-256' },
              { id: 'shopify', name: 'Shopify HMAC' },
              { id: 'xendit', name: 'Xendit Token' },
              { id: 'midtrans', name: 'Midtrans SHA-512' },
              { id: 'generic', name: 'Standard HMAC' },
            ].map((p) => (
              <span key={p.id} className="agent">
                <ProviderMark provider={p.id} size={21} />
                <span>{p.name}</span>
              </span>
            ))}
          </div>
        </section>

        {/* 2. Native Engine Comparison & Stats (#native) */}
        <section className="native rg-container" id="native">
          <div className="native__grid">
            <div className="native__text">
              <h2 className="statement native__title">
                <span className="block">No Redis.</span>
                <span className="block">No Kafka.</span>
              </h2>
              <p className="lede native__lede">
                Built on Go and embedded SQLite WAL. Your machine verifies signatures in constant time and persists every delivery on disk before returning 202 Accepted.
              </p>
            </div>

            <div className="cmp" role="table" aria-label="RelayGate architecture compared to external broker stacks">
              <div className="cmp__row cmp__row--head" role="row">
                <span role="columnheader">
                  <span className="sr-only">Layer</span>
                </span>
                <span role="columnheader" className="cmp__col">
                  Broker stack
                </span>
                <span role="columnheader" className="cmp__col cmp__col--now">
                  RelayGate Engine
                </span>
              </div>
              <div className="cmp__row" role="row">
                <span role="rowheader" className="cmp__layer">
                  Runs in
                </span>
                <span role="cell" className="cmp__before">
                  Docker compose + 4 services
                </span>
                <span role="cell" className="cmp__now">
                  Single static Go binary
                </span>
              </div>
              <div className="cmp__row" role="row">
                <span role="rowheader" className="cmp__layer">
                  Persistence
                </span>
                <span role="cell" className="cmp__before">
                  External Redis &amp; Postgres
                </span>
                <span role="cell" className="cmp__now">
                  Embedded SQLite WAL with fsync
                </span>
              </div>
              <div className="cmp__row" role="row">
                <span role="rowheader" className="cmp__layer">
                  Verification
                </span>
                <span role="cell" className="cmp__before">
                  Per-app middleware code
                </span>
                <span role="cell" className="cmp__now">
                  Constant-time edge HMAC gate
                </span>
              </div>
            </div>
          </div>

          <div className="stats">
            <div className="stat">
              <p className="stat__value">0.4 ms</p>
              <p className="stat__label">median edge HMAC verification and WAL enqueue</p>
            </div>
            <div className="stat">
              <p className="stat__value">0</p>
              <p className="stat__label">external runtime daemons or broker dependencies</p>
            </div>
            <div className="stat">
              <p className="stat__value">5x</p>
              <p className="stat__label">deterministic backoff stages before dead-letter isolation</p>
            </div>
            <div className="stat">
              <p className="stat__value">18 MB</p>
              <p className="stat__label">resident memory under sustained 50-worker dispatch</p>
            </div>
          </div>
        </section>

        {/* 3. Feature 1: Worker Pool & Operator Console Showcase (#product) */}
        <section className="feature" id="product">
          <div className="rg-container feature__grid">
            <div className="feature__text">
              <h2 className="headline feature__title">
                Workers that retry and isolate automatically.
              </h2>
              <p className="lede feature__lede">
                Every verified webhook lands in an append-only WAL queue before the sender disconnects. A bounded worker pool dispatches deliveries across your targets, scheduling exponential backoff with jitter whenever a downstream service times out.
              </p>
            </div>

            <div className="feature__media">
              <TiltFrame>
                <div className="shot shot--bare p-2 sm:p-3 rounded-2xl bg-white border border-zinc-200 shadow-sm">
                  <div className="rg-win rounded-xl border border-zinc-200 overflow-hidden bg-white shadow-xs">
                    <div className="rg-win__bar bg-zinc-50 border-b border-zinc-200 px-4 py-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                        <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                        <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                        <span className="ml-2 font-mono text-[11px] text-zinc-500">http://127.0.0.1:8080/#endpoints</span>
                      </div>
                      <span className="font-mono text-[11px] text-zinc-400">ENDPOINT ROUTING &amp; WORKERS</span>
                    </div>
                    <img
                      src="/shots/endpoints.png"
                      alt="RelayGate Endpoint Routing and Dispatch Workers"
                      className="w-full h-auto object-cover block"
                      loading="lazy"
                    />
                  </div>
                </div>
              </TiltFrame>
            </div>
          </div>
        </section>

        {/* Real RelayGate Dashboard Preview Section */}
        <section className="rg-container py-12">
          <div className="text-center max-w-[800px] mx-auto mb-8">
            <span className="metaline">Operator Workspace</span>
            <h3 className="headline mt-2 text-zinc-950">
              High-luminance developer interface.
            </h3>
            <p className="lede mx-auto mt-2 text-zinc-600">
              Clean optical white canvas matching your local workflow, with real-time throughput metrics, live Server-Sent Events, and failure inspector.
            </p>
          </div>

          <TiltFrame>
            <div className="shot shot--bare p-2 sm:p-4 rounded-2xl bg-white border border-zinc-200 shadow-sm">
              <div className="rg-win rounded-xl border border-zinc-200 overflow-hidden bg-white shadow-xs">
                <div className="rg-win__bar bg-zinc-50 border-b border-zinc-200 px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                    <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                    <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                    <span className="ml-2 font-mono text-[11px] text-zinc-500">http://127.0.0.1:8080/#events</span>
                  </div>
                  <span className="font-mono text-[11px] text-zinc-400">LIVE EVENT STREAM &amp; INGRESS</span>
                </div>
                <img
                  src="/shots/stream.png"
                  alt="RelayGate Live Webhook Event Stream and Ingress"
                  className="w-full h-auto object-cover block"
                  loading="lazy"
                />
              </div>
            </div>
          </TiltFrame>
        </section>

        {/* 4. Feature 2 (Reverse): Dead-Letter Inspection & Replay */}
        <section className="feature feature--reverse">
          <div className="rg-container feature__grid">
            <div className="feature__text">
              <h2 className="headline feature__title">
                Failures you can inspect and replay.
              </h2>
              <p className="lede feature__lede">
                When a downstream service exhausts its retry budget or fails signature verification, RelayGate isolates the event with its raw payload, headers, and HTTP trace. Fix your downstream service, press Replay, and the delivery resumes with a fresh 5-attempt quota.
              </p>
            </div>

            <div className="feature__media">
              <TiltFrame>
                <div className="shot shot--bare p-2 sm:p-3 rounded-2xl bg-white border border-zinc-200 shadow-sm">
                  <div className="rg-win rounded-xl border border-zinc-200 overflow-hidden bg-white shadow-xs">
                    <div className="rg-win__bar bg-zinc-50 border-b border-zinc-200 px-4 py-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                        <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                        <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                        <span className="ml-2 font-mono text-[11px] text-zinc-500">http://127.0.0.1:8080/#dlq</span>
                      </div>
                      <span className="font-mono text-[11px] text-zinc-400">DEAD-LETTER QUEUE &amp; TRIAGE</span>
                    </div>
                    <img
                      src="/shots/dlq.png"
                      alt="RelayGate Dead-Letter Queue Inspection and Replay"
                      className="w-full h-auto object-cover block"
                      loading="lazy"
                    />
                  </div>
                </div>
              </TiltFrame>
            </div>
          </div>
        </section>

        {/* 5. Interactive Workspace Section (#workspace) */}
        <section className="ws rg-container" id="workspace">
          <h2 className="headline ws__title">
            The rest of the pipeline, in the same window.
          </h2>
          <div className="ws__body">
            <ol className="ws__steps" ref={wsStepsRef}>
              {WORKSPACE_STEPS.map((step, idx) => (
                <li
                  key={step.id}
                  className="ws__step"
                  data-active={activeWsStep === idx ? 'true' : undefined}
                  onClick={() => setActiveWsStep(idx)}
                >
                  <h3 className="subhead ws__step-title">{step.label}</h3>
                  <p className="ws__step-body">{step.body}</p>
                  <div className="ws__inline">
                    <div className="shot shot--bare">
                      <div className="shot__body" style={{ aspectRatio: '16 / 10' }}>
                        <img src={step.image} alt={step.label} loading="lazy" decoding="async" />
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            <div className="ws__sticky" aria-hidden="true">
              <div className="shot shot--bare ws__stage">
                <div className="shot__body" style={{ aspectRatio: '16 / 10' }}>
                  {WORKSPACE_STEPS.map((step, idx) => (
                    <img
                      key={step.id}
                      src={step.image}
                      alt=""
                      data-active={activeWsStep === idx ? 'true' : undefined}
                      loading="eager"
                      decoding="async"
                    />
                  ))}
                </div>
              </div>
              <div className="ws__progress">
                {WORKSPACE_STEPS.map((step, idx) => (
                  <span key={step.id} data-active={activeWsStep === idx ? 'true' : undefined} />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 6. Substantive Details & Ingestion Architecture */}
        <section className="details rg-container" id="details">
          <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-4">
            <div>
              <p className="text-xs font-mono uppercase tracking-widest text-zinc-500 font-semibold mb-2">
                Under The Hood
              </p>
              <h2 className="headline details__title !mb-0">Details.</h2>
            </div>
            <p className="text-sm text-zinc-600 max-w-[48ch] text-pretty">
              Deterministic wire mechanics, embedded SQLite WAL persistence, and isolated retry taxonomy.
            </p>
          </div>

          <div className="shot shot--bare rounded-2xl bg-white border border-zinc-200/90 shadow-xs overflow-hidden">
            {/* Interactive Tab Header */}
            <div className="px-4 py-3 bg-zinc-50/80 border-b border-zinc-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                <span className="ml-2 font-mono text-[11px] text-zinc-500 hidden sm:inline">
                  relaygate-core :: telemetry-inspector
                </span>
              </div>

              {/* Tab Switcher */}
              <div className="flex items-center gap-1 bg-zinc-200/60 p-1 rounded-lg">
                {[
                  { id: 'ingress', label: '1. Wire Ingress & Masking' },
                  { id: 'persistence', label: '2. SQLite WAL Barrier' },
                  { id: 'dispatch', label: '3. Retry & DLQ Taxonomy' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setDetailsTab(tab.id as any)}
                    className={`min-h-[36px] px-3 py-1 text-xs font-medium rounded-md transition-all duration-150 cursor-pointer active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 ${
                      detailsTab === tab.id
                        ? 'bg-white text-zinc-950 font-semibold shadow-xs'
                        : 'text-zinc-600 hover:text-zinc-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab Content */}
            <div className="p-5 sm:p-7">
              {detailsTab === 'ingress' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <div className="lg:col-span-7 bg-zinc-950 text-zinc-100 rounded-xl p-4 sm:p-5 font-mono text-xs overflow-x-auto leading-relaxed border border-zinc-800">
                    <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800 text-zinc-400 text-[11px]">
                      <span>INBOUND WIRE PROTOCOL (HTTP POST)</span>
                      <span className="text-zinc-300">202 ACCEPTED · 0.38ms</span>
                    </div>
                    <p className="text-zinc-400">POST /api/v1/ingest/stripe HTTP/1.1</p>
                    <p className="text-zinc-400">Host: api.relaygate.internal</p>
                    <p className="text-zinc-300">Stripe-Signature: t=1730995200,v1=9a2b84cf10e8b26... <span className="text-zinc-400 font-sans text-[11px]">(HMAC verified)</span></p>
                    <p className="text-zinc-300">Authorization: •••••••••••• <span className="text-zinc-400 font-sans text-[11px]">(masked at ingress boundary)</span></p>
                    <p className="text-zinc-400">Content-Type: application/json</p>
                    <p className="text-zinc-400 mt-2">{"{"}</p>
                    <p className="text-zinc-300 ml-4">&quot;id&quot;: &quot;evt_1P8xK2LkdIwHuVnk0Z81p9Qc&quot;,</p>
                    <p className="text-zinc-300 ml-4">&quot;type&quot;: &quot;payment_intent.succeeded&quot;,</p>
                    <p className="text-zinc-300 ml-4">&quot;created&quot;: 1730995200,</p>
                    <p className="text-zinc-300 ml-4">&quot;data&quot;: {'{'} &quot;object&quot;: {'{'} &quot;amount&quot;: 4200, &quot;status&quot;: &quot;succeeded&quot; {'}'} {'}'}</p>
                    <p className="text-zinc-400">{"}"}</p>
                  </div>

                  <div className="lg:col-span-5 space-y-4">
                    <h3 className="text-base font-semibold text-zinc-900 tracking-tight">
                      Edge signature validation &amp; zero credential leakage
                    </h3>
                    <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
                      Every inbound delivery is validated against declared endpoint secrets using constant-time cryptographic digests. Signatures outside the 300s window are rejected, and sensitive headers are redacted before persistence or UI rendering.
                    </p>
                    <div className="space-y-2 pt-2 border-t border-zinc-200 text-xs font-mono">
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">HMAC Verification</span>
                        <span className="font-semibold text-zinc-900">Constant-time SHA-256 (0.09ms)</span>
                      </div>
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">Timestamp Drift</span>
                        <span className="font-semibold text-zinc-900">Δt = +0.4s (within 300s window)</span>
                      </div>
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">Header Redaction</span>
                        <span className="font-semibold text-zinc-900">Auth, Tokens, Secrets &amp; Signatures</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {detailsTab === 'persistence' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <div className="lg:col-span-7 bg-zinc-950 text-zinc-100 rounded-xl p-4 sm:p-5 font-mono text-xs overflow-x-auto leading-relaxed border border-zinc-800">
                    <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800 text-zinc-400 text-[11px]">
                      <span>EMBEDDED SQLITE WRITE-AHEAD LOG (WAL)</span>
                      <span className="text-zinc-300">FSYNC BARRIER · 0.18ms</span>
                    </div>
                    <p className="text-zinc-500">-- Immediate fsync commit to disk before returning HTTP 202</p>
                    <p className="text-zinc-300">PRAGMA journal_mode = WAL;</p>
                    <p className="text-zinc-300">PRAGMA synchronous = NORMAL;</p>
                    <p className="text-zinc-400 mt-2">BEGIN IMMEDIATE;</p>
                    <p className="text-zinc-300 ml-4">INSERT INTO events (</p>
                    <p className="text-zinc-400 ml-8">id, endpoint_id, provider, payload, headers, status, attempts</p>
                    <p className="text-zinc-300 ml-4">) VALUES (</p>
                    <p className="text-zinc-400 ml-8">&apos;evt_01J8F9&apos;, &apos;ep_prod_billing&apos;, &apos;stripe&apos;, :payload, :sanitized_headers, &apos;PENDING&apos;, 0</p>
                    <p className="text-zinc-300 ml-4">);</p>
                    <p className="text-zinc-400">COMMIT; <span className="text-zinc-500">-- Flushed to disk. Safe against process crashes.</span></p>
                  </div>

                  <div className="lg:col-span-5 space-y-4">
                    <h3 className="text-base font-semibold text-zinc-900 tracking-tight">
                      Zero broker failure modes &amp; crash-proof disk barrier
                    </h3>
                    <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
                      RelayGate eliminates external message brokers like Redis or Kafka. Inbound webhooks are committed to an embedded SQLite database in WAL mode before acknowledging the sender, ensuring zero dropped events across restarts.
                    </p>
                    <div className="space-y-2 pt-2 border-t border-zinc-200 text-xs font-mono">
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">Persistence Architecture</span>
                        <span className="font-semibold text-zinc-900">Embedded SQLite (WAL Mode)</span>
                      </div>
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">External Dependencies</span>
                        <span className="font-semibold text-zinc-900">0 (Single compiled Go binary)</span>
                      </div>
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">Disk Commit Latency</span>
                        <span className="font-semibold text-zinc-900">0.18ms synchronous fsync</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {detailsTab === 'dispatch' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  <div className="lg:col-span-7 bg-zinc-950 text-zinc-100 rounded-xl p-4 sm:p-5 font-mono text-xs overflow-x-auto leading-relaxed border border-zinc-800">
                    <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800 text-zinc-400 text-[11px]">
                      <span>DISPATCH RETRY &amp; EXPONENTIAL BACKOFF</span>
                      <span className="text-zinc-300">5 ATTEMPTS · ±15% JITTER</span>
                    </div>
                    <p className="text-zinc-500">-- Downstream: https://billing.internal/webhooks</p>
                    <p className="text-zinc-300">Attempt 1: delay 1.0s (actual 1.12s)  -&gt;  HTTP 503 [Downstream Outage]</p>
                    <p className="text-zinc-300">Attempt 2: delay 2.0s (actual 1.94s)  -&gt;  HTTP 502 [Bad Gateway]</p>
                    <p className="text-zinc-300">Attempt 3: delay 4.0s (actual 4.15s)  -&gt;  HTTP 200 [Delivered Successfully]</p>
                    <div className="mt-3 pt-3 border-t border-zinc-800 text-zinc-400 text-[11px] flex justify-between">
                      <span>Status: DELIVERED</span>
                      <span>Delivery Duration: 7.21s total</span>
                    </div>
                  </div>

                  <div className="lg:col-span-5 space-y-4">
                    <h3 className="text-base font-semibold text-zinc-900 tracking-tight">
                      8 canonical failure families with honest retry quotas
                    </h3>
                    <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
                      Errors are classified into 8 explicit failure families. Downstream timeouts receive exponential backoff and can be replayed with a reset 5-attempt budget, while signature and format defects are isolated immediately in the dead-letter queue.
                    </p>
                    <div className="space-y-2 pt-2 border-t border-zinc-200 text-xs font-mono">
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">Backoff Formula</span>
                        <span className="font-semibold text-zinc-900">delay = min(1s * 2^n, 60s) ± 15%</span>
                      </div>
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">DLQ Isolation</span>
                        <span className="font-semibold text-zinc-900">Signature defects quarantined</span>
                      </div>
                      <div className="flex justify-between py-1.5 px-2.5 rounded bg-zinc-50 border border-zinc-200">
                        <span className="text-zinc-500">Bulk Replay Audit</span>
                        <span className="font-semibold text-zinc-900">Auto-excludes defective items</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="more">
            <ul className="more__grid">
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <Shield className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Constant-time HMAC</h3>
                  <p className="tile__body">Verify SHA-256 and SHA-512 digests without timing side-channels.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <Clock className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Timestamp window</h3>
                  <p className="tile__body">Reject replayed Stripe payloads outside the 5-minute tolerance.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <KeyRound className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Secret masking</h3>
                  <p className="tile__body">Authorization and signature headers never leak into clipboard cURL.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <Layers className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">8 failure families</h3>
                  <p className="tile__body">Strict taxonomy distinguishing retryable downstream 5xx errors from request defects.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <GitBranch className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Multi-provider routes</h3>
                  <p className="tile__body">Stripe, GitHub, Shopify, Xendit, Midtrans, and generic HMAC with per-route secrets.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <PauseCircle className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Pause mid-stream</h3>
                  <p className="tile__body">Freeze the live Server-Sent Events (SSE) feed while inspecting a payload drawer.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <Sliders className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Bounded worker pool</h3>
                  <p className="tile__body">Default 10 concurrent in-memory dispatch workers with exponential backoff and jitter.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <RotateCcw className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Replay, don&apos;t re-send</h3>
                  <p className="tile__body">Re-dispatch directly from the local WAL without asking the sender.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <Mail className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Dev email preview</h3>
                  <p className="tile__body">Local preview mode outputs 6-digit OTP codes directly when SMTP is unconfigured.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <HardDrive className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Embedded web UI</h3>
                  <p className="tile__body">Compiled into the Go binary via embed.FS with zero external runtime assets.</p>
                </div>
              </li>
            </ul>

            <button
              type="button"
              onClick={onOpenLogin}
              className="more__link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded"
            >
              <span>Open the operator console</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </section>

        {/* 7. Statement & Self-Hosted Topology Diagram */}
        <section className="statement-sec rg-container">
          <div className="statement-head">
            <h2 className="statement">Nothing leaves your server.</h2>
          </div>

          <div
            className="mach"
            role="img"
            aria-label="Webhook senders, operator console, and CLI connect to relaygate on your server, which verifies providers and keeps payloads, secrets, and audit logs on disk"
          >
            <ul className="mach__clients">
              <li className="mach__client">
                <Shield className="w-[18px] h-[18px] shrink-0 text-zinc-700" />
                <span>
                  <strong>Webhook Senders</strong>
                  <small>Stripe · GitHub · Xendit</small>
                </span>
              </li>
              <li className="mach__client">
                <Layers className="w-[18px] h-[18px] shrink-0 text-zinc-700" />
                <span>
                  <strong>Operator Console</strong>
                  <small>Browser · Server-Sent Events (SSE)</small>
                </span>
              </li>
              <li className="mach__client">
                <Terminal className="w-[18px] h-[18px] shrink-0 text-zinc-700" />
                <span>
                  <strong>CLI &amp; cURL</strong>
                  <small>Replay scripts &amp; CI</small>
                </span>
              </li>
            </ul>

            <div className="mach__wire">
              <svg viewBox="0 0 100 300" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0 50 C 55 50, 45 150, 100 150" />
                <path d="M0 150 L 100 150" />
                <path d="M0 250 C 55 250, 45 150, 100 150" />
              </svg>
              <span className="mach__via">HTTPS · HMAC · LAN</span>
            </div>

            <div className="mach__box">
              <span className="mach__label">Your machine</span>
              <div className="mach__daemon">
                <RelayGateMark size={20} className="text-zinc-950" />
                <strong>relaygate</strong>
              </div>
              <ul className="mach__agents">
                {[
                  { id: 'stripe', label: 'Stripe' },
                  { id: 'github', label: 'GitHub' },
                  { id: 'shopify', label: 'Shopify' },
                  { id: 'xendit', label: 'Xendit' },
                  { id: 'midtrans', label: 'Midtrans' },
                  { id: 'generic', label: 'Generic HMAC' },
                ].map((item) => (
                  <li key={item.id}>
                    <ProviderMark provider={item.id} size={15} />
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
              <ul className="mach__kept">
                <li>
                  <Lock className="w-3.5 h-3.5 text-zinc-600" />
                  <span>Payloads</span>
                </li>
                <li>
                  <Lock className="w-3.5 h-3.5 text-zinc-600" />
                  <span>Signing Secrets</span>
                </li>
                <li>
                  <Lock className="w-3.5 h-3.5 text-zinc-600" />
                  <span>Audit Logs</span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* 8. Environment / Deployment Modes */}
        <section className="env rg-container">
          <div className="env__grid">
            <div className="env__left">
              <h2 className="statement env__title">
                Any server becomes the ingestion edge.
              </h2>
              <div className="env__shot">
                <div className="shot shot--bare">
                  <div className="rg-win p-5 font-mono text-xs space-y-2.5 text-left">
                    <p className="text-zinc-500 text-[11px] uppercase tracking-wider font-semibold">Listener Topologies</p>
                    <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 flex items-center justify-between">
                      <div>
                        <p className="text-zinc-950 font-semibold">Local Workstation (:8080)</p>
                        <p className="text-zinc-500 text-[11px]">./data/relaygate.db · 10 workers</p>
                      </div>
                      <span className="text-zinc-800 font-medium text-[11px]">CONNECTED</span>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 flex items-center justify-between">
                      <div>
                        <p className="text-zinc-950 font-semibold">Production Edge (systemd)</p>
                        <p className="text-zinc-500 text-[11px]">/var/lib/relaygate/wal.db · 50 workers</p>
                      </div>
                      <span className="text-zinc-500 text-[11px]">SSH / TLS</span>
                    </div>
                    <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 flex items-center justify-between">
                      <div>
                        <p className="text-zinc-950 font-semibold">Private Tailnet Console</p>
                        <p className="text-zinc-500 text-[11px]">100.64.0.18:8080 · WireGuard</p>
                      </div>
                      <span className="text-zinc-500 text-[11px]">TAILSCALE</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="env__right">
              <div className="env__list">
                <div className="env__item">
                  <h3 className="subhead">Drop in and run.</h3>
                  <p>The binary bundles its SQLite WAL schema and web console. Nothing to install twice.</p>
                </div>
                <div className="env__item">
                  <h3 className="subhead">Any Linux host, under systemd.</h3>
                  <p>
                    Pass -addr, -db, and -workers to bind the ingestion listener and worker pool on any VM or bare-metal server.
                  </p>
                  <div className="env__code">
                    <CopyCommand
                      prompt="$"
                      command="./relaygate -addr :8080 -db ./data/relaygate.db -workers 50"
                      small
                      copyable={false}
                    />
                  </div>
                </div>
                <div className="env__item">
                  <h3 className="subhead">Split public ingress from private admin.</h3>
                  <p>
                    Route /v1/webhook through your public reverse proxy while keeping the operator dashboard bound to your private tailnet.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 9. Questions / FAQ (#faq) */}
        <section className="faq rg-container" id="faq" aria-labelledby="faq-title">
          <div className="faq__grid">
            <h2 className="statement faq__title">
              <span id="faq-title">Questions.</span>
            </h2>
            <div className="faq__list">
              {FAQ_ITEMS.map((item) => (
                <details key={item.q} className="faq__item">
                  <summary>
                    <h3 className="faq__q">{item.q}</h3>
                    <Plus className="w-4 h-4 faq__icon" aria-hidden="true" />
                  </summary>
                  <p className="faq__a">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* 10. Run RelayGate / Quickstart Tabs (#download) */}
        <section className="download section rg-container" id="download">
          <h2 className="display download__title">Run RelayGate.</h2>

          <div className="dl">
            <div className="dl__bar">
              <div className="dl__tabs" role="tablist" aria-label="Deployment environment">
                {OS_TABS.map(({ id, label }, idx) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`dl-tab-${id}`}
                    aria-selected={activeOsTab === id}
                    aria-controls="dl-panel"
                    tabIndex={activeOsTab === id ? 0 : -1}
                    className="dl__tab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                    onClick={() => setActiveOsTab(id)}
                    onKeyDown={(e) => {
                      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                      if (!dir) return;
                      const next = OS_TABS[(idx + dir + OS_TABS.length) % OS_TABS.length];
                      setActiveOsTab(next.id);
                      document.getElementById(`dl-tab-${next.id}`)?.focus();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="dl__panel" role="tabpanel" id="dl-panel" aria-labelledby={`dl-tab-${activeOsTab}`}>
              {activeOsTab === 'linux' && (
                <>
                  <CopyCommand
                    prompt="$"
                    command="go build -o relaygate ./cmd/relaygate && ./relaygate -addr :8080 -db ./data/relaygate.db -workers 10"
                  />
                  <ul className="dl__files">
                    <li className="border-b border-zinc-200">
                      <button
                        type="button"
                        onClick={() => setExpandedAsset(expandedAsset === 'binary' ? null : 'binary')}
                        className="dl__file w-full text-left cursor-pointer hover:bg-zinc-50/80 px-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                        aria-expanded={expandedAsset === 'binary'}
                      >
                        <span className="dl__file-name">relaygate-linux-amd64</span>
                        <span className="dl__file-ext">static binary · pure Go SQLite WAL</span>
                        <ArrowDown className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${expandedAsset === 'binary' ? 'rotate-180' : ''}`} />
                      </button>
                      {expandedAsset === 'binary' && (
                        <div className="mb-3 px-3 py-3 rounded-xl bg-zinc-900 text-zinc-100 font-mono text-xs">
                          <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-800 text-[11px] text-zinc-400">
                            <span>Cross-compile static Linux binary</span>
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  if (navigator.clipboard) {
                                    await navigator.clipboard.writeText(RELAYGATE_CROSS_COMPILE);
                                  }
                                } catch {}
                                setCopiedCrossBuild(true);
                                setTimeout(() => setCopiedCrossBuild(false), 2000);
                              }}
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1 cursor-pointer transition-colors"
                            >
                              {copiedCrossBuild ? <Check className="w-3 h-3 text-zinc-100" /> : <Copy className="w-3 h-3 text-zinc-400" />}
                              <span>{copiedCrossBuild ? 'Copied' : 'Copy'}</span>
                            </button>
                          </div>
                          <p className="text-zinc-300 break-all select-all">
                            $ {RELAYGATE_CROSS_COMPILE}
                          </p>
                        </div>
                      )}
                    </li>
                    <li className="border-b border-zinc-200">
                      <button
                        type="button"
                        onClick={() => setExpandedAsset(expandedAsset === 'service' ? null : 'service')}
                        className="dl__file w-full text-left cursor-pointer hover:bg-zinc-50/80 px-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
                        aria-expanded={expandedAsset === 'service'}
                      >
                        <span className="dl__file-name">relaygate.service</span>
                        <span className="dl__file-ext">systemd unit · click to view &amp; download</span>
                        <ArrowDown className={`w-4 h-4 text-zinc-500 transition-transform duration-200 ${expandedAsset === 'service' ? 'rotate-180' : ''}`} />
                      </button>
                      {expandedAsset === 'service' && (
                        <div className="mb-3 px-3 py-3 rounded-xl bg-zinc-900 text-zinc-100 font-mono text-xs">
                          <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-800 text-[11px] text-zinc-400">
                            <span>/etc/systemd/system/relaygate.service</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadTextFile('relaygate.service', RELAYGATE_SYSTEMD_SERVICE);
                                }}
                                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1 cursor-pointer transition-colors"
                              >
                                <ArrowDown className="w-3 h-3 text-zinc-400" />
                                <span>Download</span>
                              </button>
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    if (navigator.clipboard) {
                                      await navigator.clipboard.writeText(RELAYGATE_SYSTEMD_SERVICE);
                                    }
                                  } catch {}
                                  setCopiedService(true);
                                  setTimeout(() => setCopiedService(false), 2000);
                                }}
                                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] flex items-center gap-1 cursor-pointer transition-colors"
                              >
                                {copiedService ? <Check className="w-3 h-3 text-zinc-100" /> : <Copy className="w-3 h-3 text-zinc-400" />}
                                <span>{copiedService ? 'Copied' : 'Copy'}</span>
                              </button>
                            </div>
                          </div>
                          <pre className="text-zinc-300 text-[11px] leading-relaxed overflow-x-auto whitespace-pre select-all">
                            {RELAYGATE_SYSTEMD_SERVICE}
                          </pre>
                        </div>
                      )}
                    </li>
                  </ul>
                  <p className="dl__note">
                    x86_64 and ARM64 Linux. Runs as an unprivileged user (UID 1000) without external broker dependencies.
                  </p>
                </>
              )}

              {activeOsTab === 'windows' && (
                <>
                  <CopyCommand
                    prompt=">"
                    command="go build -o relaygate.exe ./cmd/relaygate; .\relaygate.exe -addr :8080 -db .\data\relaygate.db -workers 10"
                  />
                  <p className="dl__note">
                    Windows 10, Windows 11, and Windows Server 2022 (x64). Bundles the embedded operator console on port 8080.
                  </p>
                </>
              )}

              {activeOsTab === 'mac' && (
                <>
                  <CopyCommand
                    prompt="$"
                    command="go build -o relaygate ./cmd/relaygate && ./relaygate -addr :8080 -db ./data/relaygate.db -workers 10"
                  />
                  <p className="dl__note">
                    macOS on Apple Silicon (arm64) and Intel (x86_64). Ideal for local webhook testing and signature debugging.
                  </p>
                </>
              )}

              {activeOsTab === 'docker' && (
                <>
                  <CopyCommand
                    prompt="$"
                    command="docker build -t relaygate . && docker run -d -p 8080:8080 -v relaygate_data:/app/data relaygate"
                  />
                  <p className="dl__note">
                    Builds from the included rootless Dockerfile. Mounts <code>/app/data</code> for SQLite WAL persistence and dev avatars.
                  </p>
                </>
              )}

              {activeOsTab === 'curl' && (
                <>
                  <CopyCommand
                    prompt="$"
                    command={'curl -i -X POST http://127.0.0.1:8080/ingest/ep_sample -H "Stripe-Signature: t=1700000000,v1=..." -d \'{"id":"evt_1"}\''}
                  />
                  <div className="dl__pair">
                    <CopyCommand prompt="$" command="curl -s http://127.0.0.1:8080/healthz" small />
                    <CopyCommand prompt="$" command="go test -race -p 2 -count=1 ./..." small />
                  </div>
                  <p className="dl__note">
                    Send test webhooks directly to <code>/ingest/:endpoint_id</code> (or <code>/v1/webhook/:endpoint_id</code>) and watch them appear live in the console.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="download__actions">
            <button type="button" onClick={onOpenLogin} className="btn btn--solid">
              <span>Open Operator Console</span>
              <span className="btn__icon btn__icon--upright" aria-hidden="true">
                <span className="btn__arrow">
                  <ArrowUpRight className="w-4 h-4" />
                </span>
                <span className="btn__arrow btn__arrow--echo">
                  <ArrowUpRight className="w-4 h-4" />
                </span>
              </span>
            </button>
            <button type="button" onClick={onOpenRegister} className="btn btn--ghost">
              <span>Create Operator Account</span>
              <span className="btn__icon btn__icon--upright" aria-hidden="true">
                <span className="btn__arrow">
                  <ArrowUpRight className="w-4 h-4" />
                </span>
                <span className="btn__arrow btn__arrow--echo">
                  <ArrowUpRight className="w-4 h-4" />
                </span>
              </span>
            </button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="footer rg-container">
        <div className="footer__top flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <RelayGateMark size={22} className="text-zinc-950 shrink-0" />
            <span className="font-bold text-base tracking-tight text-zinc-950">RelayGate</span>
          </div>
          <nav className="footer__links" aria-label="Footer">
            <button type="button" onClick={onOpenLogin} className="cursor-pointer">
              Console
            </button>
            <a
              href="#native"
              onClick={(e) => {
                e.preventDefault();
                scrollToSection('native');
              }}
            >
              Engine
            </a>
            <a
              href="#product"
              onClick={(e) => {
                e.preventDefault();
                scrollToSection('product');
              }}
            >
              Product
            </a>
            <a
              href="#workspace"
              onClick={(e) => {
                e.preventDefault();
                scrollToSection('workspace');
              }}
            >
              Workspace
            </a>
            <a
              href="#download"
              onClick={(e) => {
                e.preventDefault();
                scrollToSection('download');
              }}
            >
              Deploy
            </a>
            <a
              href="#faq"
              onClick={(e) => {
                e.preventDefault();
                scrollToSection('faq');
              }}
            >
              Questions
            </a>
          </nav>
        </div>

        <div className="footer__word">relaygate</div>

        <div className="footer__meta">
          <span className="metaline">© 2026 RelayGate</span>
          <span className="metaline">Webhook Gateway</span>
        </div>
      </footer>
    </div>
  );
}
