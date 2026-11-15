import { describe, expect, it } from 'vitest';
import { clipLong, recordSent, sentLog, sentTotal } from './sentLog';

describe('sent log', () => {
  it('cuts long strings and keeps short ones, at any depth', () => {
    const long = 'A'.repeat(64);
    expect(clipLong({ username: 'alice', authKey: long, list: [long, 7, null], nested: { ct: long } })).toEqual({
      username: 'alice',
      authKey: 'AAAAAAAAAAAAAAAA… (64 characters)',
      list: ['AAAAAAAAAAAAAAAA… (64 characters)', 7, null],
      nested: { ct: 'AAAAAAAAAAAAAAAA… (64 characters)' },
    });
  });

  it('records a request, its size and its answer without keeping a long value', () => {
    const secret = 'S'.repeat(44);
    const before = sentTotal();
    const answered = recordSent('POST', '/api/auth/login', undefined, { username: 'alice', authKey: secret });
    const entry = sentLog().at(-1)!;
    expect(sentTotal()).toBe(before + 1);
    expect(entry).toMatchObject({ method: 'POST', url: '/api/auth/login', status: null });
    expect(entry.bytes).toBe(JSON.stringify({ username: 'alice', authKey: secret }).length);
    expect(JSON.stringify(sentLog())).not.toContain(secret);
    answered(200);
    expect(sentLog().at(-1)!.status).toBe(200);
  });

  it('describes a binary body by its size and keeps only the latest requests', () => {
    recordSent('POST', '/api/blobs?id=x', new Blob([new Uint8Array(1234)]));
    expect(sentLog().at(-1)).toMatchObject({ bytes: 1234, body: 'Binary data, 1234 bytes' });
    for (let i = 0; i < 320; i++) recordSent('GET', `/api/sync?since=${i}`);
    expect(sentLog().length).toBe(300);
    expect(sentLog().at(-1)!.url).toBe('/api/sync?since=319');
  });
});
