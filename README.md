# NSpector

Device inventory intelligence. Diagnoses why serials and units go missing,
quantifies the exposure, and assigns an owner to every finding so nothing sits
unclaimed.

Windows app · Android app · live sync · self-hosted server

---

## It reasons, it doesn't just list

Every finding carries a **diagnosis**, the **evidence** behind it, a
**confidence** level, and **steps to take**. Severity is computed from weighted
factors, not assigned by hand, so it moves when the data moves.

### The check that changes the conclusion

Every 15-digit serial is run through the standard **Luhn check digit**.

On the loaded data, **zero of 57,354 failed**. That is not a null result — it
rules out cloned and corrupted serials, which means the duplicates are a
*process* failure, not a data-entry or counterfeiting one. You can stop
worrying about the wrong cause.

### Root cause of a duplicate comes from the gap

| Gap between dispatches | Diagnosis |
|---|---|
| Same day | Data entry / duplicate invoice |
| 1–30 days | Returned unit re-sold, original line never closed |
| 31–90 days | Slow return or late record entry |
| 90+ days | Historical backlog |

On the reference dataset, **398 of 501 duplicates resolve to unclosed returns,
not theft**.

### Detectors

| | |
|---|---|
| Duplicate serials in 2+ dealers | 501 |
| Serial in 3+ dealers | 23 |
| IMEI lock / mismatch returns | 14 |
| Returned, never dispatched | 5 |
| Return with no serial | 1 |
| TAC prefix recorded against several models | 31 |
| Serials failing the check digit | 0 |
| Repeated dealer-to-dealer flows | 45 |

### Value at risk

**Tk 1.54 Cr** across 552 findings, priced from prices actually observed on the
returns log. Models with no observed price are reported as *unpriced* rather
than silently counted as zero.

---

## Ownership, not accusation

Each finding is a reporting item with an **owner** and a status:

`open` → `investigating` → `resolved` / `dismissed`

The Ownership tab shows per-person progress and unassigned value. It answers
"who is responsible for closing this" without implying anyone did anything
wrong — because a duplicate is almost always an unclosed return.

Where a dealer shows no matched payment the app says to check name aliases
first: in this data that is nearly always a naming problem, not a collection
problem, and the largest accounts would be the ones wrongly accused.

---

## Screens

| Screen | |
|---|---|
| **Overview** | Portfolio snapshot KPIs, monthly dispatch trends, Cash-on-Delivery share, top duplicate dealers, and product class breakdown. |
| **Work Queue** | Every finding with diagnosis, confidence, score, value. Filter by status, severity, type, owner, minimum value. Export filtered results to CSV. |
| **Inspector** | Any serial → chain of custody, reasoning, evidence, action list |
| **Exposure** | Where the value sits, by severity and by root cause |
| **Flows** | Repeated dealer-to-dealer movements, grouped as one issue |
| **Dealers** | Duplicate rate as a percentage of each dealer's own stock. Export dealer directory to CSV. |
| **Ownership** | Who owes a resolution |
| **Risk** | Model risk ranking by duplicate rate, IMEI locks, and composite risk score. |

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

Needs `ANDROID_HOME` pointing at the Android SDK and a JDK on PATH:

```
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
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

### Backing up the data

`data/` is excluded from version control, so keep a copy of it somewhere else.
Run `backup-data.bat` to write a timestamped zip to `..\data-backups\` — outside
the repository, and outside anything a fresh clone or a `git clean` would touch.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/stats` | Headline numbers |
| `GET /api/findings` | The work queue — filter by status, severity, kind, owner, minValue |
| `PATCH /api/findings/:id` | Set status, owner, resolution |
| `GET /api/ownership` | Per-person rollup, unassigned total |
| `GET /api/portfolio` | Exposure by severity and root cause, plus the price book |
| `GET /api/chains` | Repeated dealer-to-dealer flows |
| `GET /api/inspect/:serial` | Full reasoning dossier for one serial |
| `GET /api/duplicates` | Duplicate serials, filterable by dealer |
| `GET /api/imei/:serial` | Dispatch trail for one serial |
| `GET /api/dealers` | Dealer list with aliases and duplicate rate |
| `GET /api/risk` | Model families ranked by risk |
| `GET /api/returns` | Return log |
| `POST /api/sync` | Re-ingest and broadcast |
| `WS /ws` | Live updates |

---

## Architecture

```
server/core.js     shared SKU + serial normalisation (also runs in the browser)
server/reason.js   inference engine — Luhn, TAC, root cause, scoring, chains
server/db.js       SQLite schema, migrations, ingest, finding generation
server/sync.js     sheet fetch + re-ingest + broadcast
server/server.js   REST API + WebSocket
web/               single-page UI, served to every client
electron/          Windows shell (runs the API in-process)
android/           Android WebView shell
```

One codebase, one API. The desktop and phone render the same UI from the same
server, which is why they stay in sync without any sync code.

Native modules are rebuilt for Electron's ABI during packaging
(`electron-rebuild`), so `better-sqlite3` loads in both development and the
packaged app.

Schema changes use additive migrations, so owner and status work already
recorded against findings survives an upgrade.

### Why the Android APK rarely changes

The phone app is a WebView shell. The UI ships from the server, so a UI change
is pushed to every connected device with no rebuild. The APK only changes when
the shell itself does.

### Android build note

The SDK location comes from the `ANDROID_HOME` environment variable. This
project deliberately does **not** use `android/local.properties` — on some
Windows and AGP combinations a perfectly valid `sdk.dir` there makes dependency
resolution fail with the misleading error:

```
Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'.
> java.io.IOException: The filename, directory name, or volume label syntax is incorrect
```

It reads like a path-length problem but is not; the build succeeds in deeply
nested folders once `local.properties` is gone. `build-apk.bat` deletes it
automatically if it finds one.

---

## Stack

Node 22+ · Express 5 · better-sqlite3 · WebSocket (`ws`) · Electron 33 ·
Android Gradle Plugin 8.7 / SDK 36 · vanilla JS frontend, no build step.

No cloud services, no telemetry, no external dependencies at runtime.