const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 8080;
const CDP_PORT = 9444;
const BRAIN_DIR = 'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\0f626320-fda7-4886-b746-3f6e3d439983';
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');

if (!fs.existsSync(BRAIN_DIR)) {
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
}
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function saveScreenshot(filename, base64Data) {
  const buf = Buffer.from(base64Data, 'base64');
  const brainPath = path.join(BRAIN_DIR, filename);
  const repoPath = path.join(SCREENSHOTS_DIR, filename);
  fs.writeFileSync(brainPath, buf);
  fs.writeFileSync(repoPath, buf);
  console.log(`[Screenshot Saved] ${filename} (${buf.length} bytes)`);
}

async function run() {
  console.log('[Script] Connecting to RelayGate server on :' + PORT);

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const chromePath = chromePaths.find((p) => fs.existsSync(p));
  if (!chromePath) {
    throw new Error('Chrome/Edge not found.');
  }

  const userDataDir = path.join(__dirname, '..', 'data', 'rg_white_chrome_' + Date.now());
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  console.log('[Script] Launching browser at:', chromePath);
  const browserProc = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,1050',
    '--force-device-scale-factor=2',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);

  browserProc.on('error', (err) => {
    console.error('Browser launch error:', err);
  });

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

    if (!cdpTargets || cdpTargets.status !== 200) {
      throw new Error('CDP failed to respond');
    }

    const targets = JSON.parse(cdpTargets.body);
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No inspectable page found in browser');
    }

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
    await wait(2000);

    // 1. landing_white_hero.png
    console.log('[Script] Capturing landing_white_hero.png (Hero & Interactive Pipeline)');
    const snapHero = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('landing_white_hero.png', snapHero.data);

    // 2. landing_white_workspace.png (Scroll to workspace and dashboard preview)
    console.log('[Script] Scrolling to #workspace & dashboard preview...');
    await send('Runtime.evaluate', {
      expression: `document.getElementById('workspace')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(800);
    const snapWorkspace = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('landing_white_workspace.png', snapWorkspace.data);

    // 3. landing_white_sections.png (Scroll to #native and #product)
    console.log('[Script] Scrolling to #native & comparison table...');
    await send('Runtime.evaluate', {
      expression: `document.getElementById('native')?.scrollIntoView({ behavior: 'instant' });`,
    });
    await wait(800);
    const snapSections = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('landing_white_sections.png', snapSections.data);

    // 4. landing_to_login.png (Click "Sign in" or navigate to login view)
    console.log('[Script] Opening Login modal/view...');
    await send('Runtime.evaluate', {
      expression: `
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Sign in'));
        if (btn) btn.click();
      `,
    });
    await wait(1000);
    const snapLogin = await send('Page.captureScreenshot', { format: 'png' });
    saveScreenshot('landing_to_login.png', snapLogin.data);

    console.log('[Script] All 4 Retina screenshots captured successfully!');
  } finally {
    try { browserProc.kill(); } catch {}
  }
}

run().catch((err) => {
  console.error('[Script Error]', err);
  process.exit(1);
});
