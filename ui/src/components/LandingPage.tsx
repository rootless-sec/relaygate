import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  ArrowDown,
  Check,
  Copy,
  Lock,
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
    body: 'Watch inbound deliveries arrive over WebSocket in real time. Pause the stream at any moment to inspect a burst without losing buffered frames.',
  },
  {
    id: 'inspector',
    label: 'Payload & header inspector',
    body: 'Open any delivery in a side drawer to examine raw JSON bodies, response status codes, and automatically masked credential headers.',
  },
  {
    id: 'dlq',
    label: 'Dead-letter triage',
    body: 'Filter failed deliveries by failure family. RelayGate separates unrecoverable signature defects from retryable downstream timeouts.',
  },
  {
    id: 'endpoints',
    label: 'Endpoint routing',
    body: 'Register target URLs, rotate signing secrets, and tune per-route concurrency and timeout budgets from one table.',
  },
];

const FAQ_ITEMS = [
  {
    q: 'What is RelayGate?',
    a: 'RelayGate is a self-hosted webhook ingestion gateway and dispatch engine compiled into a single Go binary. It verifies cryptographic signatures at the edge, persists payloads in an embedded SQLite WAL queue, and fans out deliveries to your downstream services with automatic exponential backoff.',
  },
  {
    q: 'Which webhook providers does RelayGate verify?',
    a: 'Stripe (v1 timestamped HMAC-SHA256), GitHub (X-Hub-Signature-256), Shopify (Base64 HMAC-SHA256), Xendit (static callback token), Midtrans (SHA-512 order signature), and any custom HMAC-SHA256 or static token sender.',
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
    q: 'Do webhook payloads or signing secrets leave my server?',
    a: 'RelayGate has no external cloud dependency. All raw payloads, endpoint signing secrets, and delivery audit logs remain on your machine inside your local SQLite database.',
  },
  {
    q: 'How does RelayGate protect sensitive HTTP headers?',
    a: 'Headers matching Authorization, Token, Signature, or Secret are masked at the API boundary by default. Exporting a delivery as a cURL command automatically substitutes <TOKEN> placeholders so secrets never leak into shell history.',
  },
];

function RelayGateMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.18l6.5 3.61v7.22L12 18.62l-6.5-3.61V7.79L12 4.18z"
        fill="currentColor"
      />
      <path d="M12 7.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zm0 2a2.5 2.5 0 110 5 2.5 2.5 0 010-5z" fill="currentColor" />
    </svg>
  );
}

function ProviderMark({ provider, size = 20 }: { provider: string; size?: number }) {
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
      rx: (0.5 - py) * 6,
      ry: (px - 0.5) * 6,
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
            className="copy__btn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            onClick={handleCopy}
            aria-label={copied ? 'Copied' : 'Copy command'}
          >
            {copied ? <Check className="w-4 h-4 text-zinc-100" /> : <Copy className="w-4 h-4" />}
          </button>
          <span className="copy__feedback" role="status" aria-live="polite">
            {copied ? 'Copied to clipboard' : ''}
          </span>
        </>
      )}
    </div>
  );
}

function WorkspacePreview({ stepIndex }: { stepIndex: number }) {
  if (stepIndex === 0) {
    return (
      <div className="shot shot--bare">
        <div className="rg-win">
          <div className="rg-win__bar">
            <div className="rg-win__dots">
              <i />
              <i />
              <i />
            </div>
            <span className="rg-win__title">relaygate :: live event stream (ws://127.0.0.1:8080/api/v1/ws)</span>
            <span className="font-mono text-[11px] text-zinc-400">STREAM ACTIVE</span>
          </div>
          <div className="p-5 grid grid-cols-1 sm:grid-cols-12 gap-4 text-left">
            <div className="sm:col-span-4 border-r border-white/[0.08] pr-4 space-y-2.5">
              <p className="metaline">Active Routes</p>
              {['ep_stripe_billing', 'ep_github_hooks', 'ep_xendit_payout', 'ep_midtrans_core'].map((ep, idx) => (
                <div
                  key={ep}
                  className={`px-3 py-2 rounded-lg text-xs font-mono flex items-center justify-between ${
                    idx === 0 ? 'bg-white/[0.08] text-zinc-100 border border-white/[0.14]' : 'text-zinc-400'
                  }`}
                >
                  <span>{ep}</span>
                  <span className="text-zinc-500">202</span>
                </div>
              ))}
            </div>
            <div className="sm:col-span-8 space-y-2 font-mono text-xs">
              <div className="flex items-center justify-between pb-2 border-b border-white/[0.08] text-zinc-400">
                <span>EVENT ID / PROVIDER</span>
                <span>LATENCY / STATUS</span>
              </div>
              {[
                { id: 'evt_992a8f10', prov: 'stripe', code: '200 OK', ms: '18 ms' },
                { id: 'evt_741c0b22', prov: 'github', code: '202 ACCEPTED', ms: '9 ms' },
                { id: 'evt_510e4d89', prov: 'xendit', code: '200 OK', ms: '24 ms' },
                { id: 'evt_309f1a77', prov: 'shopify', code: '200 OK', ms: '31 ms' },
              ].map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between py-2 px-2.5 rounded bg-white/[0.02] border border-white/[0.05]"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-zinc-200">{row.id}</span>
                    <span className="text-zinc-500">{row.prov}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-zinc-400">{row.ms}</span>
                    <span className="px-2 py-0.5 rounded bg-white/[0.07] text-zinc-200 text-[11px]">{row.code}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (stepIndex === 1) {
    return (
      <div className="shot shot--bare">
        <div className="rg-win">
          <div className="rg-win__bar">
            <div className="rg-win__dots">
              <i />
              <i />
              <i />
            </div>
            <span className="rg-win__title">InspectorDrawer :: evt_499cd52a (Headers &amp; Payload)</span>
            <span className="font-mono text-[11px] text-zinc-400">MASKED BY DEFAULT</span>
          </div>
          <div className="p-5 space-y-3 font-mono text-xs text-left">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-2.5">
              <span className="text-zinc-300">Headers (Sensitive tokens masked at API boundary)</span>
              <span className="px-2 py-0.5 rounded border border-white/[0.15] text-zinc-300 text-[11px]">
                Copy cURL (&lt;TOKEN&gt;)
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <div className="flex justify-between py-1.5 px-3 rounded bg-white/[0.03] border border-white/[0.06]">
                <span className="text-zinc-400">content-type</span>
                <span className="text-zinc-200">application/json</span>
              </div>
              <div className="flex justify-between py-1.5 px-3 rounded bg-white/[0.03] border border-white/[0.06]">
                <span className="text-zinc-400">stripe-signature</span>
                <span className="text-zinc-200">••••••••</span>
              </div>
              <div className="flex justify-between py-1.5 px-3 rounded bg-white/[0.03] border border-white/[0.06]">
                <span className="text-zinc-400">authorization</span>
                <span className="text-zinc-200">••••••••</span>
              </div>
            </div>
            <div className="p-3 rounded bg-white/[0.02] border border-white/[0.07] text-zinc-300">
              {`{"id":"evt_stripe_123","type":"invoice.payment_succeeded","livemode":true}`}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (stepIndex === 2) {
    return (
      <div className="shot shot--bare">
        <div className="rg-win">
          <div className="rg-win__bar">
            <div className="rg-win__dots">
              <i />
              <i />
              <i />
            </div>
            <span className="rg-win__title">DeadLetterView :: 8 Canonical Failure Families</span>
            <span className="font-mono text-[11px] text-zinc-400">ELIGIBLE FOR REPLAY</span>
          </div>
          <div className="p-5 space-y-2.5 font-mono text-xs text-left">
            {[
              {
                id: '499cd52a',
                family: 'Downstream error (5xx)',
                detail: 'HTTP 504 Gateway Timeout (5/5 attempts)',
                action: 'Replay (Reset 0/5)',
              },
              {
                id: 'e10029c1',
                family: 'Signature/token tidak cocok',
                detail: 'xendit callback token mismatch',
                action: 'Verifikasi ulang & kirim',
              },
              {
                id: '32a5285c',
                family: 'Signature/token hilang',
                detail: 'missing X-Callback-Token header',
                action: 'Ineligible (Request Defect)',
              },
            ].map((item) => (
              <div
                key={item.id}
                className="p-3 rounded-lg bg-white/[0.03] border border-white/[0.08] flex flex-wrap items-center justify-between gap-2"
              >
                <div>
                  <p className="text-zinc-100 font-semibold">{item.family}</p>
                  <p className="text-zinc-400 text-[11px] mt-0.5">
                    {item.id} · {item.detail}
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded bg-white/[0.08] text-zinc-200 text-[11px] border border-white/[0.12]">
                  {item.action}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shot shot--bare">
      <div className="rg-win">
        <div className="rg-win__bar">
          <div className="rg-win__dots">
            <i />
            <i />
            <i />
          </div>
          <span className="rg-win__title">EndpointsView :: Downstream Route Registry</span>
          <span className="font-mono text-[11px] text-zinc-400">4 ACTIVE ROUTES</span>
        </div>
        <div className="p-5 space-y-2.5 font-mono text-xs text-left">
          {[
            { name: 'Billing Core', provider: 'stripe', target: 'https://internal.api/v1/stripe', max: '5 attempts' },
            { name: 'CI Deployment Hook', provider: 'github', target: 'https://runner.internal/hooks', max: '5 attempts' },
            { name: 'Disbursement Sync', provider: 'xendit', target: 'https://ledger.internal/xendit', max: '5 attempts' },
          ].map((ep) => (
            <div
              key={ep.name}
              className="p-3 rounded-lg bg-white/[0.03] border border-white/[0.08] flex items-center justify-between gap-3"
            >
              <div>
                <p className="text-zinc-100 font-semibold">{ep.name}</p>
                <p className="text-zinc-400 text-[11px] mt-0.5">{ep.target}</p>
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 rounded bg-white/[0.07] text-zinc-200 text-[11px] uppercase">
                  {ep.provider}
                </span>
                <p className="text-zinc-500 text-[11px] mt-1">{ep.max}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LandingPage({ onOpenLogin, onOpenRegister }: LandingPageProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeWsStep, setActiveWsStep] = useState(0);
  const [activeOsTab, setActiveOsTab] = useState<OsTabId>('linux');
  const wsStepsRef = useRef<HTMLOListElement>(null);

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
      { rootMargin: '-35% 0px -55% 0px' }
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
    <div className="rg-landing min-h-screen bg-casino-bg text-zinc-100 selection:bg-white selection:text-casino-bg">
      {/* =====================================================================
          TOP HERO SECTION: Faithful to https://recent.design/i/dtnuyvc-casino-hero-section
          Adapted for RelayGate
      ===================================================================== */}
      <div className="relative overflow-hidden bg-casino-bg casino-grain">
        <header className="relative z-30 w-full max-w-[1440px] mx-auto px-6 sm:px-10 lg:px-14 h-20 flex items-center justify-between">
          <div className="flex items-center gap-10">
            <a
              href="#top"
              className="inline-flex items-center gap-2.5 text-white font-semibold text-base tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded-lg py-1"
            >
              <RelayGateMark size={20} />
              <span className="font-bold tracking-tight">RelayGate</span>
            </a>

            <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-8">
              <a
                href="#native"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('native');
                }}
                className="text-[14px] font-medium text-zinc-400 hover:text-white transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
              >
                Engine
              </a>
              <a
                href="#product"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('product');
                }}
                className="text-[14px] font-medium text-zinc-400 hover:text-white transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
              >
                Product
              </a>
              <a
                href="#workspace"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('workspace');
                }}
                className="text-[14px] font-medium text-zinc-400 hover:text-white transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
              >
                Workspace
              </a>
              <a
                href="#download"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('download');
                }}
                className="text-[14px] font-medium text-zinc-400 hover:text-white transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
              >
                Deploy
              </a>
              <a
                href="#faq"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('faq');
                }}
                className="text-[14px] font-medium text-zinc-400 hover:text-white transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
              >
                Questions
              </a>
            </nav>
          </div>

          <div className="hidden md:flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenLogin}
              className="min-h-[44px] px-4 py-2 rounded-lg text-[13px] font-medium text-zinc-200 bg-white/[0.06] hover:bg-white/[0.11] border border-white/[0.08] transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 cursor-pointer"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={onOpenRegister}
              className="min-h-[44px] px-4 py-2 rounded-lg text-[13px] font-semibold text-casino-bg bg-white hover:bg-zinc-200 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 cursor-pointer"
            >
              Get started
            </button>
          </div>

          <div className="flex md:hidden items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-expanded={mobileMenuOpen}
              aria-label="Toggle navigation menu"
              className="min-h-[44px] px-3.5 py-2 rounded-lg bg-white/[0.06] border border-white/[0.1] text-zinc-100 inline-flex items-center gap-2 text-xs font-medium active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
              <span>Menu</span>
            </button>
          </div>
        </header>

        {mobileMenuOpen && (
          <div className="md:hidden relative z-30 mx-6 mb-4 p-4 rounded-xl bg-casino-surface border border-white/[0.1] space-y-3">
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
                  className="min-h-[44px] px-3 flex items-center rounded-lg text-sm font-medium text-zinc-200 hover:bg-white/[0.06]"
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="pt-2 border-t border-white/[0.08] grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onOpenLogin();
                }}
                className="min-h-[44px] px-4 py-2.5 rounded-lg text-xs font-medium text-zinc-100 bg-white/[0.06] border border-white/[0.1] active:scale-[0.97]"
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onOpenRegister();
                }}
                className="min-h-[44px] px-4 py-2.5 rounded-lg text-xs font-semibold text-casino-bg bg-white active:scale-[0.97]"
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Hero Copy Stack */}
        <section id="top" className="relative z-20 max-w-[920px] mx-auto px-6 pt-10 sm:pt-14 pb-8 text-center flex flex-col items-center">
          <button
            type="button"
            onClick={() => scrollToSection('native')}
            className="group min-h-[36px] inline-flex items-center gap-2.5 pl-1.5 pr-3.5 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 cursor-pointer"
          >
            <span className="px-2 py-0.5 rounded-full bg-white text-casino-bg text-[11px] font-bold tracking-tight">
              New
            </span>
            <span className="text-[12px] font-medium text-zinc-200">
              Zero-dependency webhook gateway
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-zinc-400 group-hover:translate-x-0.5 transition-transform" />
          </button>

          <h1 className="mt-6 text-[clamp(2.5rem,4.5vw,4.125rem)] font-bold tracking-[-0.035em] leading-[1.06] text-white">
            Every webhook.
            <br />
            Zero dropped events.
          </h1>

          <p className="mt-4 text-[15px] sm:text-[16px] leading-[1.55] text-zinc-300 max-w-[52ch]">
            RelayGate verifies, queues, and dispatches Stripe, GitHub, and Xendit webhooks in one native Go binary.
          </p>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onOpenLogin}
              className="min-h-[44px] px-5 py-2.5 rounded-lg text-[13px] font-semibold text-casino-bg bg-white hover:bg-zinc-200 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 cursor-pointer"
            >
              Open Console
            </button>
            <button
              type="button"
              onClick={() => scrollToSection('native')}
              className="min-h-[44px] px-5 py-2.5 rounded-lg text-[13px] font-medium text-zinc-200 bg-white/[0.06] hover:bg-white/[0.11] border border-white/[0.08] transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 cursor-pointer"
            >
              Explore Engine
            </button>
          </div>
        </section>

        {/* Hero Centerpiece Artwork from https://recent.design/i/dtnuyvc-casino-hero-section */}
        <div className="relative z-10 w-full max-w-[1920px] mx-auto mt-1 select-none pointer-events-none">
          <img
            src="/hero-roulette.webp"
            alt="RelayGate high-stakes webhook ingestion centerpiece"
            width={1920}
            height={764}
            loading="eager"
            className="w-full h-auto block object-cover"
          />
        </div>
      </div>

      {/* =====================================================================
          BODY SECTIONS: Following https://kybern.treshnanda.tech/
          Adapted 100% for RelayGate (Monochrome Bone on Carbon, Zero Slop)
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

        {/* 3. Feature 1: Worker Pool & Automatic Retries (#product) */}
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
                <div className="shot shot--bare">
                  <div className="rg-win">
                    <div className="rg-win__bar">
                      <div className="rg-win__dots">
                        <i />
                        <i />
                        <i />
                      </div>
                      <span className="rg-win__title">Dispatch Worker Pool :: 4 active workers across 3 harnesses</span>
                      <span className="font-mono text-[11px] text-zinc-400">WAL SYNCED</span>
                    </div>
                    <div className="p-5 text-left space-y-4">
                      <div className="flex items-center justify-between text-xs font-mono text-zinc-400 border-b border-white/[0.08] pb-3">
                        <span>3 active routes · 50 concurrent workers</span>
                        <span>SQLite WAL checkpoint: 0.38 ms</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse font-mono text-xs">
                          <thead>
                            <tr className="border-b border-white/[0.1] text-zinc-400">
                              <th className="py-2 pr-3 font-medium">Route</th>
                              <th className="py-2 px-3 font-medium">Provider / Policy</th>
                              <th className="py-2 pl-3 font-medium">What it&apos;s doing</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.06] text-zinc-300">
                            <tr>
                              <td className="py-2.5 pr-3 text-zinc-100 font-medium">ep_7efe4e7e</td>
                              <td className="py-2.5 px-3 text-zinc-400">Stripe · HMAC-SHA256</td>
                              <td className="py-2.5 pl-3">
                                Verifies timestamp tolerance (300s), writes raw body to WAL, dispatches HTTP POST to billing service.
                              </td>
                            </tr>
                            <tr>
                              <td className="py-2.5 pr-3 text-zinc-100 font-medium">ep_97aaeddd</td>
                              <td className="py-2.5 px-3 text-zinc-400">Xendit · Static Token</td>
                              <td className="py-2.5 pl-3">
                                Compares X-Callback-Token in constant time, schedules retry 2/5 after downstream 504 timeout.
                              </td>
                            </tr>
                            <tr>
                              <td className="py-2.5 pr-3 text-zinc-100 font-medium">ep_midtrans</td>
                              <td className="py-2.5 px-3 text-zinc-400">Midtrans · SHA-512</td>
                              <td className="py-2.5 pl-3">
                                Computes SHA-512(order_id + status_code + gross_amount + secret) and delivers in 14 ms.
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </TiltFrame>
            </div>
          </div>
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
                <div className="shot shot--bare">
                  <div className="rg-win">
                    <div className="rg-win__bar">
                      <div className="rg-win__dots">
                        <i />
                        <i />
                        <i />
                      </div>
                      <span className="rg-win__title">BulkReplayModal :: Verification &amp; Quota Reset</span>
                      <span className="font-mono text-[11px] text-zinc-400">QUOTA 0/5 -&gt; 5/5</span>
                    </div>
                    <div className="p-5 text-left space-y-3.5 font-mono text-xs">
                      <div className="p-3.5 rounded-lg bg-white/[0.03] border border-white/[0.09] space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-100 font-semibold">evt_499cd52a · Stripe 504 Gateway Timeout</span>
                          <span className="px-2 py-0.5 rounded bg-white/[0.09] text-zinc-100 text-[11px]">
                            Eligible for Replay
                          </span>
                        </div>
                        <p className="text-zinc-400 text-[11px]">
                          Dijadwalkan ulang dari antrean Dead-Letter dengan reset kuota hingga 5 percobaan baru.
                        </p>
                      </div>
                      <div className="grid grid-cols-3 gap-2.5 text-center">
                        <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                          <p className="text-zinc-400 text-[11px]">VERIFIED</p>
                          <p className="text-zinc-100 text-base font-bold mt-1">HMAC OK</p>
                        </div>
                        <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                          <p className="text-zinc-400 text-[11px]">LAST HTTP</p>
                          <p className="text-zinc-100 text-base font-bold mt-1">504</p>
                        </div>
                        <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                          <p className="text-zinc-400 text-[11px]">RETRY BUDGET</p>
                          <p className="text-zinc-100 text-base font-bold mt-1">5 Attempts</p>
                        </div>
                      </div>
                    </div>
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
                    <WorkspacePreview stepIndex={idx} />
                  </div>
                </li>
              ))}
            </ol>

            <div className="ws__sticky" aria-hidden="true">
              <WorkspacePreview stepIndex={activeWsStep} />
              <div className="ws__progress">
                {WORKSPACE_STEPS.map((step, idx) => (
                  <span key={step.id} data-active={activeWsStep === idx ? 'true' : undefined} />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 6. Details & 9-Tile Grid */}
        <section className="details rg-container">
          <h2 className="headline details__title">Details.</h2>

          <div className="details__row">
            <div className="details__item" style={{ '--grow': 0.72 } as React.CSSProperties}>
              <figure>
                <div className="shot shot--bare">
                  <div className="rg-win p-4 font-mono text-xs space-y-2 text-left">
                    <p className="text-zinc-400 text-[11px] uppercase tracking-wider">Credential Redaction</p>
                    <div className="p-2.5 rounded bg-white/[0.03] border border-white/[0.07] flex justify-between">
                      <span className="text-zinc-400">Authorization</span>
                      <span className="text-zinc-100">••••••••</span>
                    </div>
                    <div className="p-2.5 rounded bg-white/[0.03] border border-white/[0.07] flex justify-between">
                      <span className="text-zinc-400">X-Callback-Token</span>
                      <span className="text-zinc-100">&lt;TOKEN&gt;</span>
                    </div>
                  </div>
                </div>
                <figcaption>
                  <h3 className="subhead">Sensitive header masking</h3>
                  <p>Credentials stay masked in the UI and export as &lt;TOKEN&gt; in cURL.</p>
                </figcaption>
              </figure>
            </div>

            <div className="details__item details__item--wide" style={{ '--grow': 1.32 } as React.CSSProperties}>
              <figure>
                <div className="shot shot--bare">
                  <div className="rg-win p-4 font-mono text-xs space-y-3 text-left">
                    <div className="flex items-center justify-between">
                      <span className="text-zinc-200 font-semibold">Exponential Backoff Schedule</span>
                      <span className="text-zinc-400">5 Attempts · ±15% Jitter</span>
                    </div>
                    <div className="grid grid-cols-5 gap-1.5 text-center">
                      {['1s', '2s', '4s', '8s', '16s'].map((delay, i) => (
                        <div key={delay} className="p-2 rounded bg-white/[0.04] border border-white/[0.08]">
                          <p className="text-zinc-500 text-[10px]">TRY {i + 1}</p>
                          <p className="text-zinc-100 font-bold mt-0.5">{delay}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <figcaption>
                  <h3 className="subhead">Attempt budget &amp; quota reset</h3>
                  <p>See which attempt each delivery is on and reset the full 5-attempt budget on replay.</p>
                </figcaption>
              </figure>
            </div>

            <div className="details__item" style={{ '--grow': 0.72 } as React.CSSProperties}>
              <figure>
                <div className="shot shot--bare">
                  <div className="rg-win p-4 font-mono text-xs space-y-2 text-left">
                    <p className="text-zinc-400 text-[11px] uppercase tracking-wider">Batch Audit Summary</p>
                    <div className="p-2.5 rounded bg-white/[0.03] border border-white/[0.07] text-zinc-200">
                      12 lolos verifikasi
                    </div>
                    <div className="p-2.5 rounded bg-white/[0.03] border border-white/[0.07] text-zinc-400">
                      2 dikecualikan otomatis
                    </div>
                  </div>
                </div>
                <figcaption>
                  <h3 className="subhead">Honest bulk replay</h3>
                  <p>Ineligible signature defects are excluded automatically before replay.</p>
                </figcaption>
              </figure>
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
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <GitBranch className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Multi-provider routes</h3>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <PauseCircle className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Pause mid-stream</h3>
                  <p className="tile__body">Freeze the live WebSocket feed while inspecting a payload drawer.</p>
                </div>
              </li>
              <li>
                <div className="tile">
                  <span className="tile__icon">
                    <Sliders className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Bounded worker pool</h3>
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
                    <HardDrive className="w-[18px] h-[18px]" />
                  </span>
                  <h3 className="tile__title">Embedded web UI</h3>
                  <p className="tile__body">Compiled into the Go binary via embed.FS with zero external assets.</p>
                </div>
              </li>
            </ul>

            <button
              type="button"
              onClick={onOpenLogin}
              className="more__link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 rounded"
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
                <Shield className="w-[18px] h-[18px] shrink-0" />
                <span>
                  <strong>Webhook Senders</strong>
                  <small>Stripe · GitHub · Xendit</small>
                </span>
              </li>
              <li className="mach__client">
                <Layers className="w-[18px] h-[18px] shrink-0" />
                <span>
                  <strong>Operator Console</strong>
                  <small>Browser · WebSocket</small>
                </span>
              </li>
              <li className="mach__client">
                <Terminal className="w-[18px] h-[18px] shrink-0" />
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
                <RelayGateMark size={20} />
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
                  <Lock className="w-3.5 h-3.5" />
                  <span>Payloads</span>
                </li>
                <li>
                  <Lock className="w-3.5 h-3.5" />
                  <span>Signing Secrets</span>
                </li>
                <li>
                  <Lock className="w-3.5 h-3.5" />
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
                    <p className="text-zinc-400 text-[11px] uppercase tracking-wider">Listener Topologies</p>
                    <div className="p-3 rounded-lg bg-white/[0.04] border border-white/[0.1] flex items-center justify-between">
                      <div>
                        <p className="text-zinc-100 font-semibold">Local Workstation (:8080)</p>
                        <p className="text-zinc-400 text-[11px]">./data/relaygate.db · 10 workers</p>
                      </div>
                      <span className="text-zinc-200 text-[11px]">CONNECTED</span>
                    </div>
                    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] flex items-center justify-between">
                      <div>
                        <p className="text-zinc-200 font-semibold">Production Edge (systemd)</p>
                        <p className="text-zinc-500 text-[11px]">/var/lib/relaygate/wal.db · 50 workers</p>
                      </div>
                      <span className="text-zinc-400 text-[11px]">SSH / TLS</span>
                    </div>
                    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] flex items-center justify-between">
                      <div>
                        <p className="text-zinc-200 font-semibold">Private Tailnet Console</p>
                        <p className="text-zinc-500 text-[11px]">100.64.0.18:8080 · WireGuard</p>
                      </div>
                      <span className="text-zinc-400 text-[11px]">TAILSCALE</span>
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
                    className="dl__tab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
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
                    <li className="dl__file">
                      <span className="dl__file-name">relaygate-linux-amd64</span>
                      <span className="dl__file-ext">static binary · SQLite WAL embedded</span>
                      <ArrowDown className="w-4 h-4 text-zinc-400" />
                    </li>
                    <li className="dl__file">
                      <span className="dl__file-name">relaygate.service</span>
                      <span className="dl__file-ext">systemd unit</span>
                      <ArrowDown className="w-4 h-4 text-zinc-400" />
                    </li>
                  </ul>
                  <p className="dl__note">
                    x86_64 and ARM64 Linux. Runs as an unprivileged user with zero external runtime dependencies.
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
                    Windows 10, Windows 11, and Windows Server 2022 (x64). Bundles the embedded React operator console on port 8080.
                  </p>
                </>
              )}

              {activeOsTab === 'mac' && (
                <>
                  <CopyCommand
                    prompt="$"
                    command="go build -o relaygate ./cmd/relaygate && ./relaygate -addr :8080 -db ./data/relaygate.db"
                  />
                  <p className="dl__note">
                    macOS on Apple Silicon and Intel. Ideal for local webhook testing and signature debugging.
                  </p>
                </>
              )}

              {activeOsTab === 'docker' && (
                <>
                  <CopyCommand
                    prompt="$"
                    command="docker run -d -p 8080:8080 -v relaygate_data:/app/data ghcr.io/rootless-sec/relaygate:latest"
                  />
                  <p className="dl__note">
                    Mount <code>/app/data</code> to persist the SQLite WAL database and avatar assets across container restarts.
                  </p>
                </>
              )}

              {activeOsTab === 'curl' && (
                <>
                  <CopyCommand
                    prompt="$"
                    command='curl -i -X POST http://127.0.0.1:8080/v1/webhook/ep_stripe -H "Stripe-Signature: t=1700000000,v1=..." -d "{\"id\":\"evt_1\"}"'
                  />
                  <div className="dl__pair">
                    <CopyCommand prompt="$" command="curl -s http://127.0.0.1:8080/healthz" small />
                    <CopyCommand prompt="$" command="go test -race -p 2 -count=1 ./..." small />
                  </div>
                  <p className="dl__note">
                    Send test webhooks directly to <code>/v1/webhook/:endpoint_id</code> and watch them appear live in the console.
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
        <div className="footer__top">
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
          <span className="metaline">Zero-Dependency Webhook Gateway</span>
        </div>
      </footer>
    </div>
  );
}
