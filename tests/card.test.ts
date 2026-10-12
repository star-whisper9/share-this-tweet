import { describe, expect, it } from 'vitest';
import { calculateTweetCardLayout, resolveCardTheme, wrapCardText } from '../src/core/card.js';
import type { AvailableTweetPoll } from '../src/shared/poll.js';

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
  it('trims outer whitespace while preserving empty lines and Unicode characters', () => {
    expect(wrapCardText(' \r\n😀A\n\nB \r\n ', 20, measureText)).toEqual(['😀A', '', 'B']);
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

describe('text-only card layout', () => {
  it('uses a finite default width and adds only text height, without an image area', () => {
    const short = calculateTweetCardLayout({ images: [], text: 'hello', measureText });
    const long = calculateTweetCardLayout({
      images: [],
      text: 'hello\n中文 😀\nworld',
      measureText,
    });
    expect(short.width).toBeGreaterThan(0);
    expect(short.imageRects).toEqual([]);
    expect(short.imageAreaHeight).toBe(0);
    expect(long.height - short.height).toBe(short.textLineHeight * 2);
    expect(Number.isFinite(short.height)).toBe(true);
    expect(short.height).toBeGreaterThan(0);
  });

  it('handles empty captions and rejects invalid photo dimensions', () => {
    expect(calculateTweetCardLayout({ images: [], text: '', measureText }).height).toBeGreaterThan(
      0,
    );
    expect(() =>
      calculateTweetCardLayout({ images: [{ width: NaN, height: 1 }], text: '', measureText }),
    ).toThrow(Error);
  });
});

describe('poll card layout', () => {
  const poll: AvailableTweetPoll = {
    status: 'available',
    options: [
      { index: 1, label: 'A long choice '.repeat(8), votes: 3 },
      { index: 2, label: 'Second choice', votes: 1 },
    ],
    selectedChoice: 1,
    endsAt: '2026-01-01T12:00:00.000Z',
  };

  it.each(['grid', 'row'] as const)(
    'wraps narrow options and reserves their height before %s media',
    (mediaLayout) => {
      const layout = calculateTweetCardLayout({
        images: [
          { width: 800, height: 600 },
          { width: 600, height: 800 },
        ],
        cardWidth: 320,
        text: 'Caption',
        poll,
        mediaLayout,
        measureText,
      });
      const block = layout.pollBlocks[0]!;
      expect(block.options[0]!.lines.length).toBeGreaterThan(1);
      for (const option of block.options) {
        expect(option.lines.every((line) => measureText(line).width <= option.labelWidth)).toBe(
          true,
        );
        expect(option.height).toBeGreaterThan(option.lines.length * layout.textLineHeight);
      }
      expect(block.options.map((option) => option.percentage)).toEqual([75, 25]);
      expect(block.options.map((option) => option.selected)).toEqual([true, false]);
      expect(block.options[1]!.y).toBeGreaterThanOrEqual(
        block.options[0]!.y + block.options[0]!.height,
      );
      expect(layout.imageY).toBeGreaterThan(block.y + block.height);
    },
  );

  it('does not expose result bars before voting or when one count is missing', () => {
    for (const hidden of [
      { ...poll, selectedChoice: undefined },
      { ...poll, options: [poll.options[0]!, { index: 2, label: 'Second choice' }] },
    ]) {
      const layout = calculateTweetCardLayout({ images: [], text: '', poll: hidden, measureText });
      expect(layout.pollBlocks[0]!.options.every((option) => option.percentage === undefined)).toBe(
        true,
      );
    }
    const final = calculateTweetCardLayout({
      images: [],
      text: '',
      poll: { ...poll, selectedChoice: undefined, countsAreFinal: true },
      measureText,
    });
    expect(final.pollBlocks[0]!.options.map((option) => option.percentage)).toEqual([75, 25]);
  });

  it('places translated options after the translation and original options after the original', () => {
    const labels = ['Translated choice one', 'Translated choice two'];
    const layout = calculateTweetCardLayout({
      images: [],
      text: 'Original caption',
      translation: { text: 'Translated caption', sourceLanguage: 'English' },
      poll: {
        ...poll,
        translation: {
          status: 'available',
          labels,
          originalLabels: poll.options.map((option) => option.label),
        },
      },
      measureText,
    });
    expect(layout.pollBlocks.map((block) => block.translated)).toEqual([true, false]);
    const translatedBody = layout.bodyLines.find((line) => line.text === 'Translated caption')!;
    const originalBody = layout.bodyLines.find((line) => line.text === 'Original caption')!;
    expect(layout.pollBlocks[0]!.y).toBeGreaterThan(translatedBody.y);
    expect(originalBody.y).toBeGreaterThan(layout.pollBlocks[0]!.y + layout.pollBlocks[0]!.height);
    expect(layout.pollBlocks[1]!.y).toBeGreaterThan(originalBody.y);
    expect(layout.pollBlocks[0]!.options.map((option) => option.lines.join(''))).toEqual(labels);
    expect(
      layout.pollBlocks.map((block) => block.options.map((option) => option.percentage)),
    ).toEqual([
      [75, 25],
      [75, 25],
    ]);
    expect(
      layout.pollBlocks.map((block) => block.options.map((option) => option.selected)),
    ).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it('includes original options once when translated labels are unavailable', () => {
    const layout = calculateTweetCardLayout({
      images: [],
      text: 'Original caption',
      translation: { text: 'Translated caption', sourceLanguage: 'English' },
      poll: { ...poll, translation: { status: 'invalid', reason: 'stale' } },
      measureText,
    });
    expect(layout.pollBlocks).toHaveLength(1);
    expect(layout.pollBlocks[0]!.translated).toBe(false);
    expect(layout.pollBlocks[0]!.y).toBeGreaterThan(
      layout.bodyLines.find((line) => line.text === 'Original caption')!.y,
    );
  });

  it('rejects a recognized malformed poll', () => {
    expect(() =>
      calculateTweetCardLayout({
        images: [],
        text: '',
        poll: { status: 'invalid' },
        measureText,
      }),
    ).toThrow(Error);
  });
});
