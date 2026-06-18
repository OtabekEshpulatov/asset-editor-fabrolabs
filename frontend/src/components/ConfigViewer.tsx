import { useState } from 'react';
import { apiV4, type AssetKind } from '../api';

/**
 * Collapsible read-only view of an asset/action's config: one flat object holding
 * the values the system uses (enabled/description/fps/frame_count) plus any extra
 * authored fields (e.g. an object's keywords/real_world_height_cm/rest_surface).
 * Pass `action` for a sprite action; omit it for an object/background/character.
 */
export default function ConfigViewer({
  kind,
  slug,
  action,
}: {
  kind: AssetKind;
  slug: string;
  action?: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (data) return; // already fetched
    setBusy(true);
    setError(null);
    try {
      setData(await apiV4.getConfigView(kind, slug, action));
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={toggle}
        className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
        title="View the stored config for this item"
      >
        {open ? '▾ config' : '⚙ config'}
      </button>
      {open && (
        <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-2">
          {busy && <div className="text-xs text-gray-500">loading…</div>}
          {error && <div className="text-xs text-red-600">{error}</div>}
          {data && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono text-gray-700">
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
