const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 8097;
const CDP_PORT = 9336;
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
const BRAIN_DIRS = [
  'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\96f30384-1a5b-49aa-911d-1943ab3ba472',
  'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\0f626320-fda7-4886-b746-3f6e3d439983',
];
const PUBLIC_SHOTS_DIR = path.join(__dirname, '..', 'ui', 'public', 'shots');
const DIST_SHOTS_DIR = path.join(__dirname, '..', 'ui', 'dist', 'shots');

[SCREENSHOTS_DIR, ...BRAIN_DIRS, PUBLIC_SHOTS_DIR, DIST_SHOTS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
});

function saveScreenshot(filename, base64Data) {
  const buf = Buffer.isBuffer(base64Data) ? base64Data : Buffer.from(base64Data, 'base64');
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, filename), buf);
  try { fs.writeFileSync(path.join(PUBLIC_SHOTS_DIR, filename), buf); } catch {}
  try { fs.writeFileSync(path.join(DIST_SHOTS_DIR, filename), buf); } catch {}
  for (const bDir of BRAIN_DIRS) {
    if (fs.existsSync(bDir)) {
      try { fs.writeFileSync(path.join(bDir, filename), buf); } catch {}
    }
  }
  console.log(`[Screenshot] Saved ${filename} (${buf.length} bytes)`);
  return buf;
}

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
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function waitForServer(url, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpRequest(url);
      if (res.status === 200) return true;
    } catch {}
    await wait(250);
  }
  throw new Error('Server timeout at ' + url);
}

async function run() {
  console.log('[Script] Starting RelayGate server on :' + PORT);
  const testDb = path.join(__dirname, '..', 'data', 'test_oauth_shots.db');
  const prodDb = path.join(__dirname, '..', 'data', 'relaygate.db');
  if (fs.existsSync(testDb)) {
    try { fs.unlinkSync(testDb); } catch {}
  }
  if (fs.existsSync(prodDb)) {
    fs.copyFileSync(prodDb, testDb);
  }

  const serverProc = spawn(
    path.join(__dirname, '..', 'relaygate.exe'),
    ['-addr', ':' + PORT, '-db', testDb, '-workers', '2'],
    { stdio: 'inherit' }
  );

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/healthz`);
    console.log('[Script] Server healthy on :' + PORT);

    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const chromePath = chromePaths.find((p) => fs.existsSync(p));
    if (!chromePath) throw new Error('Chrome/Edge not found');

    const userDataDir = path.join(__dirname, '..', 'data', 'rg_chrome_oauth_' + Date.now());
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    const browserProc = spawn(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,900',
      '--force-device-scale-factor=2',
      'about:blank',
    ]);

    let cdpTargets;
    const cdpStart = Date.now();
    while (Date.now() - cdpStart < 15000) {
      try {
        cdpTargets = await httpRequest({
          hostname: '127.0.0.1',
          port: CDP_PORT,
          path: '/json',
          method: 'GET',
        });
        if (cdpTargets.status === 200) break;
      } catch {}
      await wait(300);
    }

    const targets = JSON.parse(cdpTargets.body);
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const timer = setTimeout(() => {
          ws.removeEventListener('message', handler);
          reject(new Error(`CDP ${method} timed out`));
        }, 15000);
        const handler = (evt) => {
          const msg = JSON.parse(evt.data);
          if (msg.id === id) {
            clearTimeout(timer);
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // 1. Navigate to auth screen
    console.log('[Script] Navigating to login screen...');
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?auth=login` });
    await wait(2000);

    // Capture LoginPage with OAuth buttons
    console.log('[Script] Capturing desktop_login_oauth.png');
    const snapLogin = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('desktop_login_oauth.png', snapLogin.data);

    // 2. Open Google modal
    console.log('[Script] Opening Google OAuth modal...');
    let res = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const btn = document.querySelector('button[title="Masuk dengan Google"]');
        if (btn) { btn.click(); return { clicked: true, text: btn.textContent }; }
        return { clicked: false, allBtns: Array.from(document.querySelectorAll('button')).map(b => b.title || b.textContent) };
      })()`,
    });
    console.log('[Script] Google click result:', JSON.stringify(res.result?.value));
    await wait(1000);
    console.log('[Script] Capturing desktop_oauth_google.png');
    const snapGoogle = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('desktop_oauth_google.png', snapGoogle.data);

    // Close modal
    res = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const closeBtn = document.querySelector('div[role="dialog"] button[aria-label="Tutup dialog"]');
        if (closeBtn) { closeBtn.click(); return { closed: true }; }
        return { closed: false, dialog: !!document.querySelector('div[role="dialog"]') };
      })()`,
    });
    console.log('[Script] Google close result:', JSON.stringify(res.result?.value));
    await wait(600);

    // 3. Open GitHub modal
    console.log('[Script] Opening GitHub OAuth modal...');
    res = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const btn = document.querySelector('button[title="Masuk dengan GitHub"]');
        if (btn) { btn.click(); return { clicked: true, text: btn.textContent }; }
        return { clicked: false, allBtns: Array.from(document.querySelectorAll('button')).map(b => b.title || b.textContent) };
      })()`,
    });
    console.log('[Script] GitHub click result:', JSON.stringify(res.result?.value));
    await wait(1000);
    console.log('[Script] Capturing desktop_oauth_github.png');
    const snapGitHub = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('desktop_oauth_github.png', snapGitHub.data);

    // Close modal
    res = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const closeBtn = document.querySelector('div[role="dialog"] button[aria-label="Tutup dialog"]');
        if (closeBtn) { closeBtn.click(); return { closed: true }; }
        return { closed: false, dialog: !!document.querySelector('div[role="dialog"]') };
      })()`,
    });
    console.log('[Script] GitHub close result:', JSON.stringify(res.result?.value));
    await wait(600);

    // 4. Open GitLab modal
    console.log('[Script] Opening GitLab OAuth modal...');
    res = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const btn = document.querySelector('button[title="Masuk dengan GitLab"]');
        if (btn) { btn.click(); return { clicked: true, text: btn.textContent }; }
        return { clicked: false, allBtns: Array.from(document.querySelectorAll('button')).map(b => b.title || b.textContent) };
      })()`,
    });
    console.log('[Script] GitLab click result:', JSON.stringify(res.result?.value));
    await wait(1000);
    console.log('[Script] Capturing desktop_oauth_gitlab.png');
    const snapGitLab = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('desktop_oauth_gitlab.png', snapGitLab.data);

    // Close modal
    res = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const closeBtn = document.querySelector('div[role="dialog"] button[aria-label="Tutup dialog"]');
        if (closeBtn) { closeBtn.click(); return { closed: true }; }
        return { closed: false, dialog: !!document.querySelector('div[role="dialog"]') };
      })()`,
    });
    console.log('[Script] GitLab close result:', JSON.stringify(res.result?.value));
    await wait(600);

    // 5. Switch to Register tab
    console.log('[Script] Switching to Daftar tab...');
    await send('Runtime.evaluate', {
      expression: `
        const btns = Array.from(document.querySelectorAll('button'));
        const regBtn = btns.find(b => b.textContent.trim() === 'Daftar');
        if (regBtn) regBtn.click();
      `,
    });
    await wait(600);
    console.log('[Script] Capturing desktop_login_register_oauth.png');
    const snapRegister = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('desktop_login_register_oauth.png', snapRegister.data);

    ws.close();
    browserProc.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    console.log('[Script] All OAuth showcase screenshots captured successfully!');
  } finally {
    serverProc.kill();
    await wait(500);
    try {
      if (fs.existsSync(testDb)) fs.unlinkSync(testDb);
      if (fs.existsSync(testDb + '-shm')) fs.unlinkSync(testDb + '-shm');
      if (fs.existsSync(testDb + '-wal')) fs.unlinkSync(testDb + '-wal');
    } catch {}
  }
}

run().catch((err) => {
  console.error('[Script] Fatal error:', err);
  process.exit(1);
});
