/** Core shared types for TabBell. */

export type WatchType = 'title' | 'element';

/**
 * live    — the tab stays open; a MutationObserver reports changes instantly.
 * revisit — the page may be closed; the background scheduler re-checks it
 *           (fetch-first, background tab as fallback) on an interval.
 */
export type WatchMode = 'live' | 'revisit';

export type CheckStrategy = 'fetch' | 'tab';

export type WatchStatus =
  | 'watching'
  | 'done'
  | 'failed'
  | 'changed'
  | 'attention'
  | 'lost';

/** What the user is waiting for. */
export type Condition =
  /** Pipeline/build style: text flips to a success/failure keyword. */
  | { kind: 'statusChange' }
  /**
   * A hidden/absent/disabled element (e.g. an Apply button) becomes
   * present + visible + enabled. `expectText` lets us match a button that
   * is not in the DOM at all yet.
   */
  | { kind: 'elementAppears'; expectText?: string }
  /** A price changes / drops below a value / drops by a percentage. */
  | {
      kind: 'priceThreshold';
      rule: 'any' | 'below' | 'dropPercent';
      /** Threshold price for 'below', percentage for 'dropPercent'. */
      value?: number;
      /** Price seen when the watch was created (dropPercent reference). */
      baselinePrice?: number;
      currency?: string;
      /** True after a 'below' fire until the price rises back above. */
      latched?: boolean;
    }
  /** A phrase appears on (or disappears from) the page, e.g. "In stock". */
  | { kind: 'keyword'; phrase: string; on: 'appear' | 'disappear'; latched?: boolean };

export type ConditionKind = Condition['kind'];

export interface PricePoint {
  t: number;
  p: number;
}

export interface Watch {
  id: string;
  type: WatchType;
  mode: WatchMode;
  condition: Condition;
  /** Present while a live tab is associated; revisit watches may have none. */
  tabId?: number;
  url: string;
  pageTitle: string;
  favIconUrl?: string;
  /** Human label shown in the popup, e.g. the element's text at creation. */
  label: string;
  /** CSS selector — element watches only. */
  selector?: string;
  /** Text snapshot at watch creation, used to detect change. */
  baselineText: string;
  /** Most recent text observed. */
  lastText: string;
  status: WatchStatus;
  /** Verdict text shown after completion, e.g. "Succeeded". */
  verdict?: string;
  /** Candidate final text awaiting the stability window. */
  pendingText?: string;
  /** When pendingText was first seen. */
  pendingSince?: number;
  /** Consecutive checks where the watched element could not be found. */
  missingCount?: number;
  /** Small cropped JPEG data URL of the snipped region (popup thumbnail). */
  thumb?: string;
  /** Revisit scheduling. */
  intervalMinutes?: number;
  nextCheckAt?: number;
  lastCheckedAt?: number;
  /** Remembered cheapest strategy that works for this page. */
  checkStrategy?: CheckStrategy;
  /** Price tracking state. */
  lastPrice?: number;
  priceHistory?: PricePoint[];
  /** Continuous watches (price/keyword): when we last notified. */
  lastNotifiedAt?: number;
  createdAt: number;
  completedAt?: number;
}

export interface Settings {
  /** Notify on any text change, even if no success/failure keyword matches. */
  notifyOnAnyChange: boolean;
  successKeywords: string[];
  failureKeywords: string[];
  runningKeywords: string[];
  /** Telegram bot channel (free): token from @BotFather + chat id. */
  telegramEnabled: boolean;
  telegramToken: string;
  telegramChatId: string;
  /** Discord incoming webhook URL (free). */
  discordEnabled: boolean;
  discordWebhookUrl: string;
  /** Slack incoming webhook URL (free). */
  slackEnabled: boolean;
  slackWebhookUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  notifyOnAnyChange: true,
  successKeywords: [
    'success',
    'succeeded',
    'passed',
    'complete',
    'completed',
    'finished',
    'done',
    'deployed',
    'merged',
    'ready',
    'healthy',
    'green',
  ],
  failureKeywords: [
    'fail',
    'failed',
    'failure',
    'error',
    'errored',
    'cancelled',
    'canceled',
    'aborted',
    'timed out',
    'timeout',
    'crashed',
    'unhealthy',
    'red',
  ],
  runningKeywords: [
    'running',
    'in progress',
    'pending',
    'queued',
    'building',
    'deploying',
    'executing',
    'starting',
    'provisioning',
    'processing',
    'loading',
    'waiting',
  ],
  telegramEnabled: false,
  telegramToken: '',
  telegramChatId: '',
  discordEnabled: false,
  discordWebhookUrl: '',
  slackEnabled: false,
  slackWebhookUrl: '',
};

/** Soft cap: past this many active revisit watches the popup shows a warning. */
export const REVISIT_SOFT_CAP = 30;

/** Minimum spacing between two checks against the same host (politeness). */
export const HOST_SPACING_MS = 60_000;

/** Interval presets offered in the config card (minutes). */
export const INTERVAL_PRESETS = [15, 30, 60, 360, 1440] as const;

// ---- Check specs & snapshots ---------------------------------------------

/** Serializable description of what to look at on a page. */
export interface CheckSpec {
  selector?: string;
  /** elementAppears: match a button/link by text if the selector fails. */
  expectText?: string;
  /** keyword condition: phrase to search the page body for. */
  keyword?: string;
  wantPrice?: boolean;
}

/** Result of inspecting a document against a CheckSpec. */
export interface Snapshot {
  found: boolean;
  visible: boolean;
  enabled: boolean;
  text: string;
  price: number | null;
  currency?: string;
  keywordPresent?: boolean;
  /** Password field present + target missing: probably a login wall. */
  loginWall?: boolean;
  /** True when taken from a live, rendered DOM (vs fetched raw HTML). */
  rendered: boolean;
}

/** What the content script detected inside a snipped region. */
export interface RegionInfo {
  selector: string;
  text: string;
  price: number | null;
  currency?: string;
  /** Looks like a button/link/input — an "appears/enabled" candidate. */
  buttonish: boolean;
  visible: boolean;
  enabled: boolean;
}

/** Config chosen by the user in the in-page card after snipping. */
export interface CreateWatchConfig {
  selector: string;
  label: string;
  baselineText: string;
  condition: Condition;
  mode: WatchMode;
  intervalMinutes: number;
  thumb?: string;
}

// ---- Messages -------------------------------------------------------------

/** Messages: content/popup -> background. */
export type BackgroundMessage =
  | { kind: 'get-watches-for-tab' }
  | { kind: 'check-result'; watchId: string; snapshot: Snapshot }
  | { kind: 'element-missing'; watchId: string }
  | { kind: 'add-title-watch'; tabId: number }
  | { kind: 'start-snip'; tabId: number }
  | { kind: 'snip-cancelled' }
  | { kind: 'capture-region'; rect: { x: number; y: number; w: number; h: number }; dpr: number }
  | { kind: 'create-watch'; config: CreateWatchConfig }
  | { kind: 'remove-watch'; watchId: string }
  | { kind: 'check-now'; watchId: string }
  | { kind: 'clear-finished' }
  | { kind: 'test-channel'; channel: 'telegram' | 'discord' | 'slack' };

/** Messages: background -> content. */
export type ContentMessage =
  | { kind: 'begin-snip' }
  | { kind: 'sync-watches'; watches: Watch[] }
  | { kind: 'run-check'; spec: CheckSpec }
  | { kind: 'show-toast'; text: string };

/** Messages: background -> offscreen document. */
export type OffscreenMessage = {
  kind: 'parse-html-check';
  html: string;
  spec: CheckSpec;
};
