# TabBell

Watch anything on any web page — a hidden "Apply" button, a product price, a
CI pipeline status, a phrase like "In stock" — and get pinged the moment it
changes. No servers, no paid APIs, $0 to run.

## What it does

TabBell is a Chrome (MV3) extension built with [WXT](https://wxt.dev). You
either watch the current tab's title, or **snip** a region of the page
(drag a rectangle like a screenshot tool) to pick exactly the element you
care about. TabBell then figures out what you're probably watching for and
lets you fine-tune it before it starts:

- **Status change** — classic CI/pipeline/export use case: text flips
  between "running" / "success" / "failure" keywords (customizable in
  Settings). Handles progress percentages and elapsed timers without
  firing early.
- **Element appears** — for pages that hide a button/link until some
  condition is met (e.g. job postings that hide "Apply" until applications
  open). Fires once the element is present, visible, and enabled.
- **Price threshold** — auto-detects prices (JSON-LD, Amazon markup,
  currency regex) and lets you pick: notify on any change, notify when it
  drops below a value, or notify on an N% drop. Keeps a price history
  (shown as a small sparkline in the popup).
- **Keyword appears/disappears** — for anything phrase-based: back in
  stock, tickets available, appointment slots open, etc.

Two watch modes:

- **Live** — keeps the tab open and watches instantly via a
  `MutationObserver`. Best for something you're actively waiting on (a
  build, an export).
- **Revisit** — the tab can be closed. A background scheduler re-checks the
  page on an interval (15 min / 30 min / 1 h / 6 h / daily). It tries a
  plain `fetch()` first (parsed in an offscreen document — no rendering
  cost) and only falls back to briefly opening a hidden tab if the page
  needs JavaScript to render the target. One check runs at a time, with
  per-host rate limiting, so having many watches doesn't slow Chrome down.

Notifications go out over Chrome's native notifications, and optionally
fan out for free to **Telegram** (bot), **Discord** (webhook), and
**Slack** (webhook) — configurable per-channel in Settings, with a test
button for each.

## Project layout

```
extension/     The Chrome extension (WXT + TypeScript)
  entrypoints/
    background.ts   Service worker: scheduling, checks, notifications
    content.ts       Snip picker, in-page config card, live DOM watching
    offscreen/        Parses fetched HTML off the main thread (no tab needed)
    popup/            The toolbar popup UI (watch list, settings)
  shared/             Pure logic shared across entrypoints (types, price
                      parsing, condition evaluation, notification fan-out)
demo/          Standalone HTML pages for trying TabBell out locally
```

## Running it

Requirements: Node.js 18+ and npm.

```bash
cd extension
npm install
npm run build
```

This produces the unpacked extension in `extension/dist/chrome-mv3`.

### Load it into Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `extension/dist/chrome-mv3`.
4. If you plan to test on local `file://` pages (like the demos below),
   open the TabBell card → **Details** → enable **Allow access to file
   URLs**.

After any code change, rebuild (`npm run build`) and click the reload icon
(↻) on the TabBell card in `chrome://extensions`. Also refresh any tab
you're testing on — an already-open tab keeps running the old content
script until reloaded.

### Try the demo pages

```bash
cd demo
python3 -m http.server 8080
```

Then open in Chrome:

- `http://localhost:8080/job.html` — a fake job posting whose "Apply"
  button appears after 30 seconds. Snip the "Applications open soon" text
  and pick **Element appears** with text "Apply".
- `http://localhost:8080/price.html` — a fake product page whose price
  drops every 20 seconds. Snip the price and pick **drops below** a value
  a little under $149.99.
- `http://localhost:8080/index.html` — a fake pipeline whose status
  changes after a delay. Use **Watch this tab** to track its title.

### Other useful commands (run inside `extension/`)

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs WXT in watch mode (auto-rebuilds on save) |
| `npm run compile` | Type-checks the whole project with `tsc --noEmit` |
| `npm run build` | Production build to `dist/chrome-mv3` |
| `npm run zip` | Builds and zips the extension for distribution |
| `npm run dev:firefox` | Dev build targeting Firefox |
| `npm run icons` | Regenerates PNG icons from `assets/icon.svg` |

## Notification channels (all free)

Configure these in the popup's **Settings** panel; each has a "Send test"
button.

- **Telegram** — create a bot via [@BotFather](https://t.me/BotFather),
  paste the bot token, message your bot once, then find your chat ID via
  `https://api.telegram.org/bot<token>/getUpdates`.
- **Discord** — create a webhook under a channel's *Integrations* settings
  and paste the URL.
- **Slack** — create an incoming webhook and paste the URL.

## Notes

- All processing happens locally in the browser; the only network calls
  are to the page you're watching and, if enabled, to Telegram/Discord/Slack.
- If Chrome notifications don't seem to appear, check your OS notification
  settings for Chrome (and Focus/Do Not Disturb mode) — the popup's
  **Send test Chrome notification** button isolates whether it's a
  detection issue or an OS delivery issue.
