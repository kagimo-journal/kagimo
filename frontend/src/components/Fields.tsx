import { type InputHTMLAttributes, type ReactNode, useEffect, useId, useState } from 'react';
import { loadStrengthData, passphraseStrength, strengthDataLoaded } from '../lib/strength';
import { cleanCode } from '../lib/format';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  value: string;
  onChange: (v: string) => void;
  inputClassName?: string;
}

export function TextField({ label, hint, error, value, onChange, inputClassName = '', id, ...rest }: FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = `${fid}-hint`;
  const errId = `${fid}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      <input
        id={fid}
        className={`input ${inputClassName}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && <span id={hintId} className="hint">{hint}</span>}
      {error && <span id={errId} className="error-text" role="alert">{error}</span>}
    </div>
  );
}

export function CodeField(props: Omit<FieldProps, 'inputClassName'>) {
  return (
    <TextField
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="000 000"
      maxLength={7}
      pattern="[0-9 ]*"
      {...props}
      value={props.value}
      onChange={(v) => props.onChange(formatCodeInput(v))}
      inputClassName="input-code"
    />
  );
}

/** "482913" -> "482 913" while typing. */
function formatCodeInput(v: string): string {
  const d = cleanCode(v);
  return d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
}

export function PassphraseField({
  value,
  onChange,
  label = 'Passphrase',
  username,
  showMeter = true,
  ...rest
}: Omit<FieldProps, 'label'> & { label?: string; username?: string; showMeter?: boolean }) {
  const id = useId();
  // The dictionaries behind the estimate load lazily; re-render once they are here.
  const [, setDataReady] = useState(strengthDataLoaded());
  useEffect(() => {
    if (!showMeter || strengthDataLoaded()) return;
    let alive = true;
    loadStrengthData()
      .then(() => alive && setDataReady(true))
      .catch(() => {}); // the built-in list keeps working
    return () => {
      alive = false;
    };
  }, [showMeter]);
  const s = passphraseStrength(value, username);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        className="input"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={showMeter ? `${id}-strength` : undefined}
        spellCheck={false}
        {...rest}
      />
      {showMeter && (
        <>
          <div className={`strength${value && !s.acceptable ? ' weak' : ''}`} aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={value && s.score >= i ? 'on' : ''} />
            ))}
          </div>
          <span id={`${id}-strength`} className="hint" aria-live="polite">{s.label}</span>
        </>
      )}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="error-text" role="alert">
      {children}
    </p>
  );
}
