import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { useToast } from '../components/Toast';
import { isUnlocked } from '../crypto/session';
import { desktop } from './bridge';
import { chooseFolder } from './folder';

/** Desktop app: the File menu's "New Entry" and "Open Journal Folder…". */
export function DesktopEvents() {
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => {
    if (!desktop) return;
    const offFolder = desktop.onChooseFolder(() => {
      chooseFolder().then(
        (changed) => changed && navigate('/', { replace: true }),
        (e) => toast.show(errorMessage(e)),
      );
    });
    const offNew = desktop.onNewEntry(() => {
      if (isUnlocked()) navigate(`/e/${crypto.randomUUID()}`, { state: { fresh: true } });
    });
    return () => {
      offFolder();
      offNew();
    };
  }, [navigate, toast]);
  return null;
}
