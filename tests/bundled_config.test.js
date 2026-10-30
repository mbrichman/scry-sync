import { describe, it, expect } from 'vitest';
import bc from '../chrome/bundled_config.js';

const { parseBundledConfig, shouldSeed, seedScrySettings } = bc;

describe('parseBundledConfig', () => {
  it('accepts a valid config and strips trailing slashes from the url', () => {
    expect(parseBundledConfig({ url: 'http://localhost:5001///', token: 'test-token-1234567890' }))
      .toEqual({ url: 'http://localhost:5001', token: 'test-token-1234567890' });
  });
  it('trims whitespace', () => {
    expect(parseBundledConfig({ url: ' https://scry.example.test/ ', token: ' test-token-1234567890 ' }))
      .toEqual({ url: 'https://scry.example.test', token: 'test-token-1234567890' });
  });
  it.each([
    [null], [undefined], ['x'], [[]], [{}],
    [{ url: 'ftp://localhost', token: 't' }],
    [{ url: 'not a url', token: 't' }],
    [{ url: 'javascript:alert(1)', token: 't' }],
    [{ url: 'http://localhost:5001', token: '' }],
    [{ url: 'http://localhost:5001', token: '   ' }],
    [{ url: 'http://localhost:5001', token: 123 }],
    [{ url: 'http://localhost:5001', token: 'short-token-15ch' .slice(0, 15) }],
    [{ url: 'http://localhost:5001' }],
    [{ token: 'test-token-1234567890' }],
  ])('rejects invalid config %j', (cfg) => {
    expect(parseBundledConfig(cfg)).toBeNull();
  });
});

describe('shouldSeed', () => {
  it('seeds when there are no settings', () => {
    expect(shouldSeed(undefined)).toBe(true);
    expect(shouldSeed({})).toBe(true);
  });
  it('seeds when url and token are both empty', () => {
    expect(shouldSeed({ url: '', token: '', concurrency: 4 })).toBe(true);
  });
  it('does not seed when both are set', () => {
    expect(shouldSeed({ url: 'http://x.test', token: 'abc' })).toBe(false);
  });
  it('does not seed when only one is set (stored settings win)', () => {
    expect(shouldSeed({ url: 'http://x.test' })).toBe(false);
    expect(shouldSeed({ token: 'abc' })).toBe(false);
  });
});

describe('seedScrySettings', () => {
  const cfg = { url: 'http://localhost:5001/', token: 'test-token-1234567890' };
  const SEEDED = { url: 'http://localhost:5001', token: 'test-token-1234567890' };
  it('seeds a valid config into empty settings', () => {
    expect(seedScrySettings(undefined, cfg)).toEqual({ url: 'http://localhost:5001', token: 'test-token-1234567890', seeded: SEEDED });
  });
  it('preserves other scry keys', () => {
    expect(seedScrySettings({ concurrency: 6, chatgptEnabled: true }, cfg))
      .toEqual({ concurrency: 6, chatgptEnabled: true, url: 'http://localhost:5001', token: 'test-token-1234567890', seeded: SEEDED });
  });
  it('returns null (no write) when existing settings have a url or token', () => {
    expect(seedScrySettings({ url: 'http://other.test', token: 'mine' }, cfg)).toBeNull();
    expect(seedScrySettings({ url: 'http://other.test' }, cfg)).toBeNull();
  });
  it('returns null for an invalid config', () => {
    expect(seedScrySettings({}, { url: 'ftp://x', token: 't' })).toBeNull();
    expect(seedScrySettings({}, null)).toBeNull();
  });

  describe('token rotation', () => {
    const stored = { concurrency: 6, ...SEEDED, seeded: SEEDED };
    it('re-seeds when the file changed and stored settings are untouched', () => {
      const rotated = { url: 'http://localhost:5001', token: 'test-token-4567890123' };
      expect(seedScrySettings(stored, rotated)).toEqual({
        concurrency: 6, url: 'http://localhost:5001', token: 'test-token-4567890123',
        seeded: { url: 'http://localhost:5001', token: 'test-token-4567890123' },
      });
    });
    it('never touches hand-edited settings', () => {
      const rotated = { url: 'http://localhost:5001', token: 'test-token-4567890123' };
      expect(seedScrySettings({ ...stored, token: 'my-own-token-xyz' }, rotated)).toBeNull();
      expect(seedScrySettings({ ...stored, url: 'http://other.test' }, rotated)).toBeNull();
    });
    it('is a no-op when the file is unchanged', () => {
      expect(seedScrySettings(stored, cfg)).toBeNull();
    });
    it('is a no-op when the file is missing or invalid', () => {
      expect(seedScrySettings(stored, null)).toBeNull();
      expect(seedScrySettings(stored, { url: 'ftp://x', token: 't' })).toBeNull();
      expect(seedScrySettings(stored, { url: 'http://localhost:5001', token: '' })).toBeNull();
    });
    it('does not rotate settings that were never seeded', () => {
      expect(seedScrySettings({ url: 'http://a.test', token: 'abc' }, { url: 'http://b.test', token: 'defdefdefdefdefdef' })).toBeNull();
    });
  });
});
