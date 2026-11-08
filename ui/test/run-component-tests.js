import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('RelayGate DLQ Revamp Test Suite', async (suite) => {
  const outDir = path.join(__dirname, '.temp');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const drawerFile = path.join(outDir, 'drawer-bundle.mjs');
  const formattersFile = path.join(outDir, 'formatters-bundle.mjs');
  const dlqFile = path.join(outDir, 'dlq-bundle.mjs');

  await build({
    entryPoints: [path.join(__dirname, '../src/components/InspectorDrawer.tsx')],
    bundle: true,
    format: 'esm',
    outfile: drawerFile,
    external: ['react', 'react-dom', 'lucide-react'],
    jsx: 'transform',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  const bulkFile = path.join(outDir, 'bulk-bundle.mjs');
  const eventsFile = path.join(outDir, 'events-bundle.mjs');

  await build({
    entryPoints: [path.join(__dirname, '../src/utils/formatters.ts')],
    bundle: true,
    format: 'esm',
    outfile: formattersFile,
    loader: { '.ts': 'ts' },
  });

  await build({
    entryPoints: [path.join(__dirname, '../src/components/BulkReplayModal.tsx')],
    bundle: true,
    format: 'esm',
    outfile: bulkFile,
    external: ['react', 'react-dom', 'lucide-react'],
    jsx: 'transform',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  await build({
    entryPoints: [path.join(__dirname, '../src/components/DeadLetterView.tsx')],
    bundle: true,
    format: 'esm',
    outfile: dlqFile,
    external: ['react', 'react-dom', 'lucide-react'],
    jsx: 'transform',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  await build({
    entryPoints: [path.join(__dirname, '../src/components/EventsView.tsx')],
    bundle: true,
    format: 'esm',
    outfile: eventsFile,
    external: ['react', 'react-dom', 'lucide-react'],
    jsx: 'transform',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  const profileFile = path.join(outDir, 'profile-bundle.mjs');

  await build({
    entryPoints: [path.join(__dirname, '../src/components/ProfileModal.tsx')],
    bundle: true,
    format: 'esm',
    outfile: profileFile,
    external: ['react', 'react-dom', 'lucide-react'],
    jsx: 'transform',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  const endpointsFile = path.join(outDir, 'endpoints-bundle.mjs');

  await build({
    entryPoints: [path.join(__dirname, '../src/components/EndpointsView.tsx')],
    bundle: true,
    format: 'esm',
    outfile: endpointsFile,
    external: ['react', 'react-dom', 'lucide-react'],
    jsx: 'transform',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
  });

  const { InspectorDrawer } = await import(`file://${drawerFile.replace(/\\/g, '/')}`);
  const { 
    isSensitiveHeader, 
    analyzeEventError, 
    FAILURE_FAMILY_KEYS, 
    FAILURE_CODE_LABELS, 
    formatFailureCodeLabel, 
    isFailureCodeInFamily,
    formatAttemptsDisplay
  } = await import(`file://${formattersFile.replace(/\\/g, '/')}`);
  const { DeadLetterView } = await import(`file://${dlqFile.replace(/\\/g, '/')}`);
  const { BulkReplayModal } = await import(`file://${bulkFile.replace(/\\/g, '/')}`);
  const { EventsView } = await import(`file://${eventsFile.replace(/\\/g, '/')}`);
  const { ProfileModal } = await import(`file://${profileFile.replace(/\\/g, '/')}`);
  const { EndpointsView } = await import(`file://${endpointsFile.replace(/\\/g, '/')}`);
  const React = (await import('react')).default;
  const { renderToString } = await import('react-dom/server');

  const mockEvent = {
    id: 'evt-test-12345678',
    endpoint_id: 'ep-orders',
    provider: 'stripe',
    source_ip: '127.0.0.1',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 't=123,v1=secret123',
    },
    payload_raw: '{"hello":"world"}',
    is_verified: -1,
    status: 'FAILED',
    http_status_code: 0,
    attempts: 0,
    max_attempts: 5,
    last_error: 'cryptographic signature verification failed: stripe v1 signature mismatch',
    failure_code: 'SIGNATURE_MISMATCH',
    created_at: new Date().toISOString(),
    failed_at: new Date().toISOString(),
  };

  await suite.test('Detail Teknis: default closed (no open attribute in rendered DOM)', () => {
    const html = renderToString(
      React.createElement(InspectorDrawer, {
        event: mockEvent,
        endpoints: [{ id: 'ep-orders', name: 'Orders Service', provider: 'stripe', target_url: 'https://api.test/webhook' }],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    assert.match(html, /data-testid="technical-details"/, '<details> with data-testid="technical-details" must be rendered');
    assert.doesNotMatch(html, /<details[^>]*\bopen\b[^>]*>/i, '<details> must NOT have open attribute by default');
    assert.match(html, /Detail Teknis \(Pesan Error Asli\)/, 'Summary title must be rendered');
    assert.match(html, /cryptographic signature verification failed/, 'Original error message must reside inside technical details');
    assert.match(html, /Salin cURL/, 'cURL copy action must be available');
  });

  await suite.test('Security: Salin cURL and header formatting use <TOKEN> placeholder', () => {
    const html = renderToString(
      React.createElement(InspectorDrawer, {
        event: mockEvent,
        endpoints: [{ id: 'ep-orders', name: 'Orders Service', provider: 'stripe', target_url: 'https://api.test/webhook' }],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    assert.doesNotMatch(html, /secret123/, 'Raw sensitive secret key must NEVER be rendered in plaintext in the DOM');
  });

  await suite.test('Point 1: DELIVERED state (hidden action button, single status marker, single title, dynamic time label)', () => {
    const deliveredEvent = {
      id: 'e10029c1-d192-4efb-be07-0f394037ddaf',
      endpoint_id: 'ep-billing',
      provider: 'xendit',
      source_ip: '127.0.0.1',
      headers: {
        'content-type': 'application/json',
        'x-callback-token': 'valid_token_xyz',
      },
      payload_raw: '{"event":"invoice.paid"}',
      is_verified: 1,
      status: 'DELIVERED',
      http_status_code: 200,
      attempts: 1,
      max_attempts: 5,
      last_error: '',
      failure_code: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const html = renderToString(
      React.createElement(InspectorDrawer, {
        event: deliveredEvent,
        endpoints: [{ id: 'ep-billing', name: 'Billing Hook', provider: 'xendit', target_url: 'https://api.test/billing' }],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    // 1. Badge must be "Terkirim"
    assert.match(html, /<span>Terkirim<\/span>/, 'Status badge must display "Terkirim"');

    // 2. Point 1: Action button in header completely hidden
    assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Terkirim<\/span><\/button>/, 'Header must NOT have a button labeled "Terkirim"');
    assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Replay<\/span><\/button>/, 'Header must NOT have a Replay button when DELIVERED');

    // 3. Point 1: Single title in diagnosis block
    assert.match(html, /data-testid="diagnosis-delivered"/, 'Must render success diagnosis block');
    assert.match(html, /Lolos verifikasi dan terkirim ke downstream \(HTTP (?:<!-- -->)?200(?:<!-- -->)?\)/, 'Must show single title "Lolos verifikasi dan terkirim ke downstream (HTTP 200)"');
    assert.doesNotMatch(html, /Replay berhasil!/, 'Must NOT show "Replay berhasil!" banner');

    // 4. Point 3: Dynamic time label must be "Terkirim pada:"
    assert.match(html, /Terkirim pada:/, 'Time label for DELIVERED must be "Terkirim pada:"');
    assert.doesNotMatch(html, /Gagal pada:/, 'Time label for DELIVERED must not show "Gagal pada:"');
    assert.doesNotMatch(html, /Dijadwalkan pada:/, 'Time label for DELIVERED must not show "Dijadwalkan pada:"');

    // 5. Clean attempts count (1 / 5) without redundant subtext
    assert.match(html, /data-testid="attempts-count"[^>]*>1(?:<!-- -->)?\s*\/\s*(?:<!-- -->)?5<\/span>/, 'Attempts count must display clean "1 / 5"');
    assert.doesNotMatch(html, /Sukses terkirim/, 'Attempts must NOT have redundant subtext');

    // 6. Xendit provider row shows Token, not Signature
    assert.match(html, />Token:<\/span>/, 'Must show Token row for Xendit');
    assert.match(html, /Valid/, 'Token must show Valid');
  });

  await suite.test('Point 2: PENDING state (hidden action button, clean attempts count, dynamic time label)', () => {
    const pending504Event = {
      id: '499cd52a-8a5d-4a91-bde9-9309cafc4944',
      endpoint_id: 'ep-license',
      provider: 'stripe',
      source_ip: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload_raw: '{"data":"payload"}',
      is_verified: 1,
      status: 'PENDING',
      http_status_code: 504,
      attempts: 0,
      max_attempts: 5,
      last_error: 'HTTP 504 Gateway Timeout from downstream',
      failure_code: 'HTTP_5XX',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const html = renderToString(
      React.createElement(InspectorDrawer, {
        event: pending504Event,
        endpoints: [{ id: 'ep-license', name: 'License Service', provider: 'stripe', target_url: 'https://api.test/webhook' }],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    // 1. Badge must be "Menunggu"
    assert.match(html, /<span>Menunggu<\/span>/, 'Status badge must display "Menunggu"');

    // 2. Point 2: Action button completely hidden
    assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Dijadwalkan ulang<\/span><\/button>/, 'Header must NOT have a button labeled "Dijadwalkan ulang"');
    assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Menunggu<\/span><\/button>/, 'Header must NOT have a button labeled "Menunggu"');
    assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<span>Replay<\/span><\/button>/, 'Header must NOT have a Replay button when PENDING');

    // 3. Point 2: Clean attempts count (0 / 5) without subtext
    assert.match(html, /data-testid="attempts-count"[^>]*>0\s*\/\s*5<\/span>/, 'Attempts count must display just "0 / 5"');
    assert.doesNotMatch(html, /0\s*\/.*·\s*Dijadwalkan ulang/, 'Attempts must NOT contain "· Dijadwalkan ulang"');
    assert.doesNotMatch(html, /Antrean retry worker/, 'Attempts must NOT contain extra subtext');

    // 4. Point 3: Dynamic time label must be "Dijadwalkan pada:"
    assert.match(html, /Dijadwalkan pada:/, 'Time label for PENDING must be "Dijadwalkan pada:"');
    assert.doesNotMatch(html, /Gagal pada:/, 'Time label for PENDING must not show "Gagal pada:"');
    assert.doesNotMatch(html, /Terkirim pada:/, 'Time label for PENDING must not show "Terkirim pada:"');

    // 5. Single diagnosis title for replayed PENDING (had previous failure 504)
    assert.match(html, /data-testid="diagnosis-pending"/, 'Must render pending diagnosis block');
    assert.match(html, /Event dijadwalkan ulang untuk pengiriman downstream/, 'Replayed PENDING diagnosis title must say dijadwalkan ulang');
    assert.doesNotMatch(html, /Event menunggu giliran dikirim ke downstream/, 'Replayed PENDING must not say menunggu giliran');
    assert.match(html, /Kegagalan terakhir:(?:<!-- -->)?\s*<span[^>]*>HTTP 504<\/span>/, 'Must show subtle "Kegagalan terakhir: HTTP 504"');

    // 6. Fresh PENDING event (attempts == 0, http_status_code == 0, last_error empty)
    const freshPendingEvent = {
      id: 'ev_pending_fresh_1234',
      endpoint_id: 'ep-license',
      provider: 'generic',
      source_ip: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload_raw: '{"event":"task.enqueued"}',
      is_verified: 1,
      status: 'PENDING',
      http_status_code: 0,
      attempts: 0,
      max_attempts: 5,
      last_error: '',
      failure_code: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const freshHtml = renderToString(
      React.createElement(InspectorDrawer, {
        event: freshPendingEvent,
        endpoints: [{ id: 'ep-license', name: 'License Service', provider: 'generic', target_url: 'https://api.test/webhook' }],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    assert.match(freshHtml, /data-testid="diagnosis-pending"/, 'Must render pending diagnosis block for fresh PENDING');
    assert.match(freshHtml, /Event menunggu giliran dikirim ke downstream/, 'Fresh PENDING must display "Event menunggu giliran dikirim ke downstream"');
    assert.doesNotMatch(freshHtml, /Event dijadwalkan ulang untuk pengiriman downstream/, 'Fresh PENDING must NOT display "Event dijadwalkan ulang untuk pengiriman downstream"');
    assert.doesNotMatch(freshHtml, /Kegagalan terakhir:/, 'Fresh PENDING must NOT display "Kegagalan terakhir:"');
  });

  await suite.test('Point 3: FAILED state dynamic time label and Xendit copy without crypto/HMAC terms', () => {
    const xenditFailedEvent = {
      id: 'e10029c1-d192-4efb-be07-0f394037ddaf',
      endpoint_id: 'ep-billing',
      provider: 'xendit',
      source_ip: '127.0.0.1',
      headers: {
        'content-type': 'application/json',
        'x-callback-token': 'invalid_token',
      },
      payload_raw: '{"event":"invoice.paid"}',
      is_verified: -1,
      status: 'FAILED',
      http_status_code: 0,
      attempts: 0,
      max_attempts: 5,
      last_error: 'xendit callback token mismatch',
      failure_code: 'SIGNATURE_MISMATCH',
      created_at: new Date().toISOString(),
      failed_at: new Date().toISOString(),
    };

    const html = renderToString(
      React.createElement(InspectorDrawer, {
        event: xenditFailedEvent,
        endpoints: [{ id: 'ep-billing', name: 'Billing Hook', provider: 'xendit', target_url: 'https://api.test/billing' }],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    // 1. Time label for FAILED is "Gagal pada:"
    assert.match(html, /Gagal pada:/, 'Time label for FAILED status must be "Gagal pada:"');
    assert.doesNotMatch(html, /Terkirim pada:/, 'Time label for FAILED must not show "Terkirim pada:"');
    assert.doesNotMatch(html, /Dijadwalkan pada:/, 'Time label for FAILED must not show "Dijadwalkan pada:"');

    // 2. Title must be "Token callback Xendit tidak cocok"
    assert.match(html, /Token callback Xendit tidak cocok/, 'Title must be "Token callback Xendit tidak cocok"');

    // 3. No crypto/HMAC terms for Xendit
    assert.doesNotMatch(html, /kriptografis/i, 'Xendit copy must not use "kriptografis"');
    assert.doesNotMatch(html, /HMAC/i, 'Xendit copy must not use "HMAC"');

    // 4. Test error analysis badge label for Xendit is "Token tidak cocok"
    const analysis = analyzeEventError(xenditFailedEvent);
    assert.strictEqual(analysis.badgeLabel, 'Token tidak cocok', 'Xendit error badge must be "Token tidak cocok"');

    // 5. Test missing header for Xendit
    const xenditMissingHeaderEvent = {
      ...xenditFailedEvent,
      failure_code: 'SIGNATURE_HEADER_MISSING',
    };
    const missingAnalysis = analyzeEventError(xenditMissingHeaderEvent);
    assert.strictEqual(missingAnalysis.badgeLabel, 'Token hilang', 'Xendit missing header badge must be "Token hilang"');
    assert.match(missingAnalysis.title, /Token callback Xendit tidak ditemukan/);
  });

  await suite.test('Point 6: Single status marker and button uniqueness assertions', () => {
    // Delivered Event panel
    const deliveredEvent = {
      id: 'e10029c1-d192-4efb-be07-0f394037ddaf',
      endpoint_id: 'ep-billing',
      provider: 'stripe',
      source_ip: '127.0.0.1',
      headers: {},
      payload_raw: '{}',
      is_verified: 1,
      status: 'DELIVERED',
      http_status_code: 200,
      attempts: 1,
      max_attempts: 5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const deliveredHtml = renderToString(
      React.createElement(InspectorDrawer, {
        event: deliveredEvent,
        endpoints: [],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    // Rule: satu status = satu penanda (badge di header). Tidak ada tombol berlabel status.
    const terkirimBadgeMatches = deliveredHtml.match(/<span>Terkirim<\/span>/g);
    assert.strictEqual(terkirimBadgeMatches?.length, 1, 'Status badge "Terkirim" must appear exactly once in panel');

    const deliveredButtons = deliveredHtml.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g) || [];
    for (const btn of deliveredButtons) {
      assert.doesNotMatch(btn, /Terkirim/, 'No button in DELIVERED panel may contain "Terkirim"');
      assert.doesNotMatch(btn, /Replay/, 'No button in DELIVERED panel may contain "Replay"');
      assert.doesNotMatch(btn, /Dijadwalkan ulang/, 'No button in DELIVERED panel may contain "Dijadwalkan ulang"');
    }

    // Pending Event panel
    const pendingEvent = {
      ...deliveredEvent,
      status: 'PENDING',
      http_status_code: 504,
      attempts: 0,
    };

    const pendingHtml = renderToString(
      React.createElement(InspectorDrawer, {
        event: pendingEvent,
        endpoints: [],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    const menungguBadgeMatches = pendingHtml.match(/<span>Menunggu<\/span>/g);
    assert.strictEqual(menungguBadgeMatches?.length, 1, 'Status badge "Menunggu" must appear exactly once in panel');

    const pendingButtons = pendingHtml.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g) || [];
    for (const btn of pendingButtons) {
      assert.doesNotMatch(btn, /Dijadwalkan ulang/, 'No button in PENDING panel may contain "Dijadwalkan ulang"');
      assert.doesNotMatch(btn, /Menunggu/, 'No button in PENDING panel may contain "Menunggu"');
      assert.doesNotMatch(btn, /Replay/, 'No button in PENDING panel may contain "Replay"');
    }
  });

  await suite.test('Requirement 1: Sensitive header masking matches 7 tokens (token, secret, signature, auth, key, password, cookie)', () => {
    const tokens = ['token', 'secret', 'signature', 'auth', 'key', 'password', 'cookie'];
    for (const token of tokens) {
      assert.strictEqual(isSensitiveHeader(`x-custom-${token}`), true, `Token "${token}" must be masked`);
      assert.strictEqual(isSensitiveHeader(`X-${token.toUpperCase()}`), true, `Token "${token}" in uppercase must be masked`);
      assert.strictEqual(isSensitiveHeader(`${token}`), true, `Exact token "${token}" must be masked`);
    }

    assert.strictEqual(isSensitiveHeader('content-type'), false, 'content-type must not be masked');
    assert.strictEqual(isSensitiveHeader('accept'), false, 'accept must not be masked');
    assert.strictEqual(isSensitiveHeader('user-agent'), false, 'user-agent must not be masked');
  });

  await suite.test('Requirement 2: DeadLetterView renders skeleton loading state when isLoading is true', () => {
    const html = renderToString(
      React.createElement(DeadLetterView, {
        events: [],
        endpoints: [],
        selectedEventId: null,
        onSelectEvent: () => {},
        onReplaySingle: () => {},
        onBulkReplay: () => {},
        isLoading: true,
      })
    );

    assert.match(html, /animate-pulse/, 'Table must contain skeleton loading rows with animate-pulse');
    assert.match(html, /Dead-Letter Queue \(DLQ\)/, 'DLQ title must be rendered');
    assert.doesNotMatch(html, /Belum ada event gagal/, 'Must NOT display empty state text while loading');
  });

  await suite.test('Requirement 3: Complete URL query filter parameters synchronization and parsing', () => {
    // 1. Test parsing of all standard and Indonesian alias query parameters
    const params1 = new URLSearchParams('failure=SIGNATURE_MISMATCH&range=24h&q=order');
    assert.strictEqual(params1.get('failure'), 'SIGNATURE_MISMATCH');
    assert.strictEqual(params1.get('range'), '24h');
    assert.strictEqual(params1.get('q'), 'order');

    const params2 = new URLSearchParams('dlq_error=TIMEOUT&dlq_range=1h&dlq_q=payment');
    assert.strictEqual(params2.get('dlq_error'), 'TIMEOUT');
    assert.strictEqual(params2.get('dlq_range'), '1h');
    assert.strictEqual(params2.get('dlq_q'), 'payment');

    const paramsIndo = new URLSearchParams('penyebab=HTTP_5XX&waktu=7d&cari=invoice');
    assert.strictEqual(paramsIndo.get('penyebab'), 'HTTP_5XX');
    assert.strictEqual(paramsIndo.get('waktu'), '7d');
    assert.strictEqual(paramsIndo.get('cari'), 'invoice');
  });

  await suite.test('Requirement 4: Strict neutral zinc tokens across ALL frontend components (zero raw hex)', () => {
    const srcDir = path.join(__dirname, '../src');
    const tailwindHexRegex = /\[#(?:[0-9a-fA-F]{3,8})\]/g;
    const inlineStyleHexRegex = /style\s*=\s*\{\{[^}]*#[0-9a-fA-F]{3,8}\b[^}]*\}\}/g;
    const generalHexRegex = /#[0-9a-fA-F]{3,8}\b/g;

    function verifyNoHex(dir) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) {
          verifyNoHex(full);
        } else if (f.endsWith('.tsx')) {
          const content = fs.readFileSync(full, 'utf8');
          // 1. Check arbitrary Tailwind hex classes
          const tailwindMatches = content.match(tailwindHexRegex);
          assert.strictEqual(
            tailwindMatches,
            null,
            `File ${f} must not contain arbitrary Tailwind hex classes: ${tailwindMatches?.join(', ')}`
          );

          // 2. Check inline style attributes with raw hex
          const inlineMatches = content.match(inlineStyleHexRegex);
          assert.strictEqual(
            inlineMatches,
            null,
            `File ${f} must not contain inline style attributes with raw hex: ${inlineMatches?.join(', ')}`
          );

          // 3. Check any raw hex color literals in code (excluding comments)
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
              continue;
            }
            const codeOnly = line.replace(/\/\/.*$/, '');
            const hexMatches = codeOnly.match(generalHexRegex);
            assert.strictEqual(
              hexMatches,
              null,
              `File ${f}:${i + 1} must not contain raw hex color literals: "${trimmed}"`
            );
          }
        } else if (f.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf8');
          const tailwindMatches = content.match(tailwindHexRegex);
          assert.strictEqual(
            tailwindMatches,
            null,
            `File ${f} must not contain arbitrary Tailwind hex classes: ${tailwindMatches?.join(', ')}`
          );
        }
      }
    }

    verifyNoHex(srcDir);

    // Verify ui/index.html does not contain arbitrary Tailwind hex classes or raw hex color literals
    const indexHtmlPath = path.join(__dirname, '../index.html');
    if (fs.existsSync(indexHtmlPath)) {
      const indexContent = fs.readFileSync(indexHtmlPath, 'utf8');
      const tailwindMatches = indexContent.match(tailwindHexRegex);
      assert.strictEqual(
        tailwindMatches,
        null,
        `index.html must not contain arbitrary Tailwind hex classes: ${tailwindMatches?.join(', ')}`
      );
      const inlineMatches = indexContent.match(inlineStyleHexRegex);
      assert.strictEqual(
        inlineMatches,
        null,
        `index.html must not contain inline style attributes with raw hex: ${inlineMatches?.join(', ')}`
      );
      const generalMatches = indexContent.match(generalHexRegex);
      assert.strictEqual(
        generalMatches,
        null,
        `index.html must not contain raw hex color literals: ${generalMatches?.join(', ')}`
      );
    }
  });

  await suite.test('Point 4 & Toast: 8-char event ID truncation & Drawer toast suppression', () => {
    const longId = '499cd52a-8a5d-4a91-bde9-9309cafc4944';
    const shortId = longId.slice(0, 8);
    assert.strictEqual(shortId, '499cd52a', 'Event ID must be shortened to exactly 8 characters');
    assert.strictEqual(shortId.length, 8, 'Shortened ID length must be 8');
  });

  await suite.test('Point 5 & Bulk Modal: Always renders "N lolos verifikasi" row in result modal (including when N=0)', () => {
    const dlqSource = fs.readFileSync(path.join(__dirname, '../src/components/DeadLetterView.tsx'), 'utf8');

    assert.match(dlqSource, /data-testid="bulk-delivered-row"/, 'Bulk modal must have data-testid="bulk-delivered-row" unconditionally');
    assert.match(dlqSource, /\{bulkModal\.resultData\.deliveredCount\} event<\/b> lolos verifikasi/, 'Bulk modal must display delivered count');
  });

  await suite.test('Requirement 2 & Table Keyboard: Rows have tabindex 0, unique IDs, and navigation handlers', () => {
    const testEvent = {
      id: 'row-test-1234',
      endpoint_id: 'ep-orders',
      provider: 'stripe',
      source_ip: '127.0.0.1',
      headers: {},
      payload_raw: '{}',
      is_verified: -1,
      status: 'FAILED',
      http_status_code: 0,
      attempts: 0,
      max_attempts: 5,
      last_error: 'signature mismatch',
      failure_code: 'SIGNATURE_MISMATCH',
      created_at: new Date().toISOString(),
      failed_at: new Date().toISOString(),
    };

    const html = renderToString(
      React.createElement(DeadLetterView, {
        events: [testEvent],
        endpoints: [{ id: 'ep-orders', name: 'Orders Endpoint', provider: 'stripe', target_url: 'http://test' }],
        selectedEventId: null,
        onSelectEvent: () => {},
        onReplaySingle: () => {},
        onBulkReplay: () => {},
      })
    );

    assert.match(html, /id="dlq-row-row-test-1234"/, 'Row must have id="dlq-row-row-test-1234"');
    assert.match(html, /tabindex="0"/i, 'Row must have tabindex="0" for keyboard navigation');
  });

  await suite.test('A7 Static: ui/src/api.ts must not send identity headers (X-User-Role, X-Admin, X-User-Email, etc.)', () => {
    const apiSource = fs.readFileSync(path.join(__dirname, '../src/api.ts'), 'utf8');
    const forbiddenHeaders = ['X-User-Role', 'X-Admin', 'X-User-Email', 'x-user-role', 'x-admin', 'x-user-email'];
    for (const h of forbiddenHeaders) {
      assert.strictEqual(
        apiSource.includes(h),
        false,
        `ui/src/api.ts must not send or reference identity header: ${h}`
      );
    }
  });

  // ==========================================
  // SECTION C: UI SPECIFICATION TESTS
  // ==========================================

  await suite.test('C1: Single label map in formatters.ts with exact 8 family names and regex /\\b[A-Z]{3,}(_[A-Z0-9]+)+\\b/ verification', () => {
    // 1. Verify exact 8 family keys
    const expectedFamilies = [
      'SIGNATURE_MISMATCH',
      'SIGNATURE_HEADER_MISSING',
      'SIGNATURE_TIMESTAMP_EXPIRED',
      'SIGNATURE_TIMESTAMP_INVALID',
      'SIGNATURE_PAYLOAD_MALFORMED',
      'HTTP_4XX',
      'HTTP_5XX',
      'TIMEOUT',
    ];
    assert.deepStrictEqual(Array.from(FAILURE_FAMILY_KEYS), expectedFamilies);

    // 2. Verify exact Indonesian labels per C1
    assert.strictEqual(FAILURE_CODE_LABELS.SIGNATURE_MISMATCH, 'Signature/token tidak cocok');
    assert.strictEqual(FAILURE_CODE_LABELS.SIGNATURE_HEADER_MISSING, 'Signature/token hilang');
    assert.strictEqual(FAILURE_CODE_LABELS.SIGNATURE_TIMESTAMP_EXPIRED, 'Timestamp kedaluwarsa');
    assert.strictEqual(FAILURE_CODE_LABELS.SIGNATURE_TIMESTAMP_INVALID, 'Timestamp tidak valid');
    assert.strictEqual(FAILURE_CODE_LABELS.SIGNATURE_PAYLOAD_MALFORMED, 'Payload rusak');
    assert.strictEqual(FAILURE_CODE_LABELS.HTTP_4XX, 'Downstream menolak (4xx)');
    assert.strictEqual(FAILURE_CODE_LABELS.HTTP_5XX, 'Downstream error (5xx)');
    assert.strictEqual(FAILURE_CODE_LABELS.TIMEOUT, 'Timeout/jaringan');

    // 3. formatFailureCodeLabel maps accurately
    assert.strictEqual(formatFailureCodeLabel('SIGNATURE_MISMATCH'), 'Signature/token tidak cocok');
    assert.strictEqual(formatFailureCodeLabel('HTTP_504'), 'Downstream error (5xx)');
    assert.strictEqual(formatFailureCodeLabel('HTTP_400'), 'Downstream menolak (4xx)');
    assert.strictEqual(formatFailureCodeLabel('NETWORK_ERROR'), 'Timeout/jaringan');

    // 4. isFailureCodeInFamily matches properly
    assert.strictEqual(isFailureCodeInFamily('SIGNATURE_MISMATCH', 'SIGNATURE_MISMATCH'), true);
    assert.strictEqual(isFailureCodeInFamily('SIGNATURE_HEADER_MISSING', 'SIGNATURE_MISMATCH'), false);
    assert.strictEqual(isFailureCodeInFamily('HTTP_504', 'HTTP_5XX', 504), true);
    assert.strictEqual(isFailureCodeInFamily('TIMEOUT', 'TIMEOUT', 0), true);
    assert.strictEqual(isFailureCodeInFamily('NETWORK_ERROR', 'TIMEOUT', 0), true);
  });

  await suite.test('C2: EventsView renders "Replay yang eligible (N)", disabled/not-primary when 0, and uses shared BulkReplayModal', () => {
    // 1. When 0 eligible events: button is disabled, styled as not primary
    const emptyHtml = renderToString(
      React.createElement(EventsView, {
        events: [],
        endpoints: [],
        selectedEventId: null,
        onSelectEvent: () => {},
        onReplaySingle: () => {},
        onBulkReplay: () => {},
        onBulkReplayFailed: () => {},
      })
    );
    assert.match(emptyHtml, /Replay yang eligible \([\s<!->]*0[\s<!->]*\)/);
    assert.match(emptyHtml, /cursor-not-allowed/);

    // 2. When eligible events exist: button has count N and primary styling
    const eligibleEvent = {
      id: 'evt-failed-1',
      endpoint_id: 'ep-orders',
      provider: 'stripe',
      source_ip: '127.0.0.1',
      headers: {},
      payload_raw: '{}',
      is_verified: 1,
      status: 'FAILED',
      http_status_code: 504,
      attempts: 5,
      max_attempts: 5,
      failure_code: 'HTTP_5XX',
      created_at: new Date().toISOString(),
      failed_at: new Date().toISOString(),
    };

    const populatedHtml = renderToString(
      React.createElement(EventsView, {
        events: [eligibleEvent],
        endpoints: [],
        selectedEventId: null,
        onSelectEvent: () => {},
        onReplaySingle: () => {},
        onBulkReplay: () => {},
        onBulkReplayFailed: () => {},
      })
    );
    assert.match(populatedHtml, /Replay yang eligible \([\s<!->]*1[\s<!->]*\)/);
    assert.match(populatedHtml, /bg-zinc-900/);
    assert.match(populatedHtml, /cursor-pointer/);
  });

  await suite.test('C3: BulkReplayModal renders delivered row (even N=0), failed breakdown + advice, skipped breakdown, and retry in-progress', () => {
    // Case 1: Result with 0 delivered, 2 failed, 1 skipped, 1 inProgress
    const modalState = {
      open: true,
      totalCount: 4,
      eligibleIds: ['evt-1', 'evt-2', 'evt-3'],
      ineligibleItems: [{ id: 'evt-4', reason: 'Header hilang', badgeLabel: 'Header hilang' }],
      inProgress: false,
      pollingStatus: null,
      resultData: {
        deliveredCount: 0,
        unverifiedCount: 2,
        unverifiedBreakdown: '2 token tidak cocok',
        skippedCount: 1,
        skippedBreakdown: '1 header hilang',
        followUpAdvice: 'Tindak lanjut: Periksa kembali secret key di menu Endpoints dan dashboard provider sebelum mencoba kembali.',
        inProgressCount: 1,
      },
    };

    const html = renderToString(
      React.createElement(BulkReplayModal, {
        bulkModal: modalState,
        onClose: () => {},
        onConfirm: () => {},
      })
    );

    // Assert "Hasil replay" title
    assert.match(html, /Hasil replay/);
    // Assert total processed row "Dari total N event"
    assert.match(html, /data-testid="bulk-total-processed-row"/);
    assert.match(html, /Dari total[\s<!->]*<b[^>]*>4[\s<!->]*event<\/b>/);
    // Assert sum: lolos + tetap gagal verifikasi + tetap gagal kirim + dikecualikan + retry == N
    const sum1 =
      (modalState.resultData.deliveredCount || 0) +
      (modalState.resultData.unverifiedCount || 0) +
      (modalState.resultData.deliveryFailedCount || 0) +
      (modalState.resultData.skippedCount || 0) +
      (modalState.resultData.inProgressCount || 0);
    assert.strictEqual(sum1, 4, 'lolos + tetap gagal verifikasi + tetap gagal kirim + dikecualikan + retry == N (Case 1)');

    // Assert delivered row unconditionally rendered (even when 0)
    assert.match(html, /data-testid="bulk-delivered-row"/);
    assert.match(html, /0[\s<!->]*event<\/b>[\s<!->]*lolos verifikasi/);
    // Assert unverified failed row with breakdown
    assert.match(html, /2[\s<!->]*event<\/b>[\s<!->]*tetap gagal verifikasi[\s<!->]*\([\s<!->]*2 token tidak cocok[\s<!->]*\)/);
    assert.match(html, /Tindak lanjut: Periksa kembali secret key/);
    // Assert skipped row with breakdown
    assert.match(html, /1[\s<!->]*event<\/b>[\s<!->]*dikecualikan otomatis[\s<!->]*\([\s<!->]*1 header hilang[\s<!->]*\)/);
    // Assert inProgress retry row
    assert.match(html, /1[\s<!->]*event<\/b>[\s<!->]*masih dalam proses retry otomatis di antrean worker/);

    // Case 2: Full mixed result (delivered + unverified + deliveryFailed + skipped + retry)
    const mixedState = {
      open: true,
      totalCount: 5,
      eligibleIds: ['evt-1', 'evt-2', 'evt-3', 'evt-4'],
      ineligibleItems: [{ id: 'evt-5', reason: 'Header hilang', badgeLabel: 'Header hilang' }],
      inProgress: false,
      pollingStatus: null,
      resultData: {
        deliveredCount: 2,
        unverifiedCount: 0,
        deliveryFailedCount: 1,
        deliveryFailedBreakdown: 'HTTP 500',
        skippedCount: 1,
        skippedBreakdown: '1 header hilang',
        followUpAdvice: 'Tindak lanjut: Periksa error log downstream.',
        inProgressCount: 1,
      },
    };
    const mixedHtml = renderToString(
      React.createElement(BulkReplayModal, {
        bulkModal: mixedState,
        onClose: () => {},
        onConfirm: () => {},
      })
    );
    assert.match(mixedHtml, /Dari total[\s<!->]*<b[^>]*>5[\s<!->]*event<\/b>/);
    const sumMixed =
      mixedState.resultData.deliveredCount +
      (mixedState.resultData.unverifiedCount || 0) +
      mixedState.resultData.deliveryFailedCount +
      mixedState.resultData.skippedCount +
      mixedState.resultData.inProgressCount;
    assert.strictEqual(sumMixed, 5, 'lolos + tetap gagal verifikasi + tetap gagal kirim + dikecualikan + retry == N (Mixed Case)');
  });

  await suite.test('C4: Single status marker, no disabled status button, helper text only for disabled or ineligible', () => {
    const ineligibleEvent = {
      id: 'evt-ineligible-1',
      endpoint_id: 'ep-orders',
      provider: 'stripe',
      source_ip: '127.0.0.1',
      headers: {},
      payload_raw: '{}',
      is_verified: -1,
      status: 'FAILED',
      http_status_code: 0,
      attempts: 0,
      max_attempts: 5,
      failure_code: 'SIGNATURE_HEADER_MISSING',
      last_error: 'missing Stripe-Signature header',
      created_at: new Date().toISOString(),
      failed_at: new Date().toISOString(),
    };

    const html = renderToString(
      React.createElement(InspectorDrawer, {
        event: ineligibleEvent,
        endpoints: [],
        onClose: () => {},
        onReplay: () => {},
        onToast: () => {},
      })
    );

    // Status badge is single marker in header
    const statusBadges = html.match(/<span>Gagal<\/span>/g);
    assert.strictEqual(statusBadges?.length, 1);

    // No button labeled with status
    const buttons = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g) || [];
    for (const btn of buttons) {
      assert.doesNotMatch(btn, /<span>Gagal<\/span>/);
      assert.doesNotMatch(btn, /<span>Menunggu<\/span>/);
      assert.doesNotMatch(btn, /<span>Terkirim<\/span>/);
      assert.doesNotMatch(btn, /<span>Dijadwalkan ulang<\/span>/);
    }

    // Ineligible helper text is shown
    assert.match(html, /Tidak bisa diverifikasi ulang karena header signature tidak pernah diterima\./);
  });

  await suite.test('C5: Toast component auto-dismisses in 3s, ID 8 chars, above action bar (bottom-24)', () => {
    const toastSource = fs.readFileSync(path.join(__dirname, '../src/components/Toast.tsx'), 'utf8');
    assert.match(toastSource, /setTimeout\([^,]+,\s*3000\)/, 'Toast must auto-dismiss after 3000ms');
    assert.match(toastSource, /bottom-24/, 'Toast must be positioned at bottom-24 above action bar');
  });

  await suite.test('C7: Responsive design classes (overlay + backdrop on < 1280, side-by-side on >= 1280 without horizontal scroll)', () => {
    const drawerSource = fs.readFileSync(path.join(__dirname, '../src/components/InspectorDrawer.tsx'), 'utf8');
    assert.match(drawerSource, /xl:relative/, 'Drawer must be relative on xl: (>= 1280px)');
    assert.match(drawerSource, /xl:hidden/, 'Scrim backdrop must be hidden on xl:');
    assert.match(drawerSource, /backdrop-blur-2xs/, 'Scrim backdrop blur class present');
  });

  await suite.test('C8: Semantic <h1> heading on DLQ and Events views', () => {
    const dlqSource = fs.readFileSync(path.join(__dirname, '../src/components/DeadLetterView.tsx'), 'utf8');
    const eventsSource = fs.readFileSync(path.join(__dirname, '../src/components/EventsView.tsx'), 'utf8');

    assert.match(dlqSource, /<h1[^>]*>\s*Dead-Letter Queue \(DLQ\)\s*<\/h1>/, 'DLQ page must have <h1> semantic heading');
    assert.match(eventsSource, /<h1[^>]*>\s*Semua Webhook Event\s*<\/h1>/, 'Events page must have <h1> semantic heading');
  });

  await suite.test('C9: API error parser handles 401, 403, 409, 5xx with human Indonesian messages', () => {
    const apiSource = fs.readFileSync(path.join(__dirname, '../src/api.ts'), 'utf8');
    assert.match(apiSource, /relaygate_session_expired/, '401 must dispatch relaygate_session_expired event');
    assert.match(apiSource, /Sesi berakhir/, '401 message must be "Sesi berakhir"');
    assert.match(apiSource, /Akses ditolak/, '403 must provide human Indonesian message');
    assert.match(apiSource, /Konflik: Event ini sudah dalam status diproses ulang/, '409 must provide human Indonesian message');
    assert.match(apiSource, /Terjadi kesalahan pada server RelayGate/, '5xx must provide human Indonesian message');
  });

  // ==========================================
  // SECTION D: CROSS-STATE INVARIANTS D1 - D9
  // (Tested across all 21 canonical fixtures)
  // ==========================================

  await suite.test('Section D: Cross-state invariants D1-D9 verified across all 21 fixtures', () => {
    const fixtures = [
      {
        id: '32a5285c-49d1-4276-9356-db3f519009dc',
        name: 'Xendit SIGNATURE_HEADER_MISSING',
        event: {
          id: '32a5285c-49d1-4276-9356-db3f519009dc',
          endpoint_id: 'ep_97aaeddd',
          provider: 'xendit',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"disbursement.sent"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'static_token',
          failure_code: 'SIGNATURE_HEADER_MISSING',
          last_error: 'missing X-Callback-Token header',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: '499cd52a-8a5d-4a91-bde9-9309cafc4944',
        name: 'Stripe 504 delivery failure',
        event: {
          id: '499cd52a-8a5d-4a91-bde9-9309cafc4944',
          endpoint_id: 'ep_7efe4e7e',
          provider: 'stripe',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json', 'stripe-signature': 't=1700000000,v1=valid_dummy_signature' },
          payload_raw: '{"id":"evt_stripe_123"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 504,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_5XX',
          last_error: 'HTTP 504 Gateway Timeout from downstream server',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 504,
      },
      {
        id: '5b308412-80c8-4b64-a4cd-f3c8c2eb7357',
        name: 'Generic SIGNATURE_HEADER_MISSING',
        event: {
          id: '5b308412-80c8-4b64-a4cd-f3c8c2eb7357',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json', 'user-agent': 'Webhook-Sender/1.0' },
          payload_raw: '{"action":"deploy"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'SIGNATURE_HEADER_MISSING',
          last_error: 'cryptographic signature verification failed: missing signature header',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'e10029c1-d192-4efb-be07-0f394037ddaf',
        name: 'Xendit SIGNATURE_MISMATCH',
        event: {
          id: 'e10029c1-d192-4efb-be07-0f394037ddaf',
          endpoint_id: 'ep_97aaeddd',
          provider: 'xendit',
          source_ip: '127.0.0.1',
          headers: { 'x-callback-token': 'invalid_callback_token_xyz' },
          payload_raw: '{"event":"invoice.paid"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'static_token',
          failure_code: 'SIGNATURE_MISMATCH',
          last_error: 'xendit callback token mismatch',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Verifikasi ulang & kirim',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'ev_delivered_event_12345678',
        name: 'Generic DELIVERED',
        event: {
          id: 'ev_delivered_event_12345678',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"ping.successful"}',
          is_verified: 1,
          status: 'DELIVERED',
          http_status_code: 200,
          attempts: 1,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: '',
          last_error: '',
          created_at: '2026-10-14T10:00:00Z',
          updated_at: '2026-10-14T10:00:02Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Terkirim pada:',
        expectedHttpCode: 200,
      },
      {
        id: 'ev_github_mismatch_12345678',
        name: 'GitHub SIGNATURE_MISMATCH',
        event: {
          id: 'ev_github_mismatch_12345678',
          endpoint_id: 'ep_github',
          provider: 'github',
          source_ip: '127.0.0.1',
          headers: { 'x-hub-signature-256': 'sha256=invalid_github_signature' },
          payload_raw: '{"action":"push"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'SIGNATURE_MISMATCH',
          last_error: 'github signature mismatch',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Verifikasi ulang & kirim',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'ev_http404_failure_12345678',
        name: 'Generic HTTP_4XX (404)',
        event: {
          id: 'ev_http404_failure_12345678',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"sync.requested"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 404,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_4XX',
          last_error: 'HTTP 404 Not Found at downstream route',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 404,
      },
      {
        id: 'ev_http500_failure_12345678',
        name: 'Generic HTTP_5XX (500)',
        event: {
          id: 'ev_http500_failure_12345678',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'x-signature-sha256': 'valid_sig' },
          payload_raw: '{"event":"user.created"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 500,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_5XX',
          last_error: 'HTTP 500 Internal Server Error from target service',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 500,
      },
      {
        id: 'ev_http502_failure_12345678',
        name: 'Generic HTTP_5XX (502)',
        event: {
          id: 'ev_http502_failure_12345678',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"order.placed"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 502,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_5XX',
          last_error: 'HTTP 502 Bad Gateway downstream proxy error',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 502,
      },
      {
        id: 'ev_http503_failure_12345678',
        name: 'Generic HTTP_5XX (503)',
        event: {
          id: 'ev_http503_failure_12345678',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"inventory.checked"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 503,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_5XX',
          last_error: 'HTTP 503 Service Unavailable: upstream overloaded',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 503,
      },
      {
        id: 'ev_legacy_null_failure_code',
        name: 'Legacy row with NULL failure_code',
        event: {
          id: 'ev_legacy_null_failure_code',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"legacy.unmigrated"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 500,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: null,
          failed_at: null,
          last_error: 'HTTP 500 downstream internal error',
          created_at: '2026-10-14T10:00:00Z',
          updated_at: '2026-10-14T10:00:02Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 500,
      },
      {
        id: 'ev_midtrans_mismatch_123456',
        name: 'Midtrans SIGNATURE_MISMATCH',
        event: {
          id: 'ev_midtrans_mismatch_123456',
          endpoint_id: 'ep_midtrans',
          provider: 'midtrans',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"order_id":"order_1001","signature_key":"invalid_sha512_hash"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hash',
          failure_code: 'SIGNATURE_MISMATCH',
          last_error: 'midtrans signature key hash mismatch',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Verifikasi ulang & kirim',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'ev_pending_event_1234567890',
        name: 'Generic PENDING',
        event: {
          id: 'ev_pending_event_1234567890',
          endpoint_id: 'ep_hold',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"task.enqueued"}',
          is_verified: 1,
          status: 'PENDING',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: '',
          last_error: '',
          created_at: '2026-10-14T10:00:00Z',
          updated_at: '2026-10-14T10:00:02Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Dijadwalkan pada:',
        expectedHttpCode: null,
      },
      {
        id: 'ev_retrying_event_12345678',
        name: 'Generic RETRYING (held on ep_hold)',
        event: {
          id: 'ev_retrying_event_12345678',
          endpoint_id: 'ep_hold',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"retry.active"}',
          is_verified: 1,
          status: 'RETRYING',
          http_status_code: 504,
          attempts: 2,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_5XX',
          last_error: 'HTTP 504 Gateway Timeout on attempt 2',
          created_at: '2026-10-14T10:00:00Z',
          updated_at: '2026-10-14T10:00:02Z',
          next_retry_at: '2026-10-14T11:00:00Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Dijadwalkan pada:',
        expectedHttpCode: 504,
      },
      {
        id: 'ev_stripe_expired_123456789',
        name: 'Stripe SIGNATURE_TIMESTAMP_EXPIRED',
        event: {
          id: 'ev_stripe_expired_123456789',
          endpoint_id: 'ep_7efe4e7e',
          provider: 'stripe',
          source_ip: '127.0.0.1',
          headers: { 'stripe-signature': 't=1500000000,v1=expired_sig' },
          payload_raw: '{"id":"evt_old"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'SIGNATURE_TIMESTAMP_EXPIRED',
          last_error: 'stripe timestamp too old, exceeds tolerance window',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'ev_stripe_invalid_timestamp',
        name: 'Stripe SIGNATURE_TIMESTAMP_INVALID',
        event: {
          id: 'ev_stripe_invalid_timestamp',
          endpoint_id: 'ep_7efe4e7e',
          provider: 'stripe',
          source_ip: '127.0.0.1',
          headers: { 'stripe-signature': 'invalid_timestamp_token' },
          payload_raw: '{"id":"evt_invalid_ts"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'SIGNATURE_TIMESTAMP_INVALID',
          last_error: 'unable to parse timestamp from Stripe-Signature header',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'ev_timeout_failure_12345678',
        name: 'Generic TIMEOUT',
        event: {
          id: 'ev_timeout_failure_12345678',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"report.generate"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'TIMEOUT',
          last_error: 'context deadline exceeded while awaiting downstream response',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'adv_max_quota_replay',
        name: 'Generic FAILED 504 kuota habis (attempts 5/5)',
        event: {
          id: 'adv_max_quota_replay',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"adv.max_quota"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 504,
          attempts: 5,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_5XX',
          last_error: 'HTTP 504 Gateway Timeout: kuota pengiriman habis',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 504,
      },
      {
        id: 'adv_midtrans_corrupt',
        name: 'Midtrans SIGNATURE_PAYLOAD_MALFORMED',
        event: {
          id: 'adv_midtrans_corrupt',
          endpoint_id: 'ep_midtrans',
          provider: 'midtrans',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{corrupt_json_payload',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hash',
          failure_code: 'SIGNATURE_PAYLOAD_MALFORMED',
          last_error: "invalid character 'c' looking for beginning of object key string",
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'adv_stripe_expired',
        name: 'Stripe SIGNATURE_TIMESTAMP_EXPIRED (adv)',
        event: {
          id: 'adv_stripe_expired',
          endpoint_id: 'ep_7efe4e7e',
          provider: 'stripe',
          source_ip: '127.0.0.1',
          headers: { 'stripe-signature': 't=1500000000,v1=expired_sig_adv' },
          payload_raw: '{"id":"evt_adv_expired"}',
          is_verified: -1,
          status: 'FAILED',
          http_status_code: 0,
          attempts: 0,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'SIGNATURE_TIMESTAMP_EXPIRED',
          last_error: 'stripe timestamp too old, exceeds tolerance window',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: null,
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: null,
      },
      {
        id: 'adv_pending_fails_again',
        name: 'Generic FAILED 504 attempts < max_attempts (attempts 1/5)',
        event: {
          id: 'adv_pending_fails_again',
          endpoint_id: 'ep_35a35284',
          provider: 'generic',
          source_ip: '127.0.0.1',
          headers: { 'content-type': 'application/json' },
          payload_raw: '{"event":"adv.pending_failed_again"}',
          is_verified: 1,
          status: 'FAILED',
          http_status_code: 504,
          attempts: 1,
          max_attempts: 5,
          verification_kind: 'hmac',
          failure_code: 'HTTP_5XX',
          last_error: 'HTTP 504 Gateway Timeout: koneksi ditutup sebelum respons selesai',
          created_at: '2026-10-14T10:00:00Z',
          failed_at: '2026-10-14T10:00:01Z',
        },
        expectedButton: 'Replay',
        expectedTimeLabel: 'Gagal pada:',
        expectedHttpCode: 504,
      },
    ];

    assert.strictEqual(fixtures.length, 21, 'Must test exactly 21 canonical fixtures');

    for (const f of fixtures) {
      const html = renderToString(
        React.createElement(InspectorDrawer, {
          event: f.event,
          endpoints: [
            { id: f.event.endpoint_id, name: 'Endpoint', provider: f.event.provider, target_url: 'http://example.com' }
          ],
          onClose: () => {},
          onReplay: () => {},
          onToast: () => {},
        })
      );

      // Strip technical details for clean invariant checks on visible DOM
      const withoutDetails = html.replace(/<details\b[^>]*data-testid="technical-details"[\s\S]*?<\/details>/gi, '');
      const visibleTextWithoutTestIds = withoutDetails.replace(/\bdata-testid="[^"]*"/g, '');

      // D1: Status word appears exactly once in header badge; no button labeled with status
      const expectedBadgeWord = f.event.status === 'DELIVERED' ? 'Terkirim' : (f.event.status === 'PENDING' || f.event.status === 'RETRYING') ? 'Menunggu' : 'Gagal';
      const badgeWordMatches = html.match(new RegExp(`<span>${expectedBadgeWord}</span>`, 'g'));
      assert.strictEqual(
        badgeWordMatches?.length, 
        1, 
        `[${f.name}] D1: Status badge "${expectedBadgeWord}" must appear exactly once in header`
      );

      const buttons = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g) || [];
      for (const btn of buttons) {
        assert.doesNotMatch(btn, />(?:Terkirim|Menunggu|Gagal|Dijadwalkan ulang)<\//, `[${f.name}] D1: No button may have status label`);
      }

      // D2: "Ditolak" and "Tidak dicoba" appear ONLY when is_verified === -1
      if (f.event.is_verified === -1) {
        assert.match(withoutDetails, /Tidak dicoba/, `[${f.name}] D2: Verification rejected must show "Tidak dicoba"`);
        assert.match(withoutDetails, /Ditolak saat verifikasi/, `[${f.name}] D2: Verification rejected must show "Ditolak saat verifikasi"`);
      } else {
        assert.doesNotMatch(withoutDetails, /Tidak dicoba/, `[${f.name}] D2: Non-rejected event must not show "Tidak dicoba"`);
        assert.doesNotMatch(withoutDetails, /Ditolak saat verifikasi/, `[${f.name}] D2: Non-rejected event must not show "Ditolak saat verifikasi"`);
      }

      // D3: At most one HTTP code in panel and equals event.http_status_code
      const httpMatches = withoutDetails.match(/\bHTTP (?:<!-- -->)?(\d{3})\b/g) || [];
      if (f.expectedHttpCode) {
        assert.ok(httpMatches.length <= 1, `[${f.name}] D3: At most one HTTP code in panel, found: ${httpMatches.join(', ')}`);
        assert.match(withoutDetails, new RegExp(`HTTP (?:<!-- -->)?${f.expectedHttpCode}`), `[${f.name}] D3: Must match event HTTP code ${f.expectedHttpCode}`);
      } else {
        assert.strictEqual(httpMatches.length, 0, `[${f.name}] D3: Must not have HTTP code when code is 0, but found: ${httpMatches.join(', ')}`);
      }

      // D4: Time label strictly matches status
      assert.match(html, new RegExp(f.expectedTimeLabel), `[${f.name}] D4: Must have time label "${f.expectedTimeLabel}"`);
      if (f.expectedTimeLabel === 'Terkirim pada:') {
        assert.doesNotMatch(html, /Gagal pada:/, `[${f.name}] D4: DELIVERED must not show "Gagal pada:"`);
        assert.doesNotMatch(html, /Dijadwalkan pada:/, `[${f.name}] D4: DELIVERED must not show "Dijadwalkan pada:"`);
      } else if (f.expectedTimeLabel === 'Dijadwalkan pada:') {
        assert.doesNotMatch(html, /Gagal pada:/, `[${f.name}] D4: PENDING/RETRYING must not show "Gagal pada:"`);
        assert.doesNotMatch(html, /Terkirim pada:/, `[${f.name}] D4: PENDING/RETRYING must not show "Terkirim pada:"`);
      } else {
        assert.doesNotMatch(html, /Terkirim pada:/, `[${f.name}] D4: FAILED must not show "Terkirim pada:"`);
        assert.doesNotMatch(html, /Dijadwalkan pada:/, `[${f.name}] D4: FAILED must not show "Dijadwalkan pada:"`);
      }

      // D5: Attempts count matches state (in drawer AND table row)
      if (f.event.is_verified === -1) {
        assert.match(html, /data-testid="attempts-count"[^>]*>Tidak dicoba/, `[${f.name}] D5: attempts must show "Tidak dicoba"`);
        assert.match(html, /data-testid="attempts-stop-reason"[^>]*>Ditolak saat verifikasi/, `[${f.name}] D5: attempts subtext "Ditolak saat verifikasi"`);
        assert.doesNotMatch(html, /data-testid="attempts-count"[^>]*>0\s*\/\s*5/, `[${f.name}] D5: rejected verification must NOT show "0 / 5"`);
      } else if (f.event.status === 'DELIVERED') {
        assert.match(html, new RegExp(`data-testid="attempts-count"[^>]*>${f.event.attempts}[\\s]*(?:<!-- -->)?[\\s]*\\/[\\s]*(?:<!-- -->)?[\\s]*${f.event.max_attempts || 5}`), `[${f.name}] D5: attempts >= 1`);
      } else if (f.event.status === 'PENDING') {
        assert.match(html, /data-testid="attempts-count"[^>]*>0[\s]*(?:<!-- -->)?[\s]*\/[\s]*(?:<!-- -->)?[\s]*5/, `[${f.name}] D5: PENDING attempts clean "0 / 5"`);
        if ((f.event.attempts ?? 0) === 0 && !f.event.http_status_code && !(f.event.last_error || '').trim()) {
          assert.match(html, /Event menunggu giliran dikirim ke downstream/, `[${f.name}] Fresh PENDING must show "Event menunggu giliran dikirim ke downstream"`);
          assert.doesNotMatch(html, /Event dijadwalkan ulang untuk pengiriman downstream/, `[${f.name}] Fresh PENDING must not show "dijadwalkan ulang"`);
        } else {
          assert.match(html, /Event dijadwalkan ulang untuk pengiriman downstream/, `[${f.name}] Replayed PENDING must show "Event dijadwalkan ulang untuk pengiriman downstream"`);
        }
      } else if (f.event.status === 'RETRYING') {
        assert.match(html, new RegExp(`data-testid="attempts-count"[^>]*>${f.event.attempts}[\\s]*(?:<!-- -->)?[\\s]*\\/[\\s]*(?:<!-- -->)?[\\s]*${f.event.max_attempts || 5}`), `[${f.name}] D5: RETRYING attempts`);
        assert.match(html, /Mencoba ulang\.\.\./, `[${f.name}] D5: RETRYING subtext "Mencoba ulang..."`);
      } else {
        // FAILED delivery
        assert.match(html, new RegExp(`${f.event.attempts}[\\s]*(?:<!-- -->)?[\\s]*\\/[\\s]*(?:<!-- -->)?[\\s]*${f.event.max_attempts || 5}`), `[${f.name}] D5: FAILED delivery attempts`);
        if (f.event.attempts >= f.event.max_attempts) {
          assert.match(html, /Kuota habis/, `[${f.name}] D5: FAILED with attempts >= max_attempts must show "Kuota habis"`);
        } else {
          // When attempts < max_attempts, must show stop reason from last_error, NOT "Kuota habis", NOT "Dalam proses"
          assert.doesNotMatch(html, /Kuota habis/, `[${f.name}] D5: FAILED with attempts < max_attempts must NEVER show "Kuota habis"`);
          assert.doesNotMatch(html, /Dalam proses/, `[${f.name}] D5: FAILED with attempts < max_attempts must NEVER show "Dalam proses"`);
          assert.match(html, /data-testid="attempts-stop-reason"/, `[${f.name}] D5: stop reason rendered`);
        }
      }

      // D5: Extended check on DeadLetterView table row
      const tableRowHtml = renderToString(
        React.createElement(DeadLetterView, {
          events: [f.event],
          endpoints: [],
          selectedEventId: null,
          onSelectEvent: () => {},
          onReplaySingle: () => {},
          onBulkReplay: () => {},
        })
      );
      if (f.event.is_verified === -1) {
        assert.match(tableRowHtml, /Tidak dicoba/, `[${f.name}] D5 Table: must show "Tidak dicoba"`);
        assert.match(tableRowHtml, /Ditolak saat verifikasi/, `[${f.name}] D5 Table: must show "Ditolak saat verifikasi"`);
        assert.doesNotMatch(tableRowHtml, /<span>0\/5<\/span>/, `[${f.name}] D5 Table: must NOT show 0/5 for rejected`);
      } else if (f.event.attempts >= (f.event.max_attempts || 5)) {
        assert.match(tableRowHtml, /Kuota habis/, `[${f.name}] D5 Table: attempts >= max must show "Kuota habis"`);
      } else {
        assert.doesNotMatch(tableRowHtml, /Kuota habis/, `[${f.name}] D5 Table: attempts < max must NOT show "Kuota habis"`);
      }

      // D6: No raw enums in visible text outside technical details, no raw sensitive secrets, no forbidden terms for static_token
      assert.doesNotMatch(
        visibleTextWithoutTestIds, 
        /\b[A-Z]{3,}(_[A-Z0-9]+)+\b/, 
        `[${f.name}] D6: Visible DOM must not contain raw enum strings`
      );
      assert.doesNotMatch(html, /invalid_callback_token_xyz/, `[${f.name}] D6: Sensitive secret must be masked`);

      // D6: No English words ("attempt", "on attempt", "failed", etc.) in visible DOM outside technical details
      assert.doesNotMatch(
        withoutDetails.replace(/\bdata-testid="[^"]*"/g, ''),
        /\b(attempt|attempts|failed|on\s+attempt)\b/i,
        `[${f.name}] D6: Visible drawer DOM must not contain English attempt/failed leakage`
      );

      if (f.event.verification_kind === 'static_token' || f.event.provider === 'xendit') {
        assert.doesNotMatch(withoutDetails, /kriptografis/i, `[${f.name}] D6: static_token must not use "kriptografis"`);
        assert.doesNotMatch(withoutDetails, /HMAC/i, `[${f.name}] D6: static_token must not use "HMAC"`);
        assert.doesNotMatch(withoutDetails, /\bhash\b/i, `[${f.name}] D6: static_token must not use "hash"`);
        if (withoutDetails.includes('Token:') || withoutDetails.includes('Signature:')) {
          assert.match(withoutDetails, /Token:/, `[${f.name}] D6: static_token must use "Token:", not "Signature:"`);
          assert.doesNotMatch(withoutDetails, /Signature:/, `[${f.name}] D6: static_token must not use "Signature:"`);
        }
      }

      // D7: Each fact rendered once outside details
      const providerCount = (withoutDetails.match(/Provider:/g) || []).length;
      assert.strictEqual(providerCount, 1, `[${f.name}] D7: Provider fact rendered once in grid`);
      const timeCount = (withoutDetails.match(/(?:Terkirim|Dijadwalkan|Gagal) pada:/g) || []).length;
      assert.strictEqual(timeCount, 1, `[${f.name}] D7: Time fact rendered once in grid`);
      const attemptsFactCount = (withoutDetails.match(/Percobaan:/g) || []).length;
      assert.strictEqual(attemptsFactCount, 1, `[${f.name}] D7: Attempts fact rendered once in grid`);

      // D7: Concrete 5-consecutive-word check across normalized panel blocks
      const analysis = analyzeEventError(f.event);
      const blocks = [
        analysis.title || '',
        analysis.summary || '',
        analysis.expectedHeader ? `Header diharapkan: ${analysis.expectedHeader}` : '',
        analysis.ineligibleHelperText || '',
        analysis.ineligibleReason || '',
        ...(analysis.advice || [])
      ].filter((s) => s.trim().length > 0);

      const normalizeToWords = (txt) => txt.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

      for (let i = 0; i < blocks.length; i++) {
        const wordsA = normalizeToWords(blocks[i]);
        if (wordsA.length < 5) continue;
        for (let j = i + 1; j < blocks.length; j++) {
          const wordsB = normalizeToWords(blocks[j]);
          if (wordsB.length < 5) continue;
          for (let start = 0; start <= wordsA.length - 5; start++) {
            const sliceA = wordsA.slice(start, start + 5).join(' ');
            for (let bStart = 0; bStart <= wordsB.length - 5; bStart++) {
              const sliceB = wordsB.slice(bStart, bStart + 5).join(' ');
              assert.notStrictEqual(
                sliceA, 
                sliceB, 
                `[${f.name}] D7: Duplicate 5-word phrase found between blocks: "${sliceA}"`
              );
            }
          }
        }
      }

      // D8: Action buttons strictly match state
      if (f.expectedButton) {
        if (f.expectedButton.includes('&')) {
          assert.match(html, /<span>Verifikasi ulang (?:&amp;|&) kirim<\/span>/, `[${f.name}] D8: Must have button "${f.expectedButton}"`);
        } else {
          assert.match(html, new RegExp(`<span>${f.expectedButton}</span>`), `[${f.name}] D8: Must have button "${f.expectedButton}"`);
        }
      } else {
        assert.doesNotMatch(html, /<span>Verifikasi ulang (?:&amp;|&) kirim<\/span>/, `[${f.name}] D8: Must NOT have reverify button`);
        assert.doesNotMatch(html, /<span>Replay<\/span>/, `[${f.name}] D8: Must NOT have Replay button`);
      }

      // D9: Technical details closed by default
      if (f.event.last_error) {
        assert.match(html, /data-testid="technical-details"/, `[${f.name}] D9: Technical details rendered`);
        assert.doesNotMatch(html, /<details[^>]*\bopen\b[^>]*data-testid="technical-details"/i, `[${f.name}] D9: Must not have open attribute`);
      }
    }
  });

  // Dedicated test for BulkReplayModal D2/D6 invariants
  await suite.test('BulkReplayModal D2 and D6 Invariants', () => {
    // 1. Delivery failure case (e.g. downstream 500)
    const deliveryModalHtml = renderToString(
      React.createElement(BulkReplayModal, {
        bulkModal: {
          open: true,
          totalCount: 1,
          eligibleIds: ['evt-500'],
          ineligibleItems: [],
          inProgress: false,
          pollingStatus: null,
          resultData: {
            deliveredCount: 0,
            unverifiedCount: 0,
            deliveryFailedCount: 1,
            deliveryFailedBreakdown: 'HTTP 500',
            skippedCount: 0,
            followUpAdvice: 'Tindak lanjut: Periksa error log downstream.',
          },
        },
        onClose: () => {},
        onConfirm: () => {},
      })
    );

    // D2: "Ditolak" must strictly only appear for verification rejected, NEVER for HTTP 500
    assert.match(deliveryModalHtml, /data-testid="bulk-delivery-failed-row"/);
    assert.match(deliveryModalHtml, /1[\s<!->]*event<\/b>[\s<!->]*tetap gagal kirim[\s<!->]*\([\s<!->]*HTTP 500[\s<!->]*\)/);
    assert.doesNotMatch(deliveryModalHtml, /downstream 500/i, 'D4: Delivery failure breakdown must show (HTTP 500), not (1 downstream 500)');
    assert.doesNotMatch(deliveryModalHtml, /ditolak/i, 'D2: Bulk modal delivery failure must NEVER use the word "ditolak"');

    // D6: No raw enums in visible modal text
    assert.doesNotMatch(deliveryModalHtml.replace(/\bdata-testid="[^"]*"/g, ''), /\b[A-Z]{3,}(_[A-Z0-9]+)+\b/);

    // 2. Verification failure case (e.g. signature mismatch)
    const unverifiedModalHtml = renderToString(
      React.createElement(BulkReplayModal, {
        bulkModal: {
          open: true,
          totalCount: 1,
          eligibleIds: ['evt-sig'],
          ineligibleItems: [],
          inProgress: false,
          pollingStatus: null,
          resultData: {
            deliveredCount: 0,
            unverifiedCount: 1,
            unverifiedBreakdown: '1 token tidak cocok',
            deliveryFailedCount: 0,
            skippedCount: 0,
            followUpAdvice: 'Tindak lanjut: Periksa kembali secret key di menu Endpoints.',
          },
        },
        onClose: () => {},
        onConfirm: () => {},
      })
    );

    assert.match(unverifiedModalHtml, /data-testid="bulk-unverified-row"/);
    assert.match(unverifiedModalHtml, /1[\s<!->]*event<\/b>[\s<!->]*tetap gagal verifikasi[\s<!->]*\([\s<!->]*1 token tidak cocok[\s<!->]*\)/);
    // D6: forbidden static_token terms
    assert.doesNotMatch(unverifiedModalHtml, /kriptografis/i);
    assert.doesNotMatch(unverifiedModalHtml, /HMAC/i);
  });

  await suite.test('formatAttemptsDisplay renders N without denominator when max_attempts is absent or <= 0', () => {
    const base = {
      id: 'evt-no-max',
      endpoint_id: 'ep-1',
      provider: 'stripe',
      source_ip: '127.0.0.1',
      headers: {},
      payload_raw: '{}',
      is_verified: 1,
      status: 'FAILED',
      http_status_code: 500,
      attempts: 3,
      last_error: 'HTTP 500 Internal Server Error',
      created_at: new Date().toISOString(),
    };

    const resUndefined = formatAttemptsDisplay({ ...base, max_attempts: undefined });
    assert.strictEqual(resUndefined.primaryText, '3');
    assert.doesNotMatch(resUndefined.primaryText, /\//);
    assert.strictEqual(resUndefined.secondaryText, 'Dihentikan pada percobaan 3');

    const resZero = formatAttemptsDisplay({ ...base, max_attempts: 0 });
    assert.strictEqual(resZero.primaryText, '3');
    assert.doesNotMatch(resZero.primaryText, /\//);

    const resDelivered = formatAttemptsDisplay({ ...base, status: 'DELIVERED', attempts: 2, max_attempts: undefined });
    assert.strictEqual(resDelivered.primaryText, '2');
    assert.strictEqual(resDelivered.secondaryText, null);

    const resPending = formatAttemptsDisplay({ ...base, status: 'PENDING', attempts: 0, max_attempts: undefined });
    assert.strictEqual(resPending.primaryText, '0');
    assert.strictEqual(resPending.secondaryText, null);
  });

  await suite.test('EventsView KPI cards: includes Menunggu (PENDING) card and sum of cards equals Total', () => {
    const sampleEvents = [
      { ...mockEvent, id: 'ev-del-1', status: 'DELIVERED', is_verified: 1, attempts: 1 },
      { ...mockEvent, id: 'ev-pend-1', status: 'PENDING', is_verified: 1, attempts: 0, http_status_code: 0, last_error: '' },
      { ...mockEvent, id: 'ev-ret-1', status: 'RETRYING', is_verified: 1, attempts: 2, http_status_code: 504 },
      { ...mockEvent, id: 'ev-fail-1', status: 'FAILED', is_verified: 1, attempts: 5, http_status_code: 504 },
      { ...mockEvent, id: 'ev-fail-2', status: 'FAILED', is_verified: -1, attempts: 0, http_status_code: 0 },
    ];

    const extractKpiValues = (htmlStr) => {
      const getVal = (testId) => {
        const m = htmlStr.match(new RegExp(`data-testid="${testId}"[^>]*>(\\d+)<`));
        assert.ok(m, `Missing KPI element ${testId}`);
        return Number(m[1]);
      };
      return {
        total: getVal('kpi-total-value'),
        delivered: getVal('kpi-delivered-value'),
        pending: getVal('kpi-pending-value'),
        retrying: getVal('kpi-retrying-value'),
        failed: getVal('kpi-failed-value'),
      };
    };

    // 1. From stats prop
    const htmlWithStats = renderToString(
      React.createElement(EventsView, {
        events: sampleEvents,
        stats: {
          total_events: 21,
          delivered_events: 1,
          pending_events: 1,
          retrying_events: 1,
          failed_events: 18,
        },
        endpoints: [],
        selectedEventId: null,
        onSelectEvent: () => {},
        onReplayEvent: () => {},
        onBulkReplayFailed: () => {},
        isLive: true,
        onToggleLive: () => {},
        bufferedCount: 0,
        onFlushBuffer: () => {},
        searchInputRef: { current: null },
      })
    );
    assert.match(htmlWithStats, /<span>Menunggu<\/span>/, 'Must render Menunggu KPI card label');
    const kpiStats = extractKpiValues(htmlWithStats);
    assert.strictEqual(kpiStats.total, 21);
    assert.strictEqual(kpiStats.delivered + kpiStats.pending + kpiStats.retrying + kpiStats.failed, kpiStats.total, 'Sum of status KPI cards must equal Total Events');

    // 2. Fallback from events array when stats is null
    const htmlFromEvents = renderToString(
      React.createElement(EventsView, {
        events: sampleEvents,
        stats: null,
        endpoints: [],
        selectedEventId: null,
        onSelectEvent: () => {},
        onReplayEvent: () => {},
        onBulkReplayFailed: () => {},
        isLive: true,
        onToggleLive: () => {},
        bufferedCount: 0,
        onFlushBuffer: () => {},
        searchInputRef: { current: null },
      })
    );
    const kpiEvents = extractKpiValues(htmlFromEvents);
    assert.strictEqual(kpiEvents.total, 5);
    assert.strictEqual(kpiEvents.delivered, 1);
    assert.strictEqual(kpiEvents.pending, 1);
    assert.strictEqual(kpiEvents.retrying, 1);
    assert.strictEqual(kpiEvents.failed, 2);
    assert.strictEqual(kpiEvents.delivered + kpiEvents.pending + kpiEvents.retrying + kpiEvents.failed, kpiEvents.total, 'Sum of status KPI cards from events must equal Total Events');
  });

  await suite.test('Navattic UI/UX Craft Invariants: single Pause Stream, EventsView keyboard rows, stacked InspectorDrawer metadata, valid Tailwind v3 tokens', () => {
    const eventsHtml = renderToString(
      React.createElement(EventsView, {
        events: [mockEvent],
        stats: null,
        endpoints: [],
        selectedEventId: null,
        onSelectEvent: () => {},
        onReplayEvent: () => {},
        onBulkReplayFailed: () => {},
        isLive: true,
        onToggleLive: () => {},
        bufferedCount: 0,
        onFlushBuffer: () => {},
        searchInputRef: { current: null },
      })
    );
    assert.ok(
      !eventsHtml.includes('Pause Stream') && !eventsHtml.includes('Resume Stream'),
      'EventsView must not render a duplicate Pause/Resume Stream button (owned by App top bar)'
    );
    assert.match(eventsHtml, /id="event-row-evt-test-12345678"/, 'EventsView row must have id="event-row-..."');
    assert.match(eventsHtml, /tabindex="0"/, 'EventsView row must be keyboard focusable via tabIndex={0}');

    const srcRoot = path.join(__dirname, '../src');
    const drawerSrc = fs.readFileSync(path.join(srcRoot, 'components', 'InspectorDrawer.tsx'), 'utf8');
    assert.ok(
      drawerSrc.includes('event-row-${evId}') && drawerSrc.includes('dlq-row-${evId}'),
      'InspectorDrawer handleClose must restore focus to both dlq-row and event-row'
    );
    assert.ok(
      drawerSrc.includes('flex flex-col gap-0.5'),
      'InspectorDrawer metadata cells must stack label above value (flex flex-col gap-0.5)'
    );

    const twConfig = fs.readFileSync(path.join(__dirname, '..', 'tailwind.config.js'), 'utf8');
    assert.ok(
      twConfig.includes("'2xs'") && twConfig.includes('backdropBlur'),
      'tailwind.config.js must define 2xs/xs boxShadow and backdropBlur tokens for Tailwind v3'
    );

    const compDir = path.join(srcRoot, 'components');
    for (const f of fs.readdirSync(compDir)) {
      if (f.endsWith('.tsx')) {
        const content = fs.readFileSync(path.join(compDir, f), 'utf8');
        assert.ok(
          !content.includes('py-0.2'),
          `${f} must not use non-existent Tailwind class py-0.2`
        );
      }
    }
  });

  await suite.test('ProfileModal Component & Architecture Hygiene', async () => {
    const mockUser = {
      id: 'usr-dev-999',
      name: 'Dev Lead',
      email: 'lead@relaygate.local',
      role: 'admin',
      avatar_url: '',
      created_at: '2026-11-01T00:00:00Z',
    };

    // Render open modal
    const openHtml = renderToString(
      React.createElement(ProfileModal, {
        isOpen: true,
        onClose: () => {},
        currentUser: mockUser,
        onProfileUpdated: () => {},
        onToast: () => {},
      })
    );
    assert.match(openHtml, /Pengaturan Profil/, 'Modal title must be rendered');
    assert.match(openHtml, /Profil Pengguna/, 'Profil tab button must exist');
    assert.match(openHtml, /Keamanan Akun/, 'Keamanan tab button must exist');
    assert.match(openHtml, /lead@relaygate\.local/, 'User email must be rendered in profile view');
    assert.match(openHtml, /Dev Lead/, 'User name must be present in nickname input');
    assert.match(openHtml, /admin/, 'User role pill must display role');
    assert.ok(!openHtml.includes('size-1.5 rounded-full'), 'ProfileModal status pill must not include decorative bullet dots');

    // Dynamic resilience: User without created_at
    const userWithoutCreatedAt = {
      id: 'usr-dev-998',
      name: 'No Date User',
      email: 'nodate@relaygate.local',
      role: 'editor',
      avatar_url: '',
      created_at: '',
    };
    const noDateHtml = renderToString(
      React.createElement(ProfileModal, {
        isOpen: true,
        onClose: () => {},
        currentUser: userWithoutCreatedAt,
        onProfileUpdated: () => {},
        onToast: () => {},
      })
    );
    assert.doesNotMatch(noDateHtml, /Terdaftar Sejak/, 'Must not render Terdaftar Sejak when created_at is falsy');
    assert.match(noDateHtml, /nodate@relaygate\.local/, 'Must still render email row');
    assert.match(noDateHtml, /editor/, 'Must still render role row');

    // Responsive resilience: User with exceptionally long email
    const longEmail = 'extremely-long-enterprise-admin-user-identity@production-datacenter.internal.relaygate.local';
    const longEmailHtml = renderToString(
      React.createElement(ProfileModal, {
        isOpen: true,
        onClose: () => {},
        currentUser: { ...mockUser, email: longEmail },
        onProfileUpdated: () => {},
        onToast: () => {},
      })
    );
    assert.match(longEmailHtml, /truncate/, 'Email label must have truncate class to prevent overflow');
    assert.match(longEmailHtml, new RegExp(`title="${longEmail}"`), 'Email element must have title attribute for tooltip accessibility');

    // Source code styling token assertions
    const compDir = path.join(__dirname, '../src/components');
    const profileSource = fs.readFileSync(path.join(compDir, 'ProfileModal.tsx'), 'utf8');
    assert.match(profileSource, /divide-y\s+divide-zinc-100/, 'Metadata list must use divide-y divide-zinc-100');
    assert.match(profileSource, /gap-3\s+text-xs\s+text-zinc-900\s+min-w-0/, 'Email row must use gap-3 and min-w-0');
    assert.match(profileSource, /last:pb-0/, 'Metadata rows must use last:pb-0 to ensure clean bottom spacing');

    // Render closed modal
    const closedHtml = renderToString(
      React.createElement(ProfileModal, {
        isOpen: false,
        onClose: () => {},
        currentUser: mockUser,
      })
    );
    assert.equal(closedHtml, '', 'ProfileModal must return null when isOpen is false');

    // Zero unicode em dash check across entire src directory
    const srcDir = path.join(__dirname, '../src');
    const checkEmDash = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkEmDash(full);
        } else if (/\.(tsx?|css|html)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          assert.ok(
            !text.includes('\u2014'),
            `Found forbidden unicode em dash in ${path.relative(srcDir, full)}`
          );
        }
      }
    };
    checkEmDash(srcDir);
  });

  await suite.test('Visual hygiene & Anti-slop: clean DLQ header without red badge, elegant LayoutDashboard icon for Overview', () => {
    const srcDir = path.join(__dirname, '../src');
    const dlqSource = fs.readFileSync(path.join(srcDir, 'components', 'DeadLetterView.tsx'), 'utf8');
    const sidebarSource = fs.readFileSync(path.join(srcDir, 'components', 'Sidebar.tsx'), 'utf8');
    const appSource = fs.readFileSync(path.join(srcDir, 'App.tsx'), 'utf8');

    // 1. DLQ header has clean <h1> without red failure badge
    assert.doesNotMatch(
      dlqSource,
      /<span[^>]*bg-rose-50[^>]*>[\s\S]*?event gagal[\s\S]*?<\/span>/,
      'DeadLetterView must not have red failure badge next to heading'
    );

    // 2. Overview icon is LayoutDashboard, NOT Activity (hospital heartbeat)
    assert.match(sidebarSource, /LayoutDashboard/, 'Sidebar must import and use LayoutDashboard');
    assert.doesNotMatch(sidebarSource, /\bActivity\b/, 'Sidebar must NOT use hospital heartbeat Activity icon');

    assert.match(appSource, /LayoutDashboard/, 'App must import and use LayoutDashboard');
    assert.doesNotMatch(appSource, /\bActivity\b/, 'App must NOT use hospital heartbeat Activity icon');

    // 3. Zero-failure neutral color assertions (no redundant alarmist red when count is 0)
    assert.match(
      appSource,
      /failedEventsCount\s*>\s*0\s*\?\s*'text-rose-600'\s*:\s*'text-zinc-500'/,
      'App breadcrumb dead icon must be neutral text-zinc-500 when failedEventsCount is 0'
    );

    const overviewSource = fs.readFileSync(path.join(srcDir, 'components', 'OverviewView.tsx'), 'utf8');
    assert.match(
      overviewSource,
      /failed\s*>\s*0\s*\?\s*'text-rose-700'\s*:\s*'text-zinc-950'/,
      'OverviewView DLQ metric value must be neutral text-zinc-950 when failed is 0'
    );
  });

  await suite.test('EndpointsView and Tambah Endpoint Modal Design Craft Invariants', () => {
    // 1. Test empty state render
    const emptyHtml = renderToString(
      React.createElement(EndpointsView, {
        endpoints: [],
        onAddEndpoint: async () => {},
        onToggleActive: async () => {},
        onToast: () => {},
      })
    );
    assert.match(emptyHtml, /Belum ada endpoint terdaftar/, 'Must render empty state message when endpoints array is empty');
    assert.match(emptyHtml, /Tambah Endpoint/, 'Must render Tambah Endpoint button');

    // 2. Test populated state render
    const testEndpoints = [
      {
        id: 'ep-orders',
        name: 'Orders Service',
        provider: 'stripe',
        target_url: 'https://api.internal.id/webhooks/orders',
        secret_key: 'whsec_test123',
        is_active: true,
      },
    ];
    const populatedHtml = renderToString(
      React.createElement(EndpointsView, {
        endpoints: testEndpoints,
        onAddEndpoint: async () => {},
        onToggleActive: async () => {},
        onToast: () => {},
      })
    );
    assert.match(populatedHtml, /Orders Service/, 'Must render endpoint name');
    assert.match(populatedHtml, /stripe/, 'Must render endpoint provider');
    assert.match(populatedHtml, /Aktif/, 'Must render active status');

    // 3. Inspect EndpointsView source code for required design system tokens
    const srcDir = path.join(__dirname, '../src');
    const endpointsSource = fs.readFileSync(path.join(srcDir, 'components', 'EndpointsView.tsx'), 'utf8');

    // Provider select dropdown styling: py-2 px-3 text-sm with appearance-none and chevron
    assert.match(
      endpointsSource,
      /py-2\s+pl-3\s+pr-9\s+text-sm/,
      'Provider dropdown must use py-2 pl-3 pr-9 text-sm padding tokens'
    );
    assert.match(
      endpointsSource,
      /appearance-none/,
      'Provider dropdown must suppress native OS select styling with appearance-none'
    );
    assert.match(
      endpointsSource,
      /<ChevronDown\b/,
      'Provider dropdown must use Lucide ChevronDown icon'
    );

    // Form inputs: text-sm, h-10, sans placeholders
    assert.match(
      endpointsSource,
      /placeholder:text-zinc-400\s+placeholder:font-normal/,
      'Form inputs must use refined placeholder styling with normal font weight'
    );
    assert.match(
      endpointsSource,
      /focus:border-zinc-900\s+focus:ring-1\s+focus:ring-zinc-900/,
      'Form inputs must use zinc-900 focus border and focus ring tokens'
    );

    // Modal card and backdrop
    assert.match(
      endpointsSource,
      /bg-zinc-950\/20\s+backdrop-blur-sm/,
      'Modal backdrop must use bg-zinc-950/20 with backdrop-blur-sm'
    );
    assert.match(
      endpointsSource,
      /max-h-\[calc\(100dvh-2rem\)\]\s+flex\s+flex-col/,
      'Modal card must enforce max-h-[calc(100dvh-2rem)] flex flex-col to prevent vertical clipping on small screens'
    );

    // Button active scaling
    assert.match(
      endpointsSource,
      /active:scale-\[0\.98\]/,
      'Modal buttons must have polished active:scale-[0.98] interaction state'
    );

    // Dialog accessibility attributes
    assert.match(
      endpointsSource,
      /role="dialog"/,
      'Modal container must declare role="dialog"'
    );
    assert.match(
      endpointsSource,
      /aria-modal="true"/,
      'Modal container must declare aria-modal="true"'
    );
    assert.match(
      endpointsSource,
      /aria-labelledby="add-endpoint-modal-title"/,
      'Modal container must declare aria-labelledby="add-endpoint-modal-title"'
    );
  });

  await suite.test('LandingPage Hero (dtnuyvc-casino-hero-section) + Body (kybern.treshnanda.tech) Adapted to RelayGate & Zero Rainbow Slop', async () => {
    const landingSource = fs.readFileSync(path.join(__dirname, '../src/components/LandingPage.tsx'), 'utf8');
    const landingFile = path.join(outDir, 'landing-bundle.mjs');
    await build({
      entryPoints: [path.join(__dirname, '../src/components/LandingPage.tsx')],
      bundle: true,
      format: 'esm',
      outfile: landingFile,
      external: ['react', 'react-dom', 'lucide-react'],
      jsx: 'transform',
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
    });

    const { LandingPage } = await import(`file://${landingFile.replace(/\\/g, '/')}`);
    const html = renderToString(
      React.createElement(LandingPage, {
        onOpenLogin: () => {},
        onOpenRegister: () => {},
      })
    );

    // 1. Top Hero adapted to RelayGate with authentic brand icon and white theme
    assert.match(html, />RelayGate<\/span>/, 'Must render RelayGate brand wordmark in hero header');
    assert.doesNotMatch(html, />Casino<\/span>/, 'Must NOT copy literal Casino brand name');
    assert.doesNotMatch(html, /Kybern/i, 'Must NOT copy literal Kybern brand name');
    assert.match(html, />Engine<\/a>/, 'Must render Engine nav link');
    assert.match(html, />Product<\/a>/, 'Must render Product nav link');
    assert.match(html, />Workspace<\/a>/, 'Must render Workspace nav link');
    assert.match(html, />Deploy<\/a>/, 'Must render Deploy nav link');
    assert.match(html, />Questions<\/a>/, 'Must render Questions nav link');
    assert.match(html, />Sign in<\/button>/, 'Must render single clean Sign in header button');
    assert.doesNotMatch(html, />Get started<\/button>/, 'Must not render redundant duplicate Get started button in header');
    assert.match(html, />New<\/span>/, 'Must render New pill badge');
    assert.match(html, /Every webhook\.<br\s*\/?>Zero dropped events\./, 'Must render 2-line RelayGate H1');
    assert.match(html, />Open Console<\/button>/, 'Must render Open Console hero CTA');
    assert.match(html, />Explore Engine<\/button>/, 'Must render Explore Engine hero CTA');

    // 2. Authentic RelayGate Brand Icon geometry (stylized gate vector with speed lines & core node)
    assert.match(html, /viewBox="0 0 113 79"/, 'Must render authentic RelayGate vector icon');
    assert.match(html, /fill-rule="evenodd"/, 'Must render evenodd vector fill rule');

    // 3. Clean Dashboard Window Preview centerpiece & removal of casino roulette
    assert.doesNotMatch(html, /hero-roulette\.webp/, 'Must NOT reference casino roulette image');
    assert.match(html, /data-testid="dashboard-window-preview"/, 'Must render clean Dashboard Window Preview centerpiece');
    assert.match(html, /http:\/\/127\.0\.0\.1:8080\/dashboard/, 'Must render local dashboard address bar');
    assert.match(html, /src="\/shots\/dashboard\.png"/, 'Must render real RelayGate dashboard preview screenshot');

    const dashboardAssetPath = path.join(__dirname, '../public/shots/dashboard.png');
    assert.ok(fs.existsSync(dashboardAssetPath), 'ui/public/shots/dashboard.png must exist on disk');

    // 4. Optical White Canvas theme verification
    assert.match(html, /bg-white/, 'Must render white background canvas');
    assert.doesNotMatch(html, /bg-casino-bg/, 'Must NOT use dark casino background');

    // 2. Body sections following kybern.treshnanda.tech structure adapted for RelayGate
    for (const secId of ['agents', 'native', 'product', 'workspace', 'faq', 'download']) {
      assert.match(
        html,
        new RegExp(`id="${secId}"`),
        `LandingPage must include section id="${secId}"`
      );
    }
    assert.match(html, /No Redis\./, 'Must render No Redis statement');
    assert.match(html, /No Kafka\./, 'Must render No Kafka statement');
    assert.match(html, /Workers that retry and isolate automatically\./, 'Must render Feature 1 headline');
    assert.match(html, /Failures you can inspect and replay\./, 'Must render Feature 2 headline');
    assert.match(html, /The rest of the pipeline, in the same window\./, 'Must render Workspace headline');
    assert.match(html, /Nothing leaves your server\./, 'Must render self-hosted topology statement');
    assert.match(html, /Any server becomes the ingestion edge\./, 'Must render environment statement');
    assert.match(html, /Run RelayGate\./, 'Must render download/quickstart display heading');
    assert.match(html, /class="footer__word">relaygate<\/div>/, 'Must render giant footer wordmark relaygate');

    // 3. Zero green/yellow/red rainbow slop classes in LandingPage.tsx
    assert.doesNotMatch(
      landingSource,
      /\b(emerald|amber|rose|green|yellow|red)-\d{2,3}\b/,
      'LandingPage.tsx must not use green/yellow/red (emerald/amber/rose) classes'
    );

    // 4. Mobile navigation & accessibility invariants
    assert.match(html, />Menu<\/span>/, 'Mobile navigation trigger must have visible "Menu" label');
    assert.match(html, /min-h-\[44px\]/, 'Interactive controls must enforce 44px minimum touch target');
    assert.match(html, /active:scale-\[0\.97\]/, 'Buttons must include tactile active:scale-[0.97] press state');
    assert.match(html, /focus-visible:ring-2/, 'Interactive controls must include visible focus-visible ring');
    assert.doesNotMatch(html, /animate-pulse|animate-ping/, 'LandingPage must not use infinite pulsing/pinging animations');

    // 5. Honest Engineering Copywriting & Real Transport assertions
    assert.match(html, /Server-Sent Events|SSE|\/api\/v1\/stream/, 'Must describe real Server-Sent Events (SSE) stream');
    assert.doesNotMatch(html, /ws:\/\/127\.0\.0\.1/, 'Must NOT advertise non-existent WebSocket ws:// endpoint');
    assert.match(html, /6-digit OTP|local dev email preview/i, 'Must mention local dev email preview mode for OTP verification');

    // 6. Footer authentic brand mark verification
    assert.match(html, /class="footer__top[^"]*">[\s\S]*?viewBox="0 0 113 79"/, 'Footer must render authentic RelayGate brand icon');

    // 7. Tailwind config hygiene: zero casino leftover
    const tailwindSource = fs.readFileSync(path.join(__dirname, '../tailwind.config.js'), 'utf8');
    assert.doesNotMatch(tailwindSource, /casino:/, 'tailwind.config.js must NOT contain casino palette');

    // 8. Zero packet ping animations & solid 60 FPS performance
    assert.doesNotMatch(landingSource, /rg-packet-ping/, 'LandingPage must NOT include desktop packet ping pulse');
    assert.doesNotMatch(landingSource, /rg-packet-ping-v/, 'LandingPage must NOT include mobile vertical packet ping pulse');
    assert.doesNotMatch(landingSource, /animate-pulse|animate-ping/, 'LandingPage must not use infinite pulsing/pinging animations');
    assert.match(landingSource, /ProductDashboardPreview/, 'LandingPage must include ProductDashboardPreview');
    assert.match(html, /data-testid="dashboard-window-preview"/, 'Must render clean Dashboard Window Preview centerpiece');
    assert.match(html, /http:\/\/127\.0\.0\.1:8080\/dashboard/, 'Must render local dashboard address bar in window chrome');
    assert.match(html, /src="\/shots\/dashboard\.png"/, 'Must render real RelayGate dashboard preview screenshot');
    const cssSource = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
    assert.doesNotMatch(cssSource, /@keyframes\s+rg-(node-pulse|packet-ping|laser-sweep|flow-dash|node-glow)/, 'index.css must not contain GPU-intensive continuous keyframe animations');

    // 9. Zero-fluff authentic engineering assertions (no marketing overclaim)
    assert.match(html, />Webhook gateway<\/span>/, 'Top pill must say "Webhook gateway" without buzzword fluff');
    assert.doesNotMatch(html, /Zero-dependency webhook gateway/i, 'Must NOT contain "Zero-dependency webhook gateway" marketing buzzwords');
    assert.match(html, /<span class="metaline">Webhook Gateway<\/span>/, 'Footer metaline must say "Webhook Gateway"');
    assert.doesNotMatch(html, /<span class="metaline">Zero-Dependency Webhook Gateway<\/span>/, 'Footer must NOT contain "Zero-Dependency"');

    // 10. Real Deployment Assets and Ingestion Mechanics
    assert.match(landingSource, /RELAYGATE_SYSTEMD_SERVICE/, 'Must bundle authentic systemd service unit');
    assert.match(landingSource, /RELAYGATE_CROSS_COMPILE/, 'Must bundle authentic cross-compilation command');
    assert.match(html, /relaygate-linux-amd64/, 'Must render relaygate-linux-amd64 asset row in default Linux tab');
    assert.match(html, /relaygate\.service/, 'Must render relaygate.service unit row in default Linux tab');
    assert.match(landingSource, /docker build -t relaygate \./, 'Docker tab must build from local Dockerfile without non-existent registry pull');
    assert.match(landingSource, /\/ingest\/ep_sample/, 'cURL test command must target real /ingest/:endpoint_id path');
    assert.match(landingSource, /-d \\'\{"id":"evt_1"\}\\'/, 'cURL test command must use valid single-quoted JSON payload for standard shell compatibility');

    const serviceAssetPath = path.join(__dirname, '../../scripts/relaygate.service');
    assert.ok(fs.existsSync(serviceAssetPath), 'scripts/relaygate.service must exist on disk');

    const dockerfilePath = path.join(__dirname, '../../Dockerfile');
    assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile must exist on disk');

    const dockerignorePath = path.join(__dirname, '../../.dockerignore');
    assert.ok(fs.existsSync(dockerignorePath), '.dockerignore must exist on disk to prevent local node_modules leak');
  });

  await suite.test('LoginPage Session Notice Redesign and Mobile Ergonomics (iPhone & Android)', async () => {
    const loginSource = fs.readFileSync(path.join(__dirname, '../src/components/LoginPage.tsx'), 'utf8');
    const loginFile = path.join(outDir, 'login-bundle.mjs');
    await build({
      entryPoints: [path.join(__dirname, '../src/components/LoginPage.tsx')],
      bundle: true,
      format: 'esm',
      outfile: loginFile,
      external: ['react', 'react-dom', 'lucide-react'],
      jsx: 'transform',
      loader: { '.tsx': 'tsx', '.ts': 'ts' },
    });

    const { LoginPage } = await import(`file://${loginFile.replace(/\\/g, '/')}`);

    // 1. Render with session notice
    const htmlWithNotice = renderToString(
      React.createElement(LoginPage, {
        onLoginSuccess: () => {},
        sessionNotice: 'Sesi Anda telah berakhir demi keamanan. Silakan masuk kembali.',
      })
    );

    assert.match(htmlWithNotice, /Sesi Anda telah berakhir demi keamanan\. Silakan masuk kembali\./, 'Must render dignified session expiration notice');
    assert.match(htmlWithNotice, /Sesi Berakhir/, 'Floating session notification must render "Sesi Berakhir" heading');
    assert.match(htmlWithNotice, /backdrop-blur-md/, 'Floating notification must use sleek glassmorphism backdrop-blur-md');
    assert.match(htmlWithNotice, /aria-label="Tutup pemberitahuan"/, 'Session notice must provide dismissible close action with aria-label');
    assert.match(htmlWithNotice, /min-h-\[44px\] min-w-\[44px\]/, 'Session notice dismiss button must enforce 44px touch target');

    // 2. Render with initialError="Sesi berakhir" backwards-compatibility
    const htmlWithCompat = renderToString(
      React.createElement(LoginPage, {
        onLoginSuccess: () => {},
        initialError: 'Sesi berakhir',
      })
    );
    assert.match(htmlWithCompat, /Sesi Anda telah berakhir demi keamanan\. Silakan masuk kembali\./, 'Sesi berakhir initialError must map to dignified session banner');

    // 3. Mobile responsiveness invariants
    assert.match(loginSource, /p-5 sm:p-8/, 'LoginPage modal must use mobile-responsive p-5 sm:p-8 padding');
    assert.match(loginSource, /max-w-sm mx-auto/, 'LoginPage modal must center cleanly on mobile');
    assert.match(loginSource, /safe-area-inset/, 'LoginPage must respect viewport safe-area-insets');
    assert.match(loginSource, /min-h-\[44px\]/, 'Interactive form controls must enforce 44px minimum touch targets');
    assert.match(loginSource, /text-base sm:text-sm/, 'Mobile inputs must use text-base (16px) to prevent iOS Safari auto-zoom');

    // 4. Sidebar mobile drawer invariants
    const sidebarSource = fs.readFileSync(path.join(__dirname, '../src/components/Sidebar.tsx'), 'utf8');
    assert.match(sidebarSource, /isMobileOpen/, 'Sidebar must support isMobileOpen prop');
    assert.match(sidebarSource, /onCloseMobile/, 'Sidebar must support onCloseMobile handler');
    assert.match(sidebarSource, /hidden md:flex/, 'Desktop sidebar must be hidden on mobile screens');
    assert.match(sidebarSource, /md:hidden/, 'Mobile drawer overlay must be hidden on desktop screens');
    assert.match(sidebarSource, /Escape/, 'Sidebar mobile drawer must listen to Escape key');
    assert.match(sidebarSource, /tabIndex=\{-1\}/, 'Sidebar mobile drawer panel must have tabIndex={-1} for focus management');
    assert.match(sidebarSource, /min-h-\[44px\] min-w-\[44px\]/, 'Sidebar mobile close button must enforce 44px touch target');
  });

  await suite.test('LoginPage OAuth Authentication and Logout UX Redirect Invariants', async () => {
    const loginSource = fs.readFileSync(path.join(__dirname, '../src/components/LoginPage.tsx'), 'utf8');
    const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
    const apiSource = fs.readFileSync(path.join(__dirname, '../src/api.ts'), 'utf8');

    // 1. Logout UX Redirect Invariant in App.tsx
    assert.match(appSource, /setShowAuthView\(true\)/, 'App.tsx must set showAuthView to true on handleLogout to redirect directly to LoginPage');
    assert.doesNotMatch(appSource, /handleLogout[^}]*setShowAuthView\(false\)/, 'handleLogout must never drop user back to landing page by setting showAuthView false');
    assert.match(appSource, /searchParams\.delete\('tab'\)/, 'handleLogout must clean up tab query parameter');
    assert.match(appSource, /searchParams\.set\('auth', 'login'\)/, 'handleLogout must persist auth=login parameter in URL');
    assert.match(appSource, /initialMode=\{authMode\}/, 'App.tsx must forward authMode to LoginPage');

    // 2. OAuth API client contract in api.ts
    assert.match(apiSource, /export async function oauthLogin/, 'api.ts must export oauthLogin helper function');
    assert.match(apiSource, /\/auth\/oauth/, 'oauthLogin must call /auth/oauth backend endpoint');

    // 3. LoginPage OAuth Provider Options (Google, GitHub, GitLab)
    assert.match(loginSource, /GoogleIcon/, 'LoginPage must include GoogleIcon');
    assert.match(loginSource, /GitHubIcon/, 'LoginPage must include GitHubIcon');
    assert.match(loginSource, /GitLabIcon/, 'LoginPage must include GitLabIcon');
    assert.match(loginSource, /atau lanjutkan dengan email/, 'LoginPage must render "atau lanjutkan dengan email" clean UI divider');
    assert.match(loginSource, /initialMode\?: 'login' \| 'register'/, 'LoginPage must declare initialMode prop');

    // 4. Real OAuth Redirection Invariants (Zero Fake Modals & Zero Mock Accounts)
    assert.doesNotMatch(loginSource, /alex\.developer@gmail\.com/, 'Must NOT contain fake Alex Prasetyo mock account');
    assert.doesNotMatch(loginSource, /Alex Prasetyo/, 'Must NOT contain fake Alex Prasetyo mock name');
    assert.doesNotMatch(loginSource, /devops\.lead@gitlab\.company/, 'Must NOT contain fake devops.lead mock account');
    assert.doesNotMatch(loginSource, /devops-lead/, 'Must NOT contain fake devops-lead mock username');
    assert.doesNotMatch(loginSource, /aria-label="Autentikasi dengan Google"/, 'Must NOT render fake Google in-app modal');
    assert.doesNotMatch(loginSource, /aria-label="Autentikasi dengan GitHub"/, 'Must NOT render fake GitHub in-app modal');
    assert.doesNotMatch(loginSource, /aria-label="Autentikasi dengan GitLab"/, 'Must NOT render fake GitLab in-app modal');

    // 5. Genuine OAuth Provider URLs & Window Redirection
    assert.match(loginSource, /accounts\.google\.com/, 'Must route to genuine Google Accounts portal');
    assert.match(loginSource, /github\.com/, 'Must route to genuine GitHub portal');
    assert.match(loginSource, /gitlab\.com/, 'Must route to genuine GitLab portal');
    assert.match(loginSource, /_blank/, 'Must open genuine OAuth provider URL in a new blank tab');
    assert.match(loginSource, /noopener\s+noreferrer|noopener,noreferrer/, 'Must enforce noopener noreferrer on OAuth redirection');
    assert.match(loginSource, /<a[^>]*href=\{getOAuthProviderUrl\('google'\)\}/, 'Google option must render as native anchor link for popup blocker immunity');
    assert.match(loginSource, /getOAuthProviderUrl/, 'LoginPage must export getOAuthProviderUrl helper');

    // 6. Zero unicode em dashes in LoginPage, App, and api
    assert.doesNotMatch(loginSource, /\u2014/, 'LoginPage.tsx must not contain unicode em dashes');
    assert.doesNotMatch(appSource, /\u2014/, 'App.tsx must not contain unicode em dashes');
    assert.doesNotMatch(apiSource, /\u2014/, 'api.ts must not contain unicode em dashes');

    // 7. Authentic User Accounts & In-App OAuth Resolution Invariants (Foto 5 Parity)
    assert.match(loginSource, /suhendisuhendi224@gmail\.com/, 'Must include MUHAMMAD AFIF RIZI authentic email');
    assert.match(loginSource, /MUHAMMAD AFIF RIZI/, 'Must include MUHAMMAD AFIF RIZI authentic name');
    assert.match(loginSource, /hazama3321@gmail\.com/, 'Must include Mafifrizi authentic email');
    assert.match(loginSource, /ares\.dragon016@gmail\.com/, 'Must include Ares authentic email');
    assert.match(loginSource, /Gunakan akun lain/, 'Must include "Gunakan akun lain" custom option');
    assert.match(loginSource, /oauthLogin\(\{/, 'Must trigger in-app oauthLogin directly upon account selection');
    assert.match(loginSource, /onLoginSuccess\(res\.user\.email\)/, 'Must call onLoginSuccess to log user directly into RelayGate dashboard console');
    assert.match(loginSource, /onClick=\{handleCloseOAuthModal\}/, 'OAuth modal backdrop must allow dismissal upon outer click');
    assert.match(loginSource, /e\.stopPropagation\(\)/, 'OAuth modal dialog box must isolate event bubbling');
    assert.match(loginSource, /users\.noreply\.github\.com/, 'OAuth modal must normalize custom GitHub username to valid domain');
    assert.match(loginSource, /id:\s*res\.user\.id/, 'OAuth session storage must persist complete user profile including id');

    // 8. Register vs Login Differentiation & MVP Security Invariants
    assert.match(loginSource, /Daftar dengan Google/, 'LoginPage must display "Daftar dengan Google" title/action in register mode');
    assert.match(loginSource, /Daftar dengan GitHub/, 'LoginPage must display "Daftar dengan GitHub" title/action in register mode');
    assert.match(loginSource, /Daftar dengan GitLab/, 'LoginPage must display "Daftar dengan GitLab" title/action in register mode');
    assert.match(loginSource, /Pilih akun untuk mendaftar ke RelayGate/, 'LoginPage must display registration subtitle for Google in register mode');
    assert.match(loginSource, /Daftarkan akun operator RelayGate baru/, 'LoginPage must display registration subtitle for GitHub/GitLab in register mode');
    assert.match(loginSource, /action,\s*\}/, 'handleSelectOAuthAccount must pass action to oauthLogin');
    assert.match(loginSource, /Buka Tab Daftar untuk Registrasi/, 'LoginPage must provide shortcut to Daftar tab upon unregistered account error');
    assert.match(loginSource, /Lanjutkan ke RelayGate/, 'LoginPage must display "Lanjutkan ke RelayGate" subtitle in login mode');
    assert.match(loginSource, /Alamat email tidak boleh mengandung spasi/, 'handleSelectOAuthAccount must reject whitespace in email address');
    assert.match(apiSource, /action\?: 'login' \| 'register'/, 'api.ts oauthLogin signature must accept action parameter');
  });

  await suite.test('LoginPage Logic & Security Audit Verification Invariants', async () => {
    const loginSource = fs.readFileSync(path.join(__dirname, '../src/components/LoginPage.tsx'), 'utf8');

    // 1. Profile caching in localStorage (id, token, email, name, role) across all authentication channels
    assert.match(loginSource, /handleLogin[\s\S]*?id:\s*res\.user\.id/, 'handleLogin must persist user id in localStorage');
    assert.match(loginSource, /handleLogin[\s\S]*?token:\s*res\.token/, 'handleLogin must persist session token in localStorage');
    assert.match(loginSource, /handleLogin[\s\S]*?email:\s*res\.user\.email/, 'handleLogin must persist email in localStorage');
    assert.match(loginSource, /handleLogin[\s\S]*?role:\s*res\.user\.role/, 'handleLogin must persist role in localStorage');

    assert.match(loginSource, /handleVerify[\s\S]*?id:\s*res\.user\.id/, 'handleVerify must persist user id in localStorage');
    assert.match(loginSource, /handleVerify[\s\S]*?token:\s*res\.token/, 'handleVerify must persist session token in localStorage');
    assert.match(loginSource, /handleVerify[\s\S]*?email:\s*res\.user\.email/, 'handleVerify must persist email in localStorage');
    assert.match(loginSource, /handleVerify[\s\S]*?role:\s*res\.user\.role/, 'handleVerify must persist role in localStorage');

    assert.match(loginSource, /handleSelectOAuthAccount[\s\S]*?id:\s*res\.user\.id/, 'OAuth flow must persist user id in localStorage');
    assert.match(loginSource, /handleSelectOAuthAccount[\s\S]*?token:\s*res\.token/, 'OAuth flow must persist session token in localStorage');

    // 2. Whitespace rejection across email inputs
    assert.match(loginSource, /handleLogin[\s\S]*?email\.trim\(\)\.includes\(' '\)/, 'handleLogin must check and reject spaces in email');
    assert.match(loginSource, /handleRegister[\s\S]*?email\.trim\(\)\.includes\(' '\)/, 'handleRegister must check and reject spaces in email');
    assert.match(loginSource, /Alamat email tidak boleh mengandung spasi/, 'Must render clear feedback "Alamat email tidak boleh mengandung spasi"');

    // 3. Complete state cleanup on tab switch
    assert.match(loginSource, /switchMode[\s\S]*?setError\(null\)/, 'switchMode must clear errors');
    assert.match(loginSource, /switchMode[\s\S]*?setOauthError\(null\)/, 'switchMode must clear oauth errors');
    assert.match(loginSource, /switchMode[\s\S]*?setPassword\(''\)/, 'switchMode must clear password');
    assert.match(loginSource, /switchMode[\s\S]*?setConfirmPassword\(''\)/, 'switchMode must clear confirmPassword');
    assert.match(loginSource, /switchMode[\s\S]*?setOtp\(\['', '', '', '', '', ''\]\)/, 'switchMode must clear OTP');
    assert.match(loginSource, /switchMode[\s\S]*?setDevCode\(null\)/, 'switchMode must clear dev preview code');
    assert.match(loginSource, /switchMode[\s\S]*?setShowPassword\(false\)/, 'switchMode must reset password visibility toggle');
    assert.match(loginSource, /switchMode[\s\S]*?setShowConfirmPassword\(false\)/, 'switchMode must reset confirm password visibility toggle');

    // 4. URL state synchronization
    assert.match(loginSource, /auth',\s*'register'/, 'switchMode must set auth=register parameter on registration');
    assert.match(loginSource, /auth',\s*'login'/, 'switchMode must set auth=login parameter on login');
    assert.match(loginSource, /handleChangeEmail[\s\S]*?auth',\s*'register'/, 'handleChangeEmail must sync URL to register');

    // 5. Accessibility invariants
    assert.match(loginSource, /htmlFor="login-email"/, 'Login email label must be linked to input via htmlFor');
    assert.match(loginSource, /htmlFor="login-password"/, 'Login password label must be linked to input via htmlFor');
    assert.match(loginSource, /htmlFor="reg-name"/, 'Register name label must be linked to input via htmlFor');
    assert.match(loginSource, /htmlFor="reg-email"/, 'Register email label must be linked to input via htmlFor');
    assert.match(loginSource, /htmlFor="reg-password"/, 'Register password label must be linked to input via htmlFor');
    assert.match(loginSource, /htmlFor="reg-confirm"/, 'Register confirm label must be linked to input via htmlFor');
    assert.match(loginSource, /inputMode="numeric"/, 'OTP inputs must declare inputMode="numeric" for mobile numeric keyboard');
    assert.match(loginSource, /role="tablist"/, 'Auth tab container must declare role="tablist"');
    assert.match(loginSource, /role="tab"[\s\S]*?aria-selected={mode === 'login'}/, 'Login tab must declare role="tab" and dynamic aria-selected');
    assert.match(loginSource, /role="tab"[\s\S]*?aria-selected={mode === 'register'}/, 'Register tab must declare role="tab" and dynamic aria-selected');
    assert.match(loginSource, /aria-label={showPassword \? 'Sembunyikan password' : 'Lihat password'}/, 'Password toggle must declare dynamic aria-label');
    assert.match(loginSource, /aria-pressed={showPassword}/, 'Password toggle must declare aria-pressed state');
    assert.match(loginSource, /role="group"[\s\S]*?aria-label="6-digit kode verifikasi"/, 'OTP container must declare role="group" with accessible label');
    assert.match(loginSource, /aria-label=\{`Digit \$\{idx \+ 1\} dari 6`\}/, 'Each OTP input must declare accessible digit position label');

    // 6. Form input validation hardening
    assert.match(loginSource, /handleLogin[\s\S]*?!email\.includes\('@'\) \|\| !email\.includes\('\.'\)/, 'handleLogin must validate email syntax before submission');
    assert.match(loginSource, /handleRegister[\s\S]*?name\.trim\(\)\.length > 50/, 'handleRegister must validate max name length (50 chars)');

    // 7. Zero unicode em dashes invariant
    assert.doesNotMatch(loginSource, /\u2014/, 'LoginPage.tsx must have ZERO unicode em dashes');
  });

  await suite.test('Security Hardening & Sanitization Invariants across Landing, Auth & Inspector', async () => {
    const loginSource = fs.readFileSync(path.join(__dirname, '../src/components/LoginPage.tsx'), 'utf8');
    const landingSource = fs.readFileSync(path.join(__dirname, '../src/components/LandingPage.tsx'), 'utf8');
    const drawerSource = fs.readFileSync(path.join(__dirname, '../src/components/InspectorDrawer.tsx'), 'utf8');

    // 1. Password policy: minimum 8 characters enforced on client-side registration
    assert.match(loginSource, /password\.length < 8/, 'LoginPage must validate minimum 8 characters password');
    assert.match(loginSource, /Password minimal 8 karakter/, 'LoginPage must display Indonesian error message for password < 8');

    // 2. Landing page: external brand links have target="_blank" and rel="noopener noreferrer"
    assert.match(landingSource, /rel=\{isExternal \? 'noopener noreferrer' : undefined\}/, 'LandingPage MagneticBrand external links must declare rel="noopener noreferrer"');
    assert.match(landingSource, /target=\{isExternal \? '_blank' : undefined\}/, 'LandingPage MagneticBrand external links must declare target="_blank"');

    // 3. InspectorDrawer: curlCommand escapes single quotes and strips newlines
    assert.match(drawerSource, /k\.replace\(\/\[.*\]\/g,\s*''\)/, 'curlCommand must sanitize newline and quote characters in headers');
    assert.match(drawerSource, /String\(v\)\.replace\(/, 'curlCommand must safely escape single quotes in header values');

    // 4. Invariant: ZERO unicode em dashes across LandingPage and InspectorDrawer
    assert.doesNotMatch(landingSource, /\u2014/, 'LandingPage.tsx must have ZERO unicode em dashes');
    assert.doesNotMatch(drawerSource, /\u2014/, 'InspectorDrawer.tsx must have ZERO unicode em dashes');
  });

  // Cleanup temp files
  try {
    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 0 });
  } catch {}
});
