/**
 * Platform detection + latest-release download resolution for the /intro
 * landing page.
 *
 * The release assets carry the version in their names
 * (`Carmen_1.0.1_universal.dmg`), so `releases/latest/download/<file>`
 * links cannot be hardcoded — the page asks GitHub's API for the latest
 * release once (the same CORS-open, network-loose call
 * `services/updateCheck` already makes) and matches each platform's assets
 * by pattern. Every failure — offline, rate limit, a renamed asset —
 * degrades to the releases page, so a download button is never dead.
 */
import { RELEASES_PAGE } from '../../services/updateCheck';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/z44d/carmen/releases/latest';

/** The five platforms a release ships installers for. */
export type OsId = 'macos' | 'windows' | 'linux' | 'android' | 'ios';

/** Grid order of the download cards. */
export const OS_ORDER: OsId[] = ['macos', 'windows', 'linux', 'android', 'ios'];

/** One downloadable file of a platform. */
export interface DownloadFile {
  /** Short file-kind label — ".dmg", ".apk", ".exe — x64". */
  label: string;
  /** One line of context — "Universal — Apple Silicon & Intel". */
  detail: string;
  /** Direct asset URL; the releases page while unresolved. */
  href: string;
}

/** What the download section renders — labels always, direct URLs once known. */
export interface LatestRelease {
  /** Release tag ("v1.0.1"), '' while unknown. */
  tag: string;
  byOs: Record<OsId, DownloadFile[]>;
}

/**
 * Asset patterns per file kind, matched against the latest release's
 * assets. Deliberately loose (`Carmen` + suffix) so a version-shape change
 * (`1.0.1` → `1.1.0-beta.1`, `x86_64.rpm` → `x86_64.rpm`) keeps matching.
 */
const PATTERNS = {
  dmg: /^Carmen.*universal\.dmg$/i,
  winX64: /^Carmen.*x64-setup\.exe$/i,
  winArm64: /^Carmen.*arm64-setup\.exe$/i,
  appimage: /^Carmen.*\.AppImage$/i,
  deb: /^Carmen.*\.deb$/i,
  rpm: /^Carmen.*\.rpm$/i,
  apk: /^Carmen.*\.apk$/i,
  ipa: /^Carmen.*\.ipa$/i,
} as const;

/**
 * The catalogue with every link pointed at the releases page — the state
 * the page shows while the API call is in flight, and the fallback when it
 * fails. The labels/details are the presentation the cards show either way.
 */
export const FALLBACK_RELEASE: LatestRelease = {
  tag: '',
  byOs: {
    macos: [{ label: '.dmg', detail: 'Universal — Apple Silicon & Intel', href: RELEASES_PAGE }],
    windows: [
      { label: '.exe — x64', detail: '64-bit installer', href: RELEASES_PAGE },
      { label: '.exe — ARM64', detail: 'For Windows on ARM', href: RELEASES_PAGE },
    ],
    linux: [
      { label: '.AppImage', detail: 'Any distro', href: RELEASES_PAGE },
      { label: '.deb', detail: 'Debian / Ubuntu', href: RELEASES_PAGE },
      { label: '.rpm', detail: 'Fedora / RHEL', href: RELEASES_PAGE },
    ],
    android: [{ label: '.apk', detail: 'Universal — installs directly', href: RELEASES_PAGE }],
    ios: [
      { label: '.ipa', detail: 'Unsigned — sideload with AltStore / SideStore', href: RELEASES_PAGE },
    ],
  },
};

/**
 * Resolves every platform's direct download URL from the latest release.
 * Never rejects — an unreachable API simply returns the releases-page
 * fallback (same promise discipline as `checkForUpdate`).
 */
export async function fetchLatestRelease(): Promise<LatestRelease> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return FALLBACK_RELEASE;

    const release = (await response.json()) as {
      tag_name?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const assets = release.assets ?? [];
    const urlFor = (pattern: RegExp) =>
      assets.find((asset) => pattern.test(asset.name))?.browser_download_url ?? RELEASES_PAGE;

    return {
      tag: release.tag_name ?? '',
      byOs: {
        macos: [
          { label: '.dmg', detail: 'Universal — Apple Silicon & Intel', href: urlFor(PATTERNS.dmg) },
        ],
        windows: [
          { label: '.exe — x64', detail: '64-bit installer', href: urlFor(PATTERNS.winX64) },
          { label: '.exe — ARM64', detail: 'For Windows on ARM', href: urlFor(PATTERNS.winArm64) },
        ],
        linux: [
          { label: '.AppImage', detail: 'Any distro', href: urlFor(PATTERNS.appimage) },
          { label: '.deb', detail: 'Debian / Ubuntu', href: urlFor(PATTERNS.deb) },
          { label: '.rpm', detail: 'Fedora / RHEL', href: urlFor(PATTERNS.rpm) },
        ],
        android: [
          { label: '.apk', detail: 'Universal — installs directly', href: urlFor(PATTERNS.apk) },
        ],
        ios: [
          {
            label: '.ipa',
            detail: 'Unsigned — sideload with AltStore / SideStore',
            href: urlFor(PATTERNS.ipa),
          },
        ],
      },
    };
  } catch {
    return FALLBACK_RELEASE; // offline / timed out / rate-limited — never a dead button
  }
}

/**
 * The visitor's platform, best effort. Android is matched before Linux (its
 * UA says "Linux; Android …"), and iPadOS 13+ masquerades as macOS — the
 * classic `maxTouchPoints` tell separates the two.
 */
export function detectOs(): OsId | null {
  if (typeof navigator === 'undefined') return null;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const source = `${uaData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`;
  if (/android/i.test(source)) return 'android';
  if (/iphone|ipad|ipod/i.test(source)) return 'ios';
  if (/mac/i.test(source) && (navigator.maxTouchPoints ?? 0) > 1) return 'ios'; // iPad pretending
  if (/mac/i.test(source)) return 'macos';
  if (/win/i.test(source)) return 'windows';
  if (/linux|x11|cros/i.test(source)) return 'linux';
  return null;
}
