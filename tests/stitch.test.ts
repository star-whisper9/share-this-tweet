import { afterEach, expect, it, vi } from 'vitest';
import { calculateStitchLayout, renderStitchedMedia } from '../src/core/stitch.js';
import { calculateTweetCardLayout } from '../src/core/card.js';
import { ImageResources } from '../src/core/image-resources.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import type { TweetRecord } from '../src/shared/model.js';

const sizes = [
  { width: 200, height: 400 },
  { width: 400, height: 800 },
  { width: 600, height: 400 },
];
it('preserves complete aspect ratios at the smallest height, with optional proportional gaps', () => {
  const seamless = calculateStitchLayout(sizes, 'seamless');
  expect(seamless.height).toBe(400);
  expect(seamless.width).toBe(1000);
  expect(seamless.rects.map((rect) => rect.x)).toEqual([0, 200, 400]);
  const gallery = calculateStitchLayout(sizes, 'gallery');
  expect(gallery.rects.map((rect) => rect.x)).toEqual([0, 205, 410]);
  expect(gallery.width).toBe(1010);
  const huge = calculateStitchLayout(
    [
      { width: 50000, height: 50000 },
      { width: 50000, height: 50000 },
    ],
    'gallery',
  );
  expect(huge.width).toBeLessThanOrEqual(12000);
  expect(huge.height).toBeLessThanOrEqual(12000);
  expect(huge.width * huge.height).toBeLessThanOrEqual(24000000.01);
  expect(() => calculateStitchLayout([{ width: 0, height: 10 }], 'seamless')).toThrow();
});

it('keeps every card image on one row without cropping or seams', () => {
  const layout = calculateTweetCardLayout({
    images: sizes,
    text: '',
    measureText: () => ({ width: 0 }),
    mediaLayout: 'row',
  });
  for (const [index, rect] of layout.imageRects.entries()) {
    expect(rect.y).toBe(0);
    expect(rect.width / rect.height).toBeCloseTo(sizes[index]!.width / sizes[index]!.height);
    if (index)
      expect(rect.x).toBeCloseTo(
        layout.imageRects[index - 1]!.x + layout.imageRects[index - 1]!.width,
      );
  }
});

const draws = vi.fn();
class Canvas {
  width = 0;
  height = 0;
  getContext() {
    return {
      drawImage: draws,
      fillRect() {},
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
      measureText: () => ({ width: 20 }),
      scale() {},
      save() {},
      restore() {},
      fillText() {},
      strokeRect() {},
    };
  }
  toBlob(callback: BlobCallback, type: string) {
    callback(new Blob(['image'], { type }));
  }
}
const record: TweetRecord = {
  tweetId: '42',
  url: 'https://x.com/a/status/42',
  author: { id: '1', name: 'A', handle: 'a' },
  text: '',
  media: [
    { index: 1, type: 'photo', originalUrl: 'photo' },
    {
      index: 2,
      type: 'animated_gif',
      previewUrl: 'preview',
      variants: [{ mime: 'video/mp4', url: 'video' }],
    },
  ],
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  draws.mockClear();
});
it.each([false, true])(
  'renders all stills in order and cleans up, framed=%s',
  async (stitchFrame) => {
    vi.stubGlobal('HTMLCanvasElement', Canvas);
    vi.stubGlobal('document', { createElement: () => new Canvas() });
    vi.stubGlobal('browser', { runtime: { getURL: () => 'brand' } });
    const resources = new ImageResources();
    const images = ['photo', 'preview', 'brand'].map((id) => ({
      id,
      naturalWidth: 200,
      naturalHeight: 400,
      remove: vi.fn(),
      removeAttribute: vi.fn(),
    }));
    const load = vi.spyOn(resources, 'load').mockImplementation(async (url) => {
      const image = images.find((image) => image.id === url);
      if (!image) throw new Error('unexpected URL');
      return image as unknown as HTMLImageElement;
    });
    const result = await renderStitchedMedia(
      record,
      { ...DEFAULT_SETTINGS, stitchFrame },
      'dark',
      resources,
    );
    expect(result.type).toBe(stitchFrame ? 'image/jpeg' : 'image/png');
    expect(load.mock.calls.map(([url]) => url)).toEqual(
      stitchFrame ? ['photo', 'preview', 'brand'] : ['photo', 'preview'],
    );
    expect(draws.mock.calls.slice(0, 2).map(([image]) => image.id)).toEqual(['photo', 'preview']);
    for (const image of images.slice(0, 2)) expect(image.remove).toHaveBeenCalledOnce();
  },
);
it('fails instead of omitting a missing dynamic preview, releasing decoded photos', async () => {
  vi.stubGlobal('HTMLCanvasElement', Canvas);
  vi.stubGlobal('document', { createElement: () => new Canvas() });
  const resources = new ImageResources();
  const image = {
    naturalWidth: 200,
    naturalHeight: 400,
    remove: vi.fn(),
    removeAttribute: vi.fn(),
  };
  vi.spyOn(resources, 'load').mockResolvedValue(image as unknown as HTMLImageElement);
  await expect(
    renderStitchedMedia(
      { ...record, media: [record.media[0]!, { index: 2, type: 'video' }] },
      DEFAULT_SETTINGS,
      'light',
      resources,
    ),
  ).rejects.toThrow();
  expect(image.remove).toHaveBeenCalledOnce();
  expect(draws).not.toHaveBeenCalled();
});
