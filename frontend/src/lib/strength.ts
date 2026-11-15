/**
 * Passphrase strength estimate (zxcvbn-style, written for this app; no runtime dependency).
 *
 * The passphrase is split at separators (space - _ . ,) into chunks, and each chunk is segmented
 * (dynamic programming, cheapest cover) into: dictionary words (common passwords, English words,
 * names; cost log2(rank) + 1, plus capitalisation and l33t substitutions), years, dates, digit runs,
 * repeats and sequences, and brute-force characters. The estimate is the sum of the segment costs
 * plus a little for their arrangement. Policy (SPEC §5): acceptable at ≥ 60 bits, roughly four
 * unrelated words or 16+ random mixed characters.
 *
 * Long passphrases (four or more different words, 20+ characters) are not penalised for using
 * everyday words: each whole-word chunk counts at least PHRASE_WORD_BITS, as if picked from a
 * ~32k-word vocabulary. The phrase as a whole is still checked (a famous phrase, the username,
 * repeated words).
 *
 * The dictionaries (~150 KB) are loaded lazily with loadStrengthData(); until then a tiny built-in
 * list of the most common passwords, seasons and months is used, so the meter never blocks.
 * Callers that enforce the policy should `await loadStrengthData()` first.
 */
export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  acceptable: boolean;
  label: string;
  /** Estimated bits of guessing work. */
  bits: number;
}

export const MIN_BITS = 60;

/** Floor for one whole word in a long multi-word passphrase (see above). */
const PHRASE_WORD_BITS = 15;
const PHRASE_MIN_WORDS = 4;
const PHRASE_MIN_LENGTH = 20;

const FALLBACK =
  'password,123456,12345678,qwerty,123456789,12345,1234,111111,1234567,dragon,123123,baseball,abc123,football,monkey,' +
  'letmein,shadow,master,mustang,qwertyuiop,1234567890,superman,1qaz2wsx,qazwsx,jordan,123qwe,killer,trustno1,hunter,' +
  'harley,zxcvbnm,asdfgh,buster,batman,soccer,tigger,charlie,sunshine,iloveyou,ranger,hockey,computer,starwars,pepper,' +
  'freedom,princess,maggie,ginger,cheese,love,welcome,admin,passw0rd,whatever,michael,jennifer,thomas,jessica,london,' +
  'liverpool,arsenal,chelsea,united,manchester,london,secret,summer,winter,spring,autumn,january,february,march,april,' +
  'may,june,july,august,september,october,november,december,monday,friday,sunday,journal,diary,changeme,flower,' +
  'hello,orange,banana,purple,silver,golden,family,forever,angel,matrix,cookie,chocolate,correcthorsebatterystaple';

/** word -> best (lowest) frequency rank across all lists. */
let dict = new Map<string, number>();
let common = new Map<string, number>(); // passwords only (for "one of the most common passwords")
let loaded = false;
let loading: Promise<void> | null = null;

function addList(target: Map<string, number>, csv: string, offset = 0) {
  const words = csv.split(',');
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    const r = i + 1 + offset;
    const cur = target.get(w);
    if (cur === undefined || r < cur) target.set(w, r);
  }
}

function resetToFallback() {
  dict = new Map();
  common = new Map();
  addList(dict, FALLBACK);
  addList(common, FALLBACK);
}
resetToFallback();

/** Loads the full dictionaries (a separate, lazily loaded chunk). Safe to call repeatedly. */
export function loadStrengthData(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = import('./strengthData')
      .then((d) => {
        const next = new Map<string, number>();
        const pw = new Map<string, number>();
        addList(pw, d.PASSWORDS);
        addList(pw, d.EXTRA_PASSWORDS, 200); // hand-picked extras: treat as fairly common
        addList(pw, FALLBACK);
        for (const [w, r] of pw) next.set(w, r);
        for (const csv of [d.ENGLISH, d.FEMALE_NAMES, d.MALE_NAMES, d.SURNAMES]) addList(next, csv);
        dict = next;
        common = pw;
        loaded = true;
      })
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

export function strengthDataLoaded(): boolean {
  return loaded;
}

// ---- estimator -------------------------------------------------------------------------------

const SEPARATORS = /[\s\-_.,]+/;
const LEET: Record<string, string> = { '4': 'a', '@': 'a', '0': 'o', '3': 'e', '5': 's', $: 's', '7': 't', '1': 'i', '!': 'i', '|': 'l', '8': 'b', '9': 'g' };
const log2 = Math.log2;

type Kind = 'word' | 'common' | 'year' | 'date' | 'digits' | 'repeat' | 'sequence' | 'brute';
interface Seg {
  kind: Kind;
  bits: number;
  len: number;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isLetter = (c: string) => /\p{L}/u.test(c);
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

/** De-leeted lower-case variants of s, each with its number of substitutions. */
function variants(s: string): { w: string; subs: number }[] {
  const lower = s.toLowerCase();
  const out = [{ w: lower, subs: 0 }];
  if (!/[4@03$5719!|8]/.test(lower)) return out;
  for (const one of ['i', 'l']) {
    let subs = 0;
    let w = '';
    for (const c of lower) {
      const m = c === '1' ? one : LEET[c];
      if (m) {
        subs++;
        w += m;
      } else w += c;
    }
    if (subs && !out.some((o) => o.w === w)) out.push({ w, subs });
  }
  return out;
}

function capBits(s: string): number {
  const letters = [...s].filter(isLetter);
  const uppers = letters.filter(isUpper).length;
  if (!uppers) return 0;
  if (uppers === letters.length) return 1;
  if (uppers === 1 && isUpper(letters[0])) return 1;
  return Math.min(uppers, letters.length);
}

function wordCost(s: string): Seg | null {
  if (s.length < 3) return null;
  const letters = [...s].filter(isLetter).length;
  if (letters * 2 < s.length || letters === 0) return null;
  let best: Seg | null = null;
  for (const { w, subs } of variants(s)) {
    if (!/^\p{L}+$/u.test(w)) continue;
    const rank = dict.get(w);
    if (rank === undefined) continue;
    const bits = log2(rank) + 1 + capBits(s) + subs;
    if (!best || bits < best.bits) best = { kind: common.has(w) ? 'common' : 'word', bits, len: s.length };
  }
  return best;
}

function digitCost(s: string): Seg | null {
  if (s.length < 2 || ![...s].every(isDigit)) return null;
  const n = Number(s);
  const opts: Seg[] = [{ kind: 'digits', bits: s.length * log2(10), len: s.length }];
  if (s.length === 4 && n >= 1900 && n <= 2039) opts.push({ kind: 'year', bits: log2(140), len: 4 });
  if (s.length === 2) opts.push({ kind: 'year', bits: log2(100), len: 2 });
  if (s.length === 6 || s.length === 8) opts.push({ kind: 'date', bits: 15, len: s.length });
  if ([...s].every((c) => c === s[0])) opts.push({ kind: 'repeat', bits: log2(10) + log2(s.length), len: s.length });
  const step = s.charCodeAt(1) - s.charCodeAt(0);
  if (Math.abs(step) === 1 && [...s].every((_c, i) => i === 0 || s.charCodeAt(i) - s.charCodeAt(i - 1) === step)) {
    opts.push({ kind: 'sequence', bits: log2(10) + log2(s.length) + 1, len: s.length });
  }
  return opts.reduce((a, b) => (b.bits < a.bits ? b : a));
}

function bruteChar(s: string, i: number): number {
  const c = s[i];
  const prev = i > 0 ? s[i - 1] : '';
  if (prev) {
    const d = c.toLowerCase().charCodeAt(0) - prev.toLowerCase().charCodeAt(0);
    if (d === 0 || ((d === 1 || d === -1) && isLetter(c) === isLetter(prev) && isDigit(c) === isDigit(prev))) return 1;
  }
  if (isDigit(c)) return log2(10);
  if (isLetter(c)) return isUpper(c) ? 5.7 : 4.7;
  return 5;
}

/** Cheapest segmentation of one separator-free chunk. */
function segmentChunk(s: string): Seg[] {
  const n = s.length;
  const best: number[] = new Array(n + 1).fill(Infinity);
  const how: (Seg | null)[] = new Array(n + 1).fill(null);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === Infinity) continue;
    const relax = (seg: Seg | null) => {
      if (!seg) return;
      const j = i + seg.len;
      if (best[i] + seg.bits < best[j]) {
        best[j] = best[i] + seg.bits;
        how[j] = seg;
      }
    };
    relax({ kind: 'brute', bits: bruteChar(s, i), len: 1 });
    for (let j = i + 2; j <= Math.min(n, i + 32); j++) {
      const sub = s.slice(i, j);
      relax(wordCost(sub));
      relax(digitCost(sub));
      // A repeat of what came just before ("abcabc", "lovelove").
      const L = j - i;
      if (i >= L && s.slice(i - L, i).toLowerCase() === sub.toLowerCase()) relax({ kind: 'repeat', bits: 1 + log2(L), len: L });
    }
  }
  const segs: Seg[] = [];
  for (let j = n; j > 0; ) {
    const seg = how[j]!;
    segs.unshift(seg);
    j -= seg.len;
  }
  return segs;
}

interface Analysis {
  bits: number;
  segs: Seg[];
  wholeCommon: boolean;
}

function factorialBits(k: number): number {
  let b = 0;
  for (let i = 2; i <= k; i++) b += log2(i);
  return b;
}

export function analyse(p: string): Analysis {
  const chunks = p.split(SEPARATORS).filter(Boolean);
  const wordChunks = new Set(chunks.filter((c) => c.length >= 3 && /^\p{L}+$/u.test(c)).map((c) => c.toLowerCase()));
  const phrase = wordChunks.size >= PHRASE_MIN_WORDS && p.trim().length >= PHRASE_MIN_LENGTH;
  const seen = new Set<string>();
  const segs: Seg[] = [];
  let bits = 0;
  for (const chunk of chunks) {
    const key = chunk.toLowerCase();
    if (seen.has(key)) {
      segs.push({ kind: 'repeat', bits: 1, len: chunk.length });
      bits += 1;
      continue;
    }
    seen.add(key);
    const chunkSegs = segmentChunk(chunk.slice(0, 128));
    // In a long phrase, a chunk that is one dictionary word counts as an ordinary word, however common.
    if (phrase && chunkSegs.length === 1 && wordChunks.has(key) && (chunkSegs[0].kind === 'word' || chunkSegs[0].kind === 'common')) {
      chunkSegs[0] = { kind: 'word', bits: Math.max(chunkSegs[0].bits, PHRASE_WORD_BITS), len: chunkSegs[0].len };
    }
    for (const seg of chunkSegs) {
      segs.push(seg);
      bits += seg.bits;
    }
  }
  // Arrangement: count consecutive brute-force characters as one segment, as zxcvbn does.
  let k = 0;
  for (let i = 0; i < segs.length; i++) if (segs[i].kind !== 'brute' || segs[i - 1]?.kind !== 'brute') k++;
  bits += factorialBits(k);
  if (chunks.length > 1) bits += 1; // which separator

  // The whole thing (separators removed, de-leeted) is itself a known password or phrase.
  let wholeCommon = false;
  const compact = p.replace(/[\s\-_.,]+/g, '');
  for (const { w, subs } of variants(compact)) {
    const rank = dict.get(w);
    if (rank === undefined) continue;
    bits = Math.min(bits, log2(rank) + 2 + subs + capBits(compact));
    if (common.has(w)) wholeCommon = true;
  }
  return { bits, segs, wholeCommon };
}

export function estimateEntropyBits(p: string): number {
  return p ? analyse(p).bits : 0;
}

const EMPTY_LABEL = 'Use four or more unrelated words, or 16 or more mixed characters.';

export function passphraseStrength(p: string, username = ''): Strength {
  if (!p) return { score: 0, acceptable: false, label: EMPTY_LABEL, bits: 0 };
  const u = username.trim().toLowerCase();
  if (u.length >= 3 && p.toLowerCase().includes(u)) return { score: 1, acceptable: false, label: "Don't include your username.", bits: 0 };

  const { bits, segs, wholeCommon } = analyse(p);
  const b = Math.round(bits);
  if (bits >= 80) return { score: 4, acceptable: true, label: 'Very strong.', bits: b };
  if (bits >= MIN_BITS) return { score: 3, acceptable: true, label: 'Strong. Four or more unrelated words works well.', bits: b };

  const words = segs.filter((s) => s.kind === 'word' || s.kind === 'common').length;
  const numbery = segs.some((s) => s.kind === 'year' || s.kind === 'date' || s.kind === 'digits' || s.kind === 'sequence');
  const patterned = segs.filter((s) => s.kind === 'repeat' || s.kind === 'sequence').reduce((n, s) => n + s.len, 0) * 2 >= p.length;
  let label: string;
  if (wholeCommon) label = 'This is one of the most common passwords. Try four unrelated words.';
  else if (patterned) label = 'Repeats and sequences like aaa, abc or 1234 are easy to guess.';
  else if (words >= 1 && words <= 2 && (numbery || segs.some((s) => s.kind === 'brute'))) {
    label = numbery
      ? 'A word plus a year or number is easy to guess. Try four unrelated words.'
      : 'Common words with a few changes are easy to guess. Try four unrelated words.';
  } else if (bits < 35) label = 'Too predictable. Try four or more unrelated words.';
  else if (words >= 3) label = 'Almost. These are common words; add another word or two.';
  else label = 'Almost. Make it a little longer, or use four unrelated words.';
  return { score: bits < 35 ? 1 : 2, acceptable: false, label, bits: b };
}

/** Test hook: forget the full dictionaries (back to the built-in fallback). */
export function _resetStrengthDataForTests() {
  loaded = false;
  loading = null;
  resetToFallback();
}
