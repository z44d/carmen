import type { FontId } from './types/models';

/** One selectable accent of the palette. */
export interface AccentOption {
  id: string;
  name: string;
  color: string;
}

/**
 * Accent palette. The green family (Material Green, Emerald, Teal,
 * Lime) is deliberately absent — the site's colours stay unified and
 * neutral by default. Neutral is the first option and the default, so
 * anyone who never touches the picker keeps the neutral look; the
 * remaining hues are user choices only, applied through the accent
 * token when Adaptive accent is off.
 */
export const ACCENTS: AccentOption[] = [
  { id: 'neutral', name: 'Neutral', color: '#fafafa' },
  { id: 'cyan', name: 'Cyan', color: '#00BCD4' },
  { id: 'blue', name: 'Blue', color: '#2196F3' },
  { id: 'indigo', name: 'Indigo', color: '#3F51B5' },
  { id: 'purple', name: 'Purple', color: '#9C27B0' },
  { id: 'pink', name: 'Pink', color: '#E91E63' },
  { id: 'red', name: 'Red', color: '#F44336' },
  { id: 'orange', name: 'Orange', color: '#FF5722' },
  { id: 'amber', name: 'Amber', color: '#FF9800' },
  { id: 'white', name: 'White', color: '#ffffff' },
];

export const DEFAULT_ACCENT = '#fafafa';

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
 * secondary text. The light palette is warm paper, not grey: a warm
 * ivory ground (`#faf7f1`), warm-white surfaces, warm near-black text,
 * and a stronger secondary/divider so hierarchy survives daylight —
 * the old near-white-on-white with 0.62-alpha secondaries and faint
 * dividers read washed out. The accent picker (and Adaptive accent,
 * when on) drives active states and focus through the `--app-accent`
 * token; the default accent is Neutral, so chrome stays monochrome
 * until the user picks a hue.
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
    bg: '#faf7f1',
    paper: '#fffdf8',
    text: '#1b1712',
    textSecondary: 'rgba(27,23,18,0.68)',
    divider: 'rgba(60,45,25,0.14)',
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
    '--app-text-disabled': mode === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(27,23,18,0.38)',
    '--app-action-active': mode === 'dark' ? 'rgba(255,255,255,0.7)' : 'rgba(27,23,18,0.62)',
    // Success wears the body text colour — a check/icon, not a hue.
    '--app-success': colors.text,
    '--app-hover': mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(60,45,25,0.06)',
    // MUI error.main — the one severity colour `buildTheme` never overrode.
    '--app-error': mode === 'dark' ? '#f44336' : '#d32f2f',
  };
}

/** Resolve a font id into a CSS font stack (unknown ids fall back to system). */
export function fontStack(fontId: FontId): string {
  const match = FONTS.find((font) => font.id === fontId);
  return (match || FONTS[0]).stack;
}
