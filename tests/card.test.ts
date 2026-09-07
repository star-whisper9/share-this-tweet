import { describe, expect, it } from 'vitest';
import { calculateTweetCardLayout, resolveCardTheme, wrapCardText } from '../src/core/card.js';

const measureText = (text: string): { width: number } => ({ width: [...text].length * 10 });

describe('tweet card layout', () => {
  it('wraps text and produces a dynamic height', () => {
    const layout = calculateTweetCardLayout({
      images: [{ width: 1200, height: 800 }],
      cardWidth: 420,
      text: '这是一段需要在推文卡片中自动折行的正文，需要继续写一些内容才能覆盖多个文本行。',
      measureText,
    });

    expect(layout.textLines.length).toBeGreaterThan(1);
    expect(layout.height).toBeGreaterThan(layout.imageY + layout.imageAreaHeight);
    expect(layout.imageRects[0]?.width).toBeLessThanOrEqual(layout.contentWidth);
  });

  it('keeps a narrow image centered inside the card', () => {
    const layout = calculateTweetCardLayout({
      images: [{ width: 320, height: 640 }],
      text: '',
      measureText,
    });

    expect(layout.width).toBe(320);
    expect(layout.imageRects[0]?.x).toBeGreaterThan(0);
    expect(layout.imageRects[0]?.width).toBeLessThan(320);
    expect((layout.imageRects[0]?.width ?? 0) / (layout.imageRects[0]?.height ?? 1)).toBeCloseTo(
      320 / 640,
      2,
    );
  });

  it('creates a two-column grid for multiple photos', () => {
    const layout = calculateTweetCardLayout({
      images: [
        { width: 800, height: 600 },
        { width: 600, height: 800 },
        { width: 1200, height: 800 },
      ],
      text: '',
      measureText,
    });

    expect(layout.imageRects).toHaveLength(3);
    expect(layout.imageRects[0]?.y).toBe(layout.imageRects[1]?.y);
    expect(layout.imageRects[2]?.y).toBeGreaterThan(layout.imageRects[0]?.y ?? 0);
    expect(layout.height).toBeGreaterThan(layout.imageY + layout.imageAreaHeight);
  });
});

describe('wrapCardText', () => {
  it('preserves explicit line breaks', () => {
    expect(wrapCardText('first\nsecond', 100, measureText)).toEqual(['first', 'second']);
  });
});

describe('card theme selection', () => {
  it('prefers an explicit X theme over the system theme', () => {
    expect(resolveCardTheme('dark', false)).toBe('dark');
    expect(resolveCardTheme('light', true)).toBe('light');
    expect(resolveCardTheme(undefined, true)).toBe('dark');
    expect(resolveCardTheme(undefined, false)).toBe('light');
  });
});
