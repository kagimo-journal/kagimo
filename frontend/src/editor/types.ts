import type { JSONContent } from '@tiptap/react';
import type { EntryLocation } from '../location/geocode';
import type { EntryWeather } from '../weather/weather';

/** Plaintext entry header (SPEC §4). */
export interface EntryHeader {
  v: 1;
  title: string;
  snippet: string;
  createdAt: string;
  tz: string;
  location: EntryLocation | null;
  /** Weather when the entry was started. Absent in headers saved before it existed. */
  weather?: EntryWeather | null;
  wordCount: number;
  imageCount: number;
  /** The first image's blob ID (timeline thumbnail). Absent in headers saved before it existed. */
  coverBlobId?: string | null;
  /** Number of photos in the entry. Absent in headers saved before it existed. */
  photoCount?: number;
}

/** Plaintext entry body (SPEC §4). */
export interface EntryBody {
  v: 1;
  doc: JSONContent;
}

export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
