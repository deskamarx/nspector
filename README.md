# NSpector

Device inventory inspector. Finds duplicate IMEIs, tracks returns, and assigns
an owner and status to every finding so nothing sits unclaimed.

Built for a device distribution business where units were going missing and
nobody could say why. It reads the existing Google Sheets data, does the
reconciliation a spreadsheet cannot, and reports what needs attention.

**Windows app** · **Android app** · **live sync between them** · **self-hosted server**

---

## What it finds

Loaded from your sheets (66,028 dispatch records, 6,095 deposits, 49 returns):

| | |
|---|---|
| Duplicate serials in 2+ dealers | **501** |
| Serials in 3 or more dealers | 23 |
| IMEI lock / mismatch returns | 14 |
| Returns with no serial — untraceable | 1 |
| Dealer names for what is a much smaller roster | 396 |
| Product families after collapsing SKU spelling variants | 79 |

It separates the duplicate types that matter:

- **Same dealer twice** — a double-scan. Harmless, but it inflates your counts.
- **Two different dealers** — a handset cannot be in two shops. This is the
  real exposure and it is what the app queues for verification.
- **Three or more dealers** — worst case.

It also collapses your SKU spelling variants into real product families, so
`Redmi Note 17 8/256 - Purple` and `- Black` are counted as one model rather
than as separate products with fake risk scores.

---

## Ownership, not accusation

Every finding is a reporting item. Each one gets an **owner** and a **status**:

| Status | Meaning |
|---|---|
| `open` | Not looked at yet |
| `investigating` | Someone is checking it |
| `resolved` | Action taken, note recorded |
| `dismissed` | Checked, not an issue |

The Ownership tab shows per-person progress and how much value is sitting
unassigned. It answers "who is responsible for closing this" without implying
anyone did anything wrong — a duplicate is usually a data-entry issue, not
theft.

The app will not accuse anyone. When a dealer shows no matched payment it says
to check name aliases first, because in this data that is almost always a
naming problem rather than a collection problem.

---

## Running it

### Desktop app (Windows)

```
npm install
npm run dev          # rebuild native module for Electron, then run
npm run dist         # build installer + portable exe
```

Installers land in `release/`:
- `NSpector Setup 1.0.0.exe` — normal installer
- `NSpector 1.0.0.exe` — portable, no install

The packaged app needs no Node installed — it carries its own runtime.

### Server only

```
npm install
npm run rebuild:node   # native module for plain Node
npm start              # http://localhost:4173
```

For a machine that just stays on so phones can reach it.

### Native module ABI

`better-sqlite3` compiles against a specific Node ABI, and Electron bundles its
own Node. They are not interchangeable, so switch with:

```
npm run rebuild:node       # for npm start
npm run rebuild:electron   # for npm run dev / npm run dist
```

`npm run dev` and `npm run dist` do the Electron rebuild for you. If
`npm start` ever fails with `NODE_MODULE_VERSION`, run `npm run rebuild:node`.

### Android

```
android\build-apk.bat
```

Produces `android/NSpector.apk`. Install it on the phone, then enter the
server address shown in the desktop app under **Help → Server address**.

Both devices must be on the same network.

---

## Live sync

The server pushes over WebSocket. When someone changes a status on the phone,
the desktop updates immediately, and vice versa. No refresh, no polling.

`/api/stats` reports how many clients are connected.

---

## Data

Put CSV exports in `data/`:

| File | Contents |
|---|---|
| `s4_imei_master.csv` | 59,273 IMEI dispatch records |
| `s3_dispatch_sep.csv` | September 2026 dispatch |
| `s3_dispatch_oct.csv` | October 2026 dispatch |
| `s1_deposits.csv` | Deposit ledger |
| `s4_all.txt` | Returns and defect log |
| `s4_orders.csv` | Order quantities |

The desktop app copies these into its own data folder on first run
(`%APPDATA%/NSpector/data`) so your exports live somewhere you can edit them.
Replace the files and press **Sync**.

Public Google Sheets are fetched directly. Private ones must be exported to CSV
first — the app will not attempt to authenticate as you.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/stats` | Headline numbers |
| `GET /api/overview` | Charts: COD trend, families, dealer exposure |
| `GET /api/findings` | The work queue, filterable by status/kind/owner |
| `PATCH /api/findings/:id` | Set status, owner, resolution |
| `GET /api/ownership` | Per-person rollup, unassigned total |
| `GET /api/duplicates` | Duplicate serials, filterable by dealer |
| `GET /api/imei/:serial` | Full dispatch trail for one serial |
| `GET /api/dealers` | Dealer list with aliases |
| `GET /api/risk` | Model families ranked by risk |
| `GET /api/returns` | Return log |
| `POST /api/sync` | Re-ingest and broadcast |
| `WS /ws` | Live updates |

---

## Architecture

```
server/core.js    shared normalisation + analysis (also runs in the browser)
server/db.js      SQLite schema, ingest, finding generation
server/sync.js    sheet fetch + re-ingest + broadcast
server/server.js  REST API + WebSocket
web/              single-page UI, served to every client
electron/         Windows shell (runs the API in-process)
android/          Android WebView shell
```

One codebase, one API. The desktop and phone render the same UI from the same
server, which is why they stay in sync without any sync code.

Native modules are rebuilt for Electron's ABI during packaging
(`electron-rebuild`), so `better-sqlite3` loads in both development and the
packaged app.

### Android build note

Gradle fails with `The filename, directory name, or volume label syntax is
incorrect` on deeply-nested Windows paths. `build-apk.bat` stages the project
into `C:\nscbuild` before building, then copies the APK back. Building
directly inside a long path will fail.

---

## Stack

Node 22+ · Express 5 · better-sqlite3 · WebSocket (`ws`) · Electron 33 ·
Android Gradle Plugin 8.7 / SDK 36 · vanilla JS frontend, no build step.

No cloud services, no telemetry, no external dependencies at runtime.