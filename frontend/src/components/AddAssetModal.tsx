import { useState } from 'react';
import { apiV4, type AssetKind } from '../api';

const SLUG_RE = /^[a-z0-9_]+$/;

const KIND_LABEL: Record<AssetKind, string> = {
  character: 'sprite',
  background: 'background',
  object: 'object',
};

type AnimRow = { name: string; png: File | null; json: File | null };

export default function AddAssetModal({
  kind,
  categories,
  onClose,
  onDone,
}: {
  kind: AssetKind;
  categories: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [slug, setSlug] = useState('');
  const [category, setCategory] = useState(categories[0] ?? '');
  const [sceneType, setSceneType] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [anims, setAnims] = useState<AnimRow[]>([{ name: 'idle', png: null, json: null }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugValid = SLUG_RE.test(slug);

  const updateAnim = (i: number, next: Partial<AnimRow>) =>
    setAnims((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...next } : r)));

  const canSubmit = (() => {
    if (!slugValid || !category) return false;
    if (kind === 'character') {
      return anims.some((a) => a.name && a.png && a.json);
    }
    return !!file;
  })();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('slug', slug);
      form.append('category', category);
      if (kind === 'object') {
        form.append('file', file!);
        await apiV4.addObject(form);
      } else if (kind === 'background') {
        form.append('scene_type', sceneType);
        form.append('description', description);
        form.append('file', file!);
        await apiV4.addBackground(form);
      } else {
        for (const a of anims) {
          if (!a.name || !a.png || !a.json) continue;
          form.append('files', a.png, `${a.name}.png`);
          form.append('files', a.json, `${a.name}.json`);
        }
        await apiV4.addCharacter(form);
      }
      onDone();
      onClose();
    } catch (e: any) {
      setError(String(e?.response?.data?.detail ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 overflow-auto rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Add {KIND_LABEL[kind]}</h3>
          <button onClick={onClose} className="rounded px-2 text-gray-500 hover:bg-gray-100">
            ✕
          </button>
        </div>

        <label className="block text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Slug</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="lower_snake_case"
            className={`mt-1 w-full rounded border px-2 py-1 ${
              slug && !slugValid ? 'border-red-400' : 'border-gray-300'
            }`}
          />
          {slug && !slugValid && (
            <span className="text-xs text-red-500">lowercase letters, digits, underscores only</span>
          )}
        </label>

        <label className="block text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Category
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        {kind === 'background' && (
          <>
            <label className="block text-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Scene type
              </span>
              <input
                value={sceneType}
                onChange={(e) => setSceneType(e.target.value)}
                placeholder="e.g. outdoor_nature"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Description
              </span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              />
            </label>
          </>
        )}

        {kind === 'object' && (
          <FileField label="SVG file" accept=".svg,image/svg+xml" onPick={setFile} file={file} />
        )}
        {kind === 'background' && (
          <FileField label="PNG file" accept=".png,image/png" onPick={setFile} file={file} />
        )}

        {kind === 'character' && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Animations — each needs spritesheet.png + atlas.json
              </span>
              <button
                onClick={() => setAnims((r) => [...r, { name: '', png: null, json: null }])}
                className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
              >
                + animation
              </button>
            </div>
            <div className="space-y-2">
              {anims.map((a, i) => (
                <div key={i} className="rounded border border-gray-200 p-2">
                  <input
                    value={a.name}
                    onChange={(e) => updateAnim(i, { name: e.target.value })}
                    placeholder="animation name (e.g. idle)"
                    className="mb-2 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                  <div className="flex flex-wrap gap-3">
                    <FileField
                      compact
                      label=".png"
                      accept=".png,image/png"
                      file={a.png}
                      onPick={(f) => updateAnim(i, { png: f })}
                    />
                    <FileField
                      compact
                      label=".json"
                      accept=".json,application/json"
                      file={a.json}
                      onPick={(f) => updateAnim(i, { json: f })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <div className="text-sm text-red-600">{error}</div>}

        <div className="mt-1 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || busy}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 hover:bg-blue-700"
          >
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileField({
  label,
  accept,
  file,
  onPick,
  compact,
}: {
  label: string;
  accept: string;
  file: File | null;
  onPick: (f: File | null) => void;
  compact?: boolean;
}) {
  return (
    <label className={`block text-sm ${compact ? '' : 'mt-1'}`}>
      <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      <input
        type="file"
        accept={accept}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className="mt-1 block w-full text-xs text-gray-600 file:mr-2 file:rounded file:border file:border-gray-300 file:bg-gray-50 file:px-2 file:py-1"
      />
      {file && <span className="text-[11px] text-green-600">{file.name}</span>}
    </label>
  );
}
