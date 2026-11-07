const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const PORT = 8099;
const CDP_PORT = 9333;
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

    const userDataDir = path.join(__dirname, '..', 'data', 'rg_chrome_' + Date.now());
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    console.log('[Script] Launching browser at:', chromePath);
    const browserProc = spawn(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,920',
      '--force-device-scale-factor=2',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ]);

    browserProc.stderr?.on('data', (d) => console.log('[Browser stderr]', d.toString().trim()));
    browserProc.on('exit', (code) => console.log('[Browser process exited with code]', code));

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
        const timer = setTimeout(() => {
          ws.removeEventListener('message', handler);
          reject(new Error(`CDP ${method} timed out after 15000ms`));
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

    console.log('[Script] Navigating to http://127.0.0.1:' + PORT);
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` });
    await wait(1500);

    // 0. Capture Public Landing Page (Before Login) at 2x Retina
    console.log('[Script] Capturing 00_landing_hero_desktop.png');
    const snapHero = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00_landing_hero_desktop.png'), Buffer.from(snapHero.data, 'base64'));

    // Scroll to below-the-fold #native & #product sections
    await send('Runtime.evaluate', {
      expression: `document.getElementById('native')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(600);
    console.log('[Script] Capturing 00b_landing_sections_desktop.png');
    const snapSections = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00b_landing_sections_desktop.png'), Buffer.from(snapSections.data, 'base64'));

    // Scroll to #product section
    await send('Runtime.evaluate', {
      expression: `document.getElementById('product')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(600);
    console.log('[Script] Capturing 00b2_landing_product_desktop.png');
    const snapProduct = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00b2_landing_product_desktop.png'), Buffer.from(snapProduct.data, 'base64'));

    // Test scrolled floating navbar (expanded state via real CDP mouseMoved event)
    const isleBox = await send('Runtime.evaluate', {
      expression: `
        (() => {
          window.scrollTo(0, 800);
          const isle = document.querySelector('.nav__isle');
          if (!isle) return JSON.stringify({ x: 720, y: 28 });
          const rect = isle.getBoundingClientRect();
          return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        })()
      `,
    });
    const navPos = JSON.parse(isleBox.result.value);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: navPos.x, y: navPos.y });
    await wait(700);
    console.log('[Script] Capturing 00a_scrolled_floating_navbar.png');
    const snapNav = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00a_scrolled_floating_navbar.png'), Buffer.from(snapNav.data, 'base64'));

    // Scroll to #workspace section
    await send('Runtime.evaluate', {
      expression: `document.getElementById('workspace')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(600);
    console.log('[Script] Capturing 00c_landing_workspace_desktop.png');
    const snapWs = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00c_landing_workspace_desktop.png'), Buffer.from(snapWs.data, 'base64'));

    // Scroll to #details section (substantive architecture workbench)
    await send('Runtime.evaluate', {
      expression: `document.getElementById('details')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(600);
    console.log('[Script] Capturing 00c2_landing_details_desktop.png');
    const snapDetails = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00c2_landing_details_desktop.png'), Buffer.from(snapDetails.data, 'base64'));

    // Scroll to #download section (Run RelayGate)
    await send('Runtime.evaluate', {
      expression: `document.getElementById('download')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(600);
    console.log('[Script] Capturing 00e_landing_download_desktop.png');
    const snapDownload = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00e_landing_download_desktop.png'), Buffer.from(snapDownload.data, 'base64'));

    // Scroll to footer
    await send('Runtime.evaluate', {
      expression: `document.querySelector('footer')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(600);
    console.log('[Script] Capturing 00f_landing_footer_desktop.png');
    const snapFooter = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00f_landing_footer_desktop.png'), Buffer.from(snapFooter.data, 'base64'));

    // Check horizontal overflow at 1440
    const overflowCheck = await send('Runtime.evaluate', {
      expression: `JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })`,
    });
    console.log('[Script] Overflow check:', overflowCheck.result.value);

    // Test clicking "Open Console" -> LoginPage
    await send('Runtime.evaluate', {
      expression: `
        window.scrollTo(0, 0);
        const openBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Open Console');
        if (openBtn) openBtn.click();
      `,
    });
    await wait(700);
    console.log('[Script] Capturing 00d_landing_to_auth.png');
    const snapAuth = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '00d_landing_to_auth.png'), Buffer.from(snapAuth.data, 'base64'));

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

    // 1. Navigate to Overview Dashboard
    console.log('[Script] Navigating to Overview tab');
    await send('Runtime.evaluate', {
      expression: `
        const ovBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('Overview'));
        if (ovBtn) ovBtn.click();
      `,
    });
    await wait(1000);

    const layoutMetrics = await send('Runtime.evaluate', {
      expression: `
        JSON.stringify({
          windowInnerHeight: window.innerHeight,
          logoRect: document.querySelector('img[alt="RelayGate"]')?.getBoundingClientRect(),
          sidebarHeaderRect: document.querySelector('aside > div:first-child > div:first-child')?.getBoundingClientRect(),
          mainHeaderRect: document.querySelector('header')?.getBoundingClientRect(),
        })
      `,
    });
    console.log('[Script] Layout metrics:', layoutMetrics.result.value);

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

    // 4b. Open Tambah Endpoint Modal
    console.log('[Script] Opening Tambah Endpoint Modal');
    await send('Runtime.evaluate', {
      expression: `
        const addBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Tambah Endpoint'));
        if (addBtn) addBtn.click();
      `,
    });
    await wait(800);

    console.log('[Script] Capturing 04b_add_endpoint_modal.png');
    const snapModal = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '04b_add_endpoint_modal.png'), Buffer.from(snapModal.data, 'base64'));

    // Close Tambah Endpoint Modal
    await send('Runtime.evaluate', {
      expression: `
        const closeAddBtn = document.querySelector('button[aria-label="Tutup modal tambah endpoint"]');
        if (closeAddBtn) closeAddBtn.click();
      `,
    });
    await wait(500);

    // 5. Navigate to Dead-Letter Queue (DLQ) view
    console.log('[Script] Navigating to Dead-Letter Queue view');
    await send('Runtime.evaluate', {
      expression: `
        const dlqBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Dead-letter') || b.textContent.includes('DLQ'));
        if (dlqBtn) dlqBtn.click();
      `,
    });
    await wait(1000);

    console.log('[Script] Capturing 05_dlq_view.png');
    const snap5 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, '05_dlq_view.png'), Buffer.from(snap5.data, 'base64'));

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
