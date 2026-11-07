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
  Play,
  Server,
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
    q: 'Do webhook payloads or signing secrets leave my server?',
    a: 'RelayGate has no external cloud dependency. All raw payloads, endpoint signing secrets, and delivery audit logs remain on your machine inside your local SQLite database.',
  },
  {
    q: 'How does RelayGate protect sensitive HTTP headers?',
    a: 'Headers matching Authorization, Token, Signature, or Secret are masked at the API boundary by default. Exporting a delivery as a cURL command automatically substitutes <TOKEN> placeholders so secrets never leak into shell history.',
  },
];

export function RelayGateMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polygon points="12 2.5 20.2 7.25 20.2 16.75 12 21.5 3.8 16.75 3.8 7.25" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
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

const SIMULATOR_PROVIDERS = [
  {
    id: 'stripe',
    name: 'Stripe',
    standard: 'v1 timestamped HMAC-SHA256',
    endpoint: '/v1/webhook/ep_stripe',
    target: 'https://billing.internal/stripe',
    headerName: 'Stripe-Signature',
    samplePayload: {
      id: 'evt_3Msw2CH8K91X92',
      object: 'event',
      type: 'invoice.payment_succeeded',
      created: 1700000000,
      data: { amount_paid: 4900, currency: 'usd' },
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    standard: 'X-Hub-Signature-256',
    endpoint: '/v1/webhook/ep_github',
    target: 'https://runner.internal/hooks',
    headerName: 'X-Hub-Signature-256',
    samplePayload: {
      action: 'push',
      ref: 'refs/heads/main',
      repository: { full_name: 'org/backend-core' },
      sender: { login: 'developer' },
    },
  },
  {
    id: 'shopify',
    name: 'Shopify',
    standard: 'Base64 HMAC-SHA256',
    endpoint: '/v1/webhook/ep_shopify',
    target: 'https://orders.internal/shopify',
    headerName: 'X-Shopify-Hmac-Sha256',
    samplePayload: {
      id: 82098291194615,
      topic: 'orders/create',
      order_number: 1042,
      total_price: '129.50',
    },
  },
  {
    id: 'xendit',
    name: 'Xendit',
    standard: 'Constant-time callback token',
    endpoint: '/v1/webhook/ep_xendit',
    target: 'https://ledger.internal/xendit',
    headerName: 'x-callback-token',
    samplePayload: {
      id: 'inv_9981294',
      status: 'PAID',
      external_id: 'disbursement_001',
      paid_amount: 500000,
    },
  },
  {
    id: 'midtrans',
    name: 'Midtrans',
    standard: 'SHA-512 order digest',
    endpoint: '/v1/webhook/ep_midtrans',
    target: 'https://payments.internal/midtrans',
    headerName: 'Signature-Key',
    samplePayload: {
      order_id: 'ORDER-2026-9901',
      transaction_status: 'settlement',
      gross_amount: '350000.00',
      status_code: '200',
    },
  },
];

function WebhookRoutingPipeline() {
  const [activeProvId, setActiveProvId] = useState('stripe');
  const [isSimulating, setIsSimulating] = useState(false);
  const [pipelineStep, setPipelineStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [simulateTimeout, setSimulateTimeout] = useState(false);
  const [lastLatency, setLastLatency] = useState('0.38 ms');
  const [deliveredCount, setDeliveredCount] = useState(148);

  const activeProvider = SIMULATOR_PROVIDERS.find((p) => p.id === activeProvId) || SIMULATOR_PROVIDERS[0];

  const handleSimulate = () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setPipelineStep(1);

    setTimeout(() => {
      setPipelineStep(2);
    }, 400);

    setTimeout(() => {
      setPipelineStep(3);
    }, 850);

    setTimeout(() => {
      setPipelineStep(4);
      setIsSimulating(false);
      setLastLatency((0.32 + Math.random() * 0.12).toFixed(2) + ' ms');
      if (!simulateTimeout) {
        setDeliveredCount((c) => c + 1);
      }
    }, 1300);
  };

  return (
    <div
      data-testid="webhook-pipeline"
      className="w-full max-w-[1240px] mx-auto mt-6 text-left rounded-2xl border border-zinc-200/90 bg-white shadow-xs overflow-hidden"
    >
      {/* Simulator Window Header */}
      <div className="bg-zinc-50 border-b border-zinc-200 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
          </div>
          <span className="font-mono text-xs font-semibold text-zinc-800">
            relaygate :: interactive routing pipeline
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-zinc-900 inline-block" />
          <span>ENGINE: ONLINE (UID 1000)</span>
          <span className="hidden sm:inline text-zinc-300">|</span>
          <span className="hidden sm:inline">WAL SYNC: {lastLatency}</span>
        </div>
      </div>

      {/* Control Bar: Provider Selector & Simulation Trigger */}
      <div className="p-4 sm:p-6 border-b border-zinc-200 bg-zinc-50/50 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-zinc-700 mr-1">Sender Node:</span>
          {SIMULATOR_PROVIDERS.map((prov) => {
            const isSelected = prov.id === activeProvId;
            return (
              <button
                key={prov.id}
                type="button"
                onClick={() => {
                  setActiveProvId(prov.id);
                  setPipelineStep(0);
                }}
                className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 inline-flex items-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 ${
                  isSelected
                    ? 'bg-zinc-900 text-white shadow-xs'
                    : 'bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-100'
                }`}
              >
                <ProviderMark provider={prov.id} size={15} />
                <span>{prov.name}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs text-zinc-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={simulateTimeout}
              onChange={(e) => setSimulateTimeout(e.target.checked)}
              className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
            />
            <span>Simulate 504 Timeout</span>
          </label>

          <button
            type="button"
            data-testid="send-test-webhook"
            onClick={handleSimulate}
            disabled={isSimulating}
            className="min-h-[44px] px-4 py-2 rounded-lg text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer inline-flex items-center gap-2 shadow-xs"
          >
            <Play className={`w-3.5 h-3.5 ${isSimulating ? 'rotate-90' : ''} transition-transform`} />
            <span>{isSimulating ? 'Routing Delivery...' : 'Send Test Webhook'}</span>
          </button>
        </div>
      </div>

      {/* Main Interactive Diagram: Provider -> RelayGate Ingestion Edge -> Target Downstream */}
      <div className="p-5 sm:p-8 bg-white">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          {/* Node 1: Ingress Sender */}
          <div className="lg:col-span-3">
            <div
              className={`p-4 rounded-xl border transition-all duration-200 ${
                pipelineStep >= 1 ? 'border-zinc-900 bg-zinc-50 shadow-xs' : 'border-zinc-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">01. Webhook Sender</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-100 text-zinc-700">POST :8080</span>
              </div>
              <div className="flex items-center gap-2.5 mb-2">
                <div className="p-1.5 rounded-md bg-zinc-900 text-white">
                  <ProviderMark provider={activeProvider.id} size={18} />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-zinc-950 leading-tight">{activeProvider.name}</h4>
                  <p className="text-[11px] font-mono text-zinc-500">{activeProvider.endpoint}</p>
                </div>
              </div>
              <div className="mt-3 pt-2.5 border-t border-zinc-100 font-mono text-[11px] text-zinc-500 space-y-1">
                <p className="truncate">Header: {activeProvider.headerName}</p>
                <p className="truncate">Event: {String(activeProvider.samplePayload.type || activeProvider.samplePayload.topic || activeProvider.samplePayload.status)}</p>
              </div>
            </div>
          </div>

          {/* Flow Wire 1 */}
          <div className="lg:col-span-1 hidden lg:flex flex-col items-center justify-center relative">
            <svg className="w-full h-8" viewBox="0 0 80 32" fill="none">
              <path
                d="M0 16 H80"
                stroke="currentColor"
                strokeWidth="2"
                className={`text-zinc-300 ${isSimulating ? 'rg-flow-wire text-zinc-900' : ''}`}
              />
            </svg>
            {isSimulating && (
              <span className="absolute text-[10px] font-mono font-semibold text-zinc-900 bg-zinc-100 px-1.5 py-0.5 rounded border border-zinc-300">
                POST
              </span>
            )}
          </div>

          {/* Node 2: RelayGate Core Engine Node */}
          <div className="lg:col-span-4">
            <div
              className={`p-5 rounded-xl border transition-all duration-200 ${
                pipelineStep >= 2 ? 'border-zinc-900 bg-zinc-50 shadow-xs rg-node-pulse' : 'border-zinc-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <RelayGateMark size={20} className="text-zinc-950" />
                  <span className="font-bold text-sm text-zinc-950">RelayGate Engine</span>
                </div>
                <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-zinc-100 text-zinc-800 font-medium">
                  HTTP 202 Accepted
                </span>
              </div>

              <div className="space-y-2.5 font-mono text-xs">
                {/* Stage A */}
                <div
                  className={`p-2.5 rounded-lg border transition-colors ${
                    pipelineStep >= 2
                      ? 'bg-white border-zinc-300 text-zinc-900 shadow-2xs'
                      : 'bg-zinc-50/60 border-zinc-100 text-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      1. Constant-Time HMAC Gate
                    </span>
                    <span className="text-[10px] font-bold text-zinc-700">0.12 ms</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Verifies cryptographic signature tolerance window (300s)
                  </p>
                </div>

                {/* Stage B */}
                <div
                  className={`p-2.5 rounded-lg border transition-colors ${
                    pipelineStep >= 3
                      ? 'bg-white border-zinc-300 text-zinc-900 shadow-2xs'
                      : 'bg-zinc-50/60 border-zinc-100 text-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5" />
                      2. Embedded SQLite WAL
                    </span>
                    <span className="text-[10px] font-bold text-zinc-700">0.26 ms</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Append-only fsync journal with zero external broker daemons
                  </p>
                </div>

                {/* Stage C */}
                <div
                  className={`p-2.5 rounded-lg border transition-colors ${
                    pipelineStep >= 4
                      ? 'bg-white border-zinc-300 text-zinc-900 shadow-2xs'
                      : 'bg-zinc-50/60 border-zinc-100 text-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold flex items-center gap-1.5">
                      <Sliders className="w-3.5 h-3.5" />
                      3. Dispatch Worker Pool
                    </span>
                    <span className="text-[10px] font-bold text-zinc-700">10 Workers</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Bounded concurrency with exponential backoff &amp; DLQ triage
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Flow Wire 2 */}
          <div className="lg:col-span-1 hidden lg:flex flex-col items-center justify-center relative">
            <svg className="w-full h-8" viewBox="0 0 80 32" fill="none">
              <path
                d="M0 16 H80"
                stroke="currentColor"
                strokeWidth="2"
                className={`text-zinc-300 ${isSimulating ? 'rg-flow-wire text-zinc-900' : ''}`}
              />
            </svg>
            {pipelineStep >= 3 && (
              <span className="absolute text-[10px] font-mono font-semibold text-zinc-900 bg-zinc-100 px-1.5 py-0.5 rounded border border-zinc-300">
                DISPATCH
              </span>
            )}
          </div>

          {/* Node 3: Target Downstream Service */}
          <div className="lg:col-span-3">
            <div
              className={`p-4 rounded-xl border transition-all duration-200 ${
                pipelineStep === 4
                  ? simulateTimeout
                    ? 'border-zinc-700 bg-zinc-50'
                    : 'border-zinc-900 bg-zinc-50 shadow-xs'
                  : 'border-zinc-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">03. Target Service</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                    pipelineStep === 4
                      ? simulateTimeout
                        ? 'bg-zinc-200 text-zinc-800'
                        : 'bg-zinc-900 text-white'
                      : 'bg-zinc-100 text-zinc-600'
                  }`}
                >
                  {pipelineStep === 4
                    ? simulateTimeout
                      ? 'HTTP 504 (Retry 1/5)'
                      : 'HTTP 200 OK'
                    : 'AWAITING DISPATCH'}
                </span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Server className="w-4 h-4 text-zinc-800" />
                <h4 className="text-sm font-bold text-zinc-950 truncate">Internal Downstream</h4>
              </div>
              <p className="font-mono text-[11px] text-zinc-500 truncate">{activeProvider.target}</p>
              <div className="mt-3 pt-2.5 border-t border-zinc-100 font-mono text-[11px] text-zinc-600 space-y-1">
                <div className="flex justify-between">
                  <span>Delivered:</span>
                  <span className="font-bold text-zinc-950">{deliveredCount}</span>
                </div>
                <div className="flex justify-between">
                  <span>Total Latency:</span>
                  <span className="font-bold text-zinc-950">{pipelineStep === 4 ? lastLatency : '--'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Live Payload & Execution Trace Bar */}
        <div className="mt-6 pt-5 border-t border-zinc-200 grid grid-cols-1 md:grid-cols-12 gap-4 text-xs font-mono">
          <div className="md:col-span-7 p-3 rounded-lg bg-zinc-50 border border-zinc-200">
            <div className="flex items-center justify-between mb-1.5 text-zinc-400 text-[11px]">
              <span>INBOUND PAYLOAD (JSON)</span>
              <span>MASKED CREDS</span>
            </div>
            <pre className="text-zinc-800 overflow-x-auto text-[11px] leading-relaxed">
              {JSON.stringify(activeProvider.samplePayload, null, 2)}
            </pre>
          </div>

          <div className="md:col-span-5 p-3 rounded-lg bg-zinc-50 border border-zinc-200 flex flex-col justify-between">
            <div>
              <p className="text-zinc-400 text-[11px] mb-2 uppercase">Execution Diagnostics</p>
              <ul className="space-y-1.5 text-zinc-700 text-[11px]">
                <li className="flex items-center justify-between">
                  <span>Cryptographic Gate:</span>
                  <span className="font-semibold text-zinc-950">Constant-time match</span>
                </li>
                <li className="flex items-center justify-between">
                  <span>WAL Journal Status:</span>
                  <span className="font-semibold text-zinc-950">Fsynced (zero broker)</span>
                </li>
                <li className="flex items-center justify-between">
                  <span>Worker Queue:</span>
                  <span className="font-semibold text-zinc-950">10 concurrent workers</span>
                </li>
                <li className="flex items-center justify-between">
                  <span>Downstream Policy:</span>
                  <span className="font-semibold text-zinc-950">5 attempts with jitter</span>
                </li>
              </ul>
            </div>
            <div className="mt-3 pt-2 border-t border-zinc-200 flex items-center justify-between text-[11px] text-zinc-500">
              <span>PID: 1000 (Non-root UID)</span>
              <span>Memory: 18 MB RSS</span>
            </div>
          </div>
        </div>
      </div>
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
            <span className="font-mono text-[11px] text-zinc-500">STREAM ACTIVE</span>
          </div>
          <div className="p-5 grid grid-cols-1 sm:grid-cols-12 gap-4 text-left">
            <div className="sm:col-span-4 border-r border-zinc-200 pr-4 space-y-2.5">
              <p className="metaline">Active Routes</p>
              {['ep_stripe_billing', 'ep_github_hooks', 'ep_xendit_payout', 'ep_midtrans_core'].map((ep, idx) => (
                <div
                  key={ep}
                  className={`px-3 py-2 rounded-lg text-xs font-mono flex items-center justify-between ${
                    idx === 0 ? 'bg-zinc-100 text-zinc-950 font-semibold border border-zinc-300' : 'text-zinc-600'
                  }`}
                >
                  <span>{ep}</span>
                  <span className="text-zinc-500">202</span>
                </div>
              ))}
            </div>
            <div className="sm:col-span-8 space-y-2 font-mono text-xs">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-200 text-zinc-500">
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
                  className="flex items-center justify-between py-2 px-2.5 rounded bg-zinc-50 border border-zinc-200"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-zinc-900 font-medium">{row.id}</span>
                    <span className="text-zinc-500">{row.prov}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-zinc-500">{row.ms}</span>
                    <span className="px-2 py-0.5 rounded bg-zinc-200 text-zinc-800 text-[11px] font-medium">{row.code}</span>
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
            <span className="font-mono text-[11px] text-zinc-500">MASKED BY DEFAULT</span>
          </div>
          <div className="p-5 space-y-3 font-mono text-xs text-left">
            <div className="flex items-center justify-between border-b border-zinc-200 pb-2.5">
              <span className="text-zinc-700 font-medium">Headers (Sensitive tokens masked at API boundary)</span>
              <span className="px-2 py-0.5 rounded border border-zinc-300 text-zinc-700 text-[11px]">
                Copy cURL (&lt;TOKEN&gt;)
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <div className="flex justify-between py-1.5 px-3 rounded bg-zinc-50 border border-zinc-200">
                <span className="text-zinc-500">content-type</span>
                <span className="text-zinc-900">application/json</span>
              </div>
              <div className="flex justify-between py-1.5 px-3 rounded bg-zinc-50 border border-zinc-200">
                <span className="text-zinc-500">stripe-signature</span>
                <span className="text-zinc-900">••••••••</span>
              </div>
              <div className="flex justify-between py-1.5 px-3 rounded bg-zinc-50 border border-zinc-200">
                <span className="text-zinc-500">authorization</span>
                <span className="text-zinc-900">••••••••</span>
              </div>
            </div>
            <div className="p-3 rounded bg-zinc-50 border border-zinc-200 text-zinc-800">
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
            <span className="font-mono text-[11px] text-zinc-500">ELIGIBLE FOR REPLAY</span>
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
                className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 flex flex-wrap items-center justify-between gap-2"
              >
                <div>
                  <p className="text-zinc-900 font-semibold">{item.family}</p>
                  <p className="text-zinc-500 text-[11px] mt-0.5">
                    {item.id} · {item.detail}
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded bg-zinc-200 text-zinc-800 text-[11px] font-medium border border-zinc-300">
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
          <span className="font-mono text-[11px] text-zinc-500">4 ACTIVE ROUTES</span>
        </div>
        <div className="p-5 space-y-2.5 font-mono text-xs text-left">
          {[
            { name: 'Billing Core', provider: 'stripe', target: 'https://internal.api/v1/stripe', max: '5 attempts' },
            { name: 'CI Deployment Hook', provider: 'github', target: 'https://runner.internal/hooks', max: '5 attempts' },
            { name: 'Disbursement Sync', provider: 'xendit', target: 'https://ledger.internal/xendit', max: '5 attempts' },
          ].map((ep) => (
            <div
              key={ep.name}
              className="p-3 rounded-lg bg-zinc-50 border border-zinc-200 flex items-center justify-between gap-3"
            >
              <div>
                <p className="text-zinc-900 font-semibold">{ep.name}</p>
                <p className="text-zinc-500 text-[11px] mt-0.5">{ep.target}</p>
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 rounded bg-zinc-200 text-zinc-800 text-[11px] font-medium uppercase">
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
    <div className="rg-landing min-h-screen bg-white text-zinc-900 selection:bg-zinc-900 selection:text-white">
      {/* =====================================================================
          TOP HEADER & HERO SECTION
          Optical White Canvas & Interactive Routing Pipeline Centerpiece
      ===================================================================== */}
      <div className="relative overflow-hidden bg-white rg-canvas-pattern">
        <header className="relative z-30 w-full max-w-[1440px] mx-auto px-6 sm:px-10 lg:px-14 h-20 flex items-center justify-between border-b border-zinc-200/80">
          <div className="flex items-center gap-10">
            <a
              href="#top"
              className="inline-flex items-center gap-2.5 text-zinc-950 font-semibold text-base tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded-lg py-1"
            >
              <RelayGateMark size={22} className="text-zinc-950" />
              <span className="font-bold tracking-tight">RelayGate</span>
            </a>

            <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-8">
              <a
                href="#native"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('native');
                }}
                className="text-[14px] font-medium text-zinc-600 hover:text-zinc-950 transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded"
              >
                Engine
              </a>
              <a
                href="#product"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('product');
                }}
                className="text-[14px] font-medium text-zinc-600 hover:text-zinc-950 transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded"
              >
                Product
              </a>
              <a
                href="#workspace"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('workspace');
                }}
                className="text-[14px] font-medium text-zinc-600 hover:text-zinc-950 transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded"
              >
                Workspace
              </a>
              <a
                href="#download"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('download');
                }}
                className="text-[14px] font-medium text-zinc-600 hover:text-zinc-950 transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded"
              >
                Deploy
              </a>
              <a
                href="#faq"
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSection('faq');
                }}
                className="text-[14px] font-medium text-zinc-600 hover:text-zinc-950 transition-colors duration-150 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 rounded"
              >
                Questions
              </a>
            </nav>
          </div>

          <div className="hidden md:flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenLogin}
              className="min-h-[44px] px-4 py-2 rounded-lg text-[13px] font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={onOpenRegister}
              className="min-h-[44px] px-4 py-2 rounded-lg text-[13px] font-semibold text-white bg-zinc-900 hover:bg-zinc-800 transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer shadow-xs"
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
              className="min-h-[44px] px-3.5 py-2 rounded-lg bg-zinc-100 border border-zinc-200 text-zinc-900 inline-flex items-center gap-2 text-xs font-medium active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
              <span>Menu</span>
            </button>
          </div>
        </header>

        {mobileMenuOpen && (
          <div className="md:hidden relative z-30 mx-6 mb-4 p-4 rounded-xl bg-white border border-zinc-200 space-y-3 shadow-sm">
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
            <div className="pt-2 border-t border-zinc-200 grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onOpenLogin();
                }}
                className="min-h-[44px] px-4 py-2.5 rounded-lg text-xs font-medium text-zinc-800 bg-zinc-100 border border-zinc-200 active:scale-[0.97]"
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onOpenRegister();
                }}
                className="min-h-[44px] px-4 py-2.5 rounded-lg text-xs font-semibold text-white bg-zinc-900 active:scale-[0.97]"
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
            className="group min-h-[36px] inline-flex items-center gap-2.5 pl-1.5 pr-3.5 py-1 rounded-full bg-zinc-100 hover:bg-zinc-200/80 border border-zinc-200/90 transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 cursor-pointer"
          >
            <span className="px-2 py-0.5 rounded-full bg-zinc-900 text-white text-[11px] font-bold tracking-tight">
              New
            </span>
            <span className="text-[12px] font-medium text-zinc-800">
              Zero-dependency webhook gateway
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-zinc-500 group-hover:translate-x-0.5 transition-transform" />
          </button>

          <h1 className="mt-6 text-[clamp(2.5rem,4.5vw,4.125rem)] font-bold tracking-[-0.035em] leading-[1.06] text-zinc-950">
            Every webhook.
            <br />
            Zero dropped events.
          </h1>

          <p className="mt-4 text-[15px] sm:text-[16px] leading-[1.55] text-zinc-600 max-w-[54ch]">
            RelayGate verifies cryptographic signatures at the edge, buffers deliveries in an embedded SQLite WAL queue, and dispatches to downstream services with exponential backoff and dead-letter isolation.
          </p>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
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

        {/* Authentic Developer Centerpiece: Interactive Webhook Routing Pipeline */}
        <section className="relative z-10 px-4 sm:px-6 pb-12">
          <WebhookRoutingPipeline />
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
                <div className="shot shot--bare">
                  <div className="rg-win">
                    <div className="rg-win__bar">
                      <div className="rg-win__dots">
                        <i />
                        <i />
                        <i />
                      </div>
                      <span className="rg-win__title">Dispatch Worker Pool :: 4 active workers across 3 harnesses</span>
                      <span className="font-mono text-[11px] text-zinc-500">WAL SYNCED</span>
                    </div>
                    <div className="p-5 text-left space-y-4">
                      <div className="flex items-center justify-between text-xs font-mono text-zinc-500 border-b border-zinc-200 pb-3">
                        <span>3 active routes · 50 concurrent workers</span>
                        <span>SQLite WAL checkpoint: 0.38 ms</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse font-mono text-xs">
                          <thead>
                            <tr className="border-b border-zinc-200 text-zinc-500">
                              <th className="py-2 pr-3 font-medium">Route</th>
                              <th className="py-2 px-3 font-medium">Provider / Policy</th>
                              <th className="py-2 pl-3 font-medium">What it&apos;s doing</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-200 text-zinc-700">
                            <tr>
                              <td className="py-2.5 pr-3 text-zinc-950 font-medium">ep_7efe4e7e</td>
                              <td className="py-2.5 px-3 text-zinc-500">Stripe · HMAC-SHA256</td>
                              <td className="py-2.5 pl-3">
                                Verifies timestamp tolerance (300s), writes raw body to WAL, dispatches HTTP POST to billing service.
                              </td>
                            </tr>
                            <tr>
                              <td className="py-2.5 pr-3 text-zinc-950 font-medium">ep_97aaeddd</td>
                              <td className="py-2.5 px-3 text-zinc-500">Xendit · Static Token</td>
                              <td className="py-2.5 pl-3">
                                Compares X-Callback-Token in constant time, schedules retry 2/5 after downstream 504 timeout.
                              </td>
                            </tr>
                            <tr>
                              <td className="py-2.5 pr-3 text-zinc-950 font-medium">ep_midtrans</td>
                              <td className="py-2.5 px-3 text-zinc-500">Midtrans · SHA-512</td>
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

          <div className="shot shot--bare p-2 sm:p-4 rounded-2xl bg-white border border-zinc-200 shadow-sm">
            <div className="rg-win rounded-xl border border-zinc-200 overflow-hidden bg-white shadow-xs">
              <div className="rg-win__bar bg-zinc-50 border-b border-zinc-200 px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                  <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                  <span className="w-2.5 h-2.5 rounded-full bg-zinc-300 inline-block" />
                  <span className="ml-2 font-mono text-[11px] text-zinc-500">http://127.0.0.1:8080/#overview</span>
                </div>
                <span className="font-mono text-[11px] text-zinc-400">OPERATOR CONSOLE :: REAL TIME</span>
              </div>
              <img
                src="/dashboard-preview.png"
                alt="RelayGate Operator Console Dashboard"
                className="w-full h-auto object-cover block"
                loading="lazy"
              />
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
                      <span className="font-mono text-[11px] text-zinc-500">QUOTA 0/5 -&gt; 5/5</span>
                    </div>
                    <div className="p-5 text-left space-y-3.5 font-mono text-xs">
                      <div className="p-3.5 rounded-lg bg-zinc-50 border border-zinc-200 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-950 font-semibold">evt_499cd52a · Stripe 504 Gateway Timeout</span>
                          <span className="px-2 py-0.5 rounded bg-zinc-200 text-zinc-800 text-[11px] font-medium">
                            Eligible for Replay
                          </span>
                        </div>
                        <p className="text-zinc-600 text-[11px]">
                          Dijadwalkan ulang dari antrean Dead-Letter dengan reset kuota hingga 5 percobaan baru.
                        </p>
                      </div>
                      <div className="grid grid-cols-3 gap-2.5 text-center">
                        <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                          <p className="text-zinc-500 text-[11px]">VERIFIED</p>
                          <p className="text-zinc-950 text-base font-bold mt-1">HMAC OK</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                          <p className="text-zinc-500 text-[11px]">LAST HTTP</p>
                          <p className="text-zinc-950 text-base font-bold mt-1">504</p>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-50 border border-zinc-200">
                          <p className="text-zinc-500 text-[11px]">RETRY BUDGET</p>
                          <p className="text-zinc-950 text-base font-bold mt-1">5 Attempts</p>
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
                    <p className="text-zinc-500 text-[11px] uppercase tracking-wider font-semibold">Credential Redaction</p>
                    <div className="p-2.5 rounded bg-zinc-50 border border-zinc-200 flex justify-between">
                      <span className="text-zinc-500">Authorization</span>
                      <span className="text-zinc-900 font-semibold">••••••••</span>
                    </div>
                    <div className="p-2.5 rounded bg-zinc-50 border border-zinc-200 flex justify-between">
                      <span className="text-zinc-500">X-Callback-Token</span>
                      <span className="text-zinc-900 font-semibold">&lt;TOKEN&gt;</span>
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
                      <span className="text-zinc-900 font-semibold">Exponential Backoff Schedule</span>
                      <span className="text-zinc-500">5 Attempts · ±15% Jitter</span>
                    </div>
                    <div className="grid grid-cols-5 gap-1.5 text-center">
                      {['1s', '2s', '4s', '8s', '16s'].map((delay, i) => (
                        <div key={delay} className="p-2 rounded bg-zinc-50 border border-zinc-200">
                          <p className="text-zinc-500 text-[10px]">TRY {i + 1}</p>
                          <p className="text-zinc-950 font-bold mt-0.5">{delay}</p>
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
                    <p className="text-zinc-500 text-[11px] uppercase tracking-wider font-semibold">Batch Audit Summary</p>
                    <div className="p-2.5 rounded bg-zinc-50 border border-zinc-200 text-zinc-900 font-medium">
                      12 lolos verifikasi
                    </div>
                    <div className="p-2.5 rounded bg-zinc-50 border border-zinc-200 text-zinc-500">
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
                  <small>Browser · WebSocket</small>
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
                    <li className="dl__file">
                      <span className="dl__file-name">relaygate-linux-amd64</span>
                      <span className="dl__file-ext">static binary · SQLite WAL embedded</span>
                      <ArrowDown className="w-4 h-4 text-zinc-500" />
                    </li>
                    <li className="dl__file">
                      <span className="dl__file-name">relaygate.service</span>
                      <span className="dl__file-ext">systemd unit</span>
                      <ArrowDown className="w-4 h-4 text-zinc-500" />
                    </li>
                  </ul>
                  <p className="dl__note">
                    x86_64 and ARM64 Linux. Runs as an unprivileged user (UID 1000) with zero external runtime dependencies.
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
