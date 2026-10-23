# 🎧 Carmen

![Tauri](https://img.shields.io/badge/shell-Tauri_v2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/client-React_18-61DAFB?logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/server-FastAPI-009688?logo=fastapi&logoColor=white)
![Tailwind](https://img.shields.io/badge/styling-Tailwind_CSS-06B6D4?logo=tailwindcss&logoColor=white)

**An offline-first, cross-platform music player for YouTube Music.**
Stream anything, download it in one tap, and keep playing when the network
doesn't — with synced lyrics, lock-screen controls, and artwork that never
goes blurry.

Carmen ships as a native desktop app (**Tauri v2** — macOS, Windows, Linux)
and as a **web app** you can add to your home screen on iOS. Both talk to a
tiny **FastAPI** backend that wraps YouTube Music, caches what it can
(Redis + Telegram + disk), and never leaks upstream stream URLs.

---

## ✨ Features

- **Play anything** — search, browse, home feeds, playlists and podcasts
  straight from YouTube Music.
- **One-tap downloads** — audio + high-res cover + synced lyrics (+ the
  animated cover when the album has one) live in the app's own sandbox.
  Downloads play from disk first and need zero network.
- **A streaming ladder that just starts** — disk copy → Telegram-cached
  copy → live relay, with size-verified integrity checks and a background
  backfill so the cache heals itself.
- **Lyrics that follow the song** — line-by-line synced karaoke when the
  lyrics exist, plain scrolling text otherwise.
- **Proper media integration** — media keys, lock screen / notification
  controls and the OS's own artwork (the downloaded cover, not a 480p
  thumbnail), everywhere.
- **A UI that reads the room** — ambient background tinted from the cover,
  dark/light themes, motion artwork where albums have it.
- **Spotify import** — paste any public Spotify playlist link and Carmen
  fetches every song, finds its twin on YouTube Music (title + artist
  matching with a confidence score), and saves the winners as a normal
  library playlist. Works with zero setup; a Spotify app (see below)
  makes it faster and more reliable.
- **Degrades quietly** — no Redis? Uncached. No Telegram? Streams anyway.
  No network? Your downloads still play.

## 🏗 Architecture

```
 ┌──────────────────────────────┐        ┌──────────────────────────────────┐
 │  Client (React + TypeScript) │  HTTPS │  Server (FastAPI + ytmusicapi)   │
 │  ├─ Tauri v2 desktop shell   │ ─────▶ │  ├─ Redis     · response cache   │
 │  └─ web app (iOS home screen)│  JSON  │  ├─ Telegram  · song cache       │
 │                              │ +audio │  └─ disk      · stream cache     │
 │  offline files in the app    │ ranges │                                  │
 │  sandbox (or IndexedDB)      │ ◀───── │  /stream proxies the audio —     │
 └──────────────────────────────┘        │  upstream URLs never leave       │
                                        └──────────────────────────────────┘
```

| Path         | What lives there                                                   |
| ------------ | ------------------------------------------------------------------ |
| `frontend/`  | React client — Vite build → a static `dist/` (works in any browser, and is the whole desktop app). |
| `server/`    | The FastAPI app — browsing / search / watch / playlists / podcasts over `ytmusicapi`. |
| `src-tauri/` | The Tauri v2 shell (Rust) — asset protocol, sandboxed file system, SQL, bundling. |
| `DEVELOPMENT.md` | The deep dive: layout, offline model, theming, media session, gotchas. |

## 🚀 Quick start (development)

You need **Node 18+** and, for the desktop app, a **Rust toolchain**. The
server is optional in dev — the client boots against the public demo API and
you can point it anywhere from *Settings → Server URL*.

```bash
git clone https://github.com/z44d/carmen.git && cd carmen
npm install

npm run dev           # desktop app (Tauri dev, hot reload)
npm run dev:frontend  # web client only → http://localhost:1420
```

Running your **own server** (see below for the full production story):

```bash
python3.11 -m venv venv
./venv/bin/pip install -r server/requirements.txt
cp /path/to/your/browser.json .        # authenticated YT Music cookies — never commit it
./venv/bin/python -m server            # from the repo root → http://localhost:8000/docs
```

## 📦 Deploying to production

Three independent pieces — deploy any subset.

### 1 · The server

**Requirements:** Python 3.11, Redis,
[Deno](https://docs.deno.com) (yt-dlp decrypts stream-URL signatures through
a JS runtime and the server selects Deno — `js_runtimes` in
`server/core.py`), and a `browser.json` holding live YouTube Music cookies.

```bash
git clone https://github.com/z44d/carmen.git /opt/carmen && cd /opt/carmen
python3.11 -m venv venv
./venv/bin/pip install -r server/requirements.txt
```

Configuration is environment-only (a `.env` in the working directory is
loaded automatically):

| Variable     | Default        | What it does                                                        |
| ------------ | -------------- | ------------------------------------------------------------------- |
| `PORT`       | `8000`         | Port uvicorn binds to (`0.0.0.0`).                                  |
| `BROWSER_PATH` | `browser.json` | The authenticated cookies file the API boots with.                 |
| `API_ID`     | –              | Telegram `api_id` (optional — enables the song cache).              |
| `API_HASH`   | –              | Telegram `api_hash` (optional).                                     |
| `BOT_TOKEN`  | –              | Bot token used to mirror songs into Telegram (optional).            |
| `CHAT_ID`    | –              | Telegram chat that stores the cached songs (optional).              |
| `TG_NAME`    | `ytmusic_cache` | Telegram session name.                                             |
| `SPOTIFY_CLIENT_ID` | –        | Spotify app client id (optional — faster, more reliable Spotify import). |
| `SPOTIFY_CLIENT_SECRET` | –    | Spotify app client secret (optional — faster, more reliable Spotify import). |
| `DEBUG_LOGS` | off            | `1` → colored per-request logs, stream-tier traces, startup banner. |

Then run it under any supervisor — e.g. systemd:

```ini
# /etc/systemd/system/carmen.service
[Unit]
Description=Carmen API
After=network.target redis.service

[Service]
WorkingDirectory=/opt/carmen
EnvironmentFile=/opt/carmen/.env
ExecStart=/opt/carmen/venv/bin/python -m server
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Put TLS in front of it — the web client needs HTTPS, and audio range
requests benefit from a real proxy. With Caddy that's two lines:

```caddyfile
api.carmen.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Notes:

- Redis is expected on `localhost:6379` (default client). If it's down the
  API keeps serving — every response is simply uncached.
- Without the Telegram variables, songs still stream; the instant cache is
  just skipped.
- `browser.json` must contain a fresh `cookie` field from an authenticated
  youtube.com/music session — rotate it when search starts failing.
- Interactive API docs ship at `/docs` and `/redoc`.

### 2 · The frontend

The web app is a pile of static files. The API base URL is **baked at build
time** (it defaults to the public demo server):

```bash
cd frontend
VITE_API_BASE=https://api.carmen.example.com npm run build   # → dist/
```

Ship `dist/` on any static host — nginx, Caddy, Cloudflare Pages, GitHub
Pages. For nginx the repo ships a ready-made vhost,
[`deploy/nginx.conf`](deploy/nginx.conf), that serves the build on
**port 5432** with the caching rules baked in (`index.html` revalidated,
content-hashed `/assets/*` kept forever). To start it:

```bash
sudo mkdir -p /var/www/carmen
sudo cp -r frontend/dist/. /var/www/carmen/
sudo cp deploy/nginx.conf /etc/nginx/conf.d/carmen.conf

sudo nginx -t                        # config sanity check
sudo systemctl enable --now nginx    # first start (already running? reload)
```

Then open `http://<host>:5432`.

> **Link previews (Open Graph):** the shipped nginx vhost routes the exact
> path `/` through the API (`location = /` → `proxy_pass` to the API) so a
> shared song or search link (`/?song=…`, `/?search=…`) comes back with real
> title/artwork/description tags for Telegram and Discord. That block expects
> the API to listen on `http://127.0.0.1:8000` on the same host — edit the
> `proxy_pass` URL if yours differs, or drop the block to serve the static
> shell (the app works either way, just without rich previews).

The same two rules apply wherever else you host it:

- `index.html` → no cache; `/assets/*` (content-hashed) → cache forever.
- **HTTPS is required** on iOS for *Add to Home Screen* (the app runs
  full-screen standalone) and for the browser's persistent storage — the
  shipped config is plain HTTP on 5432, so put a TLS terminator in front
  for home-screen installs.

CORS is already open on the API (`*`), so any origin works. Users can still
repoint the app at another server from *Settings → Server URL* — it overrides
the build-time base per request, no rebuild needed.

### 3 · The desktop app

```bash
npm install
npm run build     # typecheck → frontend build → tauri build
```

Installers land in `src-tauri/target/release/bundle/` — `.app`/`.dmg` (macOS),
`.msi`/`.exe` (Windows), `.deb`/`.AppImage` (Linux). Code signing and
notarization are configured through Tauri's standard `APPLE_*` /
signing-secret environment variables.

> **macOS: "Carmen" couldn't be opened?**
> Gatekeeper blocks apps downloaded from the internet that aren't
> notarized. If macOS refuses to open the app, run this once in Terminal
> and open Carmen normally afterwards:
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/Carmen.app
> ```

## 💾 Data & storage

Downloads live in the app's own data directory (identifier
`com.z44d.carmen`):

| OS      | Path                                                              |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/com.z44d.carmen/`                  |
| Windows | `%APPDATA%\com.z44d.carmen\`                                      |
| Linux   | `~/.local/share/com.z44d.carmen/`                                 |
| Web     | the browser's own storage (IndexedDB) — nothing touches your files |

```
songs/<videoId>/
├── audio.m4a        # the stream, stored verbatim
├── artwork.jpg      # best available cover (maxresdefault when it exists)
├── track.json       # /browsing/track payload: lyrics + duration_seconds
└── motion.mp4       # animated cover, when the album has one
```

## 🧠 Worth knowing

- **Spotify import needs no setup** — paste a public playlist link and it
  just works: without credentials the server reads Spotify's public
  playlist page directly. For busier servers, create a (free) app at
  [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard),
  put its client id/secret in `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`,
  and restart — the official API is then used instead (full pagination,
  higher rate limits). Either way only **public** playlists can be read
  (private ones answer 404 — that's a Spotify limitation, not a bug).
  The API exposes
  `GET /convert/spotify/playlist?url=…` (preview) and
  `POST /convert/spotify/to-ytmusic` (server-sent-event stream: `start`,
  one `progress` per track, `done`), and the Library's *Import from
  Spotify* button drives the whole flow.
- **Deno powers stream decryption** — yt-dlp runs the player's signature
  script through a JS runtime; the server configures Deno (`js_runtimes` in
  `server/core.py`), so it must be on the server's PATH.
- **No stream URLs ever leave the API** — responses are sanitized
  (tracking tokens stripped) and audio is proxied, Range-aware, through
  `/stream`.
- The web and desktop clients share one codebase; the shell decides the
  storage backend (sandbox files vs. IndexedDB).
- **Animated covers resolve in two calls** — the client maps the album to its
  iTunes collection id via the public iTunes Search API (session-cached);
  Safari (iOS *and* macOS) skips that call entirely — the browser redirects
  `itunes.apple.com` to a non-CORS `musics://` scheme, so the fetch can never
  succeed — and every other client falls back server-side when it fails:
  `GET /browsing/itunes-id/{albumBrowseId}` (or
  `GET /browsing/itunes-id?term=…&entity=album|song` when the track carries
  no browse id) does the same "Album - Artist" lookup through CoverPy, cached
  a week under the album's YouTube Music browse id ("no match" cached a day).
  The resulting id feeds
  `GET /browsing/animated-artwork/{collectionId}`, which returns a direct MP4
  URL (cached a week; a rate-limited lookup answers `null`, deliberately
  uncached so it retries).

## 📚 More

`DEVELOPMENT.md` covers the architecture in depth — offline model, theming,
media session, animations, and the full gotcha list.
