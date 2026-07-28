/**
 * Adapter selection.
 *
 * Phase 1 ships `mock` only. Phase 3 adds `./http` (real /api/v5) and this file
 * is the ONLY place that changes — every screen already imports `data` from
 * here, so swapping the source is a config flip, not a rewrite.
 */

import type { DataAdapter } from './types';
import { mockAdapter } from './mock/adapter';

const source = (import.meta.env.VITE_DATA_SOURCE as string | undefined) ?? 'mock';

if (source !== 'mock') {
  // Fail loudly rather than silently serving fixtures where real data is meant.
  throw new Error(
    `VITE_DATA_SOURCE="${source}" is not available yet. The http adapter lands in phase 3; ` +
      'run with VITE_DATA_SOURCE=mock (the default) until then.',
  );
}

export const data: DataAdapter = mockAdapter;

/** True when the UI is running on fixtures — surfaced as a banner in the shell. */
export const isMockData = data.name === 'mock';

export * from './types';
