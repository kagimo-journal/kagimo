import { describe, expect, it } from 'vitest';
import { visitorPlatform } from './DesktopDownload';

describe('visitorPlatform', () => {
  it('names the desktop systems', () => {
    expect(visitorPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141 Safari/537.36')).toBe('linux');
    expect(visitorPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18 Safari/605.1.15')).toBe('mac');
    expect(visitorPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('windows');
  });

  it('offers nothing to phones and tablets, whose user agents also say Linux or Mac', () => {
    expect(visitorPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36')).toBeNull();
    expect(visitorPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBeNull();
    expect(visitorPlatform('')).toBeNull();
  });
});
