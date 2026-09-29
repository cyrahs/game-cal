// One shared per-second clock for live countdowns. The timer only runs while
// something is subscribed, and fires on wall-clock second boundaries so every
// countdown on the page ticks together.

type Listener = () => void;

const listeners = new Set<Listener>();
let nowMs = Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  timer = setTimeout(() => {
    nowMs = Date.now();
    for (const listener of [...listeners]) listener();
    schedule();
  }, 1000 - (Date.now() % 1000));
}

export function subscribeClock(listener: Listener): () => void {
  listeners.add(listener);
  if (timer === null) {
    nowMs = Date.now();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function getClockNowMs(): number {
  // Nothing subscribed yet (first render): read the real time instead of a stale tick.
  if (timer === null) nowMs = Date.now();
  return nowMs;
}
