/**
 * The desktop app (desktop/): what the app offers the page, set up by desktop/src-tauri/src/bridge.js.
 * `desktop` is null in a browser, where the journal lives in IndexedDB instead of a folder.
 */

/** The journal's single files: kagimo.json, settings.json, outbox.json. */
export type FolderDoc = 'vault' | 'settings' | 'outbox';
/** One file per record: entries/<id>.json, blobs/<id>.json. */
export type FolderCollection = 'entries' | 'blobs';

export interface DesktopBridge {
  platform: string;
  folder: {
    /** The journal folder in use, and whether it can be reached right now (a drive may be unplugged). */
    current(): Promise<{ path: string; available: boolean } | null>;
    /** Shows the folder dialog. null when cancelled. Nothing changes until `open`. */
    pick(): Promise<{ path: string; hasJournal: boolean } | null>;
    /** Switches to the folder last picked. */
    open(): Promise<{ path: string }>;
    /** Shows the folder in the file manager. */
    reveal(): Promise<void>;
  };
  /** Whole records in and out of the journal folder; null deletes. Everything stored is ciphertext. */
  files: {
    readDoc(name: FolderDoc): Promise<unknown | null>;
    writeDoc(name: FolderDoc, value: unknown | null): Promise<void>;
    list(coll: FolderCollection): Promise<unknown[]>;
    read(coll: FolderCollection, id: string): Promise<unknown | null>;
    write(coll: FolderCollection, id: string, value: unknown | null): Promise<void>;
    /** A photo's ciphertext (blobs/<id>.bin). */
    readBytes(id: string): Promise<Uint8Array | null>;
    writeBytes(id: string, bytes: Uint8Array | null): Promise<void>;
    /** Deletes the journal's files from the folder (the folder and anything else in it stay). */
    wipe(): Promise<void>;
  };
  /** The master key of a journal without a password, kept in the computer's keychain. */
  keys: {
    save(vaultId: string, mk: Uint8Array): Promise<void>;
    load(vaultId: string): Promise<Uint8Array | null>;
    delete(vaultId: string): Promise<void>;
  };
  /** The sync server /api requests go to. */
  server: {
    get(): Promise<{ url: string; isDefault: boolean }>;
    /** An empty address goes back to the default. Signs out of the previous server. */
    set(url: string): Promise<{ url: string; isDefault: boolean }>;
  };
  /**
   * fetch() for the sync server's /api (`path` starts with /api/). The app sends it to the chosen
   * server with its own cookie jar; the session cookie never reaches the page. Like fetch, it rejects
   * with a TypeError when the server can't be reached.
   */
  api(path: string, init: { method: string; headers: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal }): Promise<Response>;
  /** Opens an https or mailto link in the person's browser or mail app. */
  openExternal(url: string): Promise<void>;
  onChooseFolder(listener: () => void): () => void;
  onNewEntry(listener: () => void): () => void;
  onClosing(save: () => Promise<unknown>): void;
}

declare global {
  interface Window {
    kagimoDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | null = typeof window !== 'undefined' ? (window.kagimoDesktop ?? null) : null;

/** Words that differ between the desktop app and a browser, for sentences that are otherwise the same. */
export const HERE = desktop ? 'computer' : 'browser';
export const TAB = desktop ? 'window' : 'tab';
/** Where a payment page opens. */
export const NEW_TAB = desktop ? 'your browser' : 'a new tab';
