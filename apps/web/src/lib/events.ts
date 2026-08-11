import { DAY_MS } from "./time";

const UPSTREAM_URGENT_WINDOW_MS = 3 * DAY_MS;
const RECURRING_URGENT_WINDOW_MS = DAY_MS;

export function isUrgentByRemainingMs(kind: "upstream" | "recurring", remainingMs: number): boolean {
  if (remainingMs <= 0) return false;
  const threshold = kind === "recurring" ? RECURRING_URGENT_WINDOW_MS : UPSTREAM_URGENT_WINDOW_MS;
  return remainingMs <= threshold;
}

export function normalizeEventTitle(input: string): string {
  // Some upstream titles contain literal "\n" sequences; normalize them to a single-line label.
  return input.replace(/\\[rnt]/g, " ").replace(/\s+/g, " ").trim();
}
