import { describe, expect, it } from 'vitest';
import { calculateFrameLayout, wrapFrameText } from '../src/core/frame.js';

const measureText = (text: string): { width: number } => ({ width: [...text].length * 10 });

describe('calculateFrameLayout', () => {
  it('uses two columns when the image is wide enough', () => {
    const layout = calculateFrameLayout({
      width: 1200,
      userText: 'Alice',
      sourceLines: ['tweet id: 42', '@alice'],
      measureText
    });

    expect(layout.mode).toBe('double');
    expect(layout.rightLines).toEqual(['tweet id: 42', '@alice']);
    expect(layout.barHeight).toBeGreaterThan(0);
  });

  it('uses one column and wraps long text when the image is narrow', () => {
    const layout = calculateFrameLayout({
      width: 220,
      userText: '这是一段需要换行的画框文字',
      sourceLines: ['tweet id: 42', '@alice'],
      measureText
    });

    expect(layout.mode).toBe('single');
    expect(layout.rightLines).toEqual([]);
    expect(layout.leftLines.length).toBeGreaterThanOrEqual(3);
  });
});

describe('wrapFrameText', () => {
  it('preserves explicit line breaks', () => {
    expect(wrapFrameText('first\nsecond', 100, measureText)).toEqual(['first', 'second']);
  });
});
