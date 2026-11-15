import { desktop } from '../../desktop/bridge';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { ShieldIcon } from '../../components/Icons';
import { Spinner } from '../../components/Spinner';
import { exportEntriesZip, type ExportResult } from '../../export/exporter';
import { SettingsPage } from './SettingsPage';

export default function Export() {
  const [scope, setScope] = useState<'all' | 'range'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [images, setImages] = useState(true);
  const [combined, setCombined] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setResult(null);
    if (scope === 'range' && from && to && from > to) return setError('The start date is after the end date.');
    setProgress('Preparing…');
    try {
      const res = await exportEntriesZip({
        from: scope === 'range' && from ? from : undefined,
        to: scope === 'range' && to ? to : undefined,
        includeImages: images,
        combined,
        onProgress: setProgress,
      });
      setResult(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <SettingsPage
      title="Export"
      lede={`Download your entries as Markdown in a .zip file. Everything is decrypted here ${desktop ? 'on your computer' : 'in your browser'}; the server isn't involved.`}
    >

      <form
        className="card"
        style={{ maxWidth: 620 }}
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
          <legend className="label" style={{ marginBottom: 6 }}>Entries</legend>
          <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
            <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} style={{ marginTop: 0 }} />
            <span>All entries</span>
          </label>
          <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
            <input type="radio" name="scope" checked={scope === 'range'} onChange={() => setScope('range')} style={{ marginTop: 0 }} />
            <span>A date range</span>
          </label>
          {scope === 'range' && (
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', paddingLeft: 30 }}>
              <div className="field">
                <label htmlFor="ex-from">From</label>
                <input id="ex-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ex-to">To</label>
                <input id="ex-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
          )}
        </fieldset>

        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
          <legend className="label" style={{ marginBottom: 6 }}>Format</legend>
          <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
            <input type="radio" name="fmt" checked={!combined} onChange={() => setCombined(false)} style={{ marginTop: 0 }} />
            <span>One .md file per entry</span>
          </label>
          <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
            <input type="radio" name="fmt" checked={combined} onChange={() => setCombined(true)} style={{ marginTop: 0 }} />
            <span>A single journal.md</span>
          </label>
        </fieldset>

        <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
          <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} style={{ marginTop: 0 }} />
          <span>Include images</span>
        </label>

        <div className="notice">
          <ShieldIcon size={18} />
          <span>The exported files are <strong>not encrypted</strong>. Anyone who can open them can read your journal, so store them carefully.</span>
        </div>

        {error && <p className="error-text" role="alert">{error}</p>}
        <p role="status" aria-live="polite" className="hint">{progress ?? ''}</p>
        <button type="submit" className="btn btn-primary" disabled={!!progress} style={{ alignSelf: 'flex-start' }}>
          {progress && <Spinner />}
          Export as Markdown
        </button>
      </form>

      {result && (
        <div className="card" style={{ maxWidth: 620 }} role="status">
          <p style={{ fontSize: 14 }}>
            Exported {result.count} {result.count === 1 ? 'entry' : 'entries'}. Check your downloads folder.
          </p>
          {result.failed.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <p className="error-text">These couldn't be decrypted and were skipped:</p>
              <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
                {result.failed.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SettingsPage>
  );
}
