import { formatPrice, priceFromElement } from '../shared/price';
import { specForWatch } from '../shared/conditions';
import { takeSnapshot } from '../shared/snapshot';
import {
  INTERVAL_PRESETS,
  type BackgroundMessage,
  type CheckSpec,
  type Condition,
  type ContentMessage,
  type CreateWatchConfig,
  type RegionInfo,
  type Watch,
  type WatchMode,
} from '../shared/types';

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, Cantarell, sans-serif";

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const observers = new Map<string, MutationObserver>();
    const debounceTimers = new Map<string, number>();

    // ---- Wire up watches that already exist for this tab ------------------

    void send({ kind: 'get-watches-for-tab' }).then((watches) => {
      if (Array.isArray(watches)) attachAll(watches as Watch[]);
    });

    chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
      if (message.kind === 'begin-snip') {
        startSnip();
        sendResponse({ ok: true });
      }
      if (message.kind === 'sync-watches') {
        attachAll(message.watches);
        sendResponse({ ok: true });
      }
      if (message.kind === 'run-check') {
        sendResponse(takeSnapshot(document, message.spec, true));
      }
      if (message.kind === 'show-toast') {
        showToast(message.text);
        sendResponse({ ok: true });
      }
      return false;
    });

    function send(message: BackgroundMessage): Promise<unknown> {
      return chrome.runtime.sendMessage(message).catch(() => undefined);
    }

    // ---- Confirmation toast ------------------------------------------------

    function showToast(text: string): void {
      document.getElementById('tabbell-toast')?.remove();
      const toast = document.createElement('div');
      toast.id = 'tabbell-toast';
      toast.textContent = `\u{1F514} ${text}`;
      toast.style.cssText = [
        'position:fixed', 'top:18px', 'left:50%',
        'transform:translateX(-50%) translateY(-8px)',
        'z-index:2147483647', 'padding:11px 20px', 'border-radius:999px',
        'background:linear-gradient(135deg,#6d5efc,#8b5cf6)', 'color:#fff',
        `font:600 13px/1.4 ${FONT_STACK}`,
        'box-shadow:0 8px 28px rgba(109,94,252,0.45)', 'opacity:0',
        'transition:opacity 180ms ease, transform 180ms ease',
        'pointer-events:none', 'max-width:80vw', 'white-space:nowrap',
        'overflow:hidden', 'text-overflow:ellipsis',
      ].join(';');
      document.documentElement.append(toast);
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
      });
      window.setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-8px)';
        window.setTimeout(() => toast.remove(), 250);
      }, 2800);
    }

    // ---- Observer management (live watches) --------------------------------

    function attachAll(watches: Watch[]): void {
      const wanted = new Set(watches.map((w) => w.id));
      for (const [id, obs] of observers) {
        if (!wanted.has(id)) {
          obs.disconnect();
          observers.delete(id);
        }
      }
      for (const watch of watches) {
        if (!observers.has(watch.id)) attach(watch);
      }
    }

    function runCheckAndReport(watch: Watch): void {
      const spec: CheckSpec = specForWatch(watch);
      const snapshot = takeSnapshot(document, spec, true);
      void send({ kind: 'check-result', watchId: watch.id, snapshot });
    }

    function attach(watch: Watch): void {
      if (!watch.selector) return;
      let el: Element | null = null;
      try {
        el = document.querySelector(watch.selector);
      } catch {
        el = null;
      }
      // For elementAppears/keyword watches the element may legitimately not
      // exist yet — observe the body for it to show up. Others retry.
      const target =
        el ??
        (watch.condition.kind === 'elementAppears' || watch.condition.kind === 'keyword'
          ? document.body
          : null);
      if (!target) {
        retryAttach(watch, 8);
        return;
      }
      const observer = new MutationObserver(() => {
        // Debounce: SPAs mutate in bursts; report once the DOM settles.
        const existing = debounceTimers.get(watch.id);
        if (existing !== undefined) window.clearTimeout(existing);
        debounceTimers.set(
          watch.id,
          window.setTimeout(() => runCheckAndReport(watch), 400),
        );
      });
      if (el) {
        observer.observe(el, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'hidden', 'style', 'class'],
        });
        // Also watch the parent: frameworks often replace the node wholesale.
        if (el.parentElement) observer.observe(el.parentElement, { childList: true });
      } else {
        observer.observe(target, { childList: true, subtree: true });
      }
      observers.set(watch.id, observer);
      runCheckAndReport(watch); // establish an immediate baseline
    }

    function retryAttach(watch: Watch, attempts: number): void {
      if (attempts <= 0) {
        void send({ kind: 'element-missing', watchId: watch.id });
        return;
      }
      window.setTimeout(() => {
        if (observers.has(watch.id)) return;
        let found = false;
        try {
          found = !!document.querySelector(watch.selector ?? '');
        } catch {
          found = false;
        }
        if (found) attach(watch);
        else retryAttach(watch, attempts - 1);
      }, 1500);
    }

    // ---- Robust selector generation ----------------------------------------

    function cssEscape(value: string): string {
      return CSS?.escape ? CSS.escape(value) : value.replace(/([^\w-])/g, '\\$1');
    }

    /**
     * Build the most stable selector we can: prefer unique ids and
     * data-testid/aria attributes, fall back to a short structural path.
     */
    function buildSelector(el: Element): string {
      if (el.id && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
        return `#${cssEscape(el.id)}`;
      }
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'aria-label']) {
        const v = el.getAttribute(attr);
        if (v) {
          const sel = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
      const path: string[] = [];
      let node: Element | null = el;
      while (node && node !== document.documentElement && path.length < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          path.unshift(`#${cssEscape(node.id)}`);
          break;
        }
        const parent: Element | null = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (c) => c.tagName === node!.tagName,
          );
          if (siblings.length > 1) {
            part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
        }
        path.unshift(part);
        node = parent;
      }
      return path.join(' > ');
    }

    // ---- Snip picker --------------------------------------------------------

    function startSnip(): void {
      if (document.getElementById('tabbell-snip-root')) return;
      document.getElementById('tabbell-config-card')?.remove();

      const root = document.createElement('div');
      root.id = 'tabbell-snip-root';
      root.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;' +
        'background:rgba(15,12,30,0.28);user-select:none;';

      const tooltip = document.createElement('div');
      tooltip.textContent =
        'TabBell: drag to snip the area you want to watch \u2014 Esc to cancel';
      tooltip.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483647;padding:10px 18px;border-radius:999px;' +
        `background:#17151f;color:#f4f2ff;font:600 13px/1.4 ${FONT_STACK};` +
        'box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:none;';

      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;display:none;z-index:2147483647;pointer-events:none;' +
        'border:2px solid #6d5efc;border-radius:4px;' +
        'background:rgba(109,94,252,0.10);' +
        'box-shadow:0 0 0 100000px rgba(15,12,30,0.28);';

      document.documentElement.append(root, tooltip, box);

      let startX = 0;
      let startY = 0;
      let dragging = false;

      const rectNow = (e: MouseEvent) => ({
        x: Math.min(startX, e.clientX),
        y: Math.min(startY, e.clientY),
        w: Math.abs(e.clientX - startX),
        h: Math.abs(e.clientY - startY),
      });

      const onDown = (e: MouseEvent): void => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        root.style.background = 'transparent'; // the box's shadow now dims instead
        box.style.display = 'block';
      };

      const onMove = (e: MouseEvent): void => {
        if (!dragging) return;
        const r = rectNow(e);
        box.style.left = `${r.x}px`;
        box.style.top = `${r.y}px`;
        box.style.width = `${r.w}px`;
        box.style.height = `${r.h}px`;
      };

      const cleanup = (): void => {
        root.removeEventListener('mousedown', onDown);
        root.removeEventListener('mousemove', onMove);
        root.removeEventListener('mouseup', onUp);
        document.removeEventListener('keydown', onKey, true);
        root.remove();
        tooltip.remove();
        box.remove();
      };

      const onUp = (e: MouseEvent): void => {
        if (!dragging) return;
        const rect = rectNow(e);
        cleanup();
        // Tiny drags count as a click: pick the element under the cursor.
        if (rect.w < 8 || rect.h < 8) {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (el) void finishSnip(el, elementRect(el));
          return;
        }
        const el = elementForRegion(rect);
        if (el) void finishSnip(el, rect);
      };

      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cleanup();
          void send({ kind: 'snip-cancelled' });
        }
      };

      root.addEventListener('mousedown', onDown);
      root.addEventListener('mousemove', onMove);
      root.addEventListener('mouseup', onUp);
      document.addEventListener('keydown', onKey, true);
    }

    function elementRect(el: Element): { x: number; y: number; w: number; h: number } {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }

    /**
     * Map the snipped region to the DOM element that best covers it:
     * highest intersection-over-union among the elements stacked under the
     * region's center.
     */
    function elementForRegion(rect: {
      x: number;
      y: number;
      w: number;
      h: number;
    }): Element | null {
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      const stack = document.elementsFromPoint(cx, cy);
      let best: Element | null = null;
      let bestScore = 0;
      for (const el of stack) {
        if (el === document.documentElement || el === document.body) continue;
        const r = el.getBoundingClientRect();
        const ix = Math.max(
          0,
          Math.min(rect.x + rect.w, r.right) - Math.max(rect.x, r.left),
        );
        const iy = Math.max(
          0,
          Math.min(rect.y + rect.h, r.bottom) - Math.max(rect.y, r.top),
        );
        const intersection = ix * iy;
        const union = rect.w * rect.h + r.width * r.height - intersection;
        const score = union > 0 ? intersection / union : 0;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best ?? document.elementFromPoint(cx, cy);
    }

    async function finishSnip(
      el: Element,
      rect: { x: number; y: number; w: number; h: number },
    ): Promise<void> {
      const price = priceFromElement(el);
      const buttonish =
        el.closest('button, a, [role="button"], input[type="submit"], input[type="button"]') !==
        null;
      const info: RegionInfo = {
        selector: buildSelector(el),
        text: (el.textContent ?? '').trim(),
        price: price?.value ?? null,
        currency: price?.currency,
        buttonish,
        visible: true, // the user just saw it
        enabled: !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
      };

      // Let the overlay vanish before the capture so the thumbnail is clean.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const thumb = (await send({
        kind: 'capture-region',
        rect,
        dpr: window.devicePixelRatio || 1,
      })) as string | undefined;

      showConfigCard(info, thumb);
    }

    // ---- In-page config card ------------------------------------------------

    function showConfigCard(info: RegionInfo, thumb: string | undefined): void {
      document.getElementById('tabbell-config-card')?.remove();

      const card = document.createElement('div');
      card.id = 'tabbell-config-card';
      card.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:2147483647;width:300px;' +
        'background:#17151f;color:#f4f2ff;border-radius:14px;padding:16px;' +
        `font:400 13px/1.5 ${FONT_STACK};box-shadow:0 12px 40px rgba(0,0,0,0.5);`;

      const fieldCss =
        'width:100%;box-sizing:border-box;margin:4px 0 10px;padding:7px 10px;' +
        'border-radius:8px;border:1px solid #3a3550;background:#211d2f;' +
        `color:#f4f2ff;font:400 13px/1.4 ${FONT_STACK};`;
      const labelCss = 'display:block;font-weight:600;font-size:12px;color:#b9b3d9;';

      const title = document.createElement('div');
      title.textContent = '\u{1F514} Watch this?';
      title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
      card.append(title);

      if (thumb) {
        const img = document.createElement('img');
        img.src = thumb;
        img.alt = '';
        img.style.cssText =
          'width:100%;max-height:80px;object-fit:contain;border-radius:8px;' +
          'background:#211d2f;margin-bottom:10px;display:block;';
        card.append(img);
      }

      const preview = document.createElement('div');
      preview.textContent = info.text.slice(0, 90) || info.selector;
      preview.style.cssText =
        'font-size:12px;color:#8f89ad;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;margin-bottom:12px;';
      card.append(preview);

      const mkLabel = (text: string): HTMLElement => {
        const l = document.createElement('span');
        l.textContent = text;
        l.style.cssText = labelCss;
        return l;
      };
      const mkSelect = (options: [string, string][], value: string): HTMLSelectElement => {
        const s = document.createElement('select');
        s.style.cssText = fieldCss;
        for (const [v, text] of options) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = text;
          s.append(o);
        }
        s.value = value;
        return s;
      };
      const mkInput = (value: string, placeholder = ''): HTMLInputElement => {
        const i = document.createElement('input');
        i.type = 'text';
        i.value = value;
        i.placeholder = placeholder;
        i.style.cssText = fieldCss;
        return i;
      };

      // Condition -----------------------------------------------------------
      const defaultKind =
        info.price !== null ? 'priceThreshold' : info.buttonish ? 'elementAppears' : 'statusChange';
      card.append(mkLabel('Notify me when\u2026'));
      const condSelect = mkSelect(
        [
          ['statusChange', 'Status changes (build/pipeline finishes)'],
          ['elementAppears', 'Element appears or becomes clickable'],
          ['priceThreshold', 'Price changes or drops'],
          ['keyword', 'A phrase appears / disappears'],
        ],
        defaultKind,
      );
      card.append(condSelect);

      const extra = document.createElement('div');
      card.append(extra);

      // Per-condition fields --------------------------------------------------
      const expectInput = mkInput(info.buttonish ? info.text.slice(0, 40) : '', 'e.g. Apply');
      const ruleSelect = mkSelect(
        [
          ['any', 'Any price change'],
          ['below', 'Drops below\u2026'],
          ['dropPercent', 'Drops by at least\u2026 %'],
        ],
        info.price !== null ? 'below' : 'any',
      );
      const valueInput = mkInput(info.price !== null ? String(info.price) : '', 'amount');
      valueInput.inputMode = 'decimal';
      const phraseInput = mkInput(info.text.slice(0, 40), 'e.g. In stock');
      const phraseOn = mkSelect(
        [
          ['appear', 'when it appears'],
          ['disappear', 'when it disappears'],
        ],
        'appear',
      );

      const renderExtra = (): void => {
        extra.replaceChildren();
        switch (condSelect.value) {
          case 'elementAppears':
            extra.append(mkLabel('Match by text (used if the element is not on the page yet)'), expectInput);
            break;
          case 'priceThreshold': {
            if (info.price !== null) {
              const detected = document.createElement('div');
              detected.textContent = `Detected price: ${formatPrice(info.price, info.currency)}`;
              detected.style.cssText = 'font-size:12px;color:#7ee2a0;margin-bottom:6px;';
              extra.append(detected);
            }
            extra.append(mkLabel('Rule'), ruleSelect);
            if (ruleSelect.value !== 'any') extra.append(mkLabel('Value'), valueInput);
            break;
          }
          case 'keyword':
            extra.append(mkLabel('Phrase'), phraseInput, mkLabel('Fire'), phraseOn);
            break;
        }
      };
      condSelect.addEventListener('change', renderExtra);
      ruleSelect.addEventListener('change', renderExtra);
      renderExtra();

      // Mode + interval -------------------------------------------------------
      card.append(mkLabel('How to check'));
      const modeSelect = mkSelect(
        [
          ['live', 'Keep this tab open (instant)'],
          ['revisit', 'Re-check in the background (tab can be closed)'],
        ],
        defaultKind === 'statusChange' ? 'live' : 'revisit',
      );
      card.append(modeSelect);

      const intervalWrap = document.createElement('div');
      const intervalSelect = mkSelect(
        INTERVAL_PRESETS.map((m) => [
          String(m),
          m < 60 ? `Every ${m} min` : m === 60 ? 'Every hour' : m === 360 ? 'Every 6 hours' : 'Once a day',
        ]),
        '30',
      );
      intervalWrap.append(mkLabel('Check frequency'), intervalSelect);
      card.append(intervalWrap);
      const syncInterval = (): void => {
        intervalWrap.style.display = modeSelect.value === 'revisit' ? 'block' : 'none';
      };
      modeSelect.addEventListener('change', syncInterval);
      syncInterval();

      // Actions ---------------------------------------------------------------
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
      const okBtn = document.createElement('button');
      okBtn.textContent = 'Start watching';
      okBtn.style.cssText =
        'flex:1;padding:9px 0;border:none;border-radius:9px;cursor:pointer;' +
        'background:linear-gradient(135deg,#6d5efc,#8b5cf6);color:#fff;' +
        `font:700 13px/1 ${FONT_STACK};`;
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText =
        'padding:9px 14px;border:1px solid #3a3550;border-radius:9px;cursor:pointer;' +
        `background:transparent;color:#b9b3d9;font:600 13px/1 ${FONT_STACK};`;
      row.append(okBtn, cancelBtn);
      card.append(row);

      cancelBtn.addEventListener('click', () => card.remove());

      const onCardKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
          card.remove();
          document.removeEventListener('keydown', onCardKey, true);
        }
      };
      document.addEventListener('keydown', onCardKey, true);

      document.documentElement.append(card);

      okBtn.addEventListener('click', () => {
        const condition = buildCondition();
        if (!condition) return;
        const config: CreateWatchConfig = {
          selector: info.selector,
          label: info.text.trim().slice(0, 80) || info.selector,
          baselineText: info.text,
          condition,
          mode: modeSelect.value as WatchMode,
          intervalMinutes: Number(intervalSelect.value),
          thumb,
        };
        card.remove();
        void send({ kind: 'create-watch', config });
      });

      function buildCondition(): Condition | null {
        switch (condSelect.value) {
          case 'statusChange':
            return { kind: 'statusChange' };
          case 'elementAppears':
            return { kind: 'elementAppears', expectText: expectInput.value.trim() || undefined };
          case 'priceThreshold': {
            const rule = ruleSelect.value as 'any' | 'below' | 'dropPercent';
            let value: number | undefined;
            if (rule !== 'any') {
              value = Number(valueInput.value.replace(/[^\d.]/g, ''));
              if (!Number.isFinite(value) || value <= 0) {
                valueInput.style.borderColor = '#f87171';
                return null;
              }
            }
            return {
              kind: 'priceThreshold',
              rule,
              value,
              baselinePrice: info.price ?? undefined,
              currency: info.currency,
            };
          }
          case 'keyword': {
            const phrase = phraseInput.value.trim();
            if (!phrase) {
              phraseInput.style.borderColor = '#f87171';
              return null;
            }
            return { kind: 'keyword', phrase, on: phraseOn.value as 'appear' | 'disappear' };
          }
        }
        return null;
      }
    }
  },
});
