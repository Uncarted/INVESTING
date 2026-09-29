import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { actions } from '../lib/store';
import type { AssetClass } from '../lib/types';
import { CLASS_LABEL } from '../lib/types';

export function Modal({
  title, onClose, children, footer, wide,
}: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Fechar"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer">{children}</aside>
    </>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; text: string; undo?: boolean };
let toastListener: ((t: Toast[]) => void) | null = null;
let toasts: Toast[] = [];
let nextId = 1;

export function toast(text: string, opts?: { undo?: boolean }) {
  const t = { id: nextId++, text, undo: opts?.undo };
  toasts = [...toasts, t];
  toastListener?.(toasts);
  setTimeout(() => dismiss(t.id), opts?.undo ? 7000 : 3500);
}
function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  toastListener?.(toasts);
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    toastListener = setList;
    return () => {
      toastListener = null;
    };
  }, []);
  return (
    <div className="toasts" role="status">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.undo && (
            <button
              onClick={() => {
                const label = actions.undo();
                dismiss(t.id);
                if (label) toast('Desfeito');
              }}
            >
              Desfazer
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function ClassChip({ cls }: { cls: AssetClass }) {
  return (
    <span className="chip">
      <span className="dot" style={{ background: `var(--c-${cls})` }} />
      {CLASS_LABEL[cls]}
    </span>
  );
}

export function Delta({ value, children }: { value: number; children: ReactNode }) {
  return <span className={value > 0.004 ? 'pos' : value < -0.004 ? 'neg' : 'muted'}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function useSort<K extends string>(initial: K, initialDir: 1 | -1 = -1) {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<1 | -1>(initialDir);
  const toggle = (k: K) => {
    if (k === key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setKey(k);
      setDir(-1);
    }
  };
  const arrow = (k: K) => (k === key ? (dir === 1 ? ' ↑' : ' ↓') : '');
  return { key, dir, toggle, arrow };
}
