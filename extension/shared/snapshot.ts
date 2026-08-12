import { findPagePrice, priceFromElement } from './price';
import type { CheckSpec, Snapshot } from './types';

/**
 * Inspect a document against a CheckSpec. Runs in two very different
 * environments, so it must stay pure DOM:
 *
 * - a live, rendered page (content script or a background check tab), where
 *   layout + computed styles are available (`rendered = true`);
 * - a detached document parsed from fetched HTML in the offscreen document,
 *   where there is no layout at all (`rendered = false`) and visibility can
 *   only be judged from static attributes.
 */
export function takeSnapshot(doc: Document, spec: CheckSpec, rendered: boolean): Snapshot {
  const el = resolveElement(doc, spec);

  const snapshot: Snapshot = {
    found: el !== null,
    visible: el !== null && isVisible(el, rendered),
    enabled: el !== null && isEnabled(el),
    text: el?.textContent?.trim() ?? '',
    price: null,
    rendered,
  };

  if (spec.wantPrice) {
    const price = (el ? priceFromElement(el) : null) ?? findPagePrice(doc);
    snapshot.price = price?.value ?? null;
    snapshot.currency = price?.currency;
  }

  if (spec.keyword) {
    const body = (doc.body?.textContent ?? '').toLowerCase();
    snapshot.keywordPresent = body.includes(spec.keyword.toLowerCase());
  }

  if (!snapshot.found && doc.querySelector('input[type="password"]')) {
    snapshot.loginWall = true;
  }

  return snapshot;
}

function resolveElement(doc: Document, spec: CheckSpec): Element | null {
  if (spec.selector) {
    try {
      const el = doc.querySelector(spec.selector);
      if (el) return el;
    } catch {
      /* invalid selector — fall through to text search */
    }
  }
  if (spec.expectText) return findByText(doc, spec.expectText);
  return null;
}

/** Find a clickable control whose text matches (for buttons not in the DOM yet). */
function findByText(doc: Document, expectText: string): Element | null {
  const needle = expectText.trim().toLowerCase();
  if (!needle) return null;
  const candidates = doc.querySelectorAll(
    'button, a, input[type="submit"], input[type="button"], [role="button"]',
  );
  let fallback: Element | null = null;
  for (const el of Array.from(candidates)) {
    const text = (
      el.textContent ??
      el.getAttribute('value') ??
      el.getAttribute('aria-label') ??
      ''
    )
      .trim()
      .toLowerCase();
    if (!text) continue;
    if (text === needle) return el;
    if (!fallback && text.includes(needle)) fallback = el;
  }
  return fallback;
}

function isVisible(el: Element, rendered: boolean): boolean {
  if (rendered) {
    const win = el.ownerDocument.defaultView;
    if (win) {
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    }
  }
  // Static heuristics only: fetched HTML has no layout. A false positive
  // here is fine — elementAppears results from fetched HTML are always
  // confirmed with a rendered check before notifying.
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute('hidden')) return false;
    const style = (node.getAttribute('style') ?? '').toLowerCase();
    if (style.includes('display:none') || style.includes('display: none')) return false;
    if (style.includes('visibility:hidden') || style.includes('visibility: hidden')) return false;
    node = node.parentElement;
  }
  return true;
}

function isEnabled(el: Element): boolean {
  if (el.hasAttribute('disabled')) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  return true;
}
