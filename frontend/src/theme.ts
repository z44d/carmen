import type { FontId } from './types/models';

const SYSTEM_FONT =
  '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** One selectable interface font. */
export interface FontOption {
  id: FontId;
  name: string;
  stack: string;
}

/**
 * Selectable interface fonts.  `stack` is what ends up in
 * `theme.typography.fontFamily`; every entry falls back to the system stack
 * so glyphs that the web font does not cover never break the layout.
 *
 * **Alexandria is the project font** — it ships both the Arabic and the
 * Latin subset, so the whole interface reads the same in either language and
 * it is the first entry (and therefore the fallback for unknown ids).
 */
export const FONTS: FontOption[] = [
  {
    id: 'alexandria',
    name: 'Alexandria',
    stack: `"Alexandria", ${SYSTEM_FONT}`,
  },
  {
    id: 'cairo',
    name: 'Cairo',
    stack: `"Cairo", ${SYSTEM_FONT}`,
  },
  { id: 'system', name: 'System default', stack: SYSTEM_FONT },
];

export const DEFAULT_FONT: FontId = 'alexandria';

/**
 * The two surface palettes — **single source of truth** for the app's
 * colours: `ThemeProvider` publishes them as the `--app-*` custom properties
 * that the Tailwind `@theme` tokens in `styles.css` read (one engine since
 * MUI left).  Editing a colour here restyles the whole app.
 *
 * Dark look: the dark palette is near-black and flat (`#050505` ground,
 * `#0d0d0f` surfaces, hairline white dividers) with white text and grey
 * secondary text; the light palette is the same layout in readable light
 * tones. There is no coloured accent: the accent token resolves to the
 * body text colour in both themes, so active states and focus rings wear
 * the same neutral chrome everywhere.
 */
const PALETTE = {
  dark: {
    bg: '#050505',
    paper: '#0d0d0f',
    text: '#fafafa',
    textSecondary: 'rgba(250,250,250,0.62)',
    divider: 'rgba(255,255,255,0.10)',
  },
  light: {
    bg: '#fbfbfb',
    paper: '#ffffff',
    text: '#111111',
    textSecondary: 'rgba(17,17,17,0.62)',
    divider: 'rgba(0,0,0,0.09)',
  },
} as const;

/** Chrome constants — the only yellow in the interface is the star. */
export const STAR_YELLOW = '#FACC15';

/** Rank numeral colours for the ranked row (1 gold, 2 silver, 3 bronze). */
export const RANK_COLORS = ['#FACC15', '#D1D5DB', '#D97706'] as const;

/**
 * The palette of a resolved mode as CSS custom properties, applied on
 * `documentElement` by `ThemeProvider` (see `styles.css`).
 */
export function cssPalette(mode: 'light' | 'dark'): Record<string, string> {
  const colors = PALETTE[mode];
  return {
    '--app-bg': colors.bg,
    '--app-paper': colors.paper,
    '--app-text': colors.text,
    '--app-text-secondary': colors.textSecondary,
    '--app-divider': colors.divider,
    // MUI default theme values the Tailwind tokens mirror: disabled text is
    // identical to action.disabled, action.active and hover come from the
    // stock light/dark palettes.
    '--app-text-disabled': mode === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.26)',
    '--app-action-active': mode === 'dark' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.54)',
    // Success wears the body text colour — the system has no coloured
    // accent, so success is a check/icon, not a hue.
    '--app-success': colors.text,
    '--app-hover': mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
    // MUI error.main — the one severity colour `buildTheme` never overrode.
    '--app-error': mode === 'dark' ? '#f44336' : '#d32f2f',
  };
}

/** Resolve a font id into a CSS font stack (unknown ids fall back to system). */
export function fontStack(fontId: FontId): string {
  const match = FONTS.find((font) => font.id === fontId);
  return (match || FONTS[0]).stack;
}
