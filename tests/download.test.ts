import { describe, expect, it } from 'vitest';
import { isAndroidUserAgent } from '../src/core/download.js';

describe('isAndroidUserAgent', () => {
  it('recognizes Firefox Android user agents', () => {
    expect(isAndroidUserAgent(
      'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0'
    )).toBe(true);
  });

  it('does not classify desktop Firefox as Android', () => {
    expect(isAndroidUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:128.0) Gecko/20100101 Firefox/128.0'
    )).toBe(false);
  });
});
