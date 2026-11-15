import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { LoadingScreen } from '../../components/Spinner';
import { entriesStore, useEntries } from '../../editor/entriesStore';
import { MOBILE_QUERY, useLocalPref, useMediaQuery } from '../../lib/hooks';
import { EntryList } from './EntryList';
import { EntryEditor } from './EntryEditor';
import './journal.css';

export default function JournalPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const { status, items } = useEntries();
  const [sidebarOpen, setSidebarOpen] = useLocalPref('journal.sidebar', true);
  const fresh = !!(location.state as { fresh?: boolean } | null)?.fresh;

  useEffect(() => {
    void entriesStore.load();
  }, []);

  const newEntry = useCallback(() => navigate(`/e/${crypto.randomUUID()}`, { state: { fresh: true } }), [navigate]);

  // Desktop "/" opens the newest entry, or a new one when the journal is empty.
  useEffect(() => {
    if (id || mobile || (status !== 'ready' && status !== 'error')) return;
    if (items[0]) navigate(`/e/${items[0].id}`, { replace: true });
    else navigate(`/e/${crypto.randomUUID()}`, { replace: true, state: { fresh: true } });
  }, [id, mobile, status, items, navigate]);

  const afterDelete = useCallback(
    (deletedId: string) => {
      const next = entriesStore.get().items.find((e) => e.id !== deletedId);
      navigate(mobile || !next ? '/' : `/e/${next.id}`, { replace: true });
    },
    [mobile, navigate],
  );

  if (mobile) {
    return (
      <div className="journal mobile">
        {id ? (
          <EntryEditor key={id} id={id} fresh={fresh} mobile onDeleted={afterDelete} />
        ) : (
          <EntryList variant="mobile" onNew={newEntry} />
        )}
      </div>
    );
  }

  return (
    <div className="journal">
      <a href="#entry-body" className="skip-link">Skip to entry</a>
      {sidebarOpen && <EntryList variant="sidebar" activeId={id} onNew={newEntry} />}
      {id ? (
        <EntryEditor
          key={id}
          id={id}
          fresh={fresh}
          mobile={false}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          onDeleted={afterDelete}
        />
      ) : (
        <main className="journal-main">
          <LoadingScreen label="Opening your journal…" />
        </main>
      )}
    </div>
  );
}
