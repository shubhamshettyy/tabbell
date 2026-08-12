import { DEFAULT_SETTINGS, type Settings, type Watch } from './types';

const WATCHES_KEY = 'tabbell:watches';
const SETTINGS_KEY = 'tabbell:settings';
/** Pre-rename keys — read once so existing watches survive the rebrand. */
const LEGACY_WATCHES_KEY = 'taskbell:watches';
const LEGACY_SETTINGS_KEY = 'taskbell:settings';

export async function getWatches(): Promise<Watch[]> {
  const res = await chrome.storage.local.get([WATCHES_KEY, LEGACY_WATCHES_KEY]);
  const watches = res[WATCHES_KEY] as Watch[] | undefined;
  if (watches) return watches;
  const legacy = res[LEGACY_WATCHES_KEY] as Watch[] | undefined;
  if (legacy) {
    await chrome.storage.local.set({ [WATCHES_KEY]: legacy });
    await chrome.storage.local.remove(LEGACY_WATCHES_KEY);
    return legacy;
  }
  return [];
}

export async function setWatches(watches: Watch[]): Promise<void> {
  await chrome.storage.local.set({ [WATCHES_KEY]: watches });
}

export async function upsertWatch(watch: Watch): Promise<void> {
  const watches = await getWatches();
  const idx = watches.findIndex((w) => w.id === watch.id);
  if (idx >= 0) watches[idx] = watch;
  else watches.push(watch);
  await setWatches(watches);
}

export async function removeWatch(watchId: string): Promise<Watch | undefined> {
  const watches = await getWatches();
  const removed = watches.find((w) => w.id === watchId);
  await setWatches(watches.filter((w) => w.id !== watchId));
  return removed;
}

export async function getSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY]);
  const stored =
    (res[SETTINGS_KEY] as Partial<Settings> | undefined) ??
    (res[LEGACY_SETTINGS_KEY] as Partial<Settings> | undefined);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await chrome.storage.local.remove(LEGACY_SETTINGS_KEY);
}

export function newWatchId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
