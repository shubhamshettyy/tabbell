import type { Settings } from './types';

export type Verdict = 'success' | 'failure' | 'running' | 'unknown';

const boundary = (kw: string): RegExp =>
  new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`, 'i');

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => boundary(kw).test(text));
}

/** How long text must stay unchanged before an "unknown" change counts as done. */
export const STABILITY_MS = 10_000;

/** "46%" is progress, but "100%" usually means finished. */
const PARTIAL_PERCENT = /(?<!\d)(?:\d|[1-9]\d)(?:\.\d+)?\s*%/;
const FULL_PERCENT = /\b100(?:\.0+)?\s*%/;

/**
 * Classify a status string.
 *
 * Ordering rationale:
 * - Running keywords first: "running tests, 0 failed" is not a failure.
 * - Partial percentages next: "46% complete" must not match "complete".
 * - Failure beats success: "1 failed, 3 passed" reads as failure.
 * - Everything else is "unknown"; the caller's stability window filters
 *   dynamic noise (elapsed timers, spinners, tickers) that never settles.
 */
export function classifyText(text: string, settings: Settings): Verdict {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return 'unknown';
  if (matchesAny(t, settings.runningKeywords)) return 'running';
  if (PARTIAL_PERCENT.test(t) && !FULL_PERCENT.test(t)) return 'running';
  if (matchesAny(t, settings.failureKeywords)) return 'failure';
  if (matchesAny(t, settings.successKeywords)) return 'success';
  return 'unknown';
}

export function verdictLabel(v: Verdict): string {
  switch (v) {
    case 'success':
      return 'Succeeded';
    case 'failure':
      return 'Failed';
    case 'running':
      return 'Running';
    case 'unknown':
      return 'Changed';
  }
}
