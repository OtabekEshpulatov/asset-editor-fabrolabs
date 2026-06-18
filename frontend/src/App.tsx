import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { storageApi } from './api';
import AssetsPage from './pages/Assets';
import BackgroundEditorPage from './pages/BackgroundEditor';

export default function App() {
  const qc = useQueryClient();
  const { data: storage } = useQuery({
    queryKey: ['storage-info'],
    queryFn: storageApi.info,
    staleTime: Infinity,
  });

  const [reloading, setReloading] = useState(false);

  const reload = async () => {
    setReloading(true);
    try {
      await storageApi.reload();
      // assets may have been edited out-of-band — refetch the whole gallery.
      qc.invalidateQueries({ queryKey: ['asset-catalog'] });
      qc.invalidateQueries({ queryKey: ['character-actions'] });
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="flex items-center gap-6 border-b bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">asset editor</h1>
        <NavLink to="/assets" className="text-sm text-blue-600 hover:underline">
          assets
        </NavLink>
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          {storage?.configured ? (
            <span title="connected storage">
              <span className="font-mono">{storage.bucket}</span>
            </span>
          ) : (
            <span className="text-amber-600">storage not configured</span>
          )}
          <button
            onClick={reload}
            disabled={reloading}
            title="re-read assets from the bucket (use after editing assets outside the app)"
            className="text-blue-600 hover:underline disabled:opacity-50"
          >
            {reloading ? 'reloading…' : 'reload'}
          </button>
        </div>
      </header>

      <main className="p-6">
        <Routes>
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/backgrounds/:slug" element={<BackgroundEditorPage />} />
          <Route path="/videos/:slug" element={<BackgroundEditorPage />} />
          <Route path="*" element={<Navigate to="/assets" replace />} />
        </Routes>
      </main>
    </div>
  );
}
