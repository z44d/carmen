/**
 * Pure accent resolution — the colour decisions `ThemeContext`
 * applies, extracted so they can be tested without rendering.
 * Deliberately free of any DOM or store access.
 */

/**
 * Accent low battery mode pins the whole app to: no artwork theming,
 * no hue of its own (see Settings).
 */
export const LOW_BATTERY_ACCENT = '#ffffff';

/** Text colour a white accent falls back to on a light surface. */
export const LIGHT_ACCENT_FG_FALLBACK = '#12160f';

/**
 * Relative luminance of a `#rrggbb` colour (0 = black, 1 = white).
 * Used to decide whether an accent survives on a light surface — white does
 * not, and neither does the pale adaptive colour some covers produce.
 */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return 1;
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/**
 * The accent the theme actually wears: white while low battery mode
 * is on; the adaptive artwork colour while artwork theming is on and
 * a cover colour has been read; otherwise the accent chosen in
 * Settings. `adaptiveAccent` here is the *effective* switch (already
 * forced off by low battery mode in the provider).
 */
export function resolveAccentInUse(args: {
  lowBatteryMode: boolean;
  adaptiveAccent: boolean;
  adaptiveColor: string | null;
  accent: string;
}): string {
  if (args.lowBatteryMode) return LOW_BATTERY_ACCENT;
  if (args.adaptiveAccent && args.adaptiveColor) return args.adaptiveColor;
  return args.accent;
}

/**
 * Accent for things painted as text / line art on the app
 * background: the accent itself, except a white (or near-white)
 * accent on a light surface, which falls back to the readable text
 * colour. Dark mode keeps white — it is perfectly legible there.
 */
export function resolveAccentFg(resolved: 'light' | 'dark', accentInUse: string): string {
  if (resolved === 'light' && luminance(accentInUse) > 0.85) {
    return LIGHT_ACCENT_FG_FALLBACK;
  }
  return accentInUse;
}

/**
 * Text/icon colour on top of a filled accent surface — MUI's
 * `contrastText`: white while the contrast ratio against white
 * clears 3 (the accent is dark enough), otherwise 87% black.
 */
export function resolveAccentContrast(accentInUse: string): string {
  return 1.05 / (luminance(accentInUse) + 0.05) >= 3 ? '#ffffff' : 'rgba(0,0,0,0.87)';
}
