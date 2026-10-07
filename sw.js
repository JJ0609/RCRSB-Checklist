// Service worker: lets the app open with no connection.
//
// What it does, and why:
//   - On install it saves every file the app needs (pages, scripts, styles, fonts,
//     the Excel-export library, icons) so they can be served with no network.
//   - Pages, scripts and styles (the parts that change when you deploy) are fetched
//     from the network first, so a good connection always gets the latest version.
//     If the network is down - or just too slow to be useful, which is the usual
//     jobsite problem - the saved copy is used after a few seconds.
//   - Fonts, images and the vendored library never change, so they come straight
//     from the saved copy.
//   - It only ever touches files from this site. Calls to the API (the Worker) are
//     never intercepted: the app handles those itself, with its own saved data.
//
// Bump VERSION when the list of files below changes; old copies are then deleted.
const VERSION = 'v1';
const CACHE = 'pd-app-' + VERSION;
const PRECACHE = [
  "./",
  "index.html",
  "projects.html",
  "login.html",
  "style.css",
  "fonts.css",
  "config.js",
  "theme.js",
  "app.js",
  "projects.js",
  "login.js",
  "pwa.js",
  "offline.js",
  "manifest.webmanifest",
  "vendor/exceljs.min.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "power-design-logo-white.png",
  "power-design-logo-black.png",
  "fonts/jetbrains-mono-latin-400-normal.woff2",
  "fonts/jetbrains-mono-latin-500-normal.woff2",
  "fonts/jetbrains-mono-latin-600-normal.woff2",
  "fonts/libre-franklin-latin-500-normal.woff2",
  "fonts/libre-franklin-latin-700-normal.woff2",
  "fonts/libre-franklin-latin-800-normal.woff2",
  "fonts/source-sans-3-latin-400-normal.woff2",
  "fonts/source-sans-3-latin-500-normal.woff2",
  "fonts/source-sans-3-latin-600-normal.woff2",
  "fonts/source-sans-3-latin-700-normal.woff2"
];

self.addEventListener('install', function(event){
  event.waitUntil((async function(){
    const cache = await caches.open(CACHE);
    // One by one rather than addAll(): a single missing file shouldn't stop the rest being saved.
    await Promise.all(PRECACHE.map(async function(url){
      try{ await cache.add(new Request(url, {cache: 'reload'})); }
      catch(e){ console.warn('[sw] could not save', url, e && e.message); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function(event){
  event.waitUntil((async function(){
    const keys = await caches.keys();
    await Promise.all(keys.filter(function(k){ return k.indexOf('pd-app-') === 0 && k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    await self.clients.claim();
  })());
});

function stripSearch(url){ return new Request(url.origin + url.pathname); }

function withTimeout(promise, ms){
  return new Promise(function(resolve, reject){
    const t = setTimeout(function(){ reject(new Error('timeout')); }, ms);
    promise.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
  });
}

const OFFLINE_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Offline</title><body style="font-family:system-ui,sans-serif;background:#000;color:#eee;padding:40px;line-height:1.5">' +
  '<h2>You\'re offline</h2><p>This page hasn\'t been saved on this device yet. Go back, or reconnect and try again.</p>'
  + '<div style="margin-top:14px;"><a href="projects.html" style="color:var(--accent);font-weight:700;">&larr; Back to projects</a></div>'
  + '</div>';

async function networkFirst(event, url){
  const req = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, {ignoreSearch: true});
  if(cached && self.navigator && self.navigator.onLine === false) return cached;
  const isNav = req.mode === 'navigate';
  const live = fetch(req).then(function(res){
    if(res && res.ok && res.type === 'basic') cache.put(stripSearch(url), res.clone());
    return res;
  });
  event.waitUntil(live.catch(function(){}));   // lets a slow download still finish and refresh the saved copy
  try{
    return await withTimeout(live, isNav ? 4000 : 3000);
  }catch(e){
    if(cached) return cached;
    if(isNav) return new Response(OFFLINE_PAGE, {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8'}});
    return live.catch(function(){ return Response.error(); });
  }
}

async function cacheFirst(req){
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if(hit) return hit;
  const res = await fetch(req);
  if(res && res.ok && res.type === 'basic') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', function(event){
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;
  if(url.pathname.slice(-6) === '/sw.js') return;
  const isCode = req.mode === 'navigate' || /\.(html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.slice(-1) === '/';
  event.respondWith(isCode ? networkFirst(event, url) : cacheFirst(req));
});
