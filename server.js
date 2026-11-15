import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ChromeHeadlessConsole } from './src/browser.js';
import { DEFAULT_KEYWORDS, loadPlatforms } from './src/utils.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || '';

const isLocalHost = HOST === '127.0.0.1' || HOST === 'localhost';
if (!isLocalHost && !PANEL_PASS) {
  console.error('[Seguridad] Definí PANEL_PASS si escuchás fuera de localhost.');
  process.exit(1);
}

let runner = null;
let lastHeadlessSetting = true;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function isAuthorized(req) {
  if (!PANEL_PASS) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  return safeEqual(decoded.slice(0, sep), PANEL_USER) && safeEqual(decoded.slice(sep + 1), PANEL_PASS);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('Payload demasiado grande.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function ensureRunner({ headless = true, keywords = [], waitMs = 6000 }) {
  if (runner && runner.isRunning() && lastHeadlessSetting === headless) {
    if (keywords.length > 0) runner.keywords = keywords;
    runner.options.waitMs = waitMs;
    return runner;
  }
  if (runner) await runner.close();

  lastHeadlessSetting = headless;
  runner = new ChromeHeadlessConsole({
    headless,
    keywords,
    waitMs,
    executablePath: process.env.CHROME_PATH || null
  });
  await runner.init();
  return runner;
}

const server = http.createServer(async (req, res) => {
  if (!isAuthorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Panel F12"' });
    res.end('Autenticación requerida.');
    return;
  }

  const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (req.method === 'GET' && reqUrl.pathname === '/') {
      const html = await fs.readFile(path.resolve(process.cwd(), 'public', 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/platforms') {
      sendJson(res, 200, { platforms: await loadPlatforms() });
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/state') {
      if (!runner || !runner.isRunning()) return sendJson(res, 200, { running: false });
      sendJson(res, 200, await runner.getSnapshotState());
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/api/screenshot') {
      if (!runner || !runner.isRunning()) return sendJson(res, 400, { error: 'Navegador inactivo.' });
      const png = await runner.getScreenshotBuffer();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(png);
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/open') {
      const body = await readJsonBody(req);
      const headless = body.headless !== false;
      const waitMs = Number(body.waitMs) || 6000;
      const keywords = body.keyword
        ? body.keyword.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)
        : DEFAULT_KEYWORDS;

      const activeRunner = await ensureRunner({ headless, keywords, waitMs });
      if (body.clearBefore) activeRunner.clearLogs();

      if (body.username && body.password) {
        const loginUrl = body.loginUrl || body.targetUrl;
        if (!loginUrl) throw new Error('Indicá una URL de login o URL destino.');
        await activeRunner.login({
          loginUrl,
          username: body.username,
          password: body.password,
          userSelector: body.userSelector || undefined,
          passSelector: body.passSelector || undefined,
          submitSelector: body.submitSelector || undefined
        });
      }

      if (body.platform && body.channel && !body.targetUrl) {
        await activeRunner.openPlatformChannel(body.platform, body.channel);
      } else if (body.targetUrl) {
        await activeRunner.gotoUrl(body.targetUrl, waitMs);
      } else {
        throw new Error('Indicá una URL destino o plataforma y canal.');
      }

      sendJson(res, 200, await activeRunner.getSnapshotState());
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/eval') {
      if (!runner || !runner.isRunning()) return sendJson(res, 400, { error: 'Abrí primero una página.' });
      const body = await readJsonBody(req);
      if (!body.expression) return sendJson(res, 400, { error: 'Falta expresión JS.' });
      sendJson(res, 200, await runner.evalExpression(body.expression));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/click') {
      if (!runner || !runner.isRunning()) return sendJson(res, 400, { error: 'Abrí primero una página.' });
      const body = await readJsonBody(req);
      if (!body.selector) return sendJson(res, 400, { error: 'Falta selector CSS.' });
      await runner.page.click(body.selector);
      await new Promise((r) => setTimeout(r, 1500));
      sendJson(res, 200, await runner.getSnapshotState());
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/clear') {
      if (runner) runner.clearLogs();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/api/close') {
      if (runner) await runner.close();
      sendJson(res, 200, { running: false });
      return;
    }

    sendJson(res, 404, { error: 'Ruta no encontrada.' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

const shutdown = async () => {
  if (runner) await runner.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`\nPanel Web F12 listo en http://${HOST}:${PORT}`);
});
