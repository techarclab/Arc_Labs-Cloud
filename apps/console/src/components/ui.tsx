import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Connectivity } from '../api';

export function ArcMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5 24 A11 11 0 0 1 27 24" fill="none" stroke="#6E8BFF" strokeWidth="4" strokeLinecap="round" />
      <path d="M10 24 A6 6 0 0 1 22 24" fill="none" stroke="#3157F6" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
      <circle cx="16" cy="24" r="3" fill="#17B39B" />
    </svg>
  );
}

const STATUS_TEXT = { online: 'Online', offline: 'Offline', unknown: 'Not seen yet' } as const;
export function Status({ c }: { c: Connectivity | { status: Connectivity['status'] } }) {
  return (
    <span className={`status ${c.status}`}>
      <span className="dot" aria-hidden="true" />
      {STATUS_TEXT[c.status]}
    </span>
  );
}

export const LIFECYCLE_TEXT: Record<string, string> = {
  provisioned: 'Waiting for first message',
  active: 'Active',
  maintenance: 'In maintenance',
  suspended: 'Suspended',
  revoked: 'Revoked',
  retired: 'Retired',
};
export function Lifecycle({ s }: { s: string }) {
  if (s === 'active') return null;
  const cls = s === 'revoked' || s === 'retired' || s === 'suspended' ? 'bad' : s === 'maintenance' ? 'warn' : '';
  return <span className={`pill ${cls}`}>{LIFECYCLE_TEXT[s] ?? s}</span>;
}

/**
 * Heartbeat strip: one cell per time slot, filled when the device reported in that slot.
 * `counts` oldest→newest; `expected` = messages per slot at the device's normal rate.
 */
export function Strip({ counts, expected, size = 'mini', label }: { counts: number[]; expected: number; size?: 'mini' | 'big'; label: string }) {
  const hits = counts.filter((c) => c > 0).length;
  return (
    <div className={`strip ${size}`} role="img" aria-label={`${label}: reported in ${hits} of ${counts.length} slots`}>
      {counts.map((c, i) => (
        <span key={i} className={`cell ${c === 0 ? '' : c >= expected * 0.6 ? 'hit' : 'thin'}`} />
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean | number }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose} style={wide ? { width: `min(${typeof wide === 'number' ? wide : 680}px, calc(100vw - 32px))` } : undefined}>
      {open && (
        <>
          <div className="modal-head">
            <h2>{title}</h2>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-box" role="alert">
      {msg}
    </div>
  );
}

// ---- toast ----
const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Re-run `fn` now and every `ms` while the tab is visible. */
export function usePoll(fn: () => void | Promise<void>, ms: number, deps: unknown[]) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && document.visibilityState === 'visible') void saved.current();
    };
    tick();
    const id = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** A clock that re-renders every second, for "12s ago" labels. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small quiet"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}
