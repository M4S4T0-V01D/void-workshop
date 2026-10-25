import { useRef, useState } from 'react';
import { t } from '../i18n';

/**
 * A drag handle on a panel edge. `onMove` gets the live size while dragging (cheap, no re-render of the window),
 * `onEnd` the final one (saved). Dragging toward `grow` makes the panel bigger. Double-click resets.
 */
export function Resizer({
  edge,
  value,
  min,
  max,
  grow,
  scale = 1,
  title,
  onMove,
  onEnd,
  onReset,
}: {
  edge: 'left' | 'right' | 'top';
  value: number;
  min: number;
  max: number;
  /** Which pointer direction grows the panel: +1 (right/down) or -1 (left/up). */
  grow: 1 | -1;
  /** Units per pixel of pointer travel: a size in percent of a 300px box moves 1/3 per pixel. */
  scale?: number;
  title: string;
  onMove: (v: number) => void;
  onEnd: (v: number) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pos: 0, value: 0, last: 0 });
  const axis = edge === 'top' ? 'y' : 'x';

  return (
    <div
      className={`resizer ${axis} at-${edge} ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title={t('{title} (double-click to reset)', { title })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: axis === 'x' ? e.clientX : e.clientY, value, last: value };
        setDragging(true);
        document.body.classList.add('resizing', axis);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const d = ((axis === 'x' ? e.clientX : e.clientY) - start.current.pos) * grow * scale;
        const v = Math.round(Math.min(max, Math.max(min, start.current.value + d)));
        if (v !== start.current.last) {
          start.current.last = v;
          onMove(v);
        }
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        document.body.classList.remove('resizing', axis);
        if (start.current.last !== start.current.value) onEnd(start.current.last);
      }}
      onPointerCancel={() => {
        setDragging(false);
        document.body.classList.remove('resizing', axis);
        onMove(start.current.value);
      }}
      onDoubleClick={onReset}
    />
  );
}
