import { describe, expect, it } from 'vitest';

import {
  LOW_BATTERY_ACCENT,
  resolveAccentContrast,
  resolveAccentFg,
  resolveAccentInUse,
} from './accent';

describe('resolveAccentInUse', () => {
  it('pins white while low battery mode is on, whatever else is set', () => {
    expect(
      resolveAccentInUse({
        lowBatteryMode: true,
        adaptiveAccent: true,
        adaptiveColor: '#2196F3',
        accent: '#E91E63',
      }),
    ).toBe(LOW_BATTERY_ACCENT);
  });

  it('prefers the adaptive cover colour when adaptive is on and one was read', () => {
    expect(
      resolveAccentInUse({
        lowBatteryMode: false,
        adaptiveAccent: true,
        adaptiveColor: '#2196F3',
        accent: '#fafafa',
      }),
    ).toBe('#2196F3');
  });

  it('falls back to the stored accent when adaptive has no colour yet', () => {
    expect(
      resolveAccentInUse({
        lowBatteryMode: false,
        adaptiveAccent: true,
        adaptiveColor: null,
        accent: '#fafafa',
      }),
    ).toBe('#fafafa');
  });

  it('uses the stored accent when adaptive is off', () => {
    expect(
      resolveAccentInUse({
        lowBatteryMode: false,
        adaptiveAccent: false,
        adaptiveColor: '#2196F3',
        accent: '#FF9800',
      }),
    ).toBe('#FF9800');
  });

  it('keeps the neutral default for a fresh install', () => {
    expect(
      resolveAccentInUse({
        lowBatteryMode: false,
        adaptiveAccent: false,
        adaptiveColor: null,
        accent: '#fafafa',
      }),
    ).toBe('#fafafa');
  });
});

describe('resolveAccentFg', () => {
  it('falls back to readable text for a white accent in light mode', () => {
    expect(resolveAccentFg('light', '#ffffff')).toBe('#12160f');
    expect(resolveAccentFg('light', '#fafafa')).toBe('#12160f');
  });

  it('keeps a dark accent as-is in light mode', () => {
    expect(resolveAccentFg('light', '#2196F3')).toBe('#2196F3');
  });

  it('keeps white as-is in dark mode', () => {
    expect(resolveAccentFg('dark', '#ffffff')).toBe('#ffffff');
  });
});

describe('resolveAccentContrast', () => {
  it('is white on a dark accent', () => {
    expect(resolveAccentContrast('#2196F3')).toBe('#ffffff');
    expect(resolveAccentContrast('#111111')).toBe('#ffffff');
  });

  it('is dark on a near-white accent', () => {
    expect(resolveAccentContrast('#fafafa')).toBe('rgba(0,0,0,0.87)');
    expect(resolveAccentContrast('#ffffff')).toBe('rgba(0,0,0,0.87)');
  });
});
