/**
 * Simulated network conditions.
 *
 * Without this the prototype answers instantly and every loading skeleton,
 * spinner and optimistic update is untestable — the UI would look finished
 * while hiding exactly the states that go wrong against a real backend.
 *
 * Failure injection is OPT-IN via `?chaos=1` so normal review is clean, but
 * error and retry states can still be demonstrated on demand.
 */

const params = () =>
  typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);

/** `?fast=1` strips the delay — used by the automated tests. */
const isFast = () => params().has('fast');
/** `?chaos=1` makes roughly 1 in 8 reads fail, to exercise error states. */
const isChaos = () => params().has('chaos');

export function delayFor(kind: 'read' | 'write' | 'heavy'): number {
  if (isFast()) return 0;
  const base = { read: 150, write: 260, heavy: 420 }[kind];
  const spread = { read: 220, write: 260, heavy: 380 }[kind];
  return base + Math.random() * spread;
}

export class MockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockError';
  }
}

export async function settle<T>(value: T, kind: 'read' | 'write' | 'heavy' = 'read'): Promise<T> {
  await new Promise((r) => setTimeout(r, delayFor(kind)));
  if (isChaos() && Math.random() < 0.125) {
    throw new MockError('Simulated storage failure (chaos mode). Retry to continue.');
  }
  return value;
}
