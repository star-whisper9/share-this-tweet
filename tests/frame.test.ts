import { describe, expect, it } from 'vitest';
import { calculateFrameLayout, wrapFrameText, wrapVerticalText } from '../src/core/frame.js';

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

  it('uses a side frame and vertical columns for left and right orientations', () => {
    const layout = calculateFrameLayout({
      width: 800,
      height: 600,
      orientation: 'left',
      userText: 'Alice',
      sourceLines: ['tweet id: 42', '@alice'],
      measureText
    });

    expect(layout.orientation).toBe('left');
    expect(layout.frameWidth).toBeGreaterThan(0);
    expect(layout.frameHeight).toBe(600);
    expect(layout.userColumns).toEqual(['Alice']);
    expect(layout.sourceColumns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('wrapFrameText', () => {
  it('preserves explicit line breaks', () => {
    expect(wrapFrameText('first\nsecond', 100, measureText)).toEqual(['first', 'second']);
  });

  it('splits vertical text into top-to-bottom columns', () => {
    expect(wrapVerticalText('abcdef', 30, 10)).toEqual(['abc', 'def']);
  });
});
