# AGENTS.md

## Project overview
FastAPI backend (`server/`) wrapping `ytmusicapi` to expose YouTube Music endpoints (browsing, search, watch, playlists, podcasts). There is **no TS app and no `index.ts`** — ignore any leftover `bun run index.ts` references. npm is the JS tooling (two lockfiles: root + `frontend/`); server-side stream-signature decryption runs through yt-dlp, which the server configures to use **Deno** (`js_runtimes` in `server/core.py`). The iOS app (`ios/`) is a **native Swift/SwiftUI app** (no webview, no Tauri) with its own XcodeGen project — see below.

## Run the server
```bash
./venv/bin/python -m server   # from repo root; Python 3.11 venv
```
- Env: `PORT` (default 8000), `BROWSER_PATH` (default `./browser.json`).
- Startup requirements: `browser.json` (live authenticated YouTube Music cookies, gitignored) and a local Redis on localhost:6379.
- Install: `./venv/bin/pip install -r server/requirements.txt`. Always use `venv/` — system `python3` is 3.14; the venv is 3.11.
- Interactive docs at `/docs`, `/redoc`.

## Architecture
- `server/core.py`: thin sync wrappers around a single global `YTMusic` client created by `init_ytm()`. The `options` dict near the top is currently **unused** — `init_ytm` calls `YTMusic(str(browser))` directly; don't assume those options are active.
- `server/routes/*.py`: FastAPI routers (browsing, search, watch, podcasts, playlists), aggregated in `server/routes/__init__.py`. All `ytmusicapi` calls are blocking and run in a shared 8-thread `ThreadPoolExecutor` (`server/state.py`) via `loop.run_in_executor`.
- Every route uses two decorators, **in this exact outer→inner order**: `@sanitized` then `@cached("<prefix>", ttl=...)`:
  - `@sanitized` (`sanitizers.py`) strips feedback/tracking tokens and streaming URLs (`googlevideo.com`, `videoplayback`) from responses. Stream URLs are intentionally never exposed through the API — don't bypass this.
  - `@cached` (`cache.py`) JSON-caches results in Redis under `yt:{prefix}:{sha256}` and silently falls back to uncached on Redis errors.
- New routes must follow the pattern: a `partial` of the sync core function run through the executor, decorated `@sanitized` above `@cached`.

## iOS app (`ios/`)
- Two XcodeGen targets from `ios/project.yml`: `Carmen` (app) + `CarmenLiveActivity` (widget extension for the lyric Live Activity). `Shared/` sources compile into both. `Carmen.xcodeproj` and the `Info.plist`s are **generated — never hand-edit**; regenerate with `cd ios && xcodegen generate`.
- Min iOS 18; every iOS 26 / Liquid Glass API is gated with `#available(iOS 26.0, *)` — use the wrappers in `ios/Carmen/Views/Glass.swift`, never call `.glassEffect` directly (and never `.clipped()` on a glass surface).
- `Player` / `SettingsStore.shared` / `LibraryStore.shared` / `DownloadsStore.shared` are the single sources of truth (`@MainActor @Observable`); views read them from the environment (the App injects all four). The API base URL defaults to `https://api-carmen-v1.syr.qzz.io` and is overridable in-app.
- Playback source chain in `Player.startCurrent`: downloaded file (`Documents/songs/<id>/audio.*`) → `carmen-cache://` URL whose `StreamResourceLoader` (`State/StreamCache.swift`) serves/fills byte ranges from `Library/Caches/streams/` (1 GB LRU) → failure. Library data (favorites/recents/local playlists/downloads/suggestions) is on-device only — the API is read-only.
- The full player is an **overlay driven by `Player.expansion`** (0 = mini bar, 1 = full; RootView slides it by 1000 pt), not a `.fullScreenCover`. Always go through `openPlayer()` / `closePlayer()`; `showNowPlaying` is `private(set)` (set only there). Drag gestures write `expansion` directly.
- Home is **fully local** (frontend parity): last-10 recents + up to 100 suggestions harvested from the first 10 of every play's `/browsing/related` — no server home sections. `Player.loadRelated` feeds both the suggestion pool and the Related panel, and `continueWithRelated()` keeps the queue going at natural end.
- Motion artwork: `/browsing/itunes-id` → `/browsing/animated-artwork` chain (`Player.motionURL`, cached); the lock screen gets it via iOS 26 `MPMediaItemAnimatedArtwork` (gated; video handler must return a **local** file URL — `State/MotionArtwork.swift`), the in-app tile via `MotionArtworkView`. Media-session artwork is always the **center-cropped square** (`Player.squareArtwork`).
- Use `Color.carmen` for the accent (Settings → Appearance, hex in `Settings.swift`), never `Color.accentColor` — it no longer matches the theme.
- No signing in `project.yml`: CI builds unsigned (`CODE_SIGNING_ALLOWED=NO`); a sideload tool re-signs the IPA. Release version = `MARKETING_VERSION` in `ios/project.yml`.
- There is **no Xcode on this machine** (CommandLineTools only): you cannot compile Swift locally. Verify with `swift format lint` (full parse), then rely on the `ios-check` job in `.github/workflows/build.yml` — it requires the iOS 26 SDK (Xcode 26+), enforced by an SDK guard.

## Gotchas
- `browser.json` contains real auth cookies / SAPISID tokens — gitignored, never commit. `test.py` and `STUFF.md` hold the same credentials and scratch notes (cookie conversion, yt-dlp commands).
- **Deno** must be on the server's PATH: yt-dlp decrypts stream-URL signatures through a JS runtime and `server/core.py` selects `deno` (`js_runtimes`) — without it, `/stream` cannot resolve URLs.
- "Taste profile" and library-scoped endpoints require the authenticated cookies in `browser.json`.
- No test suite and no pinned linter config (ruff has been run ad hoc — `.ruff_cache` exists but no config file). CI (`.github/workflows/build.yml`) = compile/build checks (`frontend`, `rust`, `server`, `ios-check`) + release bundles on tags (desktop, Android APK/AAB, unsigned iOS IPA). Verify server changes by running the server, not via JS/TS tooling.
- The installed venv can lag `requirements.txt` (e.g. `yt-dlp` is in requirements but not yet installed in `venv/`).
- Commit style follows conventional commits: `feat(core): …`, `feat(sanitizers): …` (see git log).