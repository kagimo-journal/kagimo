import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { admin } from '../api/endpoints';
import type { AdminInvite, AdminStats, AdminUser } from '../api/types';
import { Brand } from '../components/Brand';
import { TextField } from '../components/Fields';
import { ConfirmDialog } from '../components/Dialog';
import { ShieldIcon } from '../components/Icons';
import { Menu } from '../components/Menu';
import { LoadingScreen, Spinner } from '../components/Spinner';
import { useToast } from '../components/Toast';
import { formatBytes, relativeTime } from '../lib/format';
import { useMe } from '../state/auth';
import './admin.css';

const PLAN_LABEL: Record<AdminUser['plan'], string> = {
  unlimited: '',
  admin: '',
  comped: 'Free access',
  subscribed: 'Subscribed',
  free: 'Free',
};

function factors(u: AdminUser): string {
  const pk = u.passkeyCount > 0;
  if (pk && u.totpEnabled) return 'Passkey + authenticator';
  if (pk) return u.passkeyCount > 1 ? `${u.passkeyCount} passkeys` : 'Passkey';
  if (u.totpEnabled) return 'Authenticator';
  return 'No second factor yet';
}

type Confirm = { kind: 'delete' | 'disable'; user: AdminUser } | null;

export default function Admin() {
  const me = useMe();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [inviteNote, setInviteNote] = useState('');
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<AdminInvite | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, s, i] = await Promise.all([admin.users(), admin.stats(), admin.invites()]);
      setUsers(u);
      setStats(s);
      setInvites(i);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => document.visibilityState === 'visible' && void load(), 30000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (u: AdminUser, fn: (id: string) => Promise<unknown>, done: string) => {
    setBusyId(u.id);
    try {
      await fn(u.id);
      toast.show(done);
      await load();
    } catch (e) {
      toast.show(errorMessage(e));
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  const mint = async () => {
    setMinting(true);
    try {
      setMinted(await admin.createInvite(inviteNote.trim()));
      setInviteNote('');
      await load();
    } catch (e) {
      toast.show(errorMessage(e));
    } finally {
      setMinting(false);
    }
  };

  const withdraw = async (inv: AdminInvite) => {
    setBusyId(inv.id);
    try {
      await admin.deleteInvite(inv.id);
      if (minted?.id === inv.id) setMinted(null);
      toast.show('Invite withdrawn.');
      await load();
    } catch (e) {
      toast.show(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.show('Invite code copied.');
    } catch {
      toast.show("Couldn't copy: select the code and copy it yourself.");
    }
  };

  const runConfirm = () => {
    if (!confirm) return;
    const { kind, user } = confirm;
    if (kind === 'delete') void act(user, admin.remove, `Deleted ${user.username} and all their data.`);
    if (kind === 'disable') void act(user, admin.disable, `Disabled ${user.username}. They've been signed out.`);
  };

  if (!users && !error) return <LoadingScreen />;

  const members = users ?? [];

  return (
    <div className="page">
      <header className="page-header admin-header">
        <div className="row" style={{ gap: 16 }}>
          <Brand />
          <span className="eyebrow">Admin</span>
        </div>
        <Link to="/" style={{ fontSize: 14, fontWeight: 500 }}>Back to my journal</Link>
      </header>
      <main className="page-main" id="main" style={{ paddingTop: 40 }}>
        <div className="stack" style={{ width: '100%', maxWidth: 1040, gap: 32 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
            <h1 className="page-title">People</h1>
            {stats && (
              <dl className="admin-stats">
                <div><dt>Members</dt><dd>{stats.members}</dd></div>
                <div><dt>Storage used</dt><dd>{formatBytes(stats.storageBytes)}</dd></div>
              </dl>
            )}
          </div>

          <div className="notice">
            <ShieldIcon size={18} />
            <span>
              Entries, images and their details are end-to-end encrypted. As administrator you can see usernames, sign-in methods and storage used,
              never content. You can't reset a member's passphrase.
            </span>
          </div>

          {error && <p className="error-text" role="alert">{error}</p>}

          <section className="stack" style={{ gap: 12 }} aria-labelledby="members-h">
            <h2 id="members-h" style={{ fontSize: 15, fontWeight: 600 }}>Members</h2>
            <div className="admin-box" style={{ overflowX: 'auto' }}>
              <table className="members">
                <thead>
                  <tr>
                    <th scope="col">Username</th>
                    <th scope="col">Sign-in</th>
                    <th scope="col">Plan</th>
                    <th scope="col">Storage</th>
                    <th scope="col">Last active</th>
                    <th scope="col"><span className="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((u) => {
                    const self = String(u.id) === String(me.id);
                    return (
                      <tr key={u.id}>
                        <td style={{ fontWeight: 500 }}>
                          {u.username} {u.isAdmin && <span className="role">Admin</span>}
                          {u.status === 'disabled' && <span className="role disabled">Disabled</span>}
                        </td>
                        <td className="muted">{factors(u)}</td>
                        <td className="muted">
                          {PLAN_LABEL[u.plan]}
                          {u.plan === 'free' && ` · ${Math.min(100, Math.round((100 * u.storageBytes) / u.freeBytes))}% full`}
                        </td>
                        <td className="muted">{formatBytes(u.storageBytes)}</td>
                        <td className="muted">{self ? 'Now' : relativeTime(u.lastActiveAt)}</td>
                        <td style={{ textAlign: 'right', padding: '4px 12px' }}>
                          {!self && (
                            <Menu
                              label={`Manage ${u.username}`}
                              buttonClassName="btn btn-ghost btn-sm"
                              trigger={busyId === u.id ? <Spinner /> : 'Manage'}
                              items={[
                                u.status === 'disabled'
                                  ? { label: 'Enable account', onSelect: () => void act(u, admin.enable, `Enabled ${u.username}.`) }
                                  : { label: 'Disable account', onSelect: () => setConfirm({ kind: 'disable', user: u }) },
                                ...(u.plan === 'free' || u.plan === 'subscribed'
                                  ? [{ label: 'Give free paid access', onSelect: () => void act(u, admin.comp, `${u.username} now has paid sync space for free.`) }]
                                  : u.plan === 'comped'
                                    ? [{ label: 'Remove free access', onSelect: () => void act(u, admin.uncomp, `${u.username} is back on the normal plan.`) }]
                                    : []),
                                { label: 'Delete account…', danger: true, onSelect: () => setConfirm({ kind: 'delete', user: u }) },
                              ]}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="stack" style={{ gap: 12 }} aria-labelledby="invites-h">
            <h2 id="invites-h" style={{ fontSize: 15, fontWeight: 600 }}>Invites</h2>
            <p className="hint" style={{ margin: 0 }}>
              Someone who signs up with an invite code gets free access, with no subscription. Make as many as you like; each code works
              once, and is shown only when you make it.
            </p>
            <form
              className="row invite-form"
              onSubmit={(e) => {
                e.preventDefault();
                void mint();
              }}
            >
              <TextField label="Who it's for (optional)" value={inviteNote} onChange={setInviteNote} maxLength={200} autoComplete="off" />
              <button type="submit" className="btn btn-primary" disabled={minting}>
                {minting && <Spinner />}
                New invite code
              </button>
            </form>
            {minted?.code && (
              <div className="notice invite-minted" role="status">
                <span>
                  {minted.note ? <>Invite for {minted.note}: </> : <>New invite: </>}
                  <code>{minted.code}</code>. Copy it now: it won't be shown again.
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy(minted.code!)}>
                  Copy
                </button>
              </div>
            )}
            <div className="admin-box" style={{ overflowX: 'auto' }}>
              {invites.length === 0 ? (
                <p className="admin-empty">No invites yet.</p>
              ) : (
                <table className="members">
                  <thead>
                    <tr>
                      <th scope="col">For</th>
                      <th scope="col">Made</th>
                      <th scope="col">Status</th>
                      <th scope="col"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((inv) => (
                      <tr key={inv.id}>
                        <td>{inv.note || <span className="muted">No note</span>}</td>
                        <td className="muted">{relativeTime(inv.createdAt)}</td>
                        <td className="muted">
                          {inv.usedAt ? `Used ${relativeTime(inv.usedAt)}${inv.usedBy ? ` by ${inv.usedBy}` : ' (account since deleted)'}` : 'Not used yet'}
                        </td>
                        <td style={{ textAlign: 'right', padding: '4px 12px' }}>
                          {!inv.usedAt && (
                            <button type="button" className="btn btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => void withdraw(inv)}>
                              {busyId === inv.id ? <Spinner /> : 'Withdraw'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </main>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'delete' ? `Delete ${confirm.user.username}?` : `Disable ${confirm?.user.username}?`}
        body={
          confirm?.kind === 'delete'
            ? 'Their account, entries and images are permanently deleted. This cannot be undone, and nobody can recover the data.'
            : "They'll be signed out everywhere and can't sign in until you enable the account again. Their entries are kept."
        }
        confirmLabel={confirm?.kind === 'delete' ? 'Delete permanently' : 'Disable'}
        danger
        busy={!!busyId}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
