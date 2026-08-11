export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { a: number };
type Hsl = { h: number; s: number; l: number };

let COLOR_PARSE_CTX: CanvasRenderingContext2D | null = null;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb): number {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export function blendOver(bg: Rgb, fg: Rgb, alpha: number): Rgb {
  const a = clamp(alpha, 0, 1);
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

function parseHexColor(input: string): Rgba | null {
  const hex = input.trim().replace(/^#/, "");
  if (![3, 4, 6, 8].includes(hex.length)) return null;

  function expand(n: string): string {
    return n.length === 1 ? `${n}${n}` : n;
  }

  const r = parseInt(expand(hex.slice(0, hex.length === 3 || hex.length === 4 ? 1 : 2)), 16);
  const g = parseInt(
    expand(hex.slice(hex.length === 3 || hex.length === 4 ? 1 : 2, hex.length === 3 || hex.length === 4 ? 2 : 4)),
    16
  );
  const b = parseInt(
    expand(hex.slice(hex.length === 3 || hex.length === 4 ? 2 : 4, hex.length === 3 || hex.length === 4 ? 3 : 6)),
    16
  );
  const a = hex.length === 4 ? parseInt(expand(hex.slice(3, 4)), 16) : hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;

  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a: a / 255 };
}

function parseRgbFunc(input: string): Rgba | null {
  const m = input.trim().match(/^rgba?\((.*)\)$/i);
  if (!m) return null;

  // Support both "r, g, b, a" and "r g b / a" styles.
  const raw = m[1].trim();
  const parts = raw.includes(",") ? raw.split(",").map((p) => p.trim()) : raw.split(/\s+\/?\s*/).filter(Boolean);
  if (parts.length < 3) return null;

  function parseChannel(v: string): number | null {
    if (v.endsWith("%")) {
      const n = parseFloat(v);
      if (Number.isNaN(n)) return null;
      return clamp((n / 100) * 255, 0, 255);
    }
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return clamp(n, 0, 255);
  }

  function parseAlpha(v: string): number | null {
    if (v.endsWith("%")) {
      const n = parseFloat(v);
      if (Number.isNaN(n)) return null;
      return clamp(n / 100, 0, 1);
    }
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return clamp(n, 0, 1);
  }

  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  if (r === null || g === null || b === null) return null;
  const a = parts.length >= 4 ? parseAlpha(parts[3]) : 1;
  if (a === null) return null;

  return { r, g, b, a };
}

export function parseCssColor(input: string): Rgba | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith("#")) return parseHexColor(s);
  if (/^rgba?\(/i.test(s)) return parseRgbFunc(s);

  // Fallback for named colors / hsl() etc. (keeps parsing local; no DOM attachment).
  if (typeof document === "undefined") return null;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("color", s)) return null;

  try {
    if (!COLOR_PARSE_CTX) {
      const canvas = document.createElement("canvas");
      COLOR_PARSE_CTX = canvas.getContext("2d");
    }
    const ctx = COLOR_PARSE_CTX;
    if (!ctx) return null;
    ctx.fillStyle = s;
    const normalized = ctx.fillStyle;
    if (normalized.startsWith("#")) return parseHexColor(normalized);
    if (/^rgba?\(/i.test(normalized)) return parseRgbFunc(normalized);
  } catch {
    // ignore
  }

  return null;
}

function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
      break;
  }
  h /= 6;
  return { h, s, l };
}

function hslToRgb(hsl: Hsl): Rgb {
  const { h, s } = hsl;
  const l = clamp(hsl.l, 0, 1);

  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  function hue2rgb(t: number): number {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  }

  const r = hue2rgb(h + 1 / 3);
  const g = hue2rgb(h);
  const b = hue2rgb(h - 1 / 3);
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

export function adjustRgbForContrast(fg: Rgb, bg: Rgb, minRatio: number): Rgb {
  if (contrastRatio(fg, bg) >= minRatio) return fg;

  const fgHsl = rgbToHsl(fg);
  const bgLum = relativeLuminance(bg);

  // Decide direction based on the background luminance (works even when fg is *darker* than a dark bg).
  const lighten = bgLum < 0.4;
  const startL = fgHsl.l;

  let best = fg;

  if (lighten) {
    let lo = startL;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      const cand = hslToRgb({ ...fgHsl, l: mid });
      if (contrastRatio(cand, bg) >= minRatio) {
        best = cand;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return best;
  }

  let lo = 0;
  let hi = startL;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const cand = hslToRgb({ ...fgHsl, l: mid });
    if (contrastRatio(cand, bg) >= minRatio) {
      best = cand;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

export function rgbToCss(rgb: Rgb): string {
  return `rgb(${clamp(Math.round(rgb.r), 0, 255)}, ${clamp(Math.round(rgb.g), 0, 255)}, ${clamp(Math.round(rgb.b), 0, 255)})`;
}
