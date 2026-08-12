import type { Settings } from './types';

/**
 * Free notification fan-out. Chrome desktop notifications are handled by
 * the background script directly; these channels forward the same event to
 * the user's phone/chat for $0: Telegram bot, Discord webhook, Slack webhook.
 */

export interface NotifyPayload {
  title: string;
  body: string;
  url?: string;
  failed?: boolean;
}

export type Channel = 'telegram' | 'discord' | 'slack';

export async function fanout(settings: Settings, payload: NotifyPayload): Promise<void> {
  await Promise.allSettled([
    settings.telegramEnabled ? sendTelegram(settings, payload) : Promise.resolve(false),
    settings.discordEnabled ? sendDiscord(settings, payload) : Promise.resolve(false),
    settings.slackEnabled ? sendSlack(settings, payload) : Promise.resolve(false),
  ]);
}

export async function sendTest(settings: Settings, channel: Channel): Promise<boolean> {
  const payload: NotifyPayload = {
    title: 'TabBell test',
    body: 'If you can read this, notifications are wired up.',
  };
  switch (channel) {
    case 'telegram':
      return sendTelegram(settings, payload);
    case 'discord':
      return sendDiscord(settings, payload);
    case 'slack':
      return sendSlack(settings, payload);
  }
}

function messageText(payload: NotifyPayload): string {
  const icon = payload.failed ? '\u274c' : '\u{1F514}';
  const lines = [`${icon} ${payload.title}`, payload.body];
  if (payload.url) lines.push(payload.url);
  return lines.join('\n');
}

async function sendTelegram(settings: Settings, payload: NotifyPayload): Promise<boolean> {
  const token = settings.telegramToken.trim();
  const chatId = settings.telegramChatId.trim();
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: messageText(payload) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendDiscord(settings: Settings, payload: NotifyPayload): Promise<boolean> {
  const url = settings.discordWebhookUrl.trim();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: messageText(payload).slice(0, 1900) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendSlack(settings: Settings, payload: NotifyPayload): Promise<boolean> {
  const url = settings.slackWebhookUrl.trim();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: messageText(payload) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
