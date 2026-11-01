<!--
  Release body — the "what's new" section, appended by build.yml to the
  standard Downloads table (env RELEASE_BODY) on every tagged release.
  Update this file as the release takes shape; the tag names the version.
-->

### What's new

**Spotify import — web, iPhone and Android**

Paste a Spotify playlist link and Carmen turns it into a YouTube Music
playlist. Every track is matched live — matched / approximate / not-found
counts stream in as the conversion runs — then you pick which matches to
save and the playlist lands in your library. Found in the playlists section
of the Library on each platform (web, Android and iPhone). Matching runs on
your own server, so self-hosters get it too.

**iOS**

The iPhone app was rebuilt as a Material 3 twin of the Android app:

- **One design language across platforms**: Poppins type scale, the shared
  component kit (top app bars, cards, chips, shimmers, sheets, buttons) and
  theme colours derived from each song's own artwork.
- **A floating pill shell**: Home / Search / Library sit behind one
  Android-style nav bar with the mini player stacked on top of it as a
  single blob; Settings opens from the ⋯ menu instead of a fourth tab, and
  the old Queue tab moved into the player as a swipeable Queue panel.
- Still on board from the previous release: related / lyrics / queue panels
  inside the player, offline downloads, motion artwork on the lock screen
  (iOS 26), fully local Home, favourites everywhere and the adaptive accent
  colour (Settings → Appearance).

**Web**

- **A new landing page** at `/intro` introducing Carmen with the right
  download link for your OS — macOS, Windows, Linux, Android and iPhone.

**Server**

- **No duplicated downloads**: while a song streams its bytes are teed into
  the audio cache in the background (and two writers can never leave two
  copies behind), so a track is fetched once and replayed from disk.
- **Failing tracks fail fast**: a video every player client refused used to
  re-run the whole extraction + download ladder on every retry — one broken
  id burned 705 extractions and 259 download attempts in a day. It is now
  memoized for a few minutes and answered instantly, and a full download no
  longer repeats extractions a relay attempt already failed.
- **Cruft swept**: half-written `.part` files left behind by a crashed or
  restarted process are cleaned up automatically instead of sitting in the
  cache looking like duplicate songs.
