/**
 * Price extraction. Works on both live DOMs (content script / check tab)
 * and detached documents parsed from fetched HTML (offscreen document),
 * so nothing here may rely on layout or computed styles.
 */

export interface ParsedPrice {
  value: number;
  currency?: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '\u20ac': 'EUR',
  '\u00a3': 'GBP',
  '\u00a5': 'JPY',
  '\u20b9': 'INR',
  '\u20a9': 'KRW',
  'R$': 'BRL',
  'C$': 'CAD',
  'A$': 'AUD',
};

const PRICE_RE =
  /(R\$|C\$|A\$|[$\u20ac\u00a3\u00a5\u20b9\u20a9]|\b(?:USD|EUR|GBP|INR|CAD|AUD|JPY)\b)\s*([\d.,]+(?:\d))|([\d.,]+(?:\d))\s*(R\$|C\$|A\$|[$\u20ac\u00a3\u00a5\u20b9\u20a9]|\b(?:USD|EUR|GBP|INR|CAD|AUD|JPY)\b)/;

/**
 * Turn "1,234.56", "1.234,56" or "1 234,56" into a number by treating the
 * last separator as the decimal point when it is followed by 1-2 digits.
 */
function parseNumeric(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const sepIdx = Math.max(lastComma, lastDot);
  let normalized: string;
  if (sepIdx === -1) {
    normalized = cleaned;
  } else {
    const decimals = cleaned.length - sepIdx - 1;
    if (decimals >= 1 && decimals <= 2) {
      normalized = cleaned.slice(0, sepIdx).replace(/[.,]/g, '') + '.' + cleaned.slice(sepIdx + 1);
    } else {
      // "1.299" style thousands separator with no decimal part.
      normalized = cleaned.replace(/[.,]/g, '');
    }
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract the first price-looking token from a text snippet. */
export function parsePrice(text: string): ParsedPrice | null {
  const m = PRICE_RE.exec(text);
  if (!m) return null;
  const symbol = m[1] ?? m[4];
  const numeric = m[2] ?? m[3];
  if (!numeric) return null;
  const value = parseNumeric(numeric);
  if (value === null) return null;
  const currency =
    symbol && symbol.length <= 2 ? CURRENCY_SYMBOLS[symbol] ?? symbol : symbol?.toUpperCase();
  return { value, currency };
}

/** Selectors that commonly hold the canonical price (Amazon and generic shops). */
const PRICE_SELECTORS = [
  '#corePrice_feature_div .a-offscreen',
  '#corePriceDisplay_desktop_feature_div .a-offscreen',
  '.a-price .a-offscreen',
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '[itemprop="price"]',
  '[data-testid*="price" i]',
  '[class*="price" i][class*="current" i]',
];

function priceFromJsonLd(doc: Document): ParsedPrice | null {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data: unknown = JSON.parse(script.textContent ?? '');
      const found = findOfferPrice(data);
      if (found) return found;
    } catch {
      /* malformed JSON-LD is common; skip */
    }
  }
  return null;
}

function findOfferPrice(node: unknown, depth = 0): ParsedPrice | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOfferPrice(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const rawPrice = obj['price'] ?? obj['lowPrice'];
  if (rawPrice !== undefined) {
    const value =
      typeof rawPrice === 'number' ? rawPrice : parseNumeric(String(rawPrice)) ?? undefined;
    if (value !== undefined && value > 0) {
      const currency = typeof obj['priceCurrency'] === 'string' ? obj['priceCurrency'] : undefined;
      return { value, currency };
    }
  }
  for (const key of ['offers', '@graph', 'itemListElement', 'item']) {
    if (key in obj) {
      const found = findOfferPrice(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function priceFromMeta(doc: Document): ParsedPrice | null {
  const meta =
    doc.querySelector('meta[property="product:price:amount"]') ??
    doc.querySelector('meta[property="og:price:amount"]');
  if (!meta) return null;
  const value = parseNumeric(meta.getAttribute('content') ?? '');
  if (value === null) return null;
  const currencyMeta =
    doc.querySelector('meta[property="product:price:currency"]') ??
    doc.querySelector('meta[property="og:price:currency"]');
  return { value, currency: currencyMeta?.getAttribute('content') ?? undefined };
}

/** Price scoped to a specific element (a snipped region or watched selector). */
export function priceFromElement(el: Element): ParsedPrice | null {
  // Amazon renders the readable price in a visually-hidden .a-offscreen span.
  const offscreen = el.querySelector('.a-offscreen');
  if (offscreen) {
    const p = parsePrice(offscreen.textContent ?? '');
    if (p) return p;
  }
  const content = el.getAttribute('content');
  if (content) {
    const asNumber = parseNumeric(content);
    if (asNumber !== null) return { value: asNumber };
  }
  return parsePrice(el.textContent ?? '');
}

/** Best-effort page-level price: structured data first, selectors second. */
export function findPagePrice(doc: Document): ParsedPrice | null {
  const structured = priceFromJsonLd(doc) ?? priceFromMeta(doc);
  if (structured) return structured;
  for (const selector of PRICE_SELECTORS) {
    let el: Element | null = null;
    try {
      el = doc.querySelector(selector);
    } catch {
      continue;
    }
    if (!el) continue;
    const p = priceFromElement(el);
    if (p) return p;
  }
  return null;
}

export function formatPrice(value: number, currency?: string): string {
  try {
    if (currency && /^[A-Z]{3}$/.test(currency)) {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    }
  } catch {
    /* unknown currency code */
  }
  const num = value.toLocaleString(undefined, {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${num}` : num;
}
