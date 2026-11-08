const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 8096;
const CDP_PORT = 9335;
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
const BRAIN_DIRS = [
  'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\96f30384-1a5b-49aa-911d-1943ab3ba472',
  'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\0f626320-fda7-4886-b746-3f6e3d439983',
  'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\aa87843b-5101-41ec-a38f-d1daf3fd21aa',
  'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\d14c3bc4-d7e1-41c6-b24a-909a4da0bd58',
  'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\a3a65308-dfc0-4a49-803a-16058f65b316',
];

[SCREENSHOTS_DIR, ...BRAIN_DIRS].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
});

function saveScreenshot(filename, base64Data) {
  const buf = Buffer.isBuffer(base64Data) ? base64Data : Buffer.from(base64Data, 'base64');
  const diskPath = path.join(SCREENSHOTS_DIR, filename);
  fs.writeFileSync(diskPath, buf);
  console.log(`[Screenshot] Saved ${filename} (${buf.length} bytes)`);

  for (const bDir of BRAIN_DIRS) {
    if (fs.existsSync(bDir)) {
      try {
        fs.writeFileSync(path.join(bDir, filename), buf);
      } catch (err) {
        console.warn(`[Screenshot] Failed copying to ${bDir}:`, err.message);
      }
    }
  }
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
  console.log('[Script] Preparing database for mobile screenshot capture...');

  const prodDb = path.join(__dirname, '..', 'data', 'relaygate.db');
  const testDb = path.join(__dirname, '..', 'data', 'test_mobile.db');
  if (fs.existsSync(testDb)) {
    try { fs.unlinkSync(testDb); } catch {}
  }
  if (fs.existsSync(prodDb)) {
    fs.copyFileSync(prodDb, testDb);
  }

  try {
    execFileSync('python', [path.join(__dirname, 'seed_showcase_data.py'), testDb], { stdio: 'inherit' });
  } catch (err) {
    console.warn('[Script] Warning: seed_showcase_data failed:', err.message);
  }

  console.log('[Script] Starting RelayGate server on :' + PORT);
  const serverProc = spawn(
    path.join(__dirname, '..', 'relaygate.exe'),
    ['-addr', ':' + PORT, '-db', testDb, '-workers', '2'],
    { stdio: 'inherit' }
  );

  try {
    await waitForServer(`http://127.0.0.1:${PORT}/healthz`);
    console.log('[Script] RelayGate is healthy on :' + PORT);

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
    const authPayload = JSON.stringify({
      token: loginData.token,
      email: loginData.user.email,
      name: loginData.user.name,
      role: loginData.user.role,
      user: loginData.user,
    });

    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const chromePath = chromePaths.find((p) => fs.existsSync(p));
    if (!chromePath) throw new Error('Chrome/Edge not found');

    const userDataDir = path.join(__dirname, '..', 'data', 'rg_chrome_mobile_' + Date.now());
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    console.log('[Script] Launching browser headless at:', chromePath);
    const browserProc = spawn(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=430,932',
      '--force-device-scale-factor=2',
      '--no-first-run',
      '--no-default-browser-check',
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
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No inspectable page found in browser');
    }

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

    async function setDeviceMetrics(width, height, deviceScaleFactor, mobile = true) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile,
        screenOrientation: { angle: 0, type: 'portraitPrimary' },
      });
    }

    // =========================================================================
    // PART 1: ANDROID VIEWPORT (360 x 800)
    // =========================================================================
    console.log('[Script] Emulating Android (360x800)...');
    await setDeviceMetrics(360, 800, 2, true);

    // 1. Android: Session Notice on Login modal
    console.log('[Script] Navigating to http://127.0.0.1:' + PORT);
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` });
    await wait(1200);

    // Trigger session expired custom event while not authenticated
    await send('Runtime.evaluate', {
      expression: `
        localStorage.removeItem('relaygate_auth');
        window.dispatchEvent(new CustomEvent('relaygate_session_expired', {
          detail: { message: 'Sesi berakhir' }
        }));
      `,
    });
    await wait(1000);

    console.log('[Script] Capturing mobile_android_360_session_notice.png');
    const snapAndroidSession = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_android_360_session_notice.png', snapAndroidSession.data);
    saveScreenshot('00d_landing_to_auth.png', snapAndroidSession.data);
    saveScreenshot('landing_to_login.png', snapAndroidSession.data);

    // 2. Android: Landing page view
    console.log('[Script] Returning to Landing Page on Android...');
    await send('Runtime.evaluate', {
      expression: `
        const backBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Kembali ke Beranda'));
        if (backBtn) backBtn.click();
      `,
    });
    await wait(800);

    console.log('[Script] Capturing mobile_android_360_landing.png');
    const snapAndroidLanding = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_android_360_landing.png', snapAndroidLanding.data);

    // 3. Android: Mobile navigation menu toggle
    console.log('[Script] Toggling mobile menu on Landing Page...');
    await send('Runtime.evaluate', {
      expression: `
        const menuBtn = document.querySelector('button[aria-label="Toggle navigation menu"]');
        if (menuBtn) menuBtn.click();
      `,
    });
    await wait(600);

    console.log('[Script] Capturing mobile_android_360_menu.png');
    const snapAndroidMenu = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_android_360_menu.png', snapAndroidMenu.data);

    // 4. Android: Authenticated Dashboard
    console.log('[Script] Setting auth and opening Dashboard on Android...');
    await send('Runtime.evaluate', {
      expression: `
        localStorage.setItem('relaygate_auth', ${JSON.stringify(authPayload)});
        window.location.reload();
      `,
    });
    await wait(1600);

    console.log('[Script] Capturing mobile_android_360_dashboard.png');
    const snapAndroidDash = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_android_360_dashboard.png', snapAndroidDash.data);

    // 5. Android: Mobile drawer open in dashboard
    console.log('[Script] Opening mobile drawer in Dashboard...');
    await send('Runtime.evaluate', {
      expression: `
        const drawerBtn = document.querySelector('button[aria-label="Buka menu navigasi"]');
        if (drawerBtn) drawerBtn.click();
      `,
    });
    await wait(600);

    console.log('[Script] Capturing mobile_android_360_drawer.png');
    const snapAndroidDrawer = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_android_360_drawer.png', snapAndroidDrawer.data);

    // =========================================================================
    // PART 2: IPHONE VIEWPORT (390 x 844)
    // =========================================================================
    console.log('[Script] Emulating iPhone 14/15/16 (390x844)...');
    await setDeviceMetrics(390, 844, 3, true);

    // 1. iPhone: Session notice on login modal
    console.log('[Script] Triggering session notice on iPhone...');
    await send('Runtime.evaluate', {
      expression: `
        localStorage.removeItem('relaygate_auth');
        window.dispatchEvent(new CustomEvent('relaygate_session_expired', {
          detail: { message: 'Sesi berakhir' }
        }));
      `,
    });
    await wait(1000);

    console.log('[Script] Capturing mobile_iphone_390_session_notice.png');
    const snapIphoneSession = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_iphone_390_session_notice.png', snapIphoneSession.data);

    // 2. iPhone: Landing page view
    console.log('[Script] Returning to Landing Page on iPhone...');
    await send('Runtime.evaluate', {
      expression: `
        const backBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Kembali ke Beranda'));
        if (backBtn) backBtn.click();
      `,
    });
    await wait(800);

    console.log('[Script] Capturing mobile_iphone_390_landing.png');
    const snapIphoneLanding = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_iphone_390_landing.png', snapIphoneLanding.data);

    // 3. iPhone: Authenticated Dashboard
    console.log('[Script] Opening Dashboard on iPhone...');
    await send('Runtime.evaluate', {
      expression: `
        localStorage.setItem('relaygate_auth', ${JSON.stringify(authPayload)});
        window.location.reload();
      `,
    });
    await wait(1600);

    console.log('[Script] Capturing mobile_iphone_390_dashboard.png');
    const snapIphoneDash = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_iphone_390_dashboard.png', snapIphoneDash.data);

    // 4. iPhone: Mobile drawer open in dashboard
    console.log('[Script] Opening mobile drawer on iPhone...');
    await send('Runtime.evaluate', {
      expression: `
        const drawerBtn = document.querySelector('button[aria-label="Buka menu navigasi"]');
        if (drawerBtn) drawerBtn.click();
      `,
    });
    await wait(600);

    console.log('[Script] Capturing mobile_iphone_390_drawer.png');
    const snapIphoneDrawer = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('mobile_iphone_390_drawer.png', snapIphoneDrawer.data);

    // =========================================================================
    // PART 3: DESKTOP SESSION NOTICE (1440 x 920)
    // =========================================================================
    console.log('[Script] Capturing Desktop session notice...');
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Runtime.evaluate', {
      expression: `
        localStorage.removeItem('relaygate_auth');
        window.dispatchEvent(new CustomEvent('relaygate_session_expired', {
          detail: { message: 'Sesi berakhir' }
        }));
      `,
    });
    await wait(1000);

    const snapDesktopSession = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('desktop_session_notice.png', snapDesktopSession.data);

    ws.close();
    browserProc.kill();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}

    console.log('[Script] All mobile and desktop screenshots successfully captured!');
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
