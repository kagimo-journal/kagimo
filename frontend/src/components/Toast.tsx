import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

interface ToastApi {
  show: (message: string, opts?: { action?: Toast['action']; ms?: number }) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback<ToastApi['show']>(
    (message, opts = {}) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-2), { id, message, action: opts.action }]);
      setTimeout(() => dismiss(id), opts.ms ?? 6000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
