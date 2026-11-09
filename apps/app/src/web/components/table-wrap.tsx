// Table container. On a computer: the plain scrolling box. On a phone (docs/features/023-phone/spec.md): the whole
// table fits the screen width (small type), two fingers zoom it, a double tap zooms in / back out, and a long table
// shows its first rows with "Afficher tout" instead of a long page.
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { isPhone } from '../hooks/phone';

const FIRST_ROWS = 8;
const MAX_ZOOM = 3;
const DOUBLE_TAP_MS = 300;

const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

const PhoneTable = ({ children }: { children: ReactNode }) => {
  const box = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = box.current;
    const table = element?.querySelector('table');
    if (!element || !table) {
      return;
    }
    let zoom = 1;
    let fit = 1;
    const apply = (next: number, focusX = element.clientWidth / 2) => {
      const contentX = (element.scrollLeft + focusX) / zoom;
      zoom = Math.min(MAX_ZOOM, Math.max(fit, next));
      table.style.zoom = String(zoom);
      element.scrollLeft = contentX * zoom - focusX; // the point under the fingers stays under them
      setZoomed(zoom > fit * 1.02);
    };
    // the table keeps its natural width (max-content): fit it to the box, and follow its rows and the box width
    const measure = () => {
      const natural = table.getBoundingClientRect().width / zoom;
      const wasFit = zoom <= fit * 1.02;
      fit = Math.min(1, element.clientWidth / natural);
      apply(wasFit ? fit : zoom);
      setRows(table.tBodies[0]?.rows.length ?? 0);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutation = new MutationObserver(measure);
    mutation.observe(table, { childList: true, subtree: true });

    let pinch: { d: number; zoom: number } | null = null;
    let lastTap = 0;
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        pinch = { d: distance(event.touches), zoom };
      } else if (event.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < DOUBLE_TAP_MS) {
          event.preventDefault();
          const x = event.touches[0].clientX - element.getBoundingClientRect().left;
          apply(zoom > fit * 1.02 ? fit : fit * 2.2, x);
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    };
    const onMove = (event: TouchEvent) => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault();
        const box = element.getBoundingClientRect();
        const middle = (event.touches[0].clientX + event.touches[1].clientX) / 2 - box.left;
        apply((pinch.zoom * distance(event.touches)) / pinch.d, middle);
      }
    };
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        pinch = null;
      }
    };
    element.addEventListener('touchstart', onStart, { passive: false });
    element.addEventListener('touchmove', onMove, { passive: false });
    element.addEventListener('touchend', onEnd);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
    };
  }, []);

  const long = rows > FIRST_ROWS;
  return (
    <div className="cy-ptable">
      <div ref={box} className={long && !open ? 'cy-ptable-box collapsed' : 'cy-ptable-box'}>
        {children}
      </div>
      {(long || zoomed) && (
        <div className="cy-ptable-foot">
          {long ? (
            <button type="button" className="cy-ptable-more" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Réduire ▴' : `Afficher les ${rows} lignes ▾`}
            </button>
          ) : (
            <span />
          )}
          <span className="ink-3">{zoomed ? 'Double-touchez pour revenir' : 'Pincez pour zoomer'}</span>
        </div>
      )}
    </div>
  );
};

/** `maxHeight`: a scrolling box on a computer; a phone shows the first rows and "Afficher tout" instead. */
export const TableWrap = ({ children, maxHeight }: { children: ReactNode; maxHeight?: number | string }) =>
  isPhone() ? <PhoneTable>{children}</PhoneTable> : <div className="cy-table-wrap" style={maxHeight != null ? { maxHeight } : undefined}>{children}</div>;
