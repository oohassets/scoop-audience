# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Scoop Audience** (product name shown in the UI: "Scoop Sense" / "Scoop Audience") is a camera-based
audience-detection digital signage system for out-of-home (OOH) advertising screens. Each physical
screen runs a **kiosk** PWA that detects the audience in front of it (male/female, child/adult, unique
visitor counts, dwell time) and switches playing content (family / kids / adult / idle) accordingly. A
separate **admin dashboard** PWA lets an operator monitor all screens in real time, publish content, and
view analytics.

There is no backend server, build step, or package manager in this repo — both apps are standalone
static HTML files (HTML + CSS + JS inline, no bundler). All cross-device sync/storage goes through
**Firebase** (Realtime Database + Storage + Auth), loaded directly from the `gstatic.com` CDN as ES
modules.

## Folder structure

```
/
├── admin/
│   ├── index.html        — admin dashboard app (was scoop-audience-admin.html)
│   └── manifest.json      — admin's Web App Manifest (was manifest-admin.json)
├── kiosk/
│   ├── index.html        — kiosk app (was scoop-audience-kiosk.html)
│   └── manifest.json      — kiosk's Web App Manifest (was manifest-kiosk.json)
├── icons/
│   ├── icon-192.png       — shared PWA icon, 192×192
│   └── icon-512.png       — shared PWA icon, 512×512
├── firebase/
│   ├── database.rules.json — RTDB security rules (source of truth; paste into Console)
│   └── storage.rules       — Storage security rules (source of truth; paste into Console)
├── firebase.json          — ties the two rule files + Hosting config together for the Firebase CLI
├── sw.js                  — shared service worker; MUST stay at repo root (see PWA section below)
└── CLAUDE.md
```

Both `admin/index.html` and `kiosk/index.html` reference `../icons/...` and register `../sw.js` with an
explicit `{ scope: '/' }` — if you ever move files again, those relative paths (and the manifests'
`../icons/...` entries, and `sw.js`'s `SHELL_ASSETS` root-absolute paths) all need to move together.
`firebase.json`'s `hosting.rewrites` map `/admin` → `/admin/index.html` and `/kiosk` → `/kiosk/index.html`
for clean URLs if this ever gets deployed to Firebase Hosting (no `.firebaserc` exists yet, so
`firebase deploy` isn't wired up to a project — that's still a manual one-time `firebase use --add`
away).

## Firebase project

Project id `scoop-audience`, using Realtime Database (not Firestore) and Cloud Storage. The client
config (apiKey, databaseURL, storageBucket, etc.) is inlined at the top of both HTML files' `<script
type="module">` — this is normal for Firebase web apps (the apiKey is not a secret); access control is
enforced by RTDB/Storage **security rules** (see below). `getAnalytics`/`measurementId` from the
provided config is intentionally **not** initialized — it tracks web-page traffic, not
audience-detection analytics, and this project already has a real analytics pipeline (see Realtime
Database schema below).

Firebase JS SDK version pinned to `10.13.2` via `https://www.gstatic.com/firebasejs/10.13.2/...`.

### One-time external setup (Console/gcloud, not in this repo's files)

None of these are fixable by editing code — they're Firebase/GCP project configuration, done once:

1. **Create at least one Email/Password user** — Console → Authentication → Users → Add user. Both
   admin and kiosk log in with this (see Auth & security rules below); there's no self-service signup.
2. **Add every domain this is hosted on to Authorized domains** — Console → Authentication → Settings →
   Authorized domains (e.g. `oohassets.github.io`; `localhost` and `*.web.app`/`*.firebaseapp.com` are
   authorized by default). Missing this → `auth/unauthorized-domain`.
3. **Paste `firebase/database.rules.json` and `firebase/storage.rules`** into Console → Realtime Database
   → Rules and Console → Storage → Rules.
4. **Set CORS on the Storage bucket** — the kiosk downloads published content with a plain `fetch()` (to
   cache it in IndexedDB for offline playback), and Cloud Storage buckets have no CORS policy by default,
   which fails as `... has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header ...` in
   the console even though the file itself loads fine in a `<video>`/`<img>` tag (media elements aren't
   subject to CORS the same way `fetch()` is). Fix once, from a machine with the Google Cloud SDK
   installed and authenticated to this project:
   ```
   gcloud auth login
   gcloud config set project scoop-audience
   gsutil cors set firebase/cors.json gs://scoop-audience.firebasestorage.app
   ```
   `firebase/cors.json` in this repo is the source of truth for the allowed origins — add any new
   hosting domain there too when you add one to Authorized domains above.

### Auth & security rules

Both `admin/index.html` and `kiosk/index.html` are gated behind an identical real **login screen**
(`signInWithEmailAndPassword`) — nothing in `#app`/`#appShell` renders until `onAuthStateChanged` fires
with a user. There is no self-service signup; accounts are created manually in Console → Authentication
→ Users. Both have a "Sign Out" button that calls `signOut(auth)` (on the kiosk it's tagged `toggleable`
so it also hides in true fullscreen kiosk mode along with the screen-name/panel buttons).

The kiosk originally used **anonymous auth** (`signInAnonymously`) instead, since it's an unattended
public display with no one there to type a password — but this particular Firebase/GCP project
consistently rejects anonymous sign-in with `auth/admin-restricted-operation` (some project/org-level
restriction on anonymous account creation that wasn't worth chasing further), so it now uses the same
email/password login as admin instead. Firebase Auth persists the session in the browser by default, so
each physical screen only needs to be logged in **once** during setup (via the on-screen login form,
same as a human would use), not on every reboot — all kiosk screens can share one account, or each can
have its own.

In both files, every RTDB/Storage write awaits an `authReady` promise first (resolved once
`onAuthStateChanged` reports a signed-in user) so writes don't race the auth handshake. `firebase/database.rules.json` and
`firebase/storage.rules` are the source of truth for the rules and must be pasted into the Firebase
Console (Realtime Database → Rules, and Storage → Rules) — `firebase.json` references them for the
Firebase CLI, but no CLI project alias (`.firebaserc`) is set up yet, so deploying them still requires
either the CLI (`firebase deploy --only database,storage`) or a manual console paste.

## Realtime Database schema

```
/screens/{screenId}
  name, ip, location, group        — display metadata
  status: 'online' | 'offline'     — set by the kiosk; auto-flipped to 'offline' via onDisconnect()
  mode: 'idle'|'kids'|'adult'|'family'
  analytics: { total, male, female, children }   — unique visitor counts for TODAY (resets at local midnight)
  dwellTime                        — rolling average dwell time (seconds) reported by the kiosk
  lastSeen, createdAt              — serverTimestamp()

/content/{mode}/{itemId}   where mode in family|kids|adult|idle — a PLAYLIST, not a single item
  url            — Firebase Storage download URL
  storagePath    — Storage object path (null if the admin published a plain URL instead of a file)
  type: 'video'|'image'
  duration       — seconds to hold before advancing; only set (and only meaningful) for type:'image' —
                   videos always advance on their own natural end instead
  name, size, updatedAt

/events/{pushId}          — one entry per NEWLY detected unique person (flat, not nested under screenId,
  screenId, gender, isChild, timestamp   so it can be queried directly with orderByChild('timestamp'))

/dwellSamples/{pushId}    — one entry per completed dwell session (person left frame)
  screenId, seconds, timestamp
```

`screenId` is always `slugify(screenName)` (lowercase, non-alnum → `-`) — computed identically in both
files. This means an admin-created screen and a kiosk self-registering under the same name collapse
into the same node. **Renaming a screen in the admin does not rename the kiosk's own identity** — the
kiosk keeps posting to its original slug until you also rename it from the kiosk's own "Screen" button
(top bar). `/events` and `/dwellSamples` are flat (not nested per screen) specifically so the admin can
run a single `orderByChild('timestamp')` range query across all screens instead of pulling full history.

## Admin dashboard (`admin/index.html`)

- Screens table/KPIs/charts are all driven by live `onValue()` listeners — no polling.
- Connectivity badge in the top bar watches the special `.info/connected` RTDB path.
- **Content → Content panel** (top bar "Content" button): each mode (family/kids/adult/idle) manages a
  **playlist**. The file input takes multiple files at once (each becomes its own playlist entry); the
  URL input adds one more entry per click; a per-mode "image duration" number field (default 8s) is
  stamped onto any image entries added in that click (irrelevant for videos, which just play out).
  Publishing uploads to Storage at `content/{mode}/{timestamp}_{filename}` with a live progress bar per
  file, then `push()`es each item under `/content/{mode}`. Playlist order is upload order (RTDB push keys
  sort chronologically, so no separate `order` field is needed). Each item has its own ✕ button to
  remove it (best-effort deletes the Storage object too). A top-of-modal **"Republish All"** button
  bumps every item's `updatedAt` (via one multi-path `update()`, nothing else about the item changes) —
  every kiosk's `/content` listener treats that as a change and re-fetches, which is the fix for a screen
  that never got the content in the first place (missed the initial sync, a corrupted partial download,
  a transient CORS/network hiccup) without having to re-upload anything.
- All 6 charts are computed from real detection data, not simulated:
  - People Per Hour — today's `/events`, bucketed by hour.
  - Adults vs Children, Gender Breakdown — summed from `/screens/*/analytics`.
  - Unique Visitors (7 Days) — `/events` bucketed by date.
  - Dwell Time Distribution — `/dwellSamples` bucketed into `<5s / 5-10s / 10-30s / 30-60s / >60s`.
  - Campaign Impressions — top 5 screens by unique total.
- **CSV/JSON exports** dump the live `screens` snapshot (current cumulative counters) — unlike the
  Report below, they are not date-range filtered.
- **Report export** is the odd one out: unlike everything else on the dashboard (which reads the live
  `screens` cumulative counters or a fixed rolling window), it's driven by the "Report range"
  `datetime-local` pair next to the export buttons (defaults to the last 24h) and does a one-off `get()`
  query — not `onValue()` — against `/events` and `/dwellSamples` bounded by `orderByChild('timestamp')
  .startAt(fromMs).endAt(toMs)`, then aggregates totals, a per-screen breakdown, and a trend bucketed by
  hour (ranges ≲26h) or by day (longer ranges) entirely from that filtered log. It renders 4 real Chart.js
  charts **off-screen** (`renderChartToImage()` — a detached canvas, `animation:false`, captured via
  `canvas.toDataURL()` after a double-`requestAnimationFrame` wait so the paint has actually happened) and
  embeds them as `<img>`s in the exported HTML, rather than shipping Chart.js + live data into the
  downloaded file — this makes the report print/PDF reliably (rasterized charts behave predictably in
  print output; live canvases often don't) and keeps it viewable fully offline. The exported HTML has its
  own `@page{size:A4;margin:0.5in;}` rule and a "Print / Save as PDF" button (`window.print()`) baked in —
  that's the actual HTML→PDF conversion path: the browser's native print-to-PDF renderer, which keeps all
  table/heading text fully vector-crisp and only rasterizes the chart images (at 1000×460px per chart,
  a deliberate quality/file-size tradeoff — bump `CW`/`CH` in `renderChartToImage()` calls if you want
  sharper images at the cost of a larger downloaded file).

## Kiosk (`kiosk/index.html`)

### Detection & unique-visitor dedup

Runs entirely client-side with **face-api.js** (TensorFlow.js) loaded from jsdelivr's GitHub CDN,
pinned to tag `0.22.2` (`justadudewhohacks/face-api.js`) for both the library and the model weights —
chosen over a server-side option (e.g. Cloud Vision) because it needs to run continuously on live video
with no per-frame cost and keep working with no internet connection.

Every `DETECTION_INTERVAL_MS` (700ms) a `setInterval` tick runs `detectAllFaces().withFaceLandmarks(true)
.withAgeAndGender().withFaceDescriptors()` (models: tinyFaceDetector, faceLandmark68TinyNet,
ageGenderNet, faceRecognitionNet), guarded by an `detectionInFlight` flag that skips a tick outright if
the previous one hasn't finished yet. **This guard matters**: `detectAllFaces` with descriptors can
easily take longer than 700ms on modest hardware or with several faces in frame, and `setInterval` does
not wait for the previous call — without the guard, two ticks run concurrently, both check the same real
person against `gallery` before either has added them, and both decide "new person," double-counting the
same visitor. To avoid **double-counting the same person across ticks**:

- A session-long `gallery` array holds one entry per unique person `{descriptor, gender, isChild, age,
  firstSeen}`. Each new detection's face descriptor is compared (Euclidean distance) against every
  gallery entry; a match under `DIST_THRESHOLD` (0.6 — face-api.js's own recommended same-person cutoff;
  an earlier, stricter 0.5 caused the same real visitor to be misclassified as "new" whenever their
  angle/lighting/expression shifted slightly between ticks) is treated as the same person and does not
  increment any counter. A miss creates a new gallery entry (increments total/male/female/children) and
  pushes one row to `/events`.
- A separate `activeState` map tracks who is *currently* in frame (for the sidebar's "Detected Audience"
  panel and dwell timing), with `ABSENCE_GRACE_MS` (4s) tolerance for someone briefly turning away before
  they're considered departed and their dwell duration is logged to `/dwellSamples`.
- The sensor preview also draws a live bounding box + `GENDER · ~AGEy` label per detected face directly
  on the camera feed (`drawOverlay()`, on an absolutely-positioned `<canvas>` mirrored to match the
  mirrored `<video>`), plus decorative corner brackets and an animated scanline — purely cosmetic, no
  effect on the dedup/counting logic above.
- Both structures are cleared at local midnight (`checkDailyReset()`), so `/screens/{id}/analytics` and
  the sidebar's "Unique Visitors Today" represent a **daily unique count per screen**, not lifetime —
  this is the standard OOH "unique reach" metric. The same visitor seen at two different screens counts
  once per screen (by design — there's no cross-device face-id matching).
- `age < CHILD_AGE_THRESHOLD` (13) decides child vs adult. Content mode is derived from who's currently
  active: no one → `idle`; only children → `kids`; only adults → `adult`; both → `family`.

These thresholds/constants live at the top of the kiosk's script — tune them there.

### Offline content playback (IndexedDB) + playlist advancing

The kiosk never plays directly from a Storage URL. It listens to `/content`, and for each playlist item
whose `updatedAt` differs from what's cached, `fetch()`s the file once and stores the **Blob** in
IndexedDB (`scoop-kiosk-cache` DB v2, `content` store, keyed by `itemId` — the RTDB push id, globally
unique across all modes). `syncPlaylistFromRemote()` also deletes any cached item whose id no longer
exists remotely (removed from the admin's playlist). Rendering always reads from this local Blob cache
via `URL.createObjectURL()` — so if the network drops, the kiosk keeps playing the last-synced playlist
per mode indefinitely. A mode with an empty playlist shows a placeholder.

`contentState[mode]` is the in-memory ordered array (post-cache) for that mode; `playlistIndex[mode]`
tracks which item is showing. `applyMode()` resets a mode's index to 0 whenever the kiosk actually
switches into it. Advancing to the next item is driven differently per type: videos have **no `loop`
attribute** and instead advance via a single persistent `playerVideo` `'ended'` listener (so they always
play their full length); images advance via a `setTimeout(..., item.duration*1000)` (default 8s) set in
`renderStage()`. A one-item playlist naturally "loops," since advancing wraps the index back to 0 and
re-renders/restarts the same item.

### Presence

On startup the kiosk `set()`s its `/screens/{screenId}` node and registers `onDisconnect()` writes that
flip `status` to `'offline'` if the tab closes or the connection drops — this is a native RTDB feature,
not polled. It also `update()`s status/mode/analytics/dwellTime every `PRESENCE_UPDATE_MS` (5s). All
Firebase writes (`push`/`set`/`update`) are queued locally by the SDK and sync automatically when the
connection returns, so the detection/event-logging code does not need its own retry logic.

## PWA (manifest + service worker)

Both apps register `sw.js` (at the repo root, one directory up — `../sw.js`) on load, with **no explicit
`scope` option** — the default scope (the directory containing the script) is deliberately left to
resolve on its own so one worker controls both subfolders correctly wherever the repo is actually
hosted. `sw.js` derives `BASE = new URL('./', self.location).href` and builds its shell-asset list from
that instead of hardcoding root-absolute paths like `/admin/index.html` — this repo is **not always
served from the domain root** (see Deployment below), and a hardcoded `/admin/...` path would resolve to
the wrong URL and silently fail to cache under a subpath deployment. At runtime it's network-first
(falling back to cache offline) for same-origin requests, and cache-first for cross-origin vendor assets
(Google Fonts, Chart.js, face-api.js + its model weight files) so the kiosk can fully cold-start offline
after the first successful load. Firebase hosts (`firebaseio.com`, `firebasestorage.googleapis.com`,
etc.) are explicitly excluded from the service worker's caching so real-time sync and the kiosk's own
IndexedDB content cache aren't interfered with.

### How an update actually reaches admin + kiosk

Pushing a new commit is not enough by itself — this is what makes it propagate to every open tab
(including unattended kiosks that never navigate on their own):

1. `sw.js` already calls `skipWaiting()` on install and `clients.claim()` on activate, so as soon as a
   browser notices the script bytes changed, the new worker takes over immediately instead of waiting for
   every tab to close.
2. Both `admin/index.html` and `kiosk/index.html` register a `controllerchange` listener that reloads the
   page exactly once when that handover happens — this is what actually gets the new HTML/JS running,
   since taking control of a page doesn't retroactively change code already loaded into it.
3. Both also call `registration.update()` every hour (`setInterval`), instead of relying solely on the
   browser's own background check (which is nominally ~24h and is also triggered by navigation — a kiosk
   that just sits on one loaded page for days won't trigger it any other way).

Net effect: push a change, and every open admin tab / kiosk screen picks it up and self-reloads within
about an hour, with no one touching the device.

**Cache versioning**: `sw.js`'s `SHELL_CACHE`/`RUNTIME_CACHE` constants are suffixed `-v1`. The `activate`
handler deletes any cache whose name doesn't match the current constants — so if you change what/how
something is cached (not just the app code inside the existing strategy), bump the suffix (`-v2`, etc.)
to force old cached entries to be dropped instead of silently lingering under the old cache name.

## Deployment

Currently deployed via **GitHub Pages** from the `main` branch root (repo: `oohassets/scoop-audience`,
live at `https://oohassets.github.io/scoop-audience/`, e.g. `/admin/` and `/kiosk/`) — a GitHub-side
setting (Settings → Pages → Source), not something in this repo's files. `firebase.json` also exists for
deploying to **Firebase Hosting** instead/as well (`firebase deploy --only hosting`, once `firebase
login` + a project alias are set up) — its `hosting.rewrites` give clean `/admin` and `/kiosk` routes
there specifically; GitHub Pages just serves the folders directly (`/admin/`, trailing slash, resolves to
`admin/index.html`).

**Whichever domain this ends up on must be added to Firebase Console → Authentication → Settings →
Authorized domains**, or both `signInWithEmailAndPassword` (admin) and `signInAnonymously` (kiosk) fail
with `auth/unauthorized-domain`. `localhost` and the project's own `*.firebaseapp.com`/`*.web.app` are
authorized by default; a GitHub Pages domain (`oohassets.github.io`) is not, and has to be added manually.

## Running / developing

No build tooling, no `package.json`, no test runner. Serve the repo root with any static file server and
open `/admin/index.html` or `/kiosk/index.html` — a real HTTP(S) origin is required for the service
worker, camera (`getUserMedia`), and IndexedDB to work; `file://` will not work for the service worker.
There are no lint/test/build commands.

## Conventions used in this codebase

- Vanilla JS. Firebase imports use `<script type="module">`; the rest of each file's logic stays in a
  `(function(){ "use strict"; ... })()` IIFE beneath the imports, using `$ = id =>
  document.getElementById(id)`.
- `slugify(name)` is duplicated verbatim in both HTML files (no shared module in this no-build setup)
  — keep the two copies identical if you ever change it, since it determines RTDB node identity.
- Theming (admin only) via CSS custom properties on `:root`, with an `html.light` override block;
  toggle persisted to `localStorage['scoop-theme']`. The kiosk is dark-only by design (public display).
- Fonts: **DM Sans** for both `--font-display` and `--font-body`, **IBM Plex Mono** for `--font-mono`
  (data-heavy/tabular bits — timestamps, stats, badges). Icons are **Google Material Symbols Outlined**
  (`<span class="material-symbols-outlined">icon_name</span>`, ligature-text icon names like `refresh`,
  `logout`, `fullscreen`) — no raw emoji/unicode glyphs in either app; keep new icons in that family for
  consistency. Fonts, icons, Chart.js, and face-api.js are all loaded from CDNs — no local vendoring.
- Both apps are responsive down to phone widths: topbars use `flex-wrap`, the admin's screens table
  scrolls horizontally inside `.table-scroll` rather than squeezing (it has a `min-width` so columns stay
  legible), and the kiosk's sidebar collapses from a 320px side column to a capped-height panel below the
  video stage under 880px. Check new UI at ~375px, ~768px, and desktop widths, not just desktop.

## Maintenance instruction for Claude

This file must be kept current: whenever you make a meaningful change to either HTML file, `sw.js`, or
the manifests (new feature, change in the RTDB schema/sync contract, detection/dedup logic, offline
caching strategy, PWA config, etc.), update the relevant section of this CLAUDE.md in the same
change/commit rather than leaving it stale.
