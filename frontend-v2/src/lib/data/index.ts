/**
 * Adapter selection.
 *
 * `mock`  — generated fixtures, no backend, no storage, no Tailscale.
 * `api`   — the real /api/v4 backend, i.e. your actual library.
 *
 * Set VITE_DATA_SOURCE to choose. Every screen imports `data` from here and
 * never calls fetch directly, so swapping the source is a config flip rather
 * than a rewrite — that is the whole reason this indirection exists.
 */

import type { DataAdapter } from './types';
import { mockAdapter } from './mock/adapter';
import { httpAdapter } from './http/adapter';

export type DataSource = 'mock' | 'api';

const configured = (import.meta.env.VITE_DATA_SOURCE as string | undefined) ?? 'mock';

if (configured !== 'mock' && configured !== 'api') {
  throw new Error(`VITE_DATA_SOURCE must be "mock" or "api" (got "${configured}")`);
}

export const dataSource: DataSource = configured;

export const data: DataAdapter = dataSource === 'api' ? httpAdapter : mockAdapter;

/** True when the UI is running on fixtures — surfaced as a banner in the shell. */
export const isMockData = data.name === 'mock';

export * from './types';
