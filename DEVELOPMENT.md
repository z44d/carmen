# Carmen — Development Guide

Carmen is a cross-platform, offline-first music player built around YouTube
Music. This guide is the single source of truth for setting up, running,
building and releasing it.

---

## 1. Project overview

Carmen is three cooperating pieces:

| Piece | Location | Technology |
|---|---|---|
| Desktop / Android shell | `src-tauri/` | Tauri v2 (Rust), identifier `com.z44d.carmen` |
| App UI | `frontend/` | React 18 + TypeScript + Vite 6 + MUI |
| Native iOS app | `ios/` | Swift + SwiftUI + ActivityKit (no webview), XcodeGen |
| Music backend | `server/` | FastAPI wrapping `ytmusicapi` + `yt-dlp` |

```text
        ┌──────────────────────────────────────────────────────────┐
        │  Tauri v2 shell — src-tauri/ (Rust)                      │
        │  identifier: com.z44d.carmen                         │
        │  · close-to-tray lifecycle + system tray (src/tray.rs)   │
        │  · commands: app_info, storage_paths, battery_status     │
        │  · plugins: fs · sql (SQLite) · opener · window-state    │
        │  · asset protocol + fs scope: $APPDATA/**                │
        │                                                          │
        │   ┌──────────────────────────────────────────────────┐   │
        │   │ WebView ── frontend/ (React + TypeScript)        │   │
        │   │ built by Vite → frontend/dist                    │   │
        │   └──────────────────────────────────────────────────┘   │
        └───────────────────────────┬──────────────────────────────┘
                                    │  HTTP JSON  (VITE_API_BASE,
                                    │  default → remote demo server,
                                    │  local → http://localhost:8000)
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  FastAPI backend — server/ (PORT, default 8000)          │
        │  routes/*.py → core.py (YTMusic client) → YouTube Music  │
        │  @cached → Redis localhost:6379                          │
        │  @sanitized → strips tracking tokens + stream URLs       │
        │  yt-dlp resolves/plays streams, caches audio on disk     │
        └──────────────────────────────────────────────────────────┘
```

### Repo layout

| Path | What it is |
|---|---|
| `package.json` (root) | Workspace-less root scripts: `dev`, `build`, `typecheck`, `icons`, `android:init` — all delegate into `frontend/` or `src-tauri/` |
| `package-lock.json` (root) | Pins `@tauri-apps/cli` (2.12.x) — this is the lockfile CI installs first |
| `frontend/` | The React app. Own `package.json` + `package-lock.json`, `vite.config.ts` (port 1420), `tsconfig.json` extends the root `tsconfig.json` |
| `frontend/src/db/` | SQLite connection (`connection.ts`) + migrations (`migrations.ts`) |
| `src-tauri/` | Rust shell: `Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `src/` (lib, tray, commands), `icons/`, `app-icon.png` |
| `src-tauri/gen/android/` | Generated Gradle project (`npx tauri android init`) — **not committed yet**, see §9 |
| `ios/` | Native iOS app (SwiftUI + widget extension): `project.yml` (XcodeGen spec), `Carmen/` (Models · API · State · Views), `CarmenLiveActivity/` (Live Activity UI), `Shared/` (ActivityKit model, compiled into **both** targets). `Carmen.xcodeproj` + `Info.plist`s are generated → gitignored, see §9 |
| `server/` | FastAPI app: `__main__.py` (app + lifespan), `core.py`, `routes/`, `cache.py`, `sanitizers.py`, `state.py` |
| `venv/` | Python **3.11** virtualenv (gitignored) |
| `browser.json` | Live YouTube Music auth cookies — **gitignored, never commit** |
| `.github/workflows/` | `build.yml` — checks + all release builds; `deploy.yml` — web-client deploys (see §10) |
| `AGENTS.md` | Agent-facing project notes (mirrors parts of this guide) |

---

## 2. Prerequisites

**Common (all platforms)**

| Tool | Version | Notes |
|---|---|---|
| Rust (rustup) | `stable` (≥ 1.77.2 per `Cargo.toml`) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js | 20+ | CI pins Node 20 |
| npm | 10+ | Two lockfiles: root + `frontend/` — install **both** |
| Python | 3.11 **inside `./venv`** | The system `python3` may be 3.14 — **never** use it; always `./venv/bin/python` / `./venv/bin/pip` |
| Deno | any recent | yt-dlp decrypts stream-URL signatures through a JS runtime and the server selects Deno (`js_runtimes` in `server/core.py`); install it server-side or `/stream` cannot resolve URLs |
| Git | any recent | Conventional commits, see §13 |

**Platform extras**

- **Linux (Debian/Ubuntu)** — Tauri system deps:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```
- **Windows** — "Desktop development with C++" Build Tools (Visual Studio), plus
  WebView2 Runtime (Windows 10 1803+ ships it; the bundle uses the
  download bootstrapper for installers). MSI builds additionally need the
  Windows "VBSCRIPT" optional feature enabled (see Tauri prerequisites).
- **macOS** — full **Xcode 26+** for the iOS app (§9): the Command Line Tools
  alone cannot build it, and the iOS 26 SDK is required to compile the
  (gated) Liquid Glass APIs. Plus XcodeGen (`brew install xcodegen`). The
  desktop shell only needs the Command Line Tools + the Rust toolchain.

**Android (only for §9)**

| Tool | Version |
|---|---|
| JDK | 17 (Temurin) |
| Android SDK | command-line tools + platform-tools + platforms + build-tools (`ANDROID_HOME` set) |
| Android NDK | side-by-side install (`NDK_HOME` or newest under `$ANDROID_HOME/ndk`) |
| Rust targets | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| Gradle | wrapper ships inside the generated project — no global install |
| — | `cargo-ndk` is **not** required: the Gradle `rust` plugin invokes the Tauri CLI, which drives cargo + the NDK linkers itself |

---

## 3. Backend setup (`server/`)

```bash
# 1. virtualenv (only once; Python 3.11!)
python3.11 -m venv venv          # or: python3 -m venv venv if python3 IS 3.11
./venv/bin/pip install -r server/requirements.txt

# 2. auth cookies — copy a fresh capture into ./browser.json (repo root).
#    It is gitignored: NEVER commit it. (test.py / STUFF.md also contain the
#    same credentials — do not commit those either.)

# 3. Redis on localhost:6379 (default connection used by server/cache.py)
brew install redis && brew services start redis      # macOS
sudo apt install redis-server && sudo systemctl start redis-server   # Linux

# 4. run (from the repo root!)
./venv/bin/python -m server
```

- **Environment variables**
  - `PORT` — default `8000`
  - `BROWSER_PATH` — default `browser.json` (relative to the working directory)
  - Optional Telegram audio cache: `API_ID`, `API_HASH`, `BOT_TOKEN`, `TG_NAME`
    (skipped with a log line when unset)
  - `DEBUG_LOGS=1` — verbose TUI logging: colored `HH:MM:SS.mss LVL logger │
    message` lines for every request (method, path, status, total ms), every
    cache hit/miss, which tier served each `/stream` (disk-cache / telegram /
    relay / download) with per-step timings, TG uploads with size + duration,
    and a startup banner with port / redis / telegram / cache state.  Off by
    default; `NO_COLOR` keeps the lines but drops the ANSI colors.
- **Docs**: interactive Swagger at `http://localhost:8000/docs`, ReDoc at `/redoc`.
- **Startup side effects** (inside the FastAPI `lifespan`, never at import time):
  initializes the `YTMusic` client from `browser.json`, creates the Redis
  client, and regenerates `server/cookies.txt` from `browser.json`.
- **CI never runs the server.** Workflows only byte-compile and import it
  (see §10); starting it would require `browser.json` and Redis secrets the
  repo deliberately does not have.
- **Caching**: every route is `@sanitized` over `@cached` — if Redis is down
  the cache silently falls back to uncached answers, but you should still run
  Redis locally; re-reading `AGENTS.md`: it is listed as a startup
  requirement and speeds everything up.
- If pip results look stale, re-run the install: the venv can lag
  `requirements.txt`.

---

## 4. Frontend web development (`frontend/`)

```bash
# one-time: install BOTH lockfiles
npm ci
npm --prefix frontend ci

# start only the Vite dev server (no Tauri shell)
npm run dev:frontend        # = npm --prefix frontend run dev → vite
```

- Dev server: **http://localhost:1420** — `vite.config.ts` sets
  `port: 1420` with `strictPort: true` and `host: true` (LAN-accessible).
  1420 is the Tauri dev default and matches `devUrl` in
  `src-tauri/tauri.conf.json`.
- **API base URL**: `frontend/src/api.ts` reads
  `import.meta.env.VITE_API_BASE`, falling back to the hosted backend
  (`https://api-carmen-v1.syr.qzz.io`) when unset. For the local backend create
  `frontend/.env.development`:
  ```bash
  echo 'VITE_API_BASE=http://localhost:8000' > frontend/.env.development
  ```
  (`.env.example` documents the variable; `.env.development` is not gitignored,
  so only commit URLs — no secrets.)
- **Routing uses `HashRouter`** (`frontend/src/App.tsx`). This is required:
  the app is also served from `tauri://` / `file://` origins where history
  routing breaks. Routes look like `http://localhost:1420/#/…`.
- Web-only features degrade outside Tauri: the SQLite layer
  (`frontend/src/db/`) reports `dbAvailable === false` when not running under
  Tauri, so library/offline features are shell-only. The same is true of
  **animated artwork** (`frontend/src/artwork/motion.ts`): Apple's `amp-api`
  is not CORS-reachable from a plain browser (it validates the `Origin`
  header), so under `vite dev` covers simply stay static. Inside Tauri those
  hops run through `tauri-plugin-http` (built with `unsafe-headers` for the
  spoofed `Origin`; the URL scope lives in `capabilities/default.json`),
  while the iTunes search and the MP4 CDN are `ACAO: *` and use the WebView's
  own fetch. The feature resolves each album at most once (URLs persisted in
  `app_state.motionUrls`, token in `app_state.motionToken`), caches the video
  under `<app data>/motion/`, and is switched off by Settings →
  *Animated artwork* or by low battery mode. It renders **only in the Now
  Playing sheet** (home/search/queue cards *and* the cover tiles stay
  static, Apple-Music style), on the surface Settings → *Animated artwork
  placement* picks: **Default** follows the device — the loop fitted over
  the whole card on desktop (video + scrim behind every piece of content),
  only behind the lyrics panel on a phone — while *Lyrics bg* / *Player
  bg* pin one of those surfaces on every device and *Cover* plays the loop
  inside the cover tile itself. Resolution
  starts only while the sheet is open, so plain listening costs no catalogue
  calls. Settings → *Blur effects* and *Artwork background* independently
  switch off the glass surfaces and the ambient artwork wash.

---

## 5. Desktop development (`src-tauri/`)

```bash
npm run dev          # = tauri dev: starts Vite (beforeDevCommand), opens the app
```

Details of what that does:

- `npm run dev` runs the Tauri CLI with `src-tauri/tauri.conf.json`, which:
  - runs `beforeDevCommand: npm run dev:frontend` (Vite on :1420),
  - points the webview at `devUrl: http://localhost:1420`,
  - hot-reloads Rust on change.
- Equivalent explicit forms: `npm run tauri -- dev` or `npx tauri dev`
  (both from the repo root; the config is picked up automatically).
- `src-tauri/tauri.conf.json` — the knobs that matter:
  - `bundle.targets: "all"`, `identifier: com.z44d.carmen`
  - `beforeBuildCommand: npm run build:frontend`, `frontendDist: ../frontend/dist`
  - `app.security.assetProtocol.enable` + scope **`$APPDATA/**`** — the
    frontend can only stream assets from inside the app data dir
  - `app.security.csp` — no remote script origins; `img:`/`media:` allow
    `https:` + the asset protocol
- **Close-to-tray contract** (documented in `src-tauri/src/lib.rs`): closing
  the main window never quits — `CloseRequested` is intercepted, the window is
  hidden and audio keeps playing. **Quit only via the tray.**
- **Tray** (`src-tauri/src/tray.rs`): left click shows/focuses the window;
  right click opens the menu — *Open Carmen*, *Play / Pause* (label kept in
  sync by the frontend through `tray://state`), *Next track* (`tray://action`
  events), *Quit Carmen* (the only path that exits the process).
- **Commands**: `app_info` (name/version/platform/arch), `storage_paths`
  (below) and `battery_status` (charge level for the low-battery auto mode —
  `supported: false` where no backend exists: Android webviews report through
  `navigator.getBattery` instead, and iOS is target-gated out entirely — the
  `battery` crate compiles its IOKit backend for `target_os = "ios"` but the
  iOS SDK doesn't export those symbols, so the archive would fail to link
  (see the Cargo.toml comment)) — everything else goes
  through the fs/sql/opener/http plugins, which are
  gated by `src-tauri/capabilities/default.json` (fs scope `$APPDATA/**`,
  opener limited to `http(s)://` URLs, http fetch scoped to Apple's
  motion-artwork endpoints — see §4).
- **Where data lives** (per platform, all under the app-data dir):

  | OS | Path |
  |---|---|
  | Windows | `%APPDATA%\com.z44d.carmen\` |
  | macOS | `~/Library/Application Support/com.z44d.carmen/` |
  | Linux | `~/.local/share/com.z44d.carmen/` (or `$XDG_DATA_HOME/…`) |

  Contents: `songs/` (one folder per downloaded track — `audio.<ext>`,
  `artwork.<ext>`, `track.json` (the `/browsing/track` payload: lyrics +
  `duration_seconds`) and, when the album has one, `motion.mp4`), `motion/`
  (the animated-cover disk cache for streamed albums), `artwork/`
  (cover art cache for OS media controls), `carmen.db`
  (SQLite, managed by `tauri-plugin-sql`). The frontend never hardcodes these
  — it calls `storage_paths` once at boot.

---

## 6. Database (SQLite via `tauri-plugin-sql`)

- Database name: `sqlite:carmen.db` (`frontend/src/db/connection.ts`) →
  `<app data>/carmen.db`. `PRAGMA foreign_keys = ON` is applied on open.
- One connection is opened during bootstrap (`frontend/src/main.tsx`) before
  React renders; migrations run at that point.
- Schema lives in **`frontend/src/db/migrations.ts`** — plain SQL entries in
  the `MIGRATIONS` array, applied in order by the runner in `connection.ts`
  and recorded in the `schema_migrations` table
  (`version`, `name`, `applied_at`).

**Tables** (migration v1): `tracks`, `downloads`, `playlists`,
`playlist_tracks`, `favorites`, `playback_state`, `feed_recent`,
`feed_suggestions`, `settings`, `app_state` — plus `schema_migrations`
created by the runner.

**Adding a migration**

1. Append a new object to `MIGRATIONS` with `version: <previous + 1>`, a
   `name`, and the `sql` for it. **Never edit an already-shipped migration** —
   the runner skips anything `<= max(version)` in `schema_migrations`.
2. Keep the SQL semicolon-free inside string literals: `splitStatements()`
   naively splits on `;` (documented in the file).
3. Run the app once and confirm the new row appears in `schema_migrations`.

---

## 7. TypeScript workflow

```bash
npm run typecheck     # = npm --prefix frontend run typecheck → tsc --noEmit
npm run build:frontend # = tsc --noEmit && vite build
```

- `frontend/tsconfig.json` extends the **root** `tsconfig.json`, which is
  `strict: true` + `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `forceConsistentCasingInFileNames`, `noEmit`, bundler module resolution.
- Deliberately relaxed for the current migration surface (see comments in the
  root tsconfig): `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax` are **off**; `allowJs` is off
  (the old JSX files are being replaced by TS).
- The root config's `include` is `frontend/src`, so the typecheck gate covers
  the app sources plus `vite.config.ts` (via the frontend config).
- Migration status is DB-side, not TS-side: query `schema_migrations` (or
  log it at boot) to see which SQL migrations are applied — see §6.
- There is no ESLint/Prettier config committed; formatting follows the
  surrounding file.

---

## 8. Building releases (desktop)

```bash
npm run build
# = npm run typecheck
#   && npm run build:frontend      (tsc + vite → frontend/dist)
#   && tauri build                 (Rust release + bundles)
```

Or stepwise:

```bash
npm run build:frontend        # frontend only (this is the CI gate)
npm run tauri -- build        # full bundle; add -- --debug for a debug bundle
npx tauri build               # equivalent, bypasses the npm script
```

- Bundles produced (`bundle.targets: "all"`):
  - **Windows**: `.msi` + NSIS `setup.exe`
  - **macOS**: `.app` + `.dmg`
  - **Linux**: `.deb`, `.rpm`, `.AppImage`
- **Icons**: `npm run icons` = `tauri icon src-tauri/app-icon.png` —
  regenerates everything under `src-tauri/icons/` (32/128/256 PNGs, `icon.icns`,
  `icon.ico`, Android mipmaps, iOS icons) from the single square source
  `src-tauri/app-icon.png`. The `bundle.icon` list in `tauri.conf.json`
  references those exact filenames.
  ⚠️ `.gitignore` contains `src-tauri/icons` — already-tracked icon files
  still show modifications, but **newly generated files need `git add -f`**.
- Code signing/notarization is **not configured yet** (no
  `TAURI_SIGNING_PRIVATE_KEY`, no Apple identity, no Windows cert) — local and
  CI bundles are unsigned (macOS gets ad-hoc signing only).

---

## 9. Mobile (Android + iOS)

Android is the Tauri shell on Gradle (§9's Android part); iOS is a
**separate native Swift app** in `ios/` — no webview, no Rust, built directly
with Xcode (see "The native iOS app" below).

### Android

**One-time setup** (see §2 for versions):

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi \
  i686-linux-android x86_64-linux-android
export ANDROID_HOME="$HOME/Android/Sdk"        # or your SDK path
export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" | sort -V | tail -1)"

npm run android:init        # = tauri android init → creates src-tauri/gen/android/
```

- `src-tauri/gen/android/` **is committed** (with the release signing config
  wired to `keystore.properties`); its `.gitignore` excludes
  `keystore.properties` and `local.properties`. CI builds from the committed
  project and only runs `npx tauri android init --ci` as a fallback if it is
  ever missing (`.github/workflows/build.yml` → `android` job).
- Init reads the app name/identifier from `src-tauri/tauri.conf.json`
  (`Carmen` / `com.z44d.carmen`).

**Signing key (Play Store upload key)**

```bash
keytool -genkey -v -keystore ~/upload-keystore.jks -keyalg RSA \
  -keysize 2048 -validity 10000 -alias upload
base64 -i ~/upload-keystore.jks            # → secret ANDROID_KEYSTORE_BASE64
# (on Linux: base64 -w0 ~/upload-keystore.jks)
```

Keep the `.jks` private and out of git.

**Wiring the keystore** — per the official Tauri docs
(<https://v2.tauri.app/distribute/sign/android/>), two things are needed in
`src-tauri/gen/android/`:

1. `keystore.properties` (gitignored):
   ```properties
   keyAlias=upload
   password=<store password>
   keyPassword=<key password, optional — defaults to password>
   storeFile=/absolute/path/to/upload-keystore.jks
   ```
2. A `release` signing config in `app/build.gradle.kts` (the generated
   template ships **without** one):
   ```kotlin
   import java.io.FileInputStream   // add at the top, next to java.util.Properties

   android {
       signingConfigs {
           create("release") {
               val keystorePropertiesFile = rootProject.file("keystore.properties")
               val keystoreProperties = Properties()
               if (keystorePropertiesFile.exists()) {
                   keystoreProperties.load(FileInputStream(keystorePropertiesFile))
               }
               keyAlias = keystoreProperties["keyAlias"] as String
               keyPassword = (keystoreProperties["keyPassword"] ?: keystoreProperties["password"]) as String
               storeFile = file(keystoreProperties["storeFile"] as String)
               storePassword = keystoreProperties["password"] as String
           }
       }
       buildTypes {
           getByName("release") {
               signingConfig = signingConfigs.getByName("release")
               // …
           }
       }
   }
   ```
   The CI workflow applies exactly this patch idempotently (it skips the step
   when `keystore.properties` is already referenced), so you only need to do
   it by hand for local release builds.

**Build**

```bash
npx tauri android build
# builds BOTH an APK and an AAB by default; be explicit if you want one:
npx tauri android build --apk               # APK only
npx tauri android build --aab               # AAB only
npx tauri android build --split-per-abi     # per-ABI APKs/AABs
```

- Release mode is the **default** — there is **no** `--release` flag
  (`--debug` opts into a debug build); passing `--release` makes the CLI
  abort with `unexpected argument '--release'`.
- `--apk` / `--aab` are **Tauri CLI flags**, not Gradle passthrough.
  Anything after a bare `--` goes to the runner/Gradle instead.
- Outputs (flavor directories from the `rust` Gradle plugin):
  - APK: `src-tauri/gen/android/app/build/outputs/apk/<flavor>/release/*.apk`
  - AAB: `src-tauri/gen/android/app/build/outputs/bundle/<flavor>Release/*.aab`
- The first build compiles Rust for four Android targets — expect minutes, not
  seconds (release uses LTO + `codegen-units = 1`).

**Deploy / test**

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
# or the debug build during development:
npx tauri android dev        # requires a device/emulator (adb devices)
```

### Opening the app from a shared link (App Links)

A copied share link (`https://<web-host>/?song=xyz`) opens the **installed
app** on Android instead of the browser, once the platform verifies the
association. Without the app — or before the placeholders below are filled
in — the link behaves exactly as before: it opens the web client, which
folds `?song=` into the player. The moving parts:

| Piece | File | Role |
|---|---|---|
| Deep-link config | `src-tauri/tauri.conf.json` → `plugins.deep-link` | Declares `https://<web-host>/*` as an App Link + a `carmen://` fallback scheme |
| Rust plugin | `src-tauri/src/lib.rs` (+ `Cargo.toml`, capability `deep-link:default`) | Delivers the opened URL to the webview |
| Frontend routing | `frontend/src/platform/deepLink.ts`, `frontend/src/utils/share.ts` (`shareTarget`) | Maps the URL onto the hash route (`/song/…`) |
| Association file | `frontend/public/.well-known/assetlinks.json` | What Google verifies — served from the web host (`try_files` in `deploy/nginx.conf` picks it up from `/var/www/carmen/.well-known/` after a normal web deploy) |

**To go live, replace the placeholders:**

1. `src-tauri/tauri.conf.json` → `plugins.deep-link.mobile[0].host`:
   swap `YOUR-WEB-HOST.example.com` with the HTTPS host the web client is
   served on (the origin share links carry).
2. `frontend/public/.well-known/assetlinks.json` → swap
   `REPLACE-WITH-RELEASE-CERT-SHA256-…` with the SHA-256 fingerprint of the
   **release signing certificate**:

   ```bash
   keytool -list -v -keystore release.jks        # the SHA256: line
   # or, for the debug keystore during development:
   ./gradlew signingReport
   # Play Store distribution: Console → Setup → App integrity →
   # "App signing key certificate" fingerprint (Play re-signs uploads)
   ```

   Rebuild + redeploy the web client so nginx serves the real file
   (`curl https://<web-host>/.well-known/assetlinks.json` must return it).
3. Rebuild the Android app — the intent filters come from the
   `plugins.deep-link` config at build time. If the checked-in manifest was
   not regenerated, add the filter by hand to
   `src-tauri/gen/android/app/src/main/AndroidManifest.xml`:

   ```xml
   <intent-filter android:autoVerify="true">
       <action android:name="android.intent.action.VIEW" />
       <category android:name="android.intent.category.DEFAULT" />
       <category android:name="android.intent.category.BROWSABLE" />
       <data android:scheme="https" android:host="YOUR-WEB-HOST.example.com" />
   </intent-filter>
   <intent-filter>
       <action android:name="android.intent.action.VIEW" />
       <category android:name="android.intent.category.DEFAULT" />
       <category android:name="android.intent.category.BROWSABLE" />
       <data android:scheme="carmen" />
   </intent-filter>
   ```

Until the fingerprint is real, Android **fails safe**: verification fails
and links keep opening in the browser.

**Testing**

```bash
# no server setup needed — the fallback scheme always works:
adb shell am start -a android.intent.action.VIEW -d 'carmen://song/ihm5-SEShb8'
# once configured, the https link itself (device must have the app installed):
adb shell am start -a android.intent.action.VIEW -d 'https://<web-host>/?song=ihm5-SEShb8'
```

Android opens verified links directly once the user has chosen "Open by
default" for the app (Settings → Apps → Carmen → Open by default), and may
ask once ("Open with Carmen") before that. The `?search=` / `?playlist=`
link shapes resolve the same way.

### The native iOS app (`ios/`)

A pure-Swift SwiftUI app (identifier `com.z44d.carmen`, iPhone-only,
portrait-only, min iOS 18): Apple Music-style UI with SF Symbols, **Liquid
Glass on iOS 26+** (every call goes through `ios/Carmen/Views/Glass.swift`,
which gates `#available(iOS 26.0, *)` and falls back to materials on
iOS 18–25), and **synced lyrics in a Live Activity** (Lock Screen + Dynamic
Island) rendered by the `CarmenLiveActivity` widget extension
(`ActivityConfiguration` UI in `ios/CarmenLiveActivity/`, data model in
`ios/Shared/` compiled into both targets).

Its feature set mirrors the web frontend: Home is a purely local feed
(recent plays + suggestions harvested from each play's related list), the
full player hosts Lyrics / Queue / Related panels plus an interactive
drag-to-expand sheet, songs can be favorited (heart) and **downloaded for
offline** (audio + artwork + lyrics per song), `/stream` responses are
disk-cached, the accent color is user-selectable (Settings → Appearance),
and Apple-catalogue **animated artwork** plays on the lock screen (iOS 26)
and in the player when available.

```bash
cd ios
xcodegen generate          # (re)generate Carmen.xcodeproj — gitignored, never hand-edit
open Carmen.xcodeproj      # pick your team under Signing to run on a device
```

- **Xcode 26+ is required** — not because the app uses iOS 26-only APIs
  (they're all gated), but because the SDK must *contain* `glassEffect` & co.
  to compile them. The CI `ios-check` job enforces this with an SDK guard.
- No signing config lives in `ios/project.yml`: CI archives with
  `CODE_SIGNING_ALLOWED=NO` (an **unsigned IPA** — sideload tools re-sign),
  local device runs use Xcode automatic signing once you pick a team.
- The app talks to the backend directly (`Settings → Server URL`, default
  `https://api-carmen-v1.syr.qzz.io`, override with e.g.
  `http://localhost:8000`). Favorites / recents / local playlists / search
  history are stored on-device (JSON in UserDefaults) — the API is read-only.
- Lyrics come from `/browsing/track/{id}`; the provider is selectable in
  Settings (Auto = the backend's chain, same as the web client).
- Without Xcode, the strongest local check is
  `swift format lint` (it fully parses every file); the real compile check is
  the `ios-check` CI job (§10).

### Portrait-only orientation (mobile builds)

The phone builds never rotate:

- **Android** — `android:screenOrientation="portrait"` on the main activity
  in `src-tauri/gen/android/app/src/main/AndroidManifest.xml` (committed, so
  CI needs nothing extra).
- **iOS** — declared in `ios/project.yml`
  (`UISupportedInterfaceOrientations` → portrait only) and therefore baked
  into every generated `Info.plist`; no CI patch step is needed.

---

## 10. CI/CD (GitHub Actions)

One workflow — `.github/workflows/build.yml` ("Build and Release") —
consolidates what used to be three files (`ci.yml`, `build-desktop.yml`,
`build-android.yml`):

| Job | Runs | What it does |
|---|---|---|
| `frontend` | push to `master`, PRs, tags `v*`, `workflow_dispatch` | `npm ci` (both lockfiles) → `npm run typecheck` → `npm run build:frontend` |
| `rust` | ″ | Linux webkit deps → `cargo check` in `src-tauri` |
| `server` | ″ | Fresh Py3.11 venv → `pip install -r server/requirements.txt` → `python -m compileall server` → `import server.__main__`. **Never starts the server** — the import is safe because `YTMusic`/Redis/browser.json are all created inside the FastAPI `lifespan`, which a plain import never runs |
| `desktop` (matrix) | tags `v*` + `workflow_dispatch`, needs all 3 checks | 4 entries: **macOS universal dmg** (`macos-latest`), **Linux deb + rpm + AppImage** (`ubuntu-latest`; the `rpm` apt package provides `rpmbuild`), **Windows x86_64 NSIS** + **Windows aarch64 NSIS** (`windows-latest`, native MSVC — VS2022 ships the ARM64 cross tools; `cargo-xwin` was dropped because its clang-cl `/imsvc` flags break ring's C build). Each entry: Node 20 + Rust stable + rust-cache → `npm ci` (both lockfiles) → `npm run icons` → `npx tauri build --ci --bundles …` |
| `android` | tags `v*` + `workflow_dispatch`, needs all 3 checks | Ubuntu + Temurin JDK 17 + the **preinstalled** Android SDK (a pinned NDK is installed via the runner's own `sdkmanager` — `android-actions/setup-android@v3` was dropped after it broke on cmdline-tools 16 by trying to install the removed `tools` package) + Rust Android targets: builds the committed `src-tauri/gen/android`, decodes the keystore + writes `keystore.properties` **when secrets exist** (otherwise builds unsigned), runs `npx tauri android build --ci --apk --aab` |
| `ios-check` | push to `master`, PRs, tags `v*`, `workflow_dispatch` | Compile check for the **native iOS app**: macOS + `maxim-lobanov/setup-xcode@v1` (`latest-stable`) → iOS SDK **≥ 26 guard** (the gated Liquid Glass symbols must exist in the SDK) → `xcodegen generate` → `xcodebuild build` for `generic/platform=iOS Simulator` with `CODE_SIGNING_ALLOWED=NO`. The `Carmen` scheme builds the app **and** the embedded `CarmenLiveActivity` widget extension, so every Swift file is compiled |
| `ios` | tags `v*` + `workflow_dispatch`, needs all 4 checks | Same Xcode setup + guard + `xcodegen generate`, then an unsigned Release **archive** (`generic/platform=iOS`, `CODE_SIGNING_ALLOWED=NO`) → the `.app` is copied into `Payload/` and zipped to `ios/build/Carmen.ipa` by hand (no `-exportArchive`, which would demand signing settings) → attached to the release. Pure Xcode — no Node, Rust or Tauri involved |

Release uploads happen **inside each build job** via
`softprops/action-gh-release@v2` — deliberately **no
`actions/upload-artifact`/`download-artifact` round-trip** (GitHub's artifact
size ceiling). Jobs may all touch the same tag's release without a
coordinating `release` job: when creation races, the action reuses the
release that already exists. `fail_on_unmatched_files: true` guards against
silently shipping a release with missing bundles. Every upload also writes
the same custom release body (`env.RELEASE_BODY` in the workflow);
`generate_release_notes` is deliberately unused because GitHub's generated
text always appends a "Full Changelog:" compare link.

Common properties: `workflow_dispatch` runs the builds **without** tagging
(handy for smoke-testing the Windows/Android steps), `defaults.run.shell:
bash` everywhere (PowerShell is the default shell on `windows-latest` and
breaks bash snippets), pinned major action versions (`checkout@v4`,
`setup-node@v4`, `setup-java@v4`, `setup-python@v5`,
`dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`,
`maxim-lobanov/setup-xcode@v1`,
`softprops/action-gh-release@v2`), a `concurrency` group per workflow/ref
that cancels superseded runs, and `permissions: contents: write` **only** on
the three bundle jobs (`desktop`, `android`, `ios`) — everything else is
`contents: read`.

Both lockfiles (`package-lock.json` + `frontend/package-lock.json`) are
tracked, so every CI install is strict `npm ci`.

**Release flow**: bump versions (`package.json` + `src-tauri/tauri.conf.json`
+ `Cargo.toml`) → commit → `git tag v1.2.0 && git push origin v1.2.0` →
checks run, then the builds → the GitHub Release is created/updated with the
desktop bundles (dmg, NSIS exe ×2, deb, rpm, AppImage), the Android
APK/AAB and the unsigned iOS IPA (`ios/build/Carmen.ipa`, whose version comes
from `MARKETING_VERSION` in `ios/project.yml`),
and `deploy.yml` republishes the web client to the `pages` branch
(GitHub Pages production). If a tag build already ran, delete the tag (and
its release) before re-pushing it:
`git push origin :refs/tags/v1.2.0 && git tag -d v1.2.0`.

**Required GitHub secrets**

| Secret | Required for | Notes |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | signed Android builds | `base64 -w0 upload-keystore.jks` (Linux) / `base64 -i …` (macOS). When unset the Android job **builds unsigned** and says so via a notice |
| `ANDROID_KEYSTORE_PASSWORD` | ″ | keystore (`-storepass`) password → `password=` in `keystore.properties` |
| `ANDROID_KEYSTORE_ALIAS` | ″ | keytool alias (`upload`) → `keyAlias=` |
| `ANDROID_KEY_PASSWORD` | optional | `-keypass`; falls back to the store password when omitted |
| `GITHUB_TOKEN` | releases | Provided automatically by Actions; the release jobs declare `permissions: contents: write` for it |

No secrets are needed for the check jobs or for the desktop bundles
(unsigned). There is no test suite in CI — see §11.

### Web deployments (`deploy.yml`)

A second workflow — `.github/workflows/deploy.yml` — publishes the static web
client (`frontend/` only; the API is deployed separately):

| Job | Runs | What it does |
|---|---|---|
| `dev` | every push to `master` (any commit) + `workflow_dispatch` | `npm run build:frontend` (root base; `VITE_API_BASE` falls back to the production API) → `rsync -az --delete frontend/dist/ $DEPLOY_HOST:$DEPLOY_PATH/` over SSH. nginx serves the result per `deploy/nginx.conf` |
| `production` | tags `v*` | Same build with `VITE_BASE=./` → relative asset URLs, so the bundle works both under Pages' `/<repo>/` sub-path and at a custom-domain root. `dist` (plus a `.nojekyll`) is force-pushed as a single orphan commit to the **`pages` branch**. One-time setup: repo Settings → Pages → "Deploy from a branch" → `pages` / root — every tag then updates the site |

Deployment secrets (Settings → Secrets and variables → Actions):

| Secret | Required for | Notes |
|---|---|---|
| `DEPLOY_HOST` | dev deploys | Server IP; use `user@ip` when the key's SSH user differs from the default |
| `DEPLOY_SSH_KEY` | ″ | Full unencrypted private key (PEM); `BatchMode` never hangs on a passphrase prompt |
| `DEPLOY_PATH` | ″ | Absolute site dir on the server, e.g. `/var/www/carmen` — must be the document root, rsync `--delete` mirrors it |
| `DEPLOY_PORT` | optional | SSH port, defaults to 22 |

Gotchas: attaching a **custom domain** to Pages? Add a `CNAME` file to
`frontend/public/` — it ships in every build, and the force-push would
otherwise drop it. Share links (`/?song=…`) work on any host (the SPA folds
the query into a hash route), but the crawler-facing Open Graph preview only
renders on the nginx copy — Pages answers `/?song=…` with the plain shell.

---

## 11. Testing policy

- **No E2E/browser test tooling** — no Playwright/Selenium/Cypress anywhere,
  and none may be added as part of the current work. The webview shell cannot
  be meaningfully driven by those tools anyway.
- **No unit-test runner** is wired up yet (`frontend` has no `test` script;
  server has no pytest suite). ruff has been run ad hoc on `server/` but there
  is no pinned config.
- **Verification = the CI gates + a manual smoke pass:**
  ```bash
  npm run typecheck            # 0 errors
  npm run build:frontend       # vite build succeeds → frontend/dist
  cd src-tauri && cargo check  # Rust compiles
  ./venv/bin/python -m compileall server && ./venv/bin/python -c "import server.__main__"
  ```
  then, for anything touching runtime behaviour, run the app and check:
  - [ ] close the window → tray icon → audio keeps playing → *Open Carmen* returns to the same route
  - [ ] restart the app → queue + position restored (`playback_state`), press play resumes
  - [ ] download a song → plays offline (airplane mode), artwork/title from local files
  - [ ] create/add/favorite a playlist → survives restart (`playlists`/`playlist_tracks`/`favorites`)
  - [ ] a lyrics-provider setting persists and changes the lyrics source
  - [ ] battery under 20% **unplugged** → low battery mode turns itself on
        (white accent, no blur, Settings status line says *On automatically*)
        → plug in → effects return; the manual toggle survives restart
  - [ ] animated artwork: **only** the Now Playing sheet animates —
        desktop: the loop covers the whole card (fitted + scrimmed, cover
        tiles static); phone: only the lyrics page animates (home / search
        / queue cards static); static cover shows first — never a
        blank tile; Settings → *Animated artwork* off **or** low battery mode
        on → static again; download such a song → `motion.mp4` next to the
        audio, plays in airplane mode; stream it once →
        `<app data>/motion/<key>.mp4` exists and the cover animates after a
        restart with no network
  - [ ] Settings → *Blur effects* off → no backdrop blur / glows app-wide;
        *Artwork background* off → plain theme background (both persist);
        *Accent color* → **White** → light mode stays readable (labels and
        line art fall back to the text colour)
  - [ ] Android: the "Carmen" header clears the status bar with **exactly
        one** safe-area pad (WebView ≥ M136 on the device — older ones
        report 0px and stay flush), the bottom nav sits above the gesture
        bar, and in the full-screen player the handle strip — not the close
        row — is what clears the status bar (close/transport must not be
        pushed a second time)
  - [ ] Android: play a track → the media notification appears (shade +
        quick-settings card + lock screen) with cover, title/artist and
        working ⏮ ⏯ ⏭; tapping it returns to the app. *Allow
        notifications* when the app asks on first play — Android 13+
        hides the card otherwise
  - [ ] Android: audio keeps playing after screen lock (switch the screen
        off a few seconds into a song, wait, unlock — the playhead moved)
        and back-press **while a track is loaded** only backgrounds the app
        (notification keeps working); back with nothing loaded still exits

### Known Android WebView gaps (as of 2026-10)

- **`navigator.mediaSession` itself is still missing.** The Android System
  WebView (Blink, the engine behind Tauri Android) has never shipped it;
  Chromium's trackers (`issues.chromium.org` 40765779 / 40540400) are still
  open and w3c/mediasession#337 was closed as "venue mismatch". The Web hook
  (`frontend/src/services/mediaSession`) still registers it defensively — it
  simply no-ops on Android.
- **The shade / lock screen works through a native media3 bridge instead.**
  Playback stays in the WebView (it is the only side that ever sees stream
  URLs — they stay hidden, `server/sanitizers.py`); the card is fed over the
  in-app Tauri **`media` plugin**, following the deep-link plugin's pattern
  (`register_android_plugin` + `run_mobile_plugin` + `Channel`):
  - `frontend/src/platform/androidMedia.ts` — `updateNativeMediaSession(...)`
    invokes `plugin:media|update_media_metadata` /
    `update_playback_state` (track facts + transport in one call, seconds)
    and listens for `media-control:<action>` events (`play`, `pause`,
    `toggle`, `next`, `previous`, `seek`, `stop`, `sync`); a `sync` replays
    the last payload. `useMediaSession` (§1 + §6) drives it — including the
    lock-screen lyric line on the artist slot — and routes buttons into the
    same handlers the Web Media Session uses. Everything is best-effort: no
    Tauri, no pushes.
  - `src-tauri/src/media.rs` + `src-tauri/build.rs` (`InlinedPlugin`) +
    `capabilities/default.json` (`media:default`) — the Rust half: two
    commands forwarded to Kotlin, and a `Channel` that re-emits every
    Kotlin-side button as a `media-control:*` event. On desktop the commands
    are registered but no-op (the Web API owns those platforms).
  - `gen/android/…/media/MediaPlugin.kt` — the Kotlin `@Command` half of the
    plugin; pure IPC into `MediaBridge`.
  - `gen/android/…/media/MediaBridge.kt` — the state hub: marshals pushes
    onto the main thread, caches the last state, starts/stops the service,
    asks for `POST_NOTIFICATIONS` on first play (Android 13+), and patches
    play/pause optimistically before the page echoes back.
  - `gen/android/…/media/PlaybackService.kt` — a media3
    **`MediaSessionService`** (`androidx.media3:media3-session`): the
    session's `Player` is `WebViewPlayer`, a `SimpleBasePlayer` that owns no
    media — every state push becomes a fresh `State`, every system button
    routes back into the page. The notification / quick-settings card /
    lock-screen card (channel, actions, artwork decoding) are built by
    media3's `DefaultMediaNotificationProvider`; covers travel as raw bytes
    (`MediaMetadata.setArtworkData`, remote URL or a downloaded song's
    `data:` URL) fetched off the main thread. The manifest declares the
    service `exported` with the `androidx.media3.session.MediaSessionService`
    intent-filter (media3's documented configuration). Back-press with a
    track loaded backgrounds the app (`MainActivity`), keeping the WebView —
    and therefore the audio — alive.
- `AGENTS.md` still holds: verify changes by **running the server**, not via
  JS/TS tooling, when the change is server-side.

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Stream URLs fail, ytmusicapi/yt-dlp errors about a JS runtime | **Bun too new** — must be **≤ 1.3.14** (`bun --version`; downgrade with `bun install -g bun@1.3.11`). Note `server/core.py` `streaming_options` also prefers `deno` as a `js_runtimes` entry |
| `redis.exceptions.ConnectionError`, cache never hits | **Redis not running** — start it on `localhost:6379`. Routes still answer (the `@cached` decorator falls back to uncached), but everything re-fetches |
| 401s / empty taste profile / `browser.json` load errors | **Stale `browser.json` cookies** — recapture the YouTube Music cookies from a logged-in browser (see `STUFF.md` for the conversion notes; never commit it) |
| `cargo` network timeouts, `error: failed to fetch` | crates.io flakiness — retry, or `export CARGO_HTTP_TIMEOUT=120 CARGO_NET_RETRY=5`; CI uses `Swatinem/rust-cache@v2`, locally just re-run. Sparse-index hiccups clear on re-run |
| Linux: `webkit2gtk-4.1 not found`, `libayatana-appindicator` errors | Install the apt package list from §2 — required for **both** `tauri dev` and `cargo check` |
| Windows: blank window / "WebView2 required" | Install the WebView2 Runtime (evergreen bootstrapper); VS Build Tools needed to compile |
| Animated artwork never appears (Tauri build) | Check the `motion` console warnings: the first run scrapes Apple's ~3 MB web bundle for a ~60-day token (slow network → timeout, retry); `amp-api` 401s mean the `unsafe-headers` feature (`Cargo.toml`) or the `http:allow-fetch` scope (`capabilities/default.json`) went missing; plenty of albums simply have **no** Apple motion artwork and stay static by design. Under plain `vite dev` it is always static (no CORS path to `amp-api`) |
| macOS: `xcrun: error: invalid active developer path` | `xcode-select --install` |
| `vite errored ... port 1420 in use` / `strictPort` failure | Port **1420** is taken — kill the previous `npm run dev`/`tauri dev`, or another dev server. `strictPort: true` makes Vite refuse to move ports because `devUrl` expects 1420 |
| `asset protocol ... not allowed` / `fs ... not authorized`, artwork/audio fails to load | The file is outside the **`$APPDATA/**` scope** (`tauri.conf.json` → `assetProtocol.scope`, `capabilities/default.json` → `fs:scope`). Move data under the app-data dir or extend the scope deliberately (it is a security boundary) |
| `npm run build` unexpectedly takes forever / runs `tauri build` | Root `build` = `typecheck && build:frontend && tauri build`. Use `npm run build:frontend` for the web bundle alone |
| Android: `Failed to find package "ndk;…"` or `NDK not found` | Install the NDK via SDK Manager and export `NDK_HOME` (§9); CI pins one in the workflow |
| Android: CI signing step fails / build stays unsigned | `keystore.properties` is written from the `ANDROID_KEYSTORE_*` secrets; without `ANDROID_KEYSTORE_BASE64` the job **builds unsigned on purpose** (a job notice says so). The `signingConfigs` block itself lives in the committed `gen/android/app/build.gradle.kts` — nothing is patched at CI time anymore |
| `permission denied` writing `server/cookies.txt` | Server startup regenerates it from `browser.json`; run from the repo root with write access |
| Ruff/PyYAML noise | `.ruff_cache` exists from ad-hoc runs; there is no pinned linter config to satisfy |

---

## 13. Commits & contribution checklist

Commit style follows **Conventional Commits** (see `git log`):

```text
feat(core): richer track payload with lyrics provider
fix(stream): stamp CORS headers so a cached song still downloads
refactor(QueuePage): reorder imports and simplify now playing text
docs(plan): add task 4b for native platform shell generation
ci(android): signed release apk and aab with keystore secrets
chore: …
```

Format: `type(scope): lowercase summary` — scopes used so far include
`core`, `sanitizers`, `stream`, `server`, `frontend`, `player`, `lyrics`,
`theme`, `downloads`, `android`, `plan`. `ci:` and `chore:` for workflow /
tooling changes.

**Before you commit**

1. `git status` — never stage `browser.json`, `venv/`, `test.py`,
   `server/.audio_cache/`, `*.jks`, `keystore.properties` (all gitignored;
   double-check anyway).
2. `npm run typecheck` → 0 errors.
3. `npm run build:frontend` → succeeds (or full `npm run build` if you changed
   Rust/config too; `cargo check -p`-style checks live in `src-tauri`).
4. Server change? `./venv/bin/python -m compileall server` +
   `./venv/bin/python -c "import server.__main__"` and a manual smoke run
   (`./venv/bin/python -m server` with Redis + `browser.json`).
5. Follow the **read-only boundaries** documented in `AGENTS.md` when working
   in parallel (frontend migration work must not touch `server/`,
   `src-tauri/`, or the root configs unless that is the task).
6. `git add <files> && git commit -m "type(scope): summary"` — do not push
   unless you intend to trigger `build.yml`.
