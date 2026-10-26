import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';

import cinematicScreenshot from '../../../../screenshots/cinematic-mode.webp';
import webClientScreenshot from '../../../../screenshots/web-client.webp';
import portraitScreenshot from '../../../../screenshots/portrait-view.webp';
import androidHomeScreenshot from '../../../../screenshots/android-client-homepage.jpg';
import androidLyricsScreenshot from '../../../../screenshots/android-client-player-lyrics.jpg';
import menuBarScreenshot from '../../../../screenshots/media-session-lyrics-in-menu-bar.png';
import { DownloadIcon, GitHubIcon, MusicNoteIcon } from '../../components/icons';
import type { SvgIconProps } from '../../components/SvgIcon';
import { RELEASES_PAGE } from '../../services/updateCheck';
import { cn } from '../../utils/cn';
import { AndroidIcon, AppleIcon, GlobeIcon, LinuxIcon, WindowsIcon } from './OsIcons';
import {
  detectOs,
  FALLBACK_RELEASE,
  fetchLatestRelease,
  OS_ORDER,
  type LatestRelease,
  type OsId,
} from './platform';

/**
 * `/intro` — the public landing page.
 *
 * Deliberately **outside `<Layout/>`**: it is a shareable download page, so
 * it carries no player shell or app navigation and owns its own scroller
 * (the root is `overflow: hidden` — see styles.css). Screenshots are the
 * repo's `screenshots/` originals, imported so Vite hashes them into the
 * bundle; the only motion is a fade-in as sections scroll into view
 * (`Reveal`, framer-motion `whileInView`, reduced-motion aware).
 */

const REPO_URL = 'https://github.com/z44d/carmen';
const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;

/* ── shared class contracts ──────────────────────────────────────────── */

const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-full bg-accent px-6 py-3.5 ' +
  'text-sm font-bold text-accent-contrast no-underline shadow-elev-3 transition ' +
  'hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-accent sm:text-base';

const BTN_GHOST =
  'inline-flex items-center justify-center gap-2 rounded-full border border-line px-6 py-3.5 ' +
  'text-sm font-semibold text-body no-underline transition hover:border-accent hover:text-accent ' +
  'active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'sm:text-base';

const FILE_ROW =
  'flex items-center justify-between gap-3 rounded-xl border border-line bg-bg px-4 py-3 ' +
  'text-body no-underline transition hover:border-accent ' +
  'focus-visible:outline-2 focus-visible:outline-accent';

/** Per-platform presentation — display name, mark, and the honest footnote. */
const OS_META: Record<OsId, { name: string; Icon: ComponentType<SvgIconProps>; note?: string }> = {
  macos: {
    name: 'macOS',
    Icon: AppleIcon,
    note: 'Unsigned build — if macOS says it can’t be opened, right-click the app and choose Open.',
  },
  windows: {
    name: 'Windows',
    Icon: WindowsIcon,
    note: 'Unsigned build — choose “Keep” when SmartScreen or your browser warns about the file.',
  },
  linux: { name: 'Linux', Icon: LinuxIcon },
  android: {
    name: 'Android',
    Icon: AndroidIcon,
    note: 'Allow “install unknown apps” for your browser when Android asks.',
  },
  ios: {
    name: 'iPhone & iPad',
    Icon: AppleIcon,
    note: 'The .ipa is unsigned — install it with a sideloader like AltStore or SideStore.',
  },
};

/* ── fade-in on scroll ───────────────────────────────────────────────── */

/**
 * The page's one and only effect: fade the block in (with a small rise) the
 * first time it scrolls into view. `once: true` — nothing animates twice.
 */
function Reveal({
  children,
  className,
  amount = 0.2,
}: {
  children: ReactNode;
  className?: string;
  amount?: number;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reducedMotion ? false : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

/* ── layout helpers ──────────────────────────────────────────────────── */

/** A screenshot in the app's card chrome (border + glass drop). */
function Shot({
  src,
  alt,
  className,
  eager,
}: {
  src: string;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  return (
    <img
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={cn('w-full rounded-2xl border border-line shadow-glass', className)}
    />
  );
}

/** A phone screenshot — portrait shots keep a handset-ish width. */
function PhoneShot({ src, alt }: { src: string; alt: string }) {
  return <Shot src={src} alt={alt} className="max-w-[264px]" />;
}

/** One feature band: copy on one side, screenshot(s) on the other. */
function Feature({
  eyebrow,
  title,
  body,
  chips,
  media,
  flip,
}: {
  eyebrow: string;
  title: ReactNode;
  body: string;
  chips?: string[];
  media: ReactNode;
  flip?: boolean;
}) {
  return (
    <Reveal className="grid items-center gap-10 md:grid-cols-2 md:gap-14">
      <div className={cn('flex flex-col items-start gap-4', flip && 'md:order-2')}>
        <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-accent">{eyebrow}</p>
        <h2 className="m-0 text-3xl font-extrabold leading-tight tracking-[-0.02em] sm:text-4xl">
          {title}
        </h2>
        <p className="m-0 text-base leading-relaxed text-muted sm:text-lg">{body}</p>
        {chips?.length ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {chips.map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold text-muted"
              >
                {chip}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className={cn('flex justify-center', flip && 'md:order-1')}>{media}</div>
    </Reveal>
  );
}

/** One small perk card under the last feature. */
function MiniCard({ title, body, href }: { title: string; body: string; href?: string }) {
  const inner = (
    <>
      <h3 className="m-0 text-base font-extrabold">{title}</h3>
      <p className="m-0 text-sm leading-relaxed text-muted">{body}</p>
    </>
  );
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5 text-body no-underline transition hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
    >
      {inner}
    </a>
  ) : (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-5">
      {inner}
    </div>
  );
}

/* ── download cards ──────────────────────────────────────────────────── */

/** One platform's card in the download grid; the visitor's OS wears a badge. */
function DownloadCard({
  os,
  release,
  detected,
}: {
  os: OsId;
  release: LatestRelease;
  detected: OsId | null;
}) {
  const { name, Icon, note } = OS_META[os];
  const isDetected = detected === os;
  return (
    <div
      className={cn(
        'relative flex flex-col gap-4 rounded-2xl border bg-surface p-6',
        isDetected ? 'border-accent' : 'border-line',
      )}
    >
      {isDetected ? (
        <span className="absolute right-4 top-4 rounded-full bg-accent px-2.5 py-1 text-[11px] font-bold text-accent-contrast">
          Your device
        </span>
      ) : null}
      <div className="flex items-center gap-3 pr-24">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-hover text-body">
          <Icon sx={{ fontSize: 24 }} />
        </span>
        <h3 className="m-0 text-lg font-extrabold tracking-tight">{name}</h3>
      </div>
      <div className="flex flex-col gap-2">
        {release.byOs[os].map((file) => (
          <a
            key={file.label}
            href={file.href}
            target="_blank"
            rel="noreferrer"
            className={FILE_ROW}
          >
            <span className="text-sm font-bold">{file.label}</span>
            <span className="text-right text-xs text-muted">{file.detail}</span>
          </a>
        ))}
      </div>
      {note ? <p className="m-0 text-xs leading-relaxed text-muted">{note}</p> : null}
    </div>
  );
}

/* ── the page ────────────────────────────────────────────────────────── */

export default function IntroPage() {
  const [detected, setDetected] = useState<OsId | null>(null);
  const [release, setRelease] = useState<LatestRelease>(FALLBACK_RELEASE);

  useEffect(() => {
    setDetected(detectOs());
    let alive = true;
    // Direct asset URLs land as soon as GitHub answers; until then every
    // button already points at the releases page (FALLBACK_RELEASE).
    fetchLatestRelease().then((latest) => {
      if (alive) setRelease(latest);
    });
    return () => {
      alive = false;
    };
  }, []);

  // iPhone/iPad: a downloaded .ipa cannot be installed without a sideloader,
  // so the honest primary call to action there is the web app.
  const webFirst = detected === 'ios';
  const detectedMeta = detected ? OS_META[detected] : null;
  const heroFile = detected ? release.byOs[detected][0] : null;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-bg text-body">
      {/* ── header ── */}
      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5 text-body no-underline">
            <img src={LOGO_SRC} alt="" className="size-8 rounded-xl" />
            <span className="text-lg font-extrabold tracking-tight">Carmen</span>
          </Link>
          <nav className="flex items-center gap-5 sm:gap-6">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-sm font-semibold text-muted no-underline transition hover:text-accent"
            >
              <GitHubIcon sx={{ fontSize: 18 }} />
              GitHub
            </a>
            <Link to="/" className="text-sm font-bold text-accent no-underline">
              Open app
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* ── hero ── */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-accent/15 to-transparent"
          />
          <div className="relative mx-auto max-w-4xl px-6 pb-14 pt-16 text-center sm:pt-24">
            <Reveal>
              <span className="inline-block rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-bold text-muted">
                Free &amp; open source
              </span>
              <h1 className="mx-auto mt-6 mb-0 max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-[-0.03em] sm:text-6xl">
                Play anything. <span className="text-accent">Keep it forever.</span>
              </h1>
              <p className="mx-auto mt-6 mb-0 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
                Carmen is a free music player for YouTube Music. Stream anything, download it in
                one tap, and keep playing when the network doesn’t.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                {webFirst ? (
                  <>
                    <Link to="/" className={BTN_PRIMARY}>
                      <MusicNoteIcon sx={{ fontSize: 20 }} />
                      Add to Home Screen
                    </Link>
                    <a href={heroFile?.href ?? RELEASES_PAGE} target="_blank" rel="noreferrer" className={BTN_GHOST}>
                      Get the native app
                    </a>
                  </>
                ) : (
                  <>
                    <a
                      href={heroFile?.href ?? RELEASES_PAGE}
                      target="_blank"
                      rel="noreferrer"
                      className={BTN_PRIMARY}
                    >
                      {detectedMeta ? (
                        <detectedMeta.Icon sx={{ fontSize: 20 }} />
                      ) : (
                        <DownloadIcon sx={{ fontSize: 20 }} />
                      )}
                      {detectedMeta ? `Download for ${detectedMeta.name}` : 'Download Carmen'}
                    </a>
                    <Link to="/" className={BTN_GHOST}>
                      Open in your browser
                    </Link>
                  </>
                )}
              </div>
              <p className="mt-6 mb-0 text-xs font-semibold text-muted">
                macOS · Windows · Linux · Android · iOS
                {release.tag ? ` — latest ${release.tag}` : ''}
              </p>
            </Reveal>
            <Reveal className="mt-12" amount={0.05}>
              <Shot
                src={cinematicScreenshot}
                alt="Carmen desktop player in cinematic mode"
                eager
                className="mx-auto max-w-3xl"
              />
            </Reveal>
          </div>
        </section>

        {/* ── features ── */}
        <div className="mx-auto flex max-w-5xl flex-col gap-20 px-6 py-16 sm:gap-24 sm:px-8 sm:py-24">
          <Feature
            eyebrow="Play"
            title="The whole catalogue, one press away"
            body="Search, browse and hit play — millions of songs, albums, artists and podcasts, with cover art in full resolution."
            chips={['Search & browse', 'Albums & artists', 'Playlists & podcasts']}
            media={<Shot src={webClientScreenshot} alt="Carmen web client playing an album" className="max-w-[560px]" />}
          />

          <Feature
            eyebrow="Offline"
            title="One tap. Fully offline."
            flip
            body="Download a song and it’s yours: audio, cover art and lyrics saved right on your device. No signal, no problem — your music starts instantly and costs zero data."
            chips={['Plays with no network', 'Audio + artwork + lyrics', 'Starts instantly']}
            media={<PhoneShot src={androidHomeScreenshot} alt="Carmen Android home page" />}
          />

          <Feature
            eyebrow="Lyrics"
            title="Lyrics that keep up"
            body="Line-by-line synced words when they exist, plain scrolling text when they don’t — on the screen, on the lock screen, and in the menu bar while you work."
            media={
              <div className="flex flex-col items-center gap-5">
                <PhoneShot src={androidLyricsScreenshot} alt="Synced lyrics in the Carmen player" />
                <Shot
                  src={menuBarScreenshot}
                  alt="Song lyrics shown in the macOS media-session menu bar"
                  className="max-w-[320px]"
                />
              </div>
            }
          />

          <Feature
            eyebrow="Native"
            title="Feels at home on every device"
            flip
            body="Media keys, lock-screen controls and a now-playing widget your system already understands. The background tints itself from whatever is playing — in dark or light."
            media={<Shot src={portraitScreenshot} alt="Carmen in portrait view" className="mx-auto max-w-[360px]" />}
          />

          <Reveal className="grid gap-4 sm:grid-cols-3">
            <MiniCard
              title="Spotify playlists, imported"
              body="Paste any public playlist link and Carmen rebuilds it song by song."
            />
            <MiniCard title="No account. No ads." body="Nothing to sign up for — open the app and press play." />
            <MiniCard
              title="Free & open source"
              body="Built in the open. Read the code, report an issue, or help out."
              href={REPO_URL}
            />
          </Reveal>
        </div>

        {/* ── downloads ── */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8 sm:py-24">
            <Reveal>
              <div className="flex flex-col items-center gap-3 text-center">
                <h2 className="m-0 text-3xl font-extrabold tracking-[-0.02em] sm:text-4xl">
                  Get Carmen
                </h2>
                <p className="m-0 text-base text-muted">
                  One click, no store account needed
                  {release.tag ? ` — latest release ${release.tag}` : ''}.
                </p>
              </div>
            </Reveal>
            <Reveal className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" amount={0.05}>
              {OS_ORDER.map((os) => (
                <DownloadCard key={os} os={os} release={release} detected={detected} />
              ))}
              {/* Web app — the platform everybody already has. */}
              <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
                <div className="flex items-center gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-hover text-body">
                    <GlobeIcon sx={{ fontSize: 24 }} />
                  </span>
                  <h3 className="m-0 text-lg font-extrabold tracking-tight">Web app</h3>
                </div>
                <Link to="/" className={cn(FILE_ROW, 'text-sm font-bold')}>
                  Open in your browser
                </Link>
                <p className="m-0 text-xs leading-relaxed text-muted">
                  On iPhone and iPad, open it in Safari and choose “Add to Home Screen”.
                </p>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ── footer ── */}
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-6 py-10 text-center sm:px-8">
          <div className="flex items-center gap-2">
            <img src={LOGO_SRC} alt="" className="size-6 rounded-lg" />
            <span className="text-sm font-extrabold tracking-tight">Carmen</span>
          </div>
          <p className="m-0 max-w-xl text-sm leading-relaxed text-muted">
            Free, open source, and built for music that shouldn’t stop when the signal does.
          </p>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm font-semibold">
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-muted no-underline transition hover:text-accent">
              GitHub
            </a>
            <a href={RELEASES_PAGE} target="_blank" rel="noreferrer" className="text-muted no-underline transition hover:text-accent">
              Releases
            </a>
            <Link to="/" className="text-muted no-underline transition hover:text-accent">
              Web app
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
