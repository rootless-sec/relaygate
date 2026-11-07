const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 8099;
const CDP_PORT = 9222;
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
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

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpRequest(url);
      if (res.status === 200) return true;
    } catch {}
    await wait(200);
  }
  throw new Error('Server timeout at ' + url);
}

async function run() {
  console.log('[Script] Starting test RelayGate server on :' + PORT);

  const prodDb = path.join(__dirname, '..', 'data', 'relaygate.db');
  const testDb = path.join(__dirname, '..', 'data', 'test_screen.db');
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

  serverProc.on('error', (err) => {
    console.error('Failed to start server:', err);
  });

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/healthz`);
    console.log('[Script] Server is healthy!');

    // Login as admin
    const loginRes = await httpRequest(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/v1/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({
        email: 'admin@relaygate.local',
        password: 'relaygate123',
      })
    );

    if (loginRes.status !== 200) {
      throw new Error('Login failed with status ' + loginRes.status + ': ' + loginRes.body);
    }

    const loginData = JSON.parse(loginRes.body);
    const token = loginData.token;
    const user = loginData.user;
    console.log('[Script] Logged in successfully. Token obtained for:', user.email);

    // Launch Chrome / Edge headless
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const chromePath = chromePaths.find((p) => fs.existsSync(p));
    if (!chromePath) {
      throw new Error('Neither Chrome nor Edge found on system.');
    }

    const userDataDir = path.join(__dirname, '..', '.temp_chrome_profile');
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    console.log('[Script] Launching browser at:', chromePath);
    const browserProc = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,900',
      '--force-device-scale-factor=2',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ]);

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
      await wait(300);
    }
    if (!cdpTargets || cdpTargets.status !== 200) {
      throw new Error('Chrome CDP failed to respond on port ' + CDP_PORT);
    }

    const targets = JSON.parse(cdpTargets.body);
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No inspectable page found in browser targets');
    }

    console.log('[Script] Connecting to CDP WebSocket...');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
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

    // Set auth in localStorage and reload
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

    await wait(2000);

    // 1. Dashboard Screenshot
    console.log('[Script] Capturing 01_dashboard.png');
    const snap1 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '01_dashboard.png'), Buffer.from(snap1.data, 'base64'));

    // 2. Open Profile Modal
    console.log('[Script] Opening Profile Modal');
    await send('Runtime.evaluate', {
      expression: `
        const btn = document.querySelector('button[title*="Kelola Profil"]') ||
                    document.querySelector('button[aria-label*="Buka Pengaturan Profil"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('admin@'));
        if (btn) btn.click();
      `,
    });
    await wait(1000);

    console.log('[Script] Capturing 02_profile_modal.png');
    const snap2 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '02_profile_modal.png'), Buffer.from(snap2.data, 'base64'));

    // 3. Switch to Security Tab in Profile Modal
    console.log('[Script] Switching to Keamanan Akun tab');
    await send('Runtime.evaluate', {
      expression: `
        const secTab = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Keamanan Akun'));
        if (secTab) secTab.click();
      `,
    });
    await wait(800);

    console.log('[Script] Capturing 03_security_modal.png');
    const snap3 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '03_security_modal.png'), Buffer.from(snap3.data, 'base64'));

    // 4. Close modal and navigate to Endpoints view
    console.log('[Script] Navigating to Endpoints view');
    await send('Runtime.evaluate', {
      expression: `
        const closeBtn = document.querySelector('button[aria-label="Tutup modal profil"]');
        if (closeBtn) closeBtn.click();
      `,
    });
    await wait(500);

    await send('Runtime.evaluate', {
      expression: `
        const epTab = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Endpoints') || b.textContent.includes('Rute'));
        if (epTab) epTab.click();
      `,
    });
    await wait(1000);

    console.log('[Script] Capturing 04_endpoints_view.png');
    const snap4 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '04_endpoints_view.png'), Buffer.from(snap4.data, 'base64'));

    ws.close();
    browserProc.kill();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}

    console.log('[Script] All 2x retina screenshots captured successfully in screenshots/');
  } finally {
    console.log('[Script] Terminating test server...');
    serverProc.kill();
    await wait(500);
    if (fs.existsSync(testDb)) {
      try { fs.unlinkSync(testDb); } catch {}
      try { fs.unlinkSync(testDb + '-shm'); } catch {}
      try { fs.unlinkSync(testDb + '-wal'); } catch {}
    }
  }
}

run().catch((err) => {
  console.error('[Script] Error:', err);
  process.exit(1);
});
