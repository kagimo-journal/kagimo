import { useEffect, useRef, useState } from 'react';
import { FlameIcon } from '../../components/Icons';
import { type Burn, burnElement } from '../../editor/burn';

/**
 * A pretend entry the visitor can burn with the app's real burn animation (editor/burn.ts). Nothing
 * is stored or deleted: the card is only hidden, and "Write another" brings it back.
 */
export function BurnDemo() {
  const card = useRef<HTMLDivElement>(null);
  const burn = useRef<Burn | null>(null);
  const [state, setState] = useState<'idle' | 'burning' | 'gone'>('idle');

  // Leaving the page mid-burn must not strand the full-screen overlay.
  useEffect(() => () => burn.current?.cancel(), []);

  const start = async () => {
    if (!card.current || state !== 'idle') return;
    setState('burning');
    const b = burnElement(card.current);
    burn.current = b;
    await b.finished;
    b.dispose(); // keeps the card hidden
    burn.current = null;
    setState('gone');
  };

  const reset = () => {
    if (card.current) card.current.style.visibility = '';
    setState('idle');
  };

  return (
    <div className="burn-demo">
      <div className="burn-demo-stage">
        <div ref={card} className="mock mock-card burn-demo-card">
          <div className="mock-meta">
            <span>Tuesday, 3 November · 11:48 pm</span>
          </div>
          <div className="mock-title">Things I can’t say out loud</div>
          <p className="mock-body">
            I’m angrier about it than I let on. I said it was fine and it isn’t. Writing it down helps, and I don’t need to keep it. Tomorrow I’ll
            start again with a clear head.
          </p>
        </div>
        {state === 'gone' && (
          <div className="burn-demo-gone" role="status">
            <p>Gone. No trash folder, no undo.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>
              Write another
            </button>
          </div>
        )}
      </div>
      {state !== 'gone' && (
        <button type="button" className="btn btn-secondary burn-demo-btn" onClick={() => void start()} disabled={state !== 'idle'}>
          <FlameIcon size={16} /> {state === 'burning' ? 'Burning…' : 'Burn it'}
        </button>
      )}
      <p className="burn-demo-note">Try it: this page is only a demo, so nothing is stored or deleted.</p>
    </div>
  );
}
