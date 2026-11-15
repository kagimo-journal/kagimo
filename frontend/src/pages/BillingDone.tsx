import { useSearchParams } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { CheckIcon, ClockIcon } from '../components/Icons';

/**
 * Stripe Checkout and the customer portal send people here, in the tab they were opened in.
 * That tab has no keys (they live only in the original tab), so this page just says where to go.
 */
export default function BillingDone() {
  const [params] = useSearchParams();
  const result = params.get('result');
  const success = result === 'success';
  const portal = result === 'portal';

  const title = success ? 'Payment received' : portal ? 'All set' : 'Checkout cancelled';
  const text = success
    ? 'Thank you for subscribing. Go back to your Kagimo tab: it picks up the subscription by itself within a few seconds.'
    : portal
      ? 'Any changes to your subscription are saved. Go back to your Kagimo tab to keep writing.'
      : "Nothing was charged. Go back to your Kagimo tab whenever you're ready.";

  return (
    <div className="page">
      <header className="page-header">
        <Brand to={null} />
      </header>
      <main className="page-main centered" id="main">
        <div className="stack center-text" style={{ width: '100%', maxWidth: 440, alignItems: 'center', gap: 24 }}>
          <div className="badge-circle">{success || portal ? <CheckIcon size={28} strokeWidth={2} /> : <ClockIcon size={28} strokeWidth={1.5} />}</div>
          <div className="stack" style={{ gap: 12 }}>
            <h1 className="page-title">{title}</h1>
            <p className="lede">{text}</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => window.close()}>
            Close this tab
          </button>
          <p className="hint">If the tab stays open, close it yourself. Your journal is still unlocked in the other tab.</p>
        </div>
      </main>
    </div>
  );
}
