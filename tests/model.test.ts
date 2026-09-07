import { describe, expect, it } from 'vitest';
import { getTweetIdFromPath, normalizeHandle } from '../src/shared/model.js';

describe('normalizeHandle', () => {
  it('keeps exactly one @ prefix', () => {
    expect(normalizeHandle('example')).toBe('@example');
    expect(normalizeHandle('@example')).toBe('@example');
    expect(normalizeHandle('@@example')).toBe('@example');
  });
});

describe('getTweetIdFromPath', () => {
  it('extracts a numeric status id from an X detail route', () => {
    expect(getTweetIdFromPath('/example/status/123456789/photo/1')).toBe('123456789');
  });

  it('rejects routes that are not tweet detail routes', () => {
    expect(getTweetIdFromPath('/home')).toBeUndefined();
    expect(getTweetIdFromPath('/example/status/not-a-number')).toBeUndefined();
  });
});
