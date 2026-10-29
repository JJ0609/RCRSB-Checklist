// Small web server for the commissioning site: it hands out the static files and answers /health in the same
// shape as the other apps, so PM2 can run it and the system dashboard can find and check it by itself.
// No dependencies - it only uses what comes with Node (18 or newer), so there is nothing to `npm install`.
//
// Settings (all optional, set in the PM2 ecosystem entry):
//   PORT         web port (default 8082)
//   HTTPS_PORT   also serve HTTPS on this port (needs TLS_KEY and TLS_CERT) - installing the app and offline mode need HTTPS
//   TLS_KEY / TLS_CERT   paths to the certificate's key and certificate files
//   BACKEND_URL  the Worker's address, if you don't want it read from config.js
//   BACKEND_INTERVAL_MS / BACKEND_TIMEOUT_MS / BACKEND_FAILS_BEFORE_DOWN / BACKEND_STALE_MS  how the Worker is checked (see below)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8082;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 0;
// Same idea as the dashboard: package.json is the single source for the version
const { version } = require('./package.json');

// Only these kinds of file are ever handed out; anything else (.sql, .toml, .md, .sh ...) is a 404
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
};
// Files that are allowed types but belong to the server, not the site
const NEVER_SERVE = new Set(['server.js', 'package.json', 'package-lock.json', 'ecosystem.config.js']);
const KEEP_AN_HOUR = new Set(['.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff2', '.woff']);   // everything else is re-checked each time

function securityHeaders(extra) { return Object.assign({ 'X-Content-Type-Options': 'nosniff' }, extra); }
function sendText(res, code, text, extra) {
  res.writeHead(code, securityHeaders(Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, extra)));
  res.end(text);
}
function sendJson(res, code, body, head) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) }));
  res.end(head ? undefined : text);
}

// ---------- the files ----------
// Turns a web address into a file inside this folder, or null if it must not be served.
function resolveFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (p.indexOf('\0') !== -1) return null;
  if (p.slice(-1) === '/') p += 'login.html';
  const parts = p.split('/').filter(Boolean);
  if (!parts.length || parts.some((s) => s.charAt(0) === '.')) return null;   // .git, .env, "..", any hidden file or folder
  if (parts[0].toLowerCase() === 'node_modules') return null;
  const file = path.join(ROOT, parts.join('/'));
  if (file.indexOf(ROOT + path.sep) !== 0) return null;                       // never leave this folder
  if (NEVER_SERVE.has(path.basename(file).toLowerCase())) return null;
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) return null;
  return { file, ext, type: MIME[ext] };
}

function serveStatic(req, res, urlPath) {
  const target = resolveFile(urlPath);
  if (!target) return sendText(res, 404, 'Not found');
  fs.stat(target.file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    const headers = securityHeaders({
      'Content-Type': target.type,
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': KEEP_AN_HOUR.has(target.ext) ? 'public, max-age=3600' : 'no-cache'
    });
    const since = Date.parse(req.headers['if-modified-since'] || '');
    if (!isNaN(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target.file).on('error', () => res.destroy()).pipe(res);
  });
}

// ---------- /health (same shape as the other apps, see the dashboard's health.js) ----------
// Runs one check and records how long it took; throwing marks it as failed.
function timed(fn) {
  const started = Date.now();
  try { return Object.assign({ status: 'pass', durationMs: Date.now() - started }, fn()); }
  catch (err) { return { status: 'fail', durationMs: Date.now() - started, error: err.message }; }
}
// Things that don't stop the site working (icons, manifest) only make it degraded, never unhealthy
const asWarning = (c) => (c.status === 'fail' ? Object.assign({}, c, { status: 'warn' }) : c);

// Errors here end up in the /health answer, so they name the file but never its location on the server
const read = (name) => { try { return fs.readFileSync(path.join(ROOT, name), 'utf8'); } catch (e) { throw new Error('cannot read ' + name); } };

function pagesCheck() {
  ['login.html', 'projects.html', 'index.html', 'config.js'].forEach((f) => read(f));
  return { files: 4 };
}
function manifestCheck() {
  const m = JSON.parse(read('app.webmanifest'));   // a missing comma in here silently turns the whole PWA off
  if (typeof m.start_url !== 'string') throw new Error('start_url must be a single text value');
  if (!Array.isArray(m.icons) || !m.icons.length) throw new Error('no icons listed');
  return {};
}
function iconsCheck() {
  const m = JSON.parse(read('app.webmanifest'));
  const wanted = (m.icons || []).map((i) => i.src);
  const touch = (read('login.html').match(/rel="apple-touch-icon"\s+href="([^"]+)"/) || [])[1];
  if (touch) wanted.push(touch);
  const missing = wanted.filter((src) => !fs.existsSync(path.join(ROOT, src)));
  if (missing.length) throw new Error('missing: ' + missing.join(', '));
  return { icons: wanted.length };
}

// ---------- the Worker check ----------
// The Worker (and the database behind it) is what makes the pages useful. The dashboard times how long /health
// takes and gives up on a slow answer, so /health never waits for the Worker: a timer asks it in the background
// every 30 seconds, and /health reports the latest result straight away.
//
// One slow or failed answer is not "down". A problem that could be a blip (no answer, a connection error, a 5xx)
// only counts as down after 3 in a row, about 90 seconds. Recovery shows at once. A problem that can't be a blip
// (a 404, no Worker address) shows immediately.
const BACKEND_INTERVAL_MS = Number(process.env.BACKEND_INTERVAL_MS) || 30000;           // how often the Worker is asked
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS) || 20000;             // how long one answer may take
const BACKEND_FAILS_BEFORE_DOWN = Number(process.env.BACKEND_FAILS_BEFORE_DOWN) || 3;   // failures in a row before it counts as down
const BACKEND_STALE_MS = Number(process.env.BACKEND_STALE_MS) || BACKEND_INTERVAL_MS * 4;   // a result older than this is flagged

let published = { status: 'warn', durationMs: 0, error: 'waiting for the first check' };   // what /health reports
let failuresInARow = 0, lastFailure = '', lastCheckAt = 0, checking = false;

function workerAddress() {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL;
  try { return (read('config.js').match(/https:\/\/[A-Za-z0-9._-]+\.workers\.dev/) || [])[0] || ''; } catch (e) { return ''; }
}
const seconds = (ms) => { const n = Math.round(ms / 1000); return n + ' second' + (n === 1 ? '' : 's'); };

async function runBackendCheck() {
  const api = workerAddress().replace(/\/+$/, '');
  const started = Date.now();
  if (!api) return { status: 'fail', durationMs: 0, error: 'no Worker address found in config.js' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BACKEND_TIMEOUT_MS);
  try {
    const r = await fetch(api + '/health', { signal: ctl.signal });
    await r.arrayBuffer();
    if (r.ok) return { status: 'pass', durationMs: Date.now() - started };
    return { status: 'fail', durationMs: Date.now() - started, error: 'HTTP ' + r.status, transient: r.status >= 500 };
  } catch (e) {
    return { status: 'fail', durationMs: Date.now() - started, transient: true, error: e.name === 'AbortError' ? 'no answer within ' + seconds(BACKEND_TIMEOUT_MS) : 'could not connect' };
  } finally { clearTimeout(timer); }
}

async function checkBackend() {
  if (checking) return;   // never two at once
  checking = true;
  let result;
  try { result = await runBackendCheck(); }
  catch (e) { result = { status: 'fail', durationMs: 0, error: 'the check could not run', transient: true }; }
  finally { checking = false; }
  lastCheckAt = Date.now();
  if (result.status === 'pass') {
    failuresInARow = 0; lastFailure = '';
    published = { status: 'pass', durationMs: result.durationMs };
    return;
  }
  failuresInARow++; lastFailure = result.error;
  if (!(result.transient && failuresInARow < BACKEND_FAILS_BEFORE_DOWN)) published = { status: 'fail', durationMs: result.durationMs, error: result.error };
}

// What /health shows for the Worker. It never waits, and it says how fresh the answer is.
function backendCheck() {
  const out = Object.assign({}, published);
  const age = lastCheckAt ? Math.round((Date.now() - lastCheckAt) / 1000) : null;
  if (age !== null) out.ageSeconds = age;
  if (failuresInARow) {
    out.failuresInARow = failuresInARow;
    if (out.status !== 'fail') out.lastError = lastFailure;   // still showing the last good answer, but say what went wrong since
  }
  if (lastCheckAt && Date.now() - lastCheckAt > BACKEND_STALE_MS && out.status !== 'fail') {   // the timer should have run by now
    out.status = 'warn';
    out.error = 'the last check was ' + seconds(Date.now() - lastCheckAt) + ' ago';
  }
  return out;
}

function startBackendChecks() {
  checkBackend();                                      // right away, so the first /health already has an answer
  setInterval(checkBackend, BACKEND_INTERVAL_MS);
}

async function health(req, res) {
  const checks = {
    pages: timed(pagesCheck),
    manifest: asWarning(timed(manifestCheck)),
    icons: asWarning(timed(iconsCheck)),
    backend: backendCheck()
  };
  // A failed check makes the app unhealthy; a warning only makes it degraded (same rule as the dashboard)
  const results = Object.values(checks).map((c) => c.status);
  const status = results.indexOf('fail') !== -1 ? 'unhealthy' : results.indexOf('warn') !== -1 ? 'degraded' : 'healthy';
  sendJson(res, status === 'unhealthy' ? 503 : 200, {
    status,
    name: 'Commissioning Site',
    description: 'Allows techs to easily test devices on site and make any notes of issues that may arise, while also allowing the office end to keep up to date with new information and find out about any issues that need to be addressed with a project.',
    version,
    checkedAt: new Date().toISOString(),
    checks,
    uptimeSeconds: Math.round(process.uptime())
  }, req.method === 'HEAD');
}

// ---------- the server ----------
function handler(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/health') {
    if (['GET', 'HEAD', 'POST'].indexOf(req.method) === -1) return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
    return health(req, res).catch((e) => sendJson(res, 500, { status: 'unhealthy', error: e.message }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  serveStatic(req, res, urlPath);
}

http.createServer(handler).listen(PORT, () => console.log('Commissioning site on http://0.0.0.0:' + PORT));
startBackendChecks();

if (HTTPS_PORT) {
  try {
    const options = { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) };
    https.createServer(options, handler).listen(HTTPS_PORT, () => console.log('Commissioning site on https://0.0.0.0:' + HTTPS_PORT));
  } catch (e) {
    console.error('HTTPS is off: ' + e.message);   // the plain-HTTP site above keeps running
  }
}