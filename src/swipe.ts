// Calendar swipe: the palm moving fast and mostly up or down in front of the calendar turns the month.
// Down = next month (like scrolling down, and the ⌄ arrow), up = previous.

export const SWIPE = 0.06, SWIPE_V = 0.3; // metres of fast vertical travel for one month; speed that counts as fast (m/s) — tune on the headset
export type Swipe = { acc: number; armed: boolean; lastDir: number; lastAt: number };
export const newSwipe = (): Swipe => ({ acc: 0, armed: true, lastDir: 0, lastAt: -9 });

/** One frame of a hand in front of the calendar. Returns +1 (next month), -1 (previous) or 0. */
export function swipeStep(s: Swipe, vy: number, vSide: number, dt: number, t: number): number {
  const fast = Math.abs(vy) > SWIPE_V && Math.abs(vy) > vSide * 1.2; // fast, and more up/down than sideways
  if (fast && s.armed) s.acc += vy * dt;
  else {
    s.acc *= Math.exp(-dt * 4); // a short slowdown mid-swipe keeps most of it
    if (Math.abs(vy) < 0.12) s.armed = true; // the hand paused: ready for the next swipe
  }
  if (Math.abs(s.acc) < SWIPE) return 0;
  const dir = s.acc < 0 ? 1 : -1;
  s.acc = 0;
  s.armed = false; // the rest of this stroke (and the hand coming back) does not count
  if (t - s.lastAt < 0.4 || (dir !== s.lastDir && t - s.lastAt < 1)) return 0; // too soon, or a quick move back
  s.lastDir = dir;
  s.lastAt = t;
  return dir;
}

/** The hand is not in front of the calendar: start fresh, and when it comes back it must pause there once
 *  before a swipe counts (a hand reaching up to pinch a button is not a swipe). */
export const swipeReset = (s: Swipe) => { s.acc = 0; s.armed = false; };
