import { useState } from 'react';
import type { ImageTransform } from '../api';

export type Transform = Required<ImageTransform>;
export const IDENTITY: Transform = { flip_h: false, flip_v: false, rotate: 0 };

/** CSS mirror of the baked transform — flip first, then rotate (matches the backend). */
export function cssTransform(t: ImageTransform): string {
  const r = t.rotate ?? 0;
  const sx = t.flip_h ? -1 : 1;
  const sy = t.flip_v ? -1 : 1;
  return `rotate(${r}deg) scaleX(${sx}) scaleY(${sy})`;
}

export function isDirty(t: Transform): boolean {
  return t.flip_h || t.flip_v || ((t.rotate % 360) + 360) % 360 !== 0;
}

function normalize(t: Transform): Transform {
  return { ...t, rotate: ((t.rotate % 360) + 360) % 360 };
}

const toolBtn =
  'inline-flex items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 ' +
  'text-xs font-medium text-gray-700 transition hover:border-gray-400 hover:bg-gray-50 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Full transform editor (controlled). The parent owns `value` and previews it
 * live via `cssTransform(value)`; `onApply` bakes it into the file.
 */
export function TransformBar({
  value,
  onChange,
  onApply,
  busy,
  error,
}: {
  value: Transform;
  onChange: (t: Transform) => void;
  onApply: (t: Transform) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const dirty = isDirty(value);
  const set = (patch: Partial<Transform>) => onChange({ ...value, ...patch });
  const bump = (delta: number) => set({ rotate: (((value.rotate + delta) % 360) + 360) % 360 });

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Transform
        </span>
        {dirty && (
          <button
            type="button"
            onClick={() => onChange(IDENTITY)}
            className="text-[11px] text-gray-500 hover:text-gray-800 hover:underline"
          >
            reset
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => set({ flip_h: !value.flip_h })}
          aria-pressed={value.flip_h}
          className={`${toolBtn} ${value.flip_h ? 'border-blue-500 bg-blue-50 text-blue-700' : ''}`}
          title="Mirror left ↔ right"
        >
          ⇆ Flip H
        </button>
        <button
          type="button"
          onClick={() => set({ flip_v: !value.flip_v })}
          aria-pressed={value.flip_v}
          className={`${toolBtn} ${value.flip_v ? 'border-blue-500 bg-blue-50 text-blue-700' : ''}`}
          title="Mirror top ↕ bottom"
        >
          ⇅ Flip V
        </button>
        <span className="mx-1 h-5 w-px bg-gray-300" />
        <button type="button" onClick={() => bump(-90)} className={toolBtn} title="Rotate 90° counter-clockwise">
          ↺ 90°
        </button>
        <button type="button" onClick={() => bump(90)} className={toolBtn} title="Rotate 90° clockwise">
          ↻ 90°
        </button>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={value.rotate}
          onChange={(e) => set({ rotate: Number(e.target.value) })}
          className="flex-1 accent-blue-600"
        />
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={360}
            value={Math.round(value.rotate)}
            onChange={(e) => set({ rotate: Number(e.target.value) })}
            className="w-16 rounded border border-gray-300 px-1.5 py-1 text-right text-xs"
          />
          <span className="text-xs text-gray-500">°</span>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-0.5">
        <button
          type="button"
          onClick={() => onApply(normalize(value))}
          disabled={!dirty || busy}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Apply & save'}
        </button>
        <span className="text-[11px] text-gray-400">Overwrites the file in storage.</span>
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    </div>
  );
}

/** Compact one-click transforms (used per action row). Each click bakes immediately. */
export function QuickTransform({
  onApply,
  title = 'transform',
}: {
  onApply: (t: Transform) => Promise<void>;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (t: Transform) => {
    setBusy(true);
    try {
      await onApply(t);
    } finally {
      setBusy(false);
    }
  };
  const cls =
    'inline-flex h-7 w-7 items-center justify-center rounded border border-gray-300 bg-white text-xs ' +
    'text-gray-600 transition hover:border-gray-400 hover:bg-gray-50 disabled:opacity-40';
  return (
    <div className="inline-flex items-center gap-1" title={title}>
      <button disabled={busy} onClick={() => run({ flip_h: true, flip_v: false, rotate: 0 })} className={cls} title="Mirror left ↔ right (in place)">
        ⇆
      </button>
      <button disabled={busy} onClick={() => run({ flip_h: false, flip_v: true, rotate: 0 })} className={cls} title="Mirror top ↕ bottom (in place)">
        ⇅
      </button>
      <button disabled={busy} onClick={() => run({ flip_h: false, flip_v: false, rotate: 270 })} className={cls} title="Rotate 90° counter-clockwise">
        ↺
      </button>
      <button disabled={busy} onClick={() => run({ flip_h: false, flip_v: false, rotate: 90 })} className={cls} title="Rotate 90° clockwise">
        ↻
      </button>
    </div>
  );
}
