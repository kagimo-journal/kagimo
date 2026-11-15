import { useState } from 'react';
import { toBase64 } from '../../crypto/encoding';
import { deriveRecoveryKeys, wrapMasterKey } from '../../crypto/keys';
import { generateRecoveryKey } from '../../crypto/recovery';
import { masterKeyCopy } from '../../crypto/session';
import { account } from '../../api/endpoints';

/** Generates a new recovery key, wraps the MK with it and replaces the server copy. */
export async function regenerateRecoveryKey(): Promise<string> {
  const rec = generateRecoveryKey();
  const mk = masterKeyCopy();
  try {
    const { authKey, kek } = await deriveRecoveryKeys(rec.bytes);
    const wrapped = await wrapMasterKey(kek, mk);
    await account.regenerateRecovery(toBase64(authKey), wrapped);
    return rec.formatted;
  } finally {
    mk.fill(0);
    rec.bytes.fill(0);
  }
}

/** The key in 8 groups plus Copy / Download .txt / Print. */
export function RecoveryKeyDisplay({ value, username }: { value: string; username: string }) {
  const [copied, setCopied] = useState(false);
  const groups = value.split('-');
  const pairs: string[] = [];
  for (let i = 0; i < groups.length; i += 2) pairs.push(groups.slice(i, i + 2).join('-'));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const text = [
      'journal. recovery key',
      '',
      `Username: ${username}`,
      `Recovery key: ${value}`,
      `Created: ${new Date().toLocaleString()}`,
      '',
      'If you forget your passphrase, this key is the only way back into your entries.',
      'Keep it somewhere safe and offline. Anyone with this key and your username',
      '(and your authenticator code, if you use one) can read your journal.',
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `journal-recovery-key-${username}.txt` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="stack recovery-print" style={{ gap: 18 }}>
      <div className="row no-print" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={copy} aria-live="polite">
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download}>Download .txt</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>Print</button>
      </div>
      <p className="print-only">journal. recovery key for {username}</p>
      <div className="recovery-grid" aria-label={`Recovery key: ${value.split('').join(' ')}`} role="group">
        {pairs.map((p) => (
          <span key={p}>{p}</span>
        ))}
      </div>
    </div>
  );
}
