import { useEffect, useState } from 'react';
import { apiV4, type CharacterAction, type CharacterActions } from '../api';
import ConfigViewer from './ConfigViewer';
import FrameEditorModal from './FrameEditorModal';
import SpriteCanvas from './SpriteCanvas';
import { QuickTransform, type Transform } from './TransformControls';

function withRev(url: string | null | undefined, rev?: number): string | undefined {
  if (!url || !rev) return url ?? undefined;
  return url + (url.includes('?') ? '&' : '?') + 'rev=' + rev;
}

function Switch({ checked, onChange, title }: { checked: boolean; onChange: () => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      title={title}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${
        checked ? 'bg-blue-600' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
          checked ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export default function SpriteActionsModal({
  slug,
  onClose,
  onChanged,
}: {
  slug: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<CharacterActions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = () =>
    apiV4
      .getCharacterActions(slug)
      .then(setData)
      .catch((e) => setError(String(e?.response?.data?.detail ?? e)));

  useEffect(() => {
    load();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = async () => {
    await load();
    onChanged();
  };

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const allNames = data?.actions.map((a) => a.name) ?? [];
  const allSelected = allNames.length > 0 && allNames.every((n) => selected.has(n));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allNames));

  const bulkSetEnabled = async (enabled: boolean) => {
    setBulkBusy(true);
    setError(null);
    try {
      for (const name of selected) await apiV4.setActionConfig(slug, name, { enabled });
      setSelected(new Set());
      await refresh();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-base font-semibold text-gray-900">Manage actions</h3>
            <span className="font-mono text-sm text-gray-500">{slug}</span>
            {data && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                {data.actions.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-5">
          {!data ? (
            <div className="py-10 text-center text-sm text-gray-500">Loading…</div>
          ) : (
            <>
              <CharacterBanner slug={slug} data={data} onChanged={refresh} setError={setError} />

              {/* bulk selection toolbar */}
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
                <label className="flex items-center gap-1.5 text-gray-700">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-blue-600" />
                  select all
                </label>
                <span className="text-xs text-gray-500">{selected.size} selected</span>
                {selected.size > 0 && (
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      disabled={bulkBusy}
                      onClick={() => bulkSetEnabled(true)}
                      className="rounded-md border border-green-600 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-800 hover:bg-green-100 disabled:opacity-40"
                    >
                      {bulkBusy ? '…' : 'Enable'}
                    </button>
                    <button
                      disabled={bulkBusy}
                      onClick={() => bulkSetEnabled(false)}
                      className="rounded-md border border-red-500 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                    >
                      {bulkBusy ? '…' : 'Disable'}
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-2.5">
                {data.actions.map((a) => (
                  <ActionRow
                    key={a.name}
                    slug={slug}
                    action={a}
                    selected={selected.has(a.name)}
                    onToggleSelect={() => toggle(a.name)}
                    onChanged={refresh}
                    setError={setError}
                  />
                ))}
              </div>
              <AddActionForm slug={slug} onChanged={refresh} setError={setError} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CharacterBanner({
  slug,
  data,
  onChanged,
  setError,
}: {
  slug: string;
  data: CharacterActions;
  onChanged: () => void;
  setError: (s: string | null) => void;
}) {
  const [desc, setDesc] = useState(data.description);
  const run = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
      await onChanged();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    }
  };
  const dirty = desc !== data.description;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gradient-to-b from-gray-50 to-white p-3">
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <Switch
          checked={data.enabled}
          onChange={() => run(apiV4.setAssetConfig('character', slug, { enabled: !data.enabled }))}
        />
        <span className="font-medium">{data.enabled ? 'Enabled' : 'Disabled'}</span>
      </label>
      <div className="flex flex-1 items-center gap-2">
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="character description…"
          className="flex-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        {dirty && (
          <button
            onClick={() => run(apiV4.setAssetConfig('character', slug, { description: desc }))}
            className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 border-l border-gray-200 pl-3">
        <span className="text-[11px] text-gray-400">flip all (in place):</span>
        <button
          onClick={() => run(apiV4.transformAsset('character', slug, { flip_h: true }))}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          title="Mirror every action left ↔ right (overwrites each spritesheet)"
        >
          ⇆ H
        </button>
        <button
          onClick={() => run(apiV4.transformAsset('character', slug, { flip_v: true }))}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          title="Mirror every action top ↕ bottom (overwrites each spritesheet)"
        >
          ⇅ V
        </button>
      </div>
    </div>
  );
}

function ActionRow({
  slug,
  action,
  selected,
  onToggleSelect,
  onChanged,
  setError,
}: {
  slug: string;
  action: CharacterAction;
  selected: boolean;
  onToggleSelect: () => void;
  onChanged: () => void;
  setError: (s: string | null) => void;
}) {
  const [fps, setFps] = useState(action.fps);
  const [frameCount, setFrameCount] = useState(action.frame_count);
  const [desc, setDesc] = useState(action.description);
  const [rename, setRename] = useState(action.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingFrames, setEditingFrames] = useState(false);

  // Keep these in sync with the server value after an out-of-band change (e.g.
  // editing frames updates frame_count via a different button/save action).
  useEffect(() => {
    setFps(action.fps);
    setFrameCount(action.frame_count);
    setDesc(action.description);
    setRename(action.name);
  }, [action.fps, action.frame_count, action.description, action.name]);

  const run = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
      await onChanged();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    }
  };

  const transform = (t: Transform) => run(apiV4.transformAction(slug, action.name, t));
  const settingsDirty =
    fps !== action.fps || frameCount !== action.frame_count || desc !== action.description;

  return (
    <div
      className={`flex gap-3 rounded-lg border p-2.5 transition ${
        selected ? 'border-blue-400 ring-1 ring-blue-300' : 'border-gray-200 hover:border-gray-300'
      } ${action.enabled ? 'bg-white' : 'bg-gray-50 opacity-75'}`}
    >
      <div className="flex flex-col items-center gap-1.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          title="select for bulk action"
          className="accent-blue-600"
        />
        <div className="overflow-hidden rounded-md ring-1 ring-gray-200">
          <SpriteCanvas url={withRev(action.spritesheet, action.rev)} size={64} fps={action.fps} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={rename}
            onChange={(e) => setRename(e.target.value)}
            className="w-28 rounded-md border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none"
          />
          {rename !== action.name && /^[a-z0-9_]+$/.test(rename) && (
            <button
              onClick={() => run(apiV4.renameAction(slug, action.name, rename.trim()))}
              className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
            >
              rename
            </button>
          )}
          <Switch
            checked={action.enabled}
            onChange={() => run(apiV4.setActionConfig(slug, action.name, { enabled: !action.enabled }))}
            title="enabled (hidden everywhere when off)"
          />
          <span className="mx-0.5 h-4 w-px bg-gray-200" />
          <QuickTransform onApply={transform} title="flip / rotate this action in place (per frame)" />
          <button
            onClick={() => run(apiV4.mirrorAction(slug, action.name))}
            title="Create a separate horizontally-mirrored copy, saved as <name>_mirrored"
            className="rounded-md border border-purple-300 bg-purple-50 px-2 py-1 text-xs font-medium text-purple-800 hover:bg-purple-100"
          >
            ⇄ copy
          </button>
          <button
            onClick={() => setEditingFrames(true)}
            disabled={!action.spritesheet}
            title="Reorder, duplicate, or delete frames of this animation (with live preview)"
            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-40"
          >
            🎞 edit frames
          </button>
          <div className="ml-auto">
            {confirmDelete ? (
              <span className="flex items-center gap-1">
                <button
                  onClick={() => run(apiV4.deleteAction(slug, action.name))}
                  className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700"
                >
                  delete?
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
                >
                  cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete this action and its sprite files"
                className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
              >
                🗑
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-gray-500">
            fps
            <input
              type="number"
              min={1}
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              className="w-14 rounded-md border border-gray-300 px-1.5 py-1 text-xs text-gray-800"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-gray-500">
            frames
            <input
              type="number"
              min={1}
              value={frameCount}
              onChange={(e) => setFrameCount(Number(e.target.value))}
              className="w-14 rounded-md border border-gray-300 px-1.5 py-1 text-xs text-gray-800"
            />
          </label>
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="action description…"
            className="min-w-[8rem] flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <button
            onClick={() =>
              run(
                apiV4.setActionConfig(slug, action.name, {
                  fps,
                  frame_count: frameCount,
                  description: desc,
                }),
              )
            }
            disabled={!settingsDirty}
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40"
          >
            Save
          </button>
        </div>

        <ConfigViewer kind="character" slug={slug} action={action.name} />
      </div>

      {editingFrames && action.spritesheet && (
        <FrameEditorModal
          slug={slug}
          action={action.name}
          spritesheetUrl={withRev(action.spritesheet, action.rev)!}
          fps={action.fps}
          frameCount={action.frame_count}
          onClose={() => setEditingFrames(false)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

function AddActionForm({
  slug,
  onChanged,
  setError,
}: {
  slug: string;
  onChanged: () => void;
  setError: (s: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [png, setPng] = useState<File | null>(null);
  const [json, setJson] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = /^[a-z0-9_]+$/.test(name) && png && json;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('action', name);
      form.append('spritesheet', png!);
      form.append('atlas', json!);
      await apiV4.addCharacterAction(slug, form);
      setName('');
      setPng(null);
      setJson(null);
      await onChanged();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50/50 p-3">
      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        Add action — spritesheet (.png) + atlas (.json)
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="action name"
          className="w-36 rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        <label className="text-xs text-gray-600">
          <span className="mb-0.5 block">.png</span>
          <input
            type="file"
            accept=".png,image/png"
            onChange={(e) => setPng(e.target.files?.[0] ?? null)}
            className="block w-40 text-xs"
          />
        </label>
        <label className="text-xs text-gray-600">
          <span className="mb-0.5 block">.json</span>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => setJson(e.target.files?.[0] ?? null)}
            className="block w-40 text-xs"
          />
        </label>
        <button
          onClick={submit}
          disabled={!valid || busy}
          className="ml-auto rounded-md bg-green-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-40"
        >
          {busy ? 'Uploading…' : '+ Add action'}
        </button>
      </div>
    </div>
  );
}
