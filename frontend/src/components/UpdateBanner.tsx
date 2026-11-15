import { flushAll } from '../editor/saver';
import { applyUpdate, useUpdateReady } from '../lib/serviceWorker';

/** "A new version is ready": reloads only when asked, after saving open entries. The journal reopens after the reload. */
export function UpdateBanner() {
  const ready = useUpdateReady();
  if (!ready) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version of Kagimo is ready.</span>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => {
          void Promise.race([flushAll(), new Promise((r) => setTimeout(r, 4000))]).finally(applyUpdate);
        }}
      >
        Update
      </button>
    </div>
  );
}
