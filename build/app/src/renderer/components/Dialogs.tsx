import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export function Modal({ title, children, onClose, footer, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
}

export function ConfirmDialog({ opts, onResult }: { opts: ConfirmOptions; onResult: (ok: boolean) => void }) {
  const [typed, setTyped] = useState('');
  const enabled = !opts.typeToConfirm || typed === opts.typeToConfirm;
  return (
    <Modal
      title={opts.title}
      onClose={() => onResult(false)}
      footer={
        <>
          <button className="btn" onClick={() => onResult(false)}>
            Cancel
          </button>
          <button className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`} disabled={!enabled} onClick={() => onResult(true)} autoFocus={!opts.typeToConfirm}>
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      <div className="confirm-message">{opts.message}</div>
      {opts.typeToConfirm && (
        <label className="field">
          <span>
            Type <code>{opts.typeToConfirm}</code> to confirm
          </span>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation text" />
        </label>
      )}
    </Modal>
  );
}

export function PromptDialog({
  title,
  label,
  initial,
  validate,
  confirmLabel,
  onResult,
}: {
  title: string;
  label: string;
  initial: string;
  validate: (v: string) => string | null;
  confirmLabel?: string;
  onResult: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const error = validate(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <Modal
      title={title}
      onClose={() => onResult(null)}
      footer={
        <>
          <button className="btn" onClick={() => onResult(null)}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!error} onClick={() => onResult(value)}>
            {confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!error) onResult(value);
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!error} />
        </label>
        {error && <div className="field-error">{error}</div>}
      </form>
    </Modal>
  );
}

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

const ToastContext = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-4), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Imperative dialogs (confirm/prompt) rendered from a single host. */
type DialogRequest =
  | { type: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { type: 'prompt'; title: string; label: string; initial: string; validate: (v: string) => string | null; confirmLabel?: string; resolve: (v: string | null) => void };

const DialogContext = createContext<{
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: { title: string; label: string; initial: string; validate: (v: string) => string | null; confirmLabel?: string }) => Promise<string | null>;
}>({ confirm: async () => false, prompt: async () => null });

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setReq({ type: 'confirm', opts, resolve })), []);
  const prompt = useCallback(
    (o: { title: string; label: string; initial: string; validate: (v: string) => string | null; confirmLabel?: string }) =>
      new Promise<string | null>((resolve) => setReq({ type: 'prompt', ...o, resolve })),
    [],
  );
  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {req?.type === 'confirm' && (
        <ConfirmDialog
          opts={req.opts}
          onResult={(ok) => {
            setReq(null);
            req.resolve(ok);
          }}
        />
      )}
      {req?.type === 'prompt' && (
        <PromptDialog
          {...req}
          onResult={(v) => {
            setReq(null);
            req.resolve(v);
          }}
        />
      )}
    </DialogContext.Provider>
  );
}

export const useDialogs = () => useContext(DialogContext);
