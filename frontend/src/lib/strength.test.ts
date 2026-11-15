import { beforeAll, describe, expect, it } from 'vitest';
import { _resetStrengthDataForTests, loadStrengthData, MIN_BITS, passphraseStrength, strengthDataLoaded } from './strength';

describe('passphraseStrength fallback (before the dictionaries load)', () => {
  it('still rejects word + year patterns', () => {
    _resetStrengthDataForTests();
    expect(strengthDataLoaded()).toBe(false);
    expect(passphraseStrength('Summer2024!!').acceptable).toBe(false);
    expect(passphraseStrength('Liverpool2023').acceptable).toBe(false);
    expect(passphraseStrength('password12345678').acceptable).toBe(false);
  });
});

describe('passphraseStrength', () => {
  beforeAll(async () => {
    await loadStrengthData();
  });

  it.each([
    'short',
    'aaaaaaaaaaaaaaaa',
    'password12345678',
    'Summer2024!!',
    'Liverpool2023',
    'P@ssw0rd2024!',
    'correct horse battery staple',
    'qwertyuiop123',
    'abcdefghijklmnop',
    'iloveyou iloveyou',
    'Jennifer1987',
    'Arsenal!2024',
    'Tr0ub4dor&3',
  ])('rejects %j', (p) => {
    const s = passphraseStrength(p);
    expect(s.acceptable).toBe(false);
    expect(s.bits).toBeLessThan(MIN_BITS);
    expect(s.label).toBeTruthy();
  });

  it('explains word + year passwords', () => {
    expect(passphraseStrength('Liverpool2023').label).toMatch(/year|number|common/i);
    expect(passphraseStrength('password').label).toMatch(/most common/i);
  });

  it('accepts four uncommon unrelated words', () => {
    const s = passphraseStrength('lantern orchard quietly ninety');
    expect(s.acceptable).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(3);
  });

  it('accepts 16+ random mixed characters', () => {
    expect(passphraseStrength('k8#Lq2!vR9@xT4zW').acceptable).toBe(true);
  });

  it('accepts a five-word phrase of ordinary words', () => {
    expect(passphraseStrength('kettle river purple morning bicycle').acceptable).toBe(true);
  });

  it.each(['blue house green tree', 'the cat sat on the warm mat', 'love dog happy sunshine', 'winter coffee monday family'])(
    'accepts a long phrase of everyday words: %j',
    (p) => {
      expect(passphraseStrength(p).acceptable).toBe(true);
    },
  );

  it('still rejects short or repetitive word lists', () => {
    expect(passphraseStrength('cat dog sun').acceptable).toBe(false);
    expect(passphraseStrength('love love love love love').acceptable).toBe(false);
  });

  it('rejects passphrases containing the username', () => {
    expect(passphraseStrength('maren maren maren maren', 'maren').acceptable).toBe(false);
    expect(passphraseStrength('lantern orchard quietly maren', 'Maren').label).toMatch(/username/);
  });

  it('rejects the same word repeated', () => {
    expect(passphraseStrength('orchard orchard orchard orchard').acceptable).toBe(false);
  });
});
