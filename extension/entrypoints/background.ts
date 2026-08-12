import { evaluate, specForWatch, verdictLabel, type Outcome } from '../shared/conditions';
import type { Verdict } from '../shared/detect';
import { fanout, sendTest } from '../shared/notify';
import {
  getSettings,
  getWatches,
  newWatchId,
  removeWatch,
  setWatches,
  upsertWatch,
} from '../shared/storage';
import type {
  BackgroundMessage,
  CheckSpec,
  ContentMessage,
  CreateWatchConfig,
  Snapshot,
  Watch,
} from '../shared/types';
import { HOST_SPACING_MS } from '../shared/types';

const POLL_ALARM = 'tabbell-poll';
const REVISIT_ALARM = 'tabbell-revisit';
const MENU_WATCH_TITLE = 'tabbell-watch-title';
const MENU_SNIP = 'tabbell-snip';
/** Give up on an element only after this many consecutive missed checks. */
const MAX_MISSING_POLLS = 4;
/** Extra wait after a check tab reports "complete" so SPAs can hydrate. */
const SETTLE_MS = 2500;
const TAB_LOAD_TIMEOUT_MS = 30_000;

/** In-memory politeness ledger: host -> last check timestamp. */
const hostLastCheck = new Map<string, number>();
let revisitRunning = false;

export default defineBackground(() => {
  // ---- Setup ------------------------------------------------------------

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: MENU_WATCH_TITLE,
      title: 'TabBell: notify me when this tab\u2019s title changes',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_SNIP,
      title: 'TabBell: snip an area to watch\u2026',
      contexts: ['page'],
    });
    void bootstrap();
  });

  chrome.runtime.onStartup.addListener(() => void bootstrap());

  async function bootstrap(): Promise<void> {
    // Drop alarms created under old names (pre-rename) before re-creating.
    await chrome.alarms.clearAll();
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
    await chrome.alarms.create(REVISIT_ALARM, { periodInMinutes: 1 });
    await migrateWatches();
    await updateBadge();
  }

  /** Upgrade watches stored by older TabBell versions in place. */
  async function migrateWatches(): Promise<void> {
    const watches = await getWatches();
    let dirty = false;
    for (const w of watches) {
      if (!w.mode) {
        w.mode = 'live';
        dirty = true;
      }
      if (!w.condition) {
        w.condition = { kind: 'statusChange' };
        dirty = true;
      }
    }
    if (dirty) await setWatches(watches);
  }

  // ---- Context menu -----------------------------------------------------

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === MENU_WATCH_TITLE) void addTitleWatch(tab.id);
    if (info.menuItemId === MENU_SNIP) void startSnip(tab.id);
  });

  // ---- Tab lifecycle ----------------------------------------------------

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (typeof changeInfo.title === 'string') {
      void handleTitleChange(tabId, changeInfo.title);
    }
    if (typeof changeInfo.url === 'string') {
      void handleNavigation(tabId, changeInfo.url);
    }
    if (typeof changeInfo.favIconUrl === 'string') {
      void updateFavicon(tabId, changeInfo.favIconUrl);
    }
    // A reload finished: re-sync watches into the fresh content script.
    if (changeInfo.status === 'complete' && tab.url) {
      void syncWatchesToTab(tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void handleTabClosed(tabId);
  });

  // ---- Notifications ----------------------------------------------------

  chrome.notifications.onClicked.addListener((notificationId) => {
    void focusWatchTab(notificationId.replace(/:\d+$/, ''));
    void chrome.notifications.clear(notificationId);
  });

  // ---- Alarms -------------------------------------------------------------

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM) void pollLiveWatches();
    if (alarm.name === REVISIT_ALARM) void runDueRevisits();
  });

  // ---- Keyboard shortcuts -------------------------------------------------

  chrome.commands.onCommand.addListener((command, tab) => {
    if (!tab?.id) return;
    if (command === 'watch-tab') void addTitleWatch(tab.id);
    if (command === 'snip-element') void startSnip(tab.id);
  });

  // ---- Message hub ------------------------------------------------------

  chrome.runtime.onMessage.addListener(
    (message: BackgroundMessage, sender, sendResponse) => {
      // The offscreen parser answers its own message kind.
      if ((message as { kind?: string }).kind === 'parse-html-check') return false;
      void (async () => {
        switch (message.kind) {
          case 'get-watches-for-tab': {
            const tabId = sender.tab?.id;
            const watches = await getWatches();
            sendResponse(
              watches.filter(
                (w) =>
                  w.tabId === tabId &&
                  w.type === 'element' &&
                  w.status === 'watching' &&
                  !!w.selector,
              ),
            );
            break;
          }
          case 'check-result': {
            await handleSnapshot(message.watchId, message.snapshot);
            sendResponse({ ok: true });
            break;
          }
          case 'element-missing': {
            await bumpMissing(message.watchId);
            sendResponse({ ok: true });
            break;
          }
          case 'add-title-watch': {
            await addTitleWatch(message.tabId);
            sendResponse({ ok: true });
            break;
          }
          case 'start-snip': {
            await startSnip(message.tabId);
            sendResponse({ ok: true });
            break;
          }
          case 'snip-cancelled': {
            sendResponse({ ok: true });
            break;
          }
          case 'capture-region': {
            const thumb = await captureRegion(sender.tab, message.rect, message.dpr);
            sendResponse(thumb);
            break;
          }
          case 'create-watch': {
            if (sender.tab) await createWatchFromConfig(sender.tab, message.config);
            sendResponse({ ok: true });
            break;
          }
          case 'remove-watch': {
            const removed = await removeWatch(message.watchId);
            if (removed?.tabId !== undefined) {
              await releaseTabIfUnwatched(removed.tabId);
              await syncWatchesToTab(removed.tabId);
            }
            await updateBadge();
            sendResponse({ ok: true });
            break;
          }
          case 'check-now': {
            await forceCheck(message.watchId);
            sendResponse({ ok: true });
            break;
          }
          case 'clear-finished': {
            const watches = await getWatches();
            await setWatches(watches.filter((w) => w.status === 'watching'));
            await updateBadge();
            sendResponse({ ok: true });
            break;
          }
          case 'test-channel': {
            const settings = await getSettings();
            sendResponse({ ok: await sendTest(settings, message.channel) });
            break;
          }
        }
      })();
      return true; // keep the message channel open for the async response
    },
  );
});

// ---- Watch creation -----------------------------------------------------

async function addTitleWatch(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isWatchableUrl(tab.url)) {
    notifyUnwatchable();
    return;
  }
  const existing = await getWatches();
  if (existing.some((w) => w.tabId === tabId && w.type === 'title' && w.status === 'watching')) {
    await showToast(tabId, 'Already watching this tab');
    return;
  }
  const watch: Watch = {
    id: newWatchId(),
    type: 'title',
    mode: 'live',
    condition: { kind: 'statusChange' },
    tabId,
    url: tab.url,
    pageTitle: tab.title ?? tab.url,
    favIconUrl: tab.favIconUrl,
    label: tab.title ?? tab.url,
    baselineText: tab.title ?? '',
    lastText: tab.title ?? '',
    status: 'watching',
    createdAt: Date.now(),
  };
  await upsertWatch(watch);
  await pinTab(tabId);
  await updateBadge();
  await showToast(tabId, 'Watching this tab \u2014 you\u2019ll get pinged when it finishes');
}

async function createWatchFromConfig(
  tab: chrome.tabs.Tab,
  config: CreateWatchConfig,
): Promise<void> {
  if (!tab.id || !tab.url || !isWatchableUrl(tab.url)) return;
  const now = Date.now();
  const watch: Watch = {
    id: newWatchId(),
    type: 'element',
    mode: config.mode,
    condition: config.condition,
    tabId: tab.id,
    url: tab.url,
    pageTitle: tab.title ?? tab.url,
    favIconUrl: tab.favIconUrl,
    label: config.label,
    selector: config.selector,
    baselineText: config.baselineText,
    lastText: config.baselineText,
    status: 'watching',
    thumb: config.thumb,
    createdAt: now,
  };
  if (config.mode === 'revisit') {
    watch.intervalMinutes = config.intervalMinutes;
    watch.nextCheckAt = now + config.intervalMinutes * 60_000;
  }
  if (config.condition.kind === 'priceThreshold' && config.condition.baselinePrice) {
    watch.lastPrice = config.condition.baselinePrice;
    watch.priceHistory = [{ t: now, p: config.condition.baselinePrice }];
  }
  await upsertWatch(watch);
  if (config.mode === 'live') await pinTab(tab.id);
  await updateBadge();
  await syncWatchesToTab(tab.id);
  const how =
    config.mode === 'live'
      ? 'keep this tab open'
      : `checking every ${config.intervalMinutes >= 60 ? `${Math.round(config.intervalMinutes / 60)}h` : `${config.intervalMinutes}m`}, tab can be closed`;
  await showToast(tab.id, `Watching \u201c${watch.label.slice(0, 40)}\u201d \u2014 ${how}`);
}

async function startSnip(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isWatchableUrl(tab.url)) {
    notifyUnwatchable();
    return;
  }
  const result = await messageTab(tabId, { kind: 'begin-snip' }, true);
  if (result === undefined) {
    // Content script could not be reached or injected on this page.
    const isFile = tab.url.startsWith('file://');
    notifyError(
      'TabBell can\u2019t run here',
      isFile
        ? 'For local files, enable \u201cAllow access to file URLs\u201d for TabBell in chrome://extensions, then reload the page.'
        : 'This page blocks extensions. Try reloading the page first.',
    );
  }
}

function notifyUnwatchable(): void {
  notifyError(
    'TabBell can\u2019t watch this page',
    'Chrome internal pages and the Web Store aren\u2019t supported. Open a normal website and try again.',
  );
}

function notifyError(title: string, message: string): void {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('/icon/128.png'),
    title,
    message,
    priority: 1,
  });
}

// ---- Region thumbnail -----------------------------------------------------

async function captureRegion(
  tab: chrome.tabs.Tab | undefined,
  rect: { x: number; y: number; w: number; h: number },
  dpr: number,
): Promise<string | undefined> {
  if (!tab?.windowId) return undefined;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 80,
    });
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const sx = rect.x * dpr;
    const sy = rect.y * dpr;
    const sw = Math.min(rect.w * dpr, bitmap.width - sx);
    const sh = Math.min(rect.h * dpr, bitmap.height - sy);
    if (sw <= 0 || sh <= 0) return undefined;
    const targetW = Math.min(320, sw);
    const targetH = Math.round((sh / sw) * targetW);
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, targetW, targetH);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return await blobToDataUrl(out);
  } catch {
    return undefined; // thumbnail is a nicety, never block watch creation
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// ---- Helpers ---------------------------------------------------------------

function isWatchableUrl(url: string): boolean {
  return (
    url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')
  );
}

async function showToast(tabId: number, text: string): Promise<void> {
  await messageTab(tabId, { kind: 'show-toast', text }, false);
}

/** Send to a tab's content script, optionally injecting it first. */
async function messageTab(
  tabId: number,
  msg: ContentMessage,
  injectIfMissing: boolean,
): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    if (!injectIfMissing) return undefined;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/content.js'],
      });
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      return undefined;
    }
  }
}

/** Keep watched tabs alive: Chrome's Memory Saver must not discard them. */
async function pinTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    /* tab may be gone */
  }
}

async function releaseTabIfUnwatched(tabId: number): Promise<void> {
  const watches = await getWatches();
  const stillWatched = watches.some(
    (w) => w.tabId === tabId && w.status === 'watching' && w.mode === 'live',
  );
  if (!stillWatched) {
    try {
      await chrome.tabs.update(tabId, { autoDiscardable: true });
    } catch {
      /* tab may be gone */
    }
  }
}

// ---- Change evaluation ----------------------------------------------------

async function handleTitleChange(tabId: number, title: string): Promise<void> {
  const watches = await getWatches();
  const titleWatches = watches.filter(
    (w) => w.tabId === tabId && w.type === 'title' && w.status === 'watching',
  );
  for (const watch of titleWatches) {
    await handleSnapshot(watch.id, {
      found: true,
      visible: true,
      enabled: true,
      text: title,
      price: null,
      rendered: true,
    });
  }
}

/** Central entry point: apply a snapshot to a watch via the condition engine. */
async function handleSnapshot(watchId: string, snapshot: Snapshot): Promise<void> {
  const watches = await getWatches();
  const watch = watches.find((w) => w.id === watchId);
  if (!watch || watch.status !== 'watching') return;

  const settings = await getSettings();
  const outcome: Outcome = evaluate(watch, snapshot, settings);
  await applyOutcome(watch, outcome);
}

async function applyOutcome(watch: Watch, outcome: Outcome): Promise<void> {
  switch (outcome.action) {
    case 'none':
      await upsertWatch(watch);
      return;
    case 'missing':
      await upsertWatch(watch);
      await bumpMissing(watch.id);
      return;
    case 'attention': {
      const first = watch.status !== 'attention';
      watch.status = 'attention';
      watch.verdict = outcome.reason;
      watch.completedAt = Date.now();
      await upsertWatch(watch);
      await updateBadge();
      if (first) {
        await deliver(watch, 'TabBell needs you', `${watch.pageTitle}\n${outcome.reason}`, true);
      }
      return;
    }
    case 'confirm-rendered':
      // Positive result from raw HTML — verify with a real rendered tab.
      await upsertWatch(watch);
      await runTabCheck(watch);
      return;
    case 'complete':
      await completeWatch(watch, outcome.verdict, outcome.title, outcome.body);
      return;
    case 'notify': {
      // Continuous watch (price/keyword): ping but keep watching.
      watch.lastNotifiedAt = Date.now();
      await upsertWatch(watch);
      await updateBadge();
      await deliver(watch, outcome.title, outcome.body, false);
      return;
    }
  }
}

async function completeWatch(
  watch: Watch,
  verdict: Verdict,
  title: string,
  body: string,
): Promise<void> {
  watch.status = verdict === 'failure' ? 'failed' : verdict === 'success' ? 'done' : 'changed';
  watch.verdict = verdictLabel(verdict);
  watch.completedAt = Date.now();
  await upsertWatch(watch);
  if (watch.tabId !== undefined) await releaseTabIfUnwatched(watch.tabId);
  await updateBadge();
  await deliver(watch, title, body, verdict === 'failure');
}

/** Chrome notification + free channel fan-out. */
async function deliver(watch: Watch, title: string, body: string, urgent: boolean): Promise<void> {
  chrome.notifications.create(`${watch.id}:${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('/icon/128.png'),
    title: `\u{1F514} ${title}`,
    message: body,
    priority: 2,
    requireInteraction: urgent,
  });
  const settings = await getSettings();
  await fanout(settings, { title: `TabBell: ${title}`, body, url: watch.url, failed: urgent });
}

async function focusWatchTab(watchId: string): Promise<void> {
  const watches = await getWatches();
  const watch = watches.find((w) => w.id === watchId);
  if (!watch) return;
  try {
    if (watch.tabId === undefined) throw new Error('no tab');
    const tab = await chrome.tabs.get(watch.tabId);
    await chrome.tabs.update(watch.tabId, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Tab is gone — reopen the URL instead.
    await chrome.tabs.create({ url: watch.url });
  }
}

// ---- Live polling fallback --------------------------------------------------

/**
 * Periodic re-check for live watches only. Confirms pending stability
 * windows, catches changes the MutationObserver missed (SW eviction, page
 * re-render), and detects dead tabs. Revisit watches have their own scheduler.
 */
async function pollLiveWatches(): Promise<void> {
  const watches = await getWatches();
  const active = watches.filter((w) => w.status === 'watching' && w.mode === 'live');

  for (const watch of active) {
    if (watch.tabId === undefined) continue;
    if (watch.type === 'title') {
      try {
        const tab = await chrome.tabs.get(watch.tabId);
        await handleSnapshot(watch.id, {
          found: true,
          visible: true,
          enabled: true,
          text: tab.title ?? '',
          price: null,
          rendered: true,
        });
      } catch {
        await markWatchLost(watch.id, 'Tab is no longer reachable');
      }
      continue;
    }
    const snapshot = (await messageTab(
      watch.tabId,
      { kind: 'run-check', spec: specForWatch(watch) },
      true,
    )) as Snapshot | undefined;
    if (snapshot) await handleSnapshot(watch.id, snapshot);
    else await markWatchLost(watch.id, 'Tab is no longer reachable');
  }
}

// ---- Revisit engine ---------------------------------------------------------

/**
 * Fetch-first, tab-fallback background checking. Runs at most one check at
 * a time, respects per-host spacing, and remembers the cheapest strategy
 * that works for each watch.
 */
async function runDueRevisits(): Promise<void> {
  if (revisitRunning) return;
  revisitRunning = true;
  try {
    const now = Date.now();
    const watches = await getWatches();
    const due = watches
      .filter(
        (w) =>
          w.status === 'watching' && w.mode === 'revisit' && (w.nextCheckAt ?? 0) <= now,
      )
      .sort((a, b) => (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0));

    for (const watch of due) {
      const host = hostOf(watch.url);
      const last = hostLastCheck.get(host) ?? 0;
      if (Date.now() - last < HOST_SPACING_MS) {
        // Same host hit too recently — nudge to the next alarm tick.
        watch.nextCheckAt = Date.now() + 90_000;
        await upsertWatch(watch);
        continue;
      }
      hostLastCheck.set(host, Date.now());
      await runRevisitCheck(watch);
    }
  } finally {
    revisitRunning = false;
  }
}

async function runRevisitCheck(watch: Watch): Promise<void> {
  // Schedule the next check up front so errors can never create tight loops.
  const interval = (watch.intervalMinutes ?? 30) * 60_000;
  const jitter = 0.9 + Math.random() * 0.2;
  watch.lastCheckedAt = Date.now();
  watch.nextCheckAt = Date.now() + Math.round(interval * jitter);
  await upsertWatch(watch);

  // If the page happens to be open in some tab, check it there — free.
  const openTab = await findOpenTab(watch.url);
  if (openTab?.id !== undefined) {
    const snapshot = (await messageTab(
      openTab.id,
      { kind: 'run-check', spec: specForWatch(watch) },
      true,
    )) as Snapshot | undefined;
    if (snapshot) {
      await handleSnapshot(watch.id, snapshot);
      return;
    }
  }

  const spec = specForWatch(watch);

  if (watch.checkStrategy !== 'tab') {
    const snapshot = await runFetchCheck(watch.url, spec);
    if (snapshot && fetchResultUsable(watch, snapshot)) {
      if (watch.checkStrategy !== 'fetch') {
        watch.checkStrategy = 'fetch';
        await upsertWatch(watch);
      }
      await handleSnapshot(watch.id, snapshot);
      return;
    }
    if (watch.checkStrategy === 'fetch') {
      // Fetch used to work but stopped — page changed; try a tab once.
      watch.checkStrategy = undefined;
      await upsertWatch(watch);
    }
  }

  const found = await runTabCheck(watch);
  if (found && watch.checkStrategy === undefined) {
    const fresh = await getWatch(watch.id);
    if (fresh && fresh.status === 'watching') {
      fresh.checkStrategy = 'tab';
      await upsertWatch(fresh);
    }
  }
}

/**
 * Is the fetched-HTML snapshot conclusive enough to skip opening a tab?
 * - keyword: body text parsed at all -> usable.
 * - price: we found a price -> usable.
 * - element/status: the target element exists in raw HTML -> usable.
 *   (elementAppears positives are still tab-confirmed by the engine.)
 * - "not found" is only trusted once we know fetch works for this page.
 */
function fetchResultUsable(watch: Watch, snapshot: Snapshot): boolean {
  switch (watch.condition.kind) {
    case 'keyword':
      return snapshot.keywordPresent !== undefined;
    case 'priceThreshold':
      return snapshot.price !== null || watch.checkStrategy === 'fetch';
    case 'elementAppears':
      return snapshot.found || watch.checkStrategy === 'fetch';
    case 'statusChange':
      return snapshot.found || watch.checkStrategy === 'fetch';
  }
}

async function runFetchCheck(url: string, spec: CheckSpec): Promise<Snapshot | undefined> {
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return undefined;
    const html = await res.text();
    await ensureOffscreenDocument();
    const snapshot = (await chrome.runtime.sendMessage({
      kind: 'parse-html-check',
      html,
      spec,
    })) as Snapshot | undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse fetched HTML for background page checks without opening a tab',
    });
  } catch {
    /* a concurrent create may have raced us — hasDocument covers next call */
  }
}

/** Open the URL in a background tab, snapshot it, close it. Serialized. */
async function runTabCheck(watch: Watch): Promise<boolean> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.create({ url: watch.url, active: false });
    if (tab.id === undefined) return false;
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    await sleep(SETTLE_MS);
    const snapshot = (await messageTab(
      tab.id,
      { kind: 'run-check', spec: specForWatch(watch) },
      true,
    )) as Snapshot | undefined;
    if (snapshot) {
      await handleSnapshot(watch.id, snapshot);
      return snapshot.found;
    }
    await bumpMissing(watch.id);
    return false;
  } catch {
    await bumpMissing(watch.id);
    return false;
  } finally {
    if (tab?.id !== undefined) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* already closed */
      }
    }
  }
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(id: number, changeInfo: { status?: string }): void {
      if (id === tabId && changeInfo.status === 'complete') done();
    }
    function done(): void {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') done();
    });
  });
}

async function findOpenTab(url: string): Promise<chrome.tabs.Tab | undefined> {
  try {
    const tabs = await chrome.tabs.query({ url: url.split('#')[0] });
    return tabs[0];
  } catch {
    return undefined;
  }
}

async function forceCheck(watchId: string): Promise<void> {
  const watch = await getWatch(watchId);
  if (!watch || watch.status !== 'watching' || watch.mode !== 'revisit') return;
  watch.nextCheckAt = 0;
  await upsertWatch(watch);
  await runDueRevisits();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getWatch(watchId: string): Promise<Watch | undefined> {
  const watches = await getWatches();
  return watches.find((w) => w.id === watchId);
}

// ---- Housekeeping -------------------------------------------------------

/**
 * Tolerate transient element disappearance (skeleton loaders, SPA
 * re-renders): only declare the watch lost after several consecutive misses.
 */
async function bumpMissing(watchId: string): Promise<void> {
  const watch = await getWatch(watchId);
  if (!watch || watch.status !== 'watching') return;
  watch.missingCount = (watch.missingCount ?? 0) + 1;
  if (watch.missingCount >= MAX_MISSING_POLLS) {
    watch.status = 'lost';
    watch.verdict = 'Watched element disappeared';
    watch.completedAt = Date.now();
    await upsertWatch(watch);
    await updateBadge();
  } else {
    await upsertWatch(watch);
  }
}

async function handleNavigation(tabId: number, newUrl: string): Promise<void> {
  const watches = await getWatches();
  let dirty = false;
  for (const watch of watches) {
    if (watch.tabId !== tabId || watch.status !== 'watching') continue;
    // Revisit watches are URL-bound, not tab-bound: just detach the tab.
    if (watch.mode === 'revisit') {
      if (watch.url.split('#')[0] !== newUrl.split('#')[0]) {
        watch.tabId = undefined;
        dirty = true;
      }
      continue;
    }
    try {
      const oldHost = new URL(watch.url).host;
      const newHost = new URL(newUrl).host;
      if (oldHost !== newHost) {
        watch.status = 'lost';
        watch.verdict = 'Tab navigated away';
        watch.completedAt = Date.now();
        dirty = true;
      } else {
        watch.url = newUrl;
        dirty = true;
      }
    } catch {
      /* unparseable URL — ignore */
    }
  }
  if (dirty) {
    await setWatches(watches);
    await updateBadge();
  }
}

async function updateFavicon(tabId: number, favIconUrl: string): Promise<void> {
  const watches = await getWatches();
  let dirty = false;
  for (const watch of watches) {
    if (watch.tabId === tabId && watch.status === 'watching' && watch.favIconUrl !== favIconUrl) {
      watch.favIconUrl = favIconUrl;
      dirty = true;
    }
  }
  if (dirty) await setWatches(watches);
}

/** Live watches die with their tab; revisit watches merely detach from it. */
async function handleTabClosed(tabId: number): Promise<void> {
  const watches = await getWatches();
  let dirty = false;
  for (const watch of watches) {
    if (watch.tabId !== tabId || watch.status !== 'watching') continue;
    if (watch.mode === 'revisit') {
      watch.tabId = undefined;
    } else {
      watch.status = 'lost';
      watch.verdict = 'Tab was closed';
      watch.completedAt = Date.now();
    }
    dirty = true;
  }
  if (dirty) {
    await setWatches(watches);
    await updateBadge();
  }
}

async function markWatchLost(watchId: string, reason: string): Promise<void> {
  const watch = await getWatch(watchId);
  if (!watch || watch.status !== 'watching') return;
  watch.status = 'lost';
  watch.verdict = reason;
  watch.completedAt = Date.now();
  await upsertWatch(watch);
  await updateBadge();
}

async function syncWatchesToTab(tabId: number): Promise<void> {
  const watches = await getWatches();
  const forTab = watches.filter(
    (w) => w.tabId === tabId && w.type === 'element' && w.status === 'watching' && !!w.selector,
  );
  const msg: ContentMessage = { kind: 'sync-watches', watches: forTab };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    /* no content script on this page (chrome://, PDF, etc.) */
  }
}

async function updateBadge(): Promise<void> {
  const watches = await getWatches();
  const active = watches.filter((w) => w.status === 'watching').length;
  const attention = watches.filter((w) => w.status === 'attention').length;
  const unseen = watches.filter((w) => w.status !== 'watching').length;
  const text =
    attention > 0 ? '!' : active > 0 ? String(active) : unseen > 0 ? '\u2713' : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: attention > 0 ? '#f59e0b' : active > 0 ? '#6d5efc' : '#22c55e',
  });
}
