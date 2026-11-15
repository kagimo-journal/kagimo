/** Warns before the tab closes or reloads while any entry text or image isn't saved on this device yet. */
import { hasUnsavedDrafts } from './saver';
import { uploads } from './uploads';

export function hasUnsavedWork(): boolean {
  return hasUnsavedDrafts() || uploads.unsaved() > 0;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedWork()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
