import { formatPrice } from '../../shared/price';
import { getSettings, getWatches, setSettings } from '../../shared/storage';
import {
  REVISIT_SOFT_CAP,
  type BackgroundMessage,
  type PricePoint,
  type Watch,
} from '../../shared/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const watchList = $<HTMLUListElement>('watch-list');
const emptyState = $('empty-state');
const clearBtn = $<HTMLButtonElement>('clear-finished');
const capWarning = $('cap-warning');

function send(message: BackgroundMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---- Actions --------------------------------------------------------------

$('watch-title').addEventListener('click', async () => {
  const tab = await currentTab();
  if (tab?.id) {
    await send({ kind: 'add-title-watch', tabId: tab.id });
    await render();
  }
});

$('snip-area').addEventListener('click', async () => {
  const tab = await currentTab();
  if (tab?.id) {
    await send({ kind: 'start-snip', tabId: tab.id });
    window.close(); // get out of the way so the user can drag on the page
  }
});

clearBtn.addEventListener('click', async () => {
  await send({ kind: 'clear-finished' });
  await render();
});

// ---- Watch list -------------------------------------------------------------

function duration(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function timeAgo(ts: number): string {
  return duration(Date.now() - ts);
}

function conditionLabel(watch: Watch): string {
  switch (watch.condition.kind) {
    case 'statusChange':
      return watch.type === 'title' ? 'title' : 'status';
    case 'elementAppears':
      return 'appears';
    case 'priceThreshold':
      return 'price';
    case 'keyword':
      return `\u201c${watch.condition.phrase.slice(0, 16)}\u201d`;
  }
}

function watchingSubtitle(watch: Watch): string {
  const parts: string[] = [conditionLabel(watch)];
  if (watch.condition.kind === 'priceThreshold' && watch.lastPrice !== undefined) {
    parts.push(formatPrice(watch.lastPrice, watch.condition.currency));
  }
  if (watch.mode === 'revisit') {
    if (watch.lastCheckedAt) parts.push(`checked ${timeAgo(watch.lastCheckedAt)} ago`);
    if (watch.nextCheckAt && watch.nextCheckAt > Date.now()) {
      parts.push(`next in ${duration(watch.nextCheckAt - Date.now())}`);
    }
  } else {
    parts.push(`watching for ${timeAgo(watch.createdAt)}`);
  }
  return parts.join(' \u00b7 ');
}

/** Tiny inline price-history chart: green when trending down (good). */
function sparkline(history: PricePoint[]): SVGSVGElement | null {
  if (history.length < 2) return null;
  const W = 56;
  const H = 20;
  const PAD = 2;
  const values = history.map((p) => p.p);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = PAD + i * step;
      const y = PAD + (1 - (v - min) / span) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.add('spark');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute(
    'stroke',
    (values.at(-1) ?? 0) < (values.at(0) ?? 0) ? '#22c55e' : '#9c96b8',
  );
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  svg.append(
    Object.assign(document.createElementNS(NS, 'title'), {
      textContent: `${history.length} price points \u00b7 low ${min} \u00b7 high ${max}`,
    }),
  );
  return svg;
}

function renderWatch(watch: Watch): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'watch';

  const dot = document.createElement('span');
  dot.className = `dot ${watch.status}`;

  const icon = document.createElement('img');
  if (watch.thumb) {
    icon.className = 'thumb';
    icon.src = watch.thumb;
  } else {
    icon.className = 'favicon';
    icon.src = watch.favIconUrl || 'icon/32.png';
  }
  icon.alt = '';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = watch.label;
  label.title = `${watch.pageTitle}\n${watch.url}`;

  const sub = document.createElement('div');
  sub.className = 'sub';
  if (watch.status === 'watching') {
    sub.textContent = watchingSubtitle(watch);
  } else {
    const verdict = document.createElement('span');
    const cls =
      watch.status === 'done'
        ? 'done'
        : watch.status === 'failed'
          ? 'failed'
          : watch.status === 'attention'
            ? 'attention'
            : 'changed';
    verdict.className = `verdict-${cls}`;
    verdict.textContent = watch.verdict ?? watch.status;
    sub.append(verdict);
    if (watch.completedAt) {
      sub.append(
        document.createTextNode(
          ` \u00b7 ${timeAgo(watch.completedAt)} ago \u00b7 took ${duration(watch.completedAt - watch.createdAt)}`,
        ),
      );
    }
  }
  meta.append(label, sub);

  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.textContent = '\u00d7';
  remove.title = 'Stop watching';
  remove.addEventListener('click', async (e) => {
    e.stopPropagation();
    await send({ kind: 'remove-watch', watchId: watch.id });
    await render();
  });

  li.append(dot, icon, meta, remove);

  if (watch.condition.kind === 'priceThreshold' && watch.priceHistory) {
    const spark = sparkline(watch.priceHistory);
    if (spark) li.insertBefore(spark, remove);
  }

  if (watch.status === 'watching' && watch.mode === 'revisit') {
    const checkNow = document.createElement('button');
    checkNow.className = 'remove check-now';
    checkNow.textContent = '\u21bb';
    checkNow.title = 'Check now';
    checkNow.addEventListener('click', async (e) => {
      e.stopPropagation();
      checkNow.disabled = true;
      await send({ kind: 'check-now', watchId: watch.id });
      await render();
    });
    li.insertBefore(checkNow, remove);
  }

  li.addEventListener('click', async () => {
    try {
      if (watch.tabId === undefined) throw new Error('no tab');
      const tab = await chrome.tabs.get(watch.tabId);
      await chrome.tabs.update(watch.tabId, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      await chrome.tabs.create({ url: watch.url });
    }
    window.close();
  });
  return li;
}

async function render(): Promise<void> {
  const watches = await getWatches();
  watches.sort((a, b) => {
    const rank = (w: Watch): number =>
      w.status === 'attention' ? 0 : w.status === 'watching' ? 1 : 2;
    return rank(a) - rank(b) || b.createdAt - a.createdAt;
  });

  watchList.replaceChildren(...watches.map(renderWatch));
  emptyState.hidden = watches.length > 0;
  clearBtn.hidden = !watches.some((w) => w.status !== 'watching');

  const revisitActive = watches.filter(
    (w) => w.status === 'watching' && w.mode === 'revisit',
  ).length;
  capWarning.hidden = revisitActive <= REVISIT_SOFT_CAP;
}

// ---- Settings ---------------------------------------------------------------

const notifyAnyChange = $<HTMLInputElement>('notify-any-change');
const kwSuccess = $<HTMLInputElement>('kw-success');
const kwFailure = $<HTMLInputElement>('kw-failure');
const kwRunning = $<HTMLInputElement>('kw-running');

function parseKeywords(raw: string): string[] {
  return raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

interface ChannelUi {
  channel: 'telegram' | 'discord' | 'slack';
  enabled: HTMLInputElement;
  fields: HTMLElement;
  status: HTMLElement;
  inputs: HTMLInputElement[];
}

const channels: ChannelUi[] = [
  {
    channel: 'telegram',
    enabled: $<HTMLInputElement>('telegram-enabled'),
    fields: $('telegram-fields'),
    status: $('telegram-status'),
    inputs: [$<HTMLInputElement>('telegram-token'), $<HTMLInputElement>('telegram-chat-id')],
  },
  {
    channel: 'discord',
    enabled: $<HTMLInputElement>('discord-enabled'),
    fields: $('discord-fields'),
    status: $('discord-status'),
    inputs: [$<HTMLInputElement>('discord-webhook')],
  },
  {
    channel: 'slack',
    enabled: $<HTMLInputElement>('slack-enabled'),
    fields: $('slack-fields'),
    status: $('slack-status'),
    inputs: [$<HTMLInputElement>('slack-webhook')],
  },
];

async function loadSettings(): Promise<void> {
  const s = await getSettings();
  notifyAnyChange.checked = s.notifyOnAnyChange;
  kwSuccess.value = s.successKeywords.join(', ');
  kwFailure.value = s.failureKeywords.join(', ');
  kwRunning.value = s.runningKeywords.join(', ');
  $<HTMLInputElement>('telegram-enabled').checked = s.telegramEnabled;
  $<HTMLInputElement>('telegram-token').value = s.telegramToken;
  $<HTMLInputElement>('telegram-chat-id').value = s.telegramChatId;
  $<HTMLInputElement>('discord-enabled').checked = s.discordEnabled;
  $<HTMLInputElement>('discord-webhook').value = s.discordWebhookUrl;
  $<HTMLInputElement>('slack-enabled').checked = s.slackEnabled;
  $<HTMLInputElement>('slack-webhook').value = s.slackWebhookUrl;
  for (const c of channels) c.fields.hidden = !c.enabled.checked;
}

async function saveSettings(): Promise<void> {
  const s = await getSettings();
  s.notifyOnAnyChange = notifyAnyChange.checked;
  // Empty fields fall back to the defaults rather than disabling detection.
  const success = parseKeywords(kwSuccess.value);
  const failure = parseKeywords(kwFailure.value);
  const running = parseKeywords(kwRunning.value);
  if (success.length > 0) s.successKeywords = success;
  if (failure.length > 0) s.failureKeywords = failure;
  if (running.length > 0) s.runningKeywords = running;
  s.telegramEnabled = $<HTMLInputElement>('telegram-enabled').checked;
  s.telegramToken = $<HTMLInputElement>('telegram-token').value.trim();
  s.telegramChatId = $<HTMLInputElement>('telegram-chat-id').value.trim();
  s.discordEnabled = $<HTMLInputElement>('discord-enabled').checked;
  s.discordWebhookUrl = $<HTMLInputElement>('discord-webhook').value.trim();
  s.slackEnabled = $<HTMLInputElement>('slack-enabled').checked;
  s.slackWebhookUrl = $<HTMLInputElement>('slack-webhook').value.trim();
  await setSettings(s);
  for (const c of channels) c.fields.hidden = !c.enabled.checked;
}

notifyAnyChange.addEventListener('change', () => void saveSettings());
for (const kw of [kwSuccess, kwFailure, kwRunning]) {
  kw.addEventListener('change', () => void saveSettings());
}
for (const c of channels) {
  c.enabled.addEventListener('change', () => void saveSettings());
  for (const input of c.inputs) input.addEventListener('change', () => void saveSettings());
  $(`test-${c.channel}`).addEventListener('click', async () => {
    await saveSettings();
    c.status.textContent = 'Sending\u2026';
    const res = (await send({ kind: 'test-channel', channel: c.channel })) as
      | { ok: boolean }
      | undefined;
    c.status.textContent = res?.ok
      ? 'Sent! Check the channel.'
      : 'Failed \u2014 double-check the credentials and that you\u2019re online.';
  });
}

// ---- Notification permission check --------------------------------------

chrome.notifications.getPermissionLevel((level) => {
  $('perm-warning').hidden = level === 'granted';
});

$('test-chrome').addEventListener('click', () => {
  const status = $('chrome-status');
  status.textContent = 'Sending\u2026';
  chrome.notifications.create(
    `test:${Date.now()}`,
    {
      type: 'basic',
      iconUrl: 'icon/128.png',
      title: '\u{1F514} TabBell test',
      message: 'If you can see this, Chrome notifications work.',
      priority: 2,
    },
    () => {
      if (chrome.runtime.lastError) {
        status.textContent = `Chrome error: ${chrome.runtime.lastError.message}`;
      } else {
        status.textContent =
          'Sent. If nothing popped up, your OS is hiding Chrome notifications \u2014 ' +
          'check your system notification settings for Chrome (and Do Not Disturb / Focus).';
      }
    },
  );
});

// ---- Live refresh -------------------------------------------------------------

chrome.storage.onChanged.addListener(() => void render());
setInterval(() => void render(), 5000);

void loadSettings();
void render();
