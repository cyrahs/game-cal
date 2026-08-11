import { type Rgb, adjustRgbForContrast, blendOver, contrastRatio, parseCssColor, rgbToCss } from "./color";

const DARK_ANN_BASE_BG: Rgb = { r: 11, g: 16, b: 32 }; // matches --bg0 in dark mode (approx)
const MIN_ANN_TEXT_CONTRAST = 4.5;

function decodeBasicHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function extractMiHoYoOpenInBrowserUrl(href: string): string | null {
  const m = /^\s*javascript:\s*miHoYoGameJSSDK\.openInBrowser\s*\(([\s\S]*)\)\s*;?\s*$/i.exec(href);
  if (!m?.[1]) return null;

  const args = m[1].trim();
  const quote = args[0];
  if (quote !== "'" && quote !== "\"") return null;

  let firstArg = "";
  for (let i = 1; i < args.length; i++) {
    const ch = args[i]!;
    if (ch === "\\") {
      if (i + 1 >= args.length) break;
      firstArg += args[i + 1]!;
      i++;
      continue;
    }
    if (ch === quote) {
      const decoded = decodeBasicHtmlEntities(firstArg).trim();
      return /^https?:\/\//i.test(decoded) ? decoded : null;
    }
    firstArg += ch;
  }

  return null;
}

function rewriteMiHoYoAnnouncementAnchors(input: string): string {
  if (typeof DOMParser === "undefined") return input;

  const doc = new DOMParser().parseFromString(input, "text/html");
  const anchors = Array.from(doc.body.querySelectorAll<HTMLAnchorElement>("a[href]"));

  let changed = false;
  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute("href");
    if (!rawHref) continue;

    const extracted = extractMiHoYoOpenInBrowserUrl(rawHref);
    if (!extracted) continue;

    anchor.setAttribute("href", extracted);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noreferrer noopener");
    changed = true;
  }

  return changed ? doc.body.innerHTML : input;
}

export function preprocessAnnContent(input: string): string {
  // miHoYo announcements sometimes escape their <t ...>time</t> placeholders, e.g.
  // "&lt;t class=\"t_lc\"&gt;2026/03/23 03:59:00&lt;/t&gt;". Keep only the timestamp text.
  const normalized = input.replace(/&lt;t[^&]*?&gt;([\s\S]*?)&lt;\/t&gt;/g, "$1");
  if (!looksLikeHtml(normalized)) return normalized;
  return rewriteMiHoYoAnnouncementAnchors(normalized);
}

export function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input);
}

export function normalizeAnnouncementHtml(html: string, theme: "light" | "dark"): string {
  if (typeof DOMParser === "undefined") return html;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body;

  for (const img of Array.from(root.querySelectorAll("img"))) {
    img.setAttribute("referrerpolicy", "no-referrer");
  }

  for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noreferrer noopener");
  }

  if (theme !== "dark") return root.innerHTML;

  const candidates = root.querySelectorAll<HTMLElement>("[style],[color],[bgcolor]");
  for (const el of candidates) {
    const bgRaw = el.style.backgroundColor || el.getAttribute("bgcolor") || "";
    const parsedBg = bgRaw ? parseCssColor(bgRaw) : null;
    const bg =
      parsedBg && parsedBg.a > 0.05
        ? parsedBg.a >= 1
          ? ({ r: parsedBg.r, g: parsedBg.g, b: parsedBg.b } satisfies Rgb)
          : blendOver(DARK_ANN_BASE_BG, { r: parsedBg.r, g: parsedBg.g, b: parsedBg.b }, parsedBg.a)
        : DARK_ANN_BASE_BG;

    const fgRaw = el.style.color || el.getAttribute("color") || "";
    if (!fgRaw) continue;
    const parsedFg = parseCssColor(fgRaw);
    if (!parsedFg || parsedFg.a <= 0.05) continue;

    const fgEffective =
      parsedFg.a >= 1
        ? ({ r: parsedFg.r, g: parsedFg.g, b: parsedFg.b } satisfies Rgb)
        : blendOver(bg, { r: parsedFg.r, g: parsedFg.g, b: parsedFg.b }, parsedFg.a);

    if (contrastRatio(fgEffective, bg) >= MIN_ANN_TEXT_CONTRAST) continue;

    const adjusted = adjustRgbForContrast(fgEffective, bg, MIN_ANN_TEXT_CONTRAST);
    el.style.setProperty("color", rgbToCss(adjusted), "important");
    if (el.hasAttribute("color")) el.removeAttribute("color");
  }

  return root.innerHTML;
}
