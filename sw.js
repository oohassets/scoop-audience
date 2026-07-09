/* Scoop Audience — shared service worker for both the admin dashboard and the
   kiosk PWA. Keeps the app shell (HTML) and vendor CDN assets (fonts,
   Chart.js, face-api.js + its model weights) available offline.

   Firebase traffic (Realtime Database / Storage) is intentionally passed
   straight through to the network — it has its own offline queueing/sync
   behavior, and kiosk content is already cached explicitly in IndexedDB
   (see kiosk/index.html), so double-caching it here would be redundant and
   could serve stale published content.

   This file lives at the project root (not inside admin/ or kiosk/) so one
   worker can control both subfolders — a service worker's scope can never be
   broader than the directory its own script is served from. Both pages
   register it as `../sw.js` with the (default) scope of that directory, i.e.
   wherever this repo's root actually is.

   Paths below are derived from `self.location` rather than hardcoded as
   root-absolute (`/admin/...`) — this repo isn't always served from the
   domain root. On a GitHub Pages *project* site it's served under
   `/<repo-name>/`, e.g. https://oohassets.github.io/scoop-audience/, so a
   hardcoded `/admin/index.html` would resolve to the wrong domain-root path
   and silently fail to cache. Deriving BASE from self.location keeps this
   correct under both that and a root deployment (e.g. Firebase Hosting). */

const BASE = new URL('./', self.location).href;

const SHELL_CACHE = 'scoop-audience-shell-v2';
const RUNTIME_CACHE = 'scoop-audience-runtime-v2';

const SHELL_ASSETS = [
  BASE + 'admin/index.html',
  BASE + 'admin/manifest.json',
  BASE + 'kiosk/index.html',
  BASE + 'kiosk/manifest.json',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png'
];

const PASSTHROUGH_HOSTS = [
  'firebaseio.com',
  'firebasestorage.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebase.googleapis.com',
  'googleapis.com/identitytoolkit'
];

self.addEventListener('install', event=>{
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(SHELL_ASSETS.map(asset => cache.add(asset).catch(()=>{}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event=>{
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event=>{
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);
  if(PASSTHROUGH_HOSTS.some(host => url.hostname.endsWith(host) || url.href.includes(host))) return;

  if(url.origin === self.location.origin){
    /* App shell: network-first so edits show up immediately when online,
       falling back to the cached copy when offline. */
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  /* Cross-origin vendor assets (fonts, Chart.js, face-api.js, model weights):
     cache-first so the kiosk still works fully offline once these have been
     fetched once. */
  event.respondWith(
    caches.match(req).then(cached=>{
      if(cached) return cached;
      return fetch(req).then(res=>{
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(cache => cache.put(req, copy));
        return res;
      }).catch(() => cached);
    })
  );
});
