const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 8080;
const CDP_PORT = 9445;
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
const PUBLIC_SHOTS_DIR = path.join(__dirname, '..', 'ui', 'public', 'shots');
const PUBLIC_DIR = path.join(__dirname, '..', 'ui', 'public');

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_SHOTS_DIR)) fs.mkdirSync(PUBLIC_SHOTS_DIR, { recursive: true });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  console.log('[Script] Connecting to RelayGate on :' + PORT);

  const loginRes = await httpRequest(
    {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    JSON.stringify({ email: 'admin@relaygate.local', password: 'relaygate123' })
  );

  if (loginRes.status !== 200) {
    throw new Error('Login failed: ' + loginRes.body);
  }
  const loginData = JSON.parse(loginRes.body);
  const token = loginData.token;
  const user = loginData.user;
  console.log('[Script] Auth token obtained for:', user.email);

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const chromePath = chromePaths.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('No browser found');

  const userDataDir = path.join(__dirname, '..', 'data', 'rg_shots_chrome_' + Date.now());
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  console.log('[Script] Launching browser...');
  const browserProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    '--force-device-scale-factor=2',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  try {
    let cdpTargets;
    const cdpStart = Date.now();
    while (Date.now() - cdpStart < 10000) {
      try {
        cdpTargets = await httpRequest({
          hostname: '127.0.0.1',
          port: CDP_PORT,
          path: '/json',
          method: 'GET',
        });
        if (cdpTargets.status === 200) break;
      } catch {}
      await wait(250);
    }

    const targets = JSON.parse(cdpTargets.body);
    const pageTarget = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (evt) => {
          const msg = JSON.parse(evt.data);
          if (msg.id === id) {
            ws.removeEventListener('message', handler);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');

    console.log('[Script] Navigating to http://127.0.0.1:' + PORT);
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` });
    await wait(1500);

    const authPayload = JSON.stringify({
      token,
      email: user.email,
      name: user.name,
      role: user.role,
      user,
    });

    await send('Runtime.evaluate', {
      expression: `
        localStorage.setItem('relaygate_auth', ${JSON.stringify(authPayload)});
        window.location.reload();
      `,
    });
    await wait(2500);

    async function captureView(filename, publicName) {
      const snap = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(snap.data, 'base64');
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, filename), buf);
      if (publicName) {
        fs.writeFileSync(path.join(PUBLIC_SHOTS_DIR, publicName), buf);
      }
      console.log(`[Captured] ${filename} -> ${publicName || ''} (${buf.length} bytes)`);
      return buf;
    }

    async function clickSidebar(label) {
      return await send('Runtime.evaluate', {
        expression: `
          (() => {
            const spans = Array.from(document.querySelectorAll('aside span.truncate'));
            const target = spans.find(s => s.textContent.trim() === '${label}');
            if (target) {
              const btn = target.closest('button');
              if (btn) { btn.click(); return true; }
            }
            return false;
          })()
        `,
      });
    }

    // 1. Overview Dashboard
    console.log('[Script] Navigating to Overview...');
    await clickSidebar('Overview');
    await wait(1500);
    const dashBuf = await captureView('01_dashboard.png', 'dashboard.png');
    fs.writeFileSync(path.join(PUBLIC_DIR, 'dashboard-preview.png'), dashBuf);

    // 2. Events Live Stream View
    console.log('[Script] Navigating to Events...');
    const evClicked = await clickSidebar('Events');
    console.log('[Script] Events button clicked:', evClicked.result?.value);
    await wait(1500);
    await captureView('02_events_stream.png', 'stream.png');

    // 3. Inspector Drawer open
    console.log('[Script] Clicking first event row to open InspectorDrawer...');
    const rowClicked = await send('Runtime.evaluate', {
      expression: `
        (() => {
          const row = document.querySelector('tbody tr');
          if (row) { row.click(); return true; }
          return false;
        })()
      `,
    });
    console.log('[Script] Row clicked:', rowClicked.result?.value);
    await wait(1500);
    await captureView('03_inspector_drawer.png', 'inspector.png');

    // Close Inspector Drawer
    await send('Runtime.evaluate', {
      expression: `
        (() => {
          const closeBtn = document.querySelector('button[aria-label="Tutup panel inspeksi"]') ||
                           document.querySelector('aside button[title*="Tutup"]');
          if (closeBtn) closeBtn.click();
        })()
      `,
    });
    await wait(600);

    // 4. Dead-Letter Queue (DLQ) View
    console.log('[Script] Navigating to Dead-letter (DLQ)...');
    const dlqClicked = await clickSidebar('Dead-letter (DLQ)');
    console.log('[Script] DLQ button clicked:', dlqClicked.result?.value);
    await wait(1500);
    await captureView('05_dlq_view.png', 'dlq.png');

    // 5. Endpoints View
    console.log('[Script] Navigating to Endpoints...');
    const epClicked = await clickSidebar('Endpoints');
    console.log('[Script] Endpoints button clicked:', epClicked.result?.value);
    await wait(1500);
    await captureView('04_endpoints_view.png', 'endpoints.png');

    console.log('[Script] All 5 showcase screenshots successfully generated and synced!');
    ws.close();
    browserProc.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  } catch (err) {
    browserProc.kill();
    throw err;
  }
}

run().catch((err) => {
  console.error('[Script] Error:', err);
  process.exit(1);
});
