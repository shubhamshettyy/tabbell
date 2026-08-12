import { classifyText, STABILITY_MS, verdictLabel, type Verdict } from './detect';
import { formatPrice } from './price';
import type { CheckSpec, Settings, Snapshot, Watch } from './types';

/**
 * What the background should do after a check. Evaluation may mutate the
 * watch's tracking state (lastText, pending*, price history, latches);
 * the caller persists the watch afterwards.
 */
export type Outcome =
  /** Nothing to report; keep watching. */
  | { action: 'none' }
  /** The watched element could not be found — count a miss. */
  | { action: 'missing' }
  /** The page needs the user (login wall, etc.). */
  | { action: 'attention'; reason: string }
  /**
   * A fetch-based (unrendered) check looks positive, but visibility can't
   * be trusted without layout — re-run the check in a real tab first.
   */
  | { action: 'confirm-rendered' }
  /** One-shot watch fired: mark done/failed/changed and notify. */
  | { action: 'complete'; verdict: Verdict; title: string; body: string }
  /** Continuous watch (price/keyword) fired: notify but keep watching. */
  | { action: 'notify'; title: string; body: string };

/** Build the page-inspection spec for a watch. */
export function specForWatch(watch: Watch): CheckSpec {
  const c = watch.condition;
  return {
    selector: watch.selector,
    expectText: c.kind === 'elementAppears' ? c.expectText : undefined,
    keyword: c.kind === 'keyword' ? c.phrase : undefined,
    wantPrice: c.kind === 'priceThreshold',
  };
}

export function evaluate(
  watch: Watch,
  snapshot: Snapshot,
  settings: Settings,
  now = Date.now(),
): Outcome {
  switch (watch.condition.kind) {
    case 'statusChange':
      return evaluateStatusChange(watch, snapshot, settings, now);
    case 'elementAppears':
      return evaluateElementAppears(watch, snapshot);
    case 'priceThreshold':
      return evaluatePrice(watch, snapshot, now);
    case 'keyword':
      return evaluateKeyword(watch, snapshot);
  }
}

// ---- statusChange (pipelines, builds, exports) ----------------------------

function evaluateStatusChange(
  watch: Watch,
  snapshot: Snapshot,
  settings: Settings,
  now: number,
): Outcome {
  if (!snapshot.found) return { action: 'missing' };
  watch.missingCount = 0;

  const text = snapshot.text;
  const verdict = classifyText(text, settings);
  const changedFromBaseline = text.trim() !== watch.baselineText.trim();

  if (verdict === 'running') {
    watch.lastText = text;
    watch.pendingText = undefined;
    watch.pendingSince = undefined;
    return { action: 'none' };
  }

  if (verdict === 'success' || verdict === 'failure') {
    watch.lastText = text;
    watch.pendingText = undefined;
    watch.pendingSince = undefined;
    return {
      action: 'complete',
      verdict,
      title: verdict === 'failure' ? 'Task failed' : 'Task finished',
      body: `${watch.pageTitle}\n${text.trim().slice(0, 180)}`,
    };
  }

  // verdict === 'unknown'
  if (!changedFromBaseline || !settings.notifyOnAnyChange) {
    watch.lastText = text;
    watch.pendingText = undefined;
    watch.pendingSince = undefined;
    return { action: 'none' };
  }

  // Unknown-but-changed text must survive a stability window so progress
  // tickers ("46%" -> "47%", elapsed timers) never fire prematurely.
  if (watch.pendingText?.trim() === text.trim()) {
    if (now - (watch.pendingSince ?? now) >= STABILITY_MS) {
      watch.lastText = text;
      watch.pendingText = undefined;
      watch.pendingSince = undefined;
      return {
        action: 'complete',
        verdict: 'unknown',
        title: 'Task updated',
        body: `${watch.pageTitle}\n${text.trim().slice(0, 180)}`,
      };
    }
    return { action: 'none' };
  }

  watch.lastText = text;
  watch.pendingText = text;
  watch.pendingSince = now;
  return { action: 'none' };
}

// ---- elementAppears (hidden Apply buttons, disabled checkout, ...) --------

function evaluateElementAppears(watch: Watch, snapshot: Snapshot): Outcome {
  if (snapshot.loginWall) return { action: 'attention', reason: 'Page is asking for a login' };

  // Not there yet — that IS the waiting state, not an error.
  if (!snapshot.found || !snapshot.visible || !snapshot.enabled) {
    watch.lastText = snapshot.found ? snapshot.text : watch.lastText;
    return { action: 'none' };
  }

  // Positive from raw HTML can't be trusted (CSS-hidden elements look
  // "visible" without layout) — confirm in a rendered tab before firing.
  if (!snapshot.rendered) return { action: 'confirm-rendered' };

  watch.lastText = snapshot.text;
  const label = snapshot.text.trim().slice(0, 80) || watch.label;
  return {
    action: 'complete',
    verdict: 'success',
    title: 'It appeared!',
    body: `${watch.pageTitle}\n\u201c${label}\u201d is now available`,
  };
}

// ---- priceThreshold (Amazon & friends) -------------------------------------

const PRICE_HISTORY_MAX = 60;

function evaluatePrice(watch: Watch, snapshot: Snapshot, now: number): Outcome {
  const c = watch.condition;
  if (c.kind !== 'priceThreshold') return { action: 'none' };

  if (snapshot.price === null) {
    if (snapshot.loginWall) return { action: 'attention', reason: 'Page is asking for a login' };
    return { action: 'missing' };
  }
  watch.missingCount = 0;

  const price = snapshot.price;
  const currency = snapshot.currency ?? c.currency;
  const previous = watch.lastPrice;

  if (previous === undefined || previous !== price) {
    watch.priceHistory = [...(watch.priceHistory ?? []), { t: now, p: price }].slice(
      -PRICE_HISTORY_MAX,
    );
  }
  watch.lastPrice = price;
  watch.lastText = formatPrice(price, currency);

  switch (c.rule) {
    case 'any': {
      if (previous !== undefined && previous !== price) {
        const dir = price < previous ? 'dropped' : 'rose';
        return {
          action: 'notify',
          title: `Price ${dir}: ${formatPrice(price, currency)}`,
          body: `${watch.pageTitle}\n${formatPrice(previous, currency)} \u2192 ${formatPrice(price, currency)}`,
        };
      }
      return { action: 'none' };
    }
    case 'below': {
      const threshold = c.value ?? 0;
      if (price <= threshold && !c.latched) {
        c.latched = true;
        return {
          action: 'notify',
          title: `Price below ${formatPrice(threshold, currency)}`,
          body: `${watch.pageTitle}\nNow ${formatPrice(price, currency)}`,
        };
      }
      if (price > threshold) c.latched = false;
      return { action: 'none' };
    }
    case 'dropPercent': {
      const pct = c.value ?? 0;
      const baseline = c.baselinePrice ?? price;
      if (c.baselinePrice === undefined) c.baselinePrice = price;
      if (baseline > 0 && price <= baseline * (1 - pct / 100)) {
        const actualPct = Math.round(((baseline - price) / baseline) * 100);
        c.baselinePrice = price; // re-arm relative to the new price
        return {
          action: 'notify',
          title: `Price dropped ${actualPct}%`,
          body: `${watch.pageTitle}\n${formatPrice(baseline, currency)} \u2192 ${formatPrice(price, currency)}`,
        };
      }
      return { action: 'none' };
    }
  }
}

// ---- keyword (in stock, tickets available, appointments open, ...) --------

function evaluateKeyword(watch: Watch, snapshot: Snapshot): Outcome {
  const c = watch.condition;
  if (c.kind !== 'keyword' || snapshot.keywordPresent === undefined) return { action: 'none' };
  watch.missingCount = 0;

  const present = snapshot.keywordPresent;
  const wantPresent = c.on === 'appear';

  if (present === wantPresent) {
    if (c.latched) return { action: 'none' };
    c.latched = true;
    return {
      action: 'notify',
      title: wantPresent ? `\u201c${c.phrase}\u201d appeared` : `\u201c${c.phrase}\u201d is gone`,
      body: watch.pageTitle,
    };
  }
  c.latched = false;
  return { action: 'none' };
}

export { verdictLabel };
