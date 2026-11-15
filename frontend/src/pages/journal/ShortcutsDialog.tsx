import { Dialog } from '../../components/Dialog';
import { formatKeys, type Shortcut, SHORTCUTS } from '../../editor/shortcuts';

const GROUPS: Shortcut['group'][] = ['Text', 'Paragraph styles', 'Layout', 'Editing'];

/** "Keyboard shortcuts" (Mod-/ in the editor, or the entry options menu). */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      title="Keyboard shortcuts"
      onClose={onClose}
      className="shortcuts-dialog"
      actions={
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
          Done
        </button>
      }
    >
      <div className="shortcut-groups">
        {GROUPS.map((group) => (
          <section key={group} className="shortcut-group" aria-label={group}>
            <h3 className="eyebrow">{group}</h3>
            <dl>
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.id} className="shortcut-row">
                  <dt>{s.label}</dt>
                  <dd>
                    {s.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="muted"> or </span>}
                        <kbd>{formatKeys(k)}</kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="hint">In the format bar, use the arrow keys to move between controls and Escape to return to your text.</p>
    </Dialog>
  );
}
