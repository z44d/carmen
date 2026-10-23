# Carmen for Android

Carmen is a modern music player for Android — a native fork of
[ArchiveTune](https://github.com/rukamori/ArchiveTune) by Rukamori, rebranded
and extended with the Carmen quick-picks algorithm and a no-login fallback
server. Released under the **GNU GPL v3** (see `LICENSE`; upstream copyright
headers are preserved where the GPL requires them).

## What Carmen changes from upstream

- **Carmen quick picks (`Suggested for you`)** — on Android the home screen now
  defaults to Carmen's suggestion feed: the 10 most-recent played tracks plus a
  FIFO suggestion pool (capped at the 100 newest) harvested from the first 10
  related songs of every play, reshuffled on Home refresh, with played tracks
  removed from the pool. The upstream quick-picks / last-listen modes remain
  selectable in Settings → Content.
- **No-login fallback through the Carmen server** — when the free YouTube
  Music APIs (Innertube / youtubei) fail (bot detection, region blocks, no
  session), key flows transparently retry through the Carmen server
  (`https://api-carmen-v1.syr.qzz.io`): search, search suggestions, related
  songs, radio/queue continuation (`/watch`), album / artist / playlist pages
  and even the stream itself (the server proxies audio bytes with Range
  support — real googlevideo URLs are never exposed to the client). The
  fallback can be disabled, and the server URL is editable, under
  Settings → Internet → *Carmen server fallback*.
- **Carmen branding** — `com.z44d.carmen` application id, Carmen launcher
  icon, About screen (z44d as lead developer, with an explicit
  "forked from ArchiveTune" credit for Rukamori), fastlane metadata, and
  versioning reset to 1.0.0 (code 1). Internal Kotlin packages keep the
  upstream `moe.rukamori.archivetune` namespace to stay diff-friendly with
  upstream.
- **Upstream features kept** — downloads, synced lyrics (7 providers),
  widgets, Android Auto, Discord Rich Presence, Last.fm / ListenBrainz
  scrobbling, music recognition, canvas/motion artwork, updaters, flavors
  (gms/foss × mobile/tv/automotive × abi splits).

## Building

```bash
cd android
./gradlew :app:assembleGmsMobileUniversalDebug   # compile check
./gradlew :app:assembleGmsMobileUniversalRelease :app:bundleGmsMobileUniversalRelease
```

- Requires **JDK 27** (the CI recipe uses Temurin) and an Android SDK;
  AGP auto-provisions the pinned NDK (`30.0.16248370`).
- `DataServer.txt` / `fallbackDataServerUrl` in `app/build.gradle.kts` point
  at the Carmen server used for account-less fallback data.
- GitHub-update endpoints default to `z44d/carmen`; override via the
  `GITHUB_OWNER` / `GITHUB_REPO` / `NIGHTLY_RELEASE_GITHUB_REPO` env vars or
  `local.properties`.

### Signing

Release builds sign with the committed
`app/keystore/carmen.keystore` (alias `carmen`, store/key password
`carmen-store-2026`) — the same "keystore lives in-tree" convention upstream
used for `Koiverse.jks`. CI or local overrides: set `STORE_PASSWORD`,
`KEY_ALIAS` and `KEY_PASSWORD`.

## CI

`.github/workflows/build.yml` (repo root) builds the native app with the
Gradle wrapper:

- `android-check` — `:app:assembleGmsMobileUniversalDebug` on every push/PR.
- `android` (tags / manual dispatch) — release APK + AAB
  (`assembleGmsMobileUniversalRelease` + `bundleGmsMobileUniversalRelease`),
  attached directly to the GitHub release.

## Provenance

Forked from ArchiveTune at these upstream pins (upstream tracks them as git
submodules; they are vendored here as plain directories):

| Path (in `android/`) | Upstream module | Pinned commit |
|---|---|---|
| `core/` | ArchiveTune `core` (Innertube) | `4421ab4` |
| `lyrics/` | ArchiveTune `lyrics` | `8c00f93` |
| `IconPack/` | ArchiveTune `IconPack` | `950d412` |
| `morideobfuscator/` | upstream `morideobfuscator` | `9dfc70f` |

All GPLv3 obligations are preserved: the `LICENSE` and every source-file
copyright header remain intact.
