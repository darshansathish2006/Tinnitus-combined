/**
 * Cochlear frequency-position mathematics.
 *
 * Kept separate from the rendering code because it is testable arithmetic with no
 * dependency on Three.js or the DOM, and because it is used in two places (the 3D
 * model and the tonotopic ruler beside it).
 *
 * The **Greenwood function** is the established relationship between position
 * along the cochlear partition and the frequency that position responds to:
 *
 *     f(x) = A · (10^(a·x) − k)
 *
 * with the human parameters A = 165.4, a = 2.1, k = 0.88, and x the normalised
 * distance from the apex (0 = apex, low frequency; 1 = base, high frequency).
 * At x = 0 it gives ~20 Hz and at x = 1 about 20.6 kHz — the human hearing range,
 * which is the check that the parameters are being applied correctly.
 *
 * Reference: Greenwood DD. A cochlear frequency-position function for several
 * species — 29 years later. J Acoust Soc Am. 1990;87(6):2592-605.
 */

export const GREENWOOD = { A: 165.4, a: 2.1, k: 0.88 } as const;

/** Characteristic frequency (Hz) at normalised distance `x` from the apex. */
export function greenwoodFrequency(x: number): number {
  return GREENWOOD.A * (Math.pow(10, GREENWOOD.a * x) - GREENWOOD.k);
}

/** Normalised distance from the apex for a characteristic frequency. */
export function greenwoodPosition(freq: number): number {
  const inner = freq / GREENWOOD.A + GREENWOOD.k;
  return Math.log10(Math.max(inner, 1e-6)) / GREENWOOD.a;
}

/**
 * Interpolate an audiometric threshold at an arbitrary frequency.
 *
 * Interpolation is linear in log-frequency, not linear in Hz: audiometric
 * frequencies are octave-spaced, so treating the 4–8 kHz gap the same as the
 * 250–500 Hz gap would misplace every intermediate value.
 */
export function interpolateThreshold(
  audiogram: Record<string, number> | undefined,
  freq: number
): number | null {
  if (!audiogram) return null;
  const points = Object.entries(audiogram)
    .map(([f, db]) => ({ f: Number(f), db: Number(db) }))
    .filter((p) => Number.isFinite(p.f) && Number.isFinite(p.db))
    .sort((a, b) => a.f - b.f);
  if (!points.length) return null;
  if (freq <= points[0].f) return points[0].db;
  if (freq >= points[points.length - 1].f) return points[points.length - 1].db;
  for (let i = 0; i < points.length - 1; i++) {
    if (freq >= points[i].f && freq <= points[i + 1].f) {
      const t =
        (Math.log2(freq) - Math.log2(points[i].f)) /
        (Math.log2(points[i + 1].f) - Math.log2(points[i].f));
      return points[i].db + t * (points[i + 1].db - points[i].db);
    }
  }
  return null;
}
