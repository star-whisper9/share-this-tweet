import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTweetCard } from '../src/core/card.js';
import type { ImageResources } from '../src/core/image-resources.js';
import type { MediaRecord, TweetRecord } from '../src/shared/model.js';

const drawCalls: string[] = [];

class FakeCanvas {
  width = 0;
  height = 0;
  readonly context = new FakeContext();

  getContext(): CanvasRenderingContext2D {
    return this.context as unknown as CanvasRenderingContext2D;
  }

  toBlob(callback: BlobCallback): void {
    callback(new Blob(['png'], { type: 'image/png' }));
  }
}

class FakeContext {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  textAlign: CanvasTextAlign = 'left';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1;

  save(): void {}
  restore(): void {}
  beginPath(): void {}
  closePath(): void {}
  clip(): void {}
  arc(): void {}
  fill(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  stroke(): void {}
  moveTo(): void {}
  lineTo(): void {}
  scale(): void {}
  fillText(): void {}
  drawImage(image: { id?: string }): void {
    if (image.id) drawCalls.push(image.id);
  }
  measureText(text: string): TextMetrics {
    return { width: Math.max(1, [...text].length * 10) } as TextMetrics;
  }
}

class FakeImage {
  readonly remove = vi.fn();
  readonly removeAttribute = vi.fn();

  constructor(
    readonly id: string,
    readonly naturalWidth = 640,
    readonly naturalHeight = 360,
  ) {}
}

function record(media: MediaRecord[], quote?: TweetRecord): TweetRecord {
  return {
    tweetId: '1',
    url: 'https://x.com/author/status/1',
    text: 'card body',
    author: { id: 'author', handle: 'author', name: 'Author', avatarUrl: 'avatar-main' },
    media,
    ...(quote
      ? { quote: { status: 'available' as const, tweetId: quote.tweetId, record: quote } }
      : {}),
  };
}

function resources(images: Map<string, FakeImage>, failures = new Set<string>()): ImageResources {
  return {
    load: vi.fn(async (url: string) => {
      if (failures.has(url)) throw new Error(`failed: ${url}`);
      const image = images.get(url);
      if (!image) throw new Error(`unexpected image request: ${url}`);
      return image;
    }),
    checkActive: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ImageResources;
}

function installCanvas(): void {
  vi.stubGlobal('HTMLCanvasElement', FakeCanvas);
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      return new FakeCanvas();
    },
  });
  vi.stubGlobal('browser', {
    runtime: {
      getURL: (path: string) => `extension:${path}`,
    },
  });
}

afterEach(() => {
  drawCalls.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renderTweetCard media previews', () => {
  it('renders supplied still previews in media order, including a quoted post, without requesting video', async () => {
    installCanvas();
    const photo = new FakeImage('media:photo');
    const video = new FakeImage('media:video');
    const gif = new FakeImage('media:gif');
    const quoteVideo = new FakeImage('media:quote-video');
    const store = resources(
      new Map([
        ['photo', photo],
        ['video-preview', video],
        ['gif-preview', gif],
        ['quote-preview', quoteVideo],
        ['avatar-main', new FakeImage('avatar:main')],
        ['avatar-quote', new FakeImage('avatar:quote')],
        ['extension:/icons/icon-48.png', new FakeImage('brand')],
      ]),
    );
    const quoted = {
      ...record([{ index: 1, type: 'video' as const, previewUrl: 'quote-preview' }]),
      tweetId: '2',
      url: 'https://x.com/quote/status/2',
      author: { id: 'quote', handle: 'quote', name: 'Quote', avatarUrl: 'avatar-quote' },
    };
    const main = record(
      [
        { index: 1, type: 'photo', originalUrl: 'photo' },
        {
          index: 2,
          type: 'video',
          previewUrl: 'video-preview',
          variants: [{ url: 'video.mp4', mime: 'video/mp4' }],
        },
        {
          index: 3,
          type: 'animated_gif',
          previewUrl: 'gif-preview',
          variants: [{ url: 'gif.mp4', mime: 'video/mp4' }],
        },
      ],
      quoted,
    );

    await expect(
      renderTweetCard(main, main.media, { theme: 'light', resources: store }),
    ).resolves.toMatchObject({
      blob: expect.any(Blob),
    });

    expect(drawCalls.filter((id) => id.startsWith('media:'))).toEqual([
      'media:photo',
      'media:video',
      'media:gif',
      'media:quote-video',
    ]);
    expect(vi.mocked(store.load)).not.toHaveBeenCalledWith('video.mp4');
    expect(vi.mocked(store.load)).not.toHaveBeenCalledWith('gif.mp4');
    for (const image of [photo, video, gif, quoteVideo]) {
      expect(image.removeAttribute).toHaveBeenCalledWith('src');
      expect(image.remove).toHaveBeenCalledOnce();
    }
  });

  it('keeps a card slot when a dynamic preview fails but rejects when a photo fails', async () => {
    installCanvas();
    const baseImages = new Map([
      ['avatar-main', new FakeImage('avatar:main')],
      ['extension:/icons/icon-48.png', new FakeImage('brand')],
    ]);
    const textOnly = record([]);
    const unavailableVideo = record([
      { index: 1, type: 'video', previewUrl: 'video-preview', width: 1920, height: 1080 },
    ]);
    const videoResult = await renderTweetCard(unavailableVideo, unavailableVideo.media, {
      theme: 'light',
      resources: resources(baseImages, new Set(['video-preview'])),
    });
    const textResult = await renderTweetCard(textOnly, textOnly.media, {
      theme: 'light',
      resources: resources(baseImages),
    });
    expect(videoResult.height).toBeGreaterThan(textResult.height);

    const failedPhoto = record([{ index: 1, type: 'photo', originalUrl: 'photo' }]);
    await expect(
      renderTweetCard(failedPhoto, failedPhoto.media, {
        theme: 'light',
        resources: resources(baseImages, new Set(['photo'])),
      }),
    ).rejects.toThrow('failed: photo');
  });
});
