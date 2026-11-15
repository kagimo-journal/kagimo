import { type ReactNode, useEffect, useId, useRef } from 'react';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Modal built on <dialog> (focus trapping, Escape to close, inert background). */
export function Dialog({ open, title, onClose, children, actions, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog native-dialog${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <h2 id={titleId}>{title}</h2>
          {children}
          {actions && <div className="dialog-actions">{actions}</div>}
        </>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Start on Cancel rather than the confirm button (for actions that can't be undone). */
  focusCancel?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel = 'Cancel', danger, focusCancel, busy, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy} autoFocus={focusCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus={!focusCancel}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="lede" style={{ fontSize: 14 }}>{body}</div>
    </Dialog>
  );
}
