/**
 * Build-time replacement for the mock adapter in `api` builds.
 *
 * `lib/data/index.ts` imports both adapters statically so `data` can be a plain
 * synchronous export. That is convenient, but it also means a production build
 * would bundle every fixture the mock adapter reaches — ~688 KB of JSON
 * describing assets that the real backend is about to serve for real.
 *
 * vite.config aliases the mock adapter to this file when VITE_DATA_SOURCE=api,
 * so the fixtures tree-shake away. Nothing should ever call it; if something
 * does, failing loudly is better than silently serving invented data next to
 * real data.
 */

import type { DataAdapter } from '../types';

const unavailable = (): never => {
  throw new Error(
    'The mock adapter is not included in this build (VITE_DATA_SOURCE=api). ' +
      'Run the dev server with the default mock mode to use fixtures.',
  );
};

export const mockAdapter = new Proxy({ name: 'mock' } as DataAdapter, {
  get: (target, prop) => (prop === 'name' ? target.name : unavailable),
});
