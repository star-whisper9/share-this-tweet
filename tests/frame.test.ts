import { frameOutputSize, renderFrameStrip } from '../src/core/frame.js';
import { describe, expect, it } from 'vitest';
import {
  calculateFrameLayout,
  wrapFrameText,
  hasTransparentPixels,
  encodeFrame,
} from '../src/core/frame.js';
import { ImageResources } from '../src/core/image-resources.js';
import type { TweetRecord } from '../src/shared/model.js';

const measureText = (text: string): { width: number } => ({ width: [...text].length * 10 });

describe('calculateFrameLayout', () => {
  it('uses two columns when the image is wide enough', () => {
    const layout = calculateFrameLayout({
      width: 1200,
      userText: 'Alice',
      sourceLines: ['tweet id: 42', '@alice'],
      measureText,
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
      measureText,
    });

    expect(layout.mode).toBe('single');
    expect(layout.rightLines).toEqual([]);
    expect(layout.leftLines.length).toBeGreaterThanOrEqual(3);
  });

  it('supports the top frame orientation', () => {
    const layout = calculateFrameLayout({
      width: 800,
      orientation: 'top',
      userText: 'Alice',
      sourceLines: ['tweet id: 42', '@alice'],
      measureText,
    });

    expect(layout.orientation).toBe('top');
    expect(layout.barHeight).toBe(layout.paddingY * 2 + layout.lineHeight * 2);
  });
});

describe('wrapFrameText', () => {
  it('preserves explicit line breaks', () => {
    expect(wrapFrameText('first\nsecond', 100, measureText)).toEqual(['first', 'second']);
  });
});

describe('frame encoding', () => {
  it('detects partial transparency and excludes pixels outside the source region', () => {
    const read = {
      getImageData: (_x: number, y: number) => ({
        data: new Uint8ClampedArray([10, 20, 30, y === 70 ? 254 : 255]),
      }),
    };
    expect(hasTransparentPixels(read as unknown as CanvasRenderingContext2D, 1, 1, 70)).toBe(true);
    expect(hasTransparentPixels(read as unknown as CanvasRenderingContext2D, 1, 1, 0)).toBe(false);
  });

  it('requires the requested format instead of accepting a silent PNG fallback', async () => {
    const canvas = {
      toBlob: (callback: BlobCallback, type: string) => callback(new Blob(['encoded'], { type })),
    };
    expect((await encodeFrame(canvas as unknown as HTMLCanvasElement, false)).type).toBe(
      'image/jpeg',
    );
    expect((await encodeFrame(canvas as unknown as HTMLCanvasElement, true)).type).toBe(
      'image/webp',
    );
    const unsupported = {
      toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
    };
    await expect(encodeFrame(unsupported as unknown as HTMLCanvasElement, true)).rejects.toThrow(
      Error,
    );
  });
});

it('raises small-frame raster resolution proportionally while preserving large images', () => {
  const small = frameOutputSize(320, 378);
  expect(small.width).toBeGreaterThan(320);
  expect(small.height / small.width).toBeCloseTo(378 / 320);
  expect(small.scale).toBe(small.width / 320);
  expect(frameOutputSize(1200, 900)).toEqual({ width: 1200, height: 900, scale: 1 });
  expect(() => frameOutputSize(1, 10000)).toThrow(Error);
});

it('renders an even-height PNG source strip at the requested video width', async () => {
  class Canvas {
    width = 0;
    height = 0;
    getContext() {
      return {
        drawImage() {},
        fillRect() {},
        fillText() {},
        measureText: (text: string) => ({ width: [...text].length * 8 }),
        save() {},
        restore() {},
        strokeRect() {},
      };
    }
    toBlob(callback: BlobCallback, type: string) {
      callback(new Blob(['strip'], { type }));
    }
  }
  const canvas = new Canvas();
  const brand = { remove: () => {}, removeAttribute: () => {} };
  const originalDocument = globalThis.document;
  const originalBrowser = globalThis.browser;
  const originalCanvas = globalThis.HTMLCanvasElement;
  Object.assign(globalThis, {
    HTMLCanvasElement: Canvas,
    browser: { runtime: { getURL: () => 'brand' } },
    document: { createElement: () => canvas },
  });
  const resources = new ImageResources();
  const load = resources.load.bind(resources);
  resources.load = async () => brand as unknown as HTMLImageElement;
  const record: TweetRecord = {
    tweetId: '42',
    url: 'https://x.com/a/status/42',
    text: '',
    author: { id: 'a', name: 'Alice', handle: 'alice' },
    media: [{ index: 0, type: 'video' }],
  };
  try {
    const result = await renderFrameStrip(
      record,
      record.media[0]!,
      318,
      '{author.name}',
      resources,
      'dark',
      'en',
    );
    expect(result.blob.type).toBe('image/png');
    expect(result.width).toBe(318);
    expect(result.height % 2).toBe(0);
  } finally {
    resources.load = load;
    Object.assign(globalThis, {
      HTMLCanvasElement: originalCanvas,
      browser: originalBrowser,
      document: originalDocument,
    });
  }
});
