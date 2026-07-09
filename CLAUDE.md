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

### Auth & security rules

Two different auth models, both satisfying the same `auth != null` RTDB/Storage rules:

- **Admin (`admin/index.html`)** is gated behind a real **login screen** (`signInWithEmailAndPassword`)
  — nothing in `#appShell` renders until `onAuthStateChanged` fires with a user. There is no self-service
  signup; operator accounts are created manually in Console → Authentication → Users. A "Sign Out" button
  in the top bar calls `signOut(auth)`.
- **Kiosk (`kiosk/index.html`)** signs in with **anonymous auth** (`signInAnonymously`) on load instead —
  it's an unattended public display with no one there to type a password.

In both files, every RTDB/Storage write awaits an `authReady` promise first (resolved on successful
sign-in) so writes don't race the auth handshake. `firebase/database.rules.json` and
`firebase/storage.rules` are the source of truth for the rules and must be pasted into the Firebase
Console (Realtime Database → Rules, and Storage → Rules) — `firebase.json` references them for the
Firebase CLI, but no CLI project alias (`.firebaserc`) is set up yet, so deploying them still requires
either the CLI (`firebase deploy --only database,storage`) or a manual console paste. For the kiosk's
anonymous auth to work, the **Anonymous** provider must also be enabled in Console → Authentication →
Sign-in method; if it isn't, `signInAnonymously` rejects and every kiosk RTDB/Storage write fails with a
permission error (surfaced to `console.error`).

## Realtime Database schema

```
/screens/{screenId}
  name, ip, location, group        — display metadata
  status: 'online' | 'offline'     — set by the kiosk; auto-flipped to 'offline' via onDisconnect()
  mode: 'idle'|'kids'|'adult'|'family'
  analytics: { total, male, female, children }   — unique visitor counts for TODAY (resets at local midnight)
  dwellTime                        — rolling average dwell time (seconds) reported by the kiosk
  lastSeen, createdAt              — serverTimestamp()

/content/{mode}          where mode in family|kids|adult|idle
  url            — Firebase Storage download URL
  storagePath    — Storage object path (null if the admin published a plain URL instead of a file)
  type: 'video'|'image'
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
- **Content → Content panel** (top bar "🎬 Content" button): each mode (family/kids/adult/idle) has its
  own file input + URL input + Publish button. Publishing a file uploads it to Storage at
  `content/{mode}/{timestamp}_{filename}` with a live progress bar, then writes the download URL +
  metadata to `/content/{mode}`; publishing a URL skips the upload and writes the metadata directly. The
  previous Storage object for that mode is deleted on replace (best-effort, non-blocking).
- All 6 charts are computed from real detection data, not simulated:
  - People Per Hour — today's `/events`, bucketed by hour.
  - Adults vs Children, Gender Breakdown — summed from `/screens/*/analytics`.
  - Unique Visitors (7 Days) — `/events` bucketed by date.
  - Dwell Time Distribution — `/dwellSamples` bucketed into `<5s / 5-10s / 10-30s / 30-60s / >60s`.
  - Campaign Impressions — top 5 screens by unique total.

## Kiosk (`kiosk/index.html`)

### Detection & unique-visitor dedup

Runs entirely client-side with **face-api.js** (TensorFlow.js) loaded from jsdelivr's GitHub CDN,
pinned to tag `0.22.2` (`justadudewhohacks/face-api.js`) for both the library and the model weights —
chosen over a server-side option (e.g. Cloud Vision) because it needs to run continuously on live video
with no per-frame cost and keep working with no internet connection.

Every `DETECTION_INTERVAL_MS` (700ms) it runs `detectAllFaces().withFaceLandmarks(true)
.withAgeAndGender().withFaceDescriptors()` (models: tinyFaceDetector, faceLandmark68TinyNet,
ageGenderNet, faceRecognitionNet). To avoid **double-counting the same person across ticks**:

- A session-long `gallery` array holds one entry per unique person `{descriptor, gender, isChild, age,
  firstSeen}`. Each new detection's face descriptor is compared (Euclidean distance) against every
  gallery entry; a match under `DIST_THRESHOLD` (0.5) is treated as the same person and does not
  increment any counter. A miss creates a new gallery entry (increments total/male/female/children) and
  pushes one row to `/events`.
- A separate `activeState` map tracks who is *currently* in frame (for the live "Live Audience" panel
  and dwell timing), with `ABSENCE_GRACE_MS` (4s) tolerance for someone briefly turning away before
  they're considered departed and their dwell duration is logged to `/dwellSamples`.
- Both structures are cleared at local midnight (`checkDailyReset()`), so `/screens/{id}/analytics` and
  the sidebar's "Unique Visitors Today" represent a **daily unique count per screen**, not lifetime —
  this is the standard OOH "unique reach" metric. The same visitor seen at two different screens counts
  once per screen (by design — there's no cross-device face-id matching).
- `age < CHILD_AGE_THRESHOLD` (13) decides child vs adult. Content mode is derived from who's currently
  active: no one → `idle`; only children → `kids`; only adults → `adult`; both → `family`.

These thresholds/constants live at the top of the kiosk's script — tune them there.

### Offline content playback (IndexedDB)

The kiosk never plays directly from a Storage URL. It listens to `/content`, and for each mode whose
`updatedAt` differs from what's cached, `fetch()`s the file once and stores the **Blob** in IndexedDB
(`scoop-kiosk-cache` DB, `content` store, keyed by `mode`). Rendering always reads from this local Blob
cache via `URL.createObjectURL()` — so if the network drops, the kiosk keeps playing the last
successfully-downloaded file per mode indefinitely. A mode with nothing cached yet shows a placeholder.

### Presence

On startup the kiosk `set()`s its `/screens/{screenId}` node and registers `onDisconnect()` writes that
flip `status` to `'offline'` if the tab closes or the connection drops — this is a native RTDB feature,
not polled. It also `update()`s status/mode/analytics/dwellTime every `PRESENCE_UPDATE_MS` (5s). All
Firebase writes (`push`/`set`/`update`) are queued locally by the SDK and sync automatically when the
connection returns, so the detection/event-logging code does not need its own retry logic.

## PWA (manifest + service worker)

Both apps register `/sw.js` (at the repo root, one directory up from `admin/`/`kiosk/`) on load, with an
explicit `{ scope: '/' }` so the one worker can control both subfolders. `sw.js` caches both HTML shells,
both manifests, and the icons on install (paths listed as root-absolute, e.g. `/admin/index.html`); at
runtime it's network-first (falling back to cache offline) for same-origin requests, and cache-first for
cross-origin vendor assets (Google Fonts, Chart.js, face-api.js + its model weight files) so the kiosk
can fully cold-start offline after the first successful load. Firebase hosts (`firebaseio.com`,
`firebasestorage.googleapis.com`, etc.) are explicitly excluded from the service worker's caching so
real-time sync and the kiosk's own IndexedDB content cache aren't interfered with.

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
- Fonts (Space Grotesk / IBM Plex Mono / Inter), Chart.js, and face-api.js are all loaded from CDNs —
  no local vendoring.

## Maintenance instruction for Claude

This file must be kept current: whenever you make a meaningful change to either HTML file, `sw.js`, or
the manifests (new feature, change in the RTDB schema/sync contract, detection/dedup logic, offline
caching strategy, PWA config, etc.), update the relevant section of this CLAUDE.md in the same
change/commit rather than leaving it stale.
