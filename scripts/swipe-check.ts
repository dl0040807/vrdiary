// npm run swipe-check — frame-by-frame hand motions in front of the calendar -> months turned.
import assert from 'node:assert/strict';
import { newSwipe, swipeReset, swipeStep } from '../src/swipe.ts';

const dt = 1 / 72;
let t = 0;
/** Move the hand at (vy, vSide) m/s for `sec` seconds; returns the months turned. */
function move(s: ReturnType<typeof newSwipe>, vy: number, sec: number, vSide = 0) {
  const out: number[] = [];
  for (let i = 0; i < Math.round(sec / dt); i++, t += dt) { const d = swipeStep(s, vy, vSide, dt, t); if (d) out.push(d); }
  return out;
}

let s = newSwipe();
assert.deepEqual(move(s, -0.5, 0.25), [1], 'swipe down = next month');
assert.deepEqual(move(s, 0.6, 0.25), [], 'bringing the hand straight back up does not count');
move(s, 0, 0.6);
assert.deepEqual(move(s, -0.5, 0.25), [1], 'pause, then down again = next month again');
move(s, 0, 1.2);
assert.deepEqual(move(s, 0.5, 0.25), [-1], 'swipe up = previous month');

s = newSwipe();
assert.deepEqual(move(s, -0.35, 0.3), [1], 'a relaxed swipe (0.35 m/s) counts');
s = newSwipe();
assert.deepEqual(move(s, -0.1, 2), [], 'a slow drift does not count');
s = newSwipe();
assert.deepEqual(move(s, -0.4, 0.3, 0.8), [], 'a mostly sideways move does not count');
s = newSwipe();
assert.deepEqual([...move(s, -0.5, 0.08), ...move(s, -0.2, 0.05), ...move(s, -0.5, 0.08)], [1], 'a short slowdown mid-swipe still counts once');
s = newSwipe();
assert.deepEqual(move(s, -0.5, 0.6), [1], 'one long swipe turns one month');
s = newSwipe(); swipeReset(s); t += 2; // the hand arrives in front of the calendar mid-reach
assert.deepEqual(move(s, 0.8, 0.4), [], 'reaching up to a button is not a swipe');
move(s, 0, 0.3);
assert.deepEqual(move(s, 0.5, 0.25), [-1], 'after a pause there, a swipe counts');
console.log('swipe-check: ok');
