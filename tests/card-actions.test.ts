import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ShareEnhancerController } from '../src/content/ui.js';
import { TweetSource } from '../src/content/tweet-source.js';
import { renderTweetCard } from '../src/core/card.js';
import { downloadBlob } from '../src/core/download.js';
import { recordOutput, saveTweetRecord } from '../src/core/storage-client.js';
import { shareImage } from '../src/core/share.js';
import type { TweetRecord } from '../src/shared/model.js';

vi.mock('../src/core/card.js', () => ({ renderTweetCard: vi.fn() }));
vi.mock('../src/core/download.js', async (original) => ({
  ...(await original<typeof import('../src/core/download.js')>()),
  downloadBlob: vi.fn(),
}));
vi.mock('../src/core/storage-client.js', () => ({
  recordOutput: vi.fn(),
  saveTweetRecord: vi.fn(),
}));
vi.mock('../src/core/share.js', async (original) => ({
  ...(await original<typeof import('../src/core/share.js')>()),
  shareImage: vi.fn(),
}));

const record: TweetRecord = {
  tweetId: '42',
  url: 'https://x.com/alice/status/42',
  text: '文字 😀\nsecond line',
  author: { id: '7', name: 'Alice', handle: 'alice' },
  media: [],
};
// Exercise the controller's output orchestration without mocking the filename
// builder or requiring a synthetic X DOM.
type Harness = {
  currentRecord: TweetRecord;
  currentTweetId: string;
  recordRequestId: number;
  renderActions: () => void;
  setSheetStatus: () => void;
  saveGeneratedCard: () => Promise<void>;
  shareTweetImage: () => Promise<void>;
};
function controller(): Harness {
  const c = new ShareEnhancerController(new TweetSource()) as unknown as Harness;
  c.currentRecord = record;
  c.currentTweetId = record.tweetId;
  c.renderActions = vi.fn();
  c.setSheetStatus = vi.fn();
  return c;
}
beforeEach(() => {
  vi.mocked(renderTweetCard).mockResolvedValue({
    blob: new Blob(['png'], { type: 'image/png' }),
    width: 1600,
    height: 500,
  });
});
afterEach(() => vi.resetAllMocks());

describe('text-only card outputs', () => {
  it('saves a PNG and source record without a media index, and permits repeat saves', async () => {
    const c = controller();
    await c.saveGeneratedCard();
    await c.saveGeneratedCard();
    expect(renderTweetCard).toHaveBeenCalledWith(record, []);
    expect(renderTweetCard).toHaveBeenCalledOnce();
    expect(downloadBlob).toHaveBeenCalledTimes(2);
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(File), 'X_alice_t42_m0_card.png');
    expect(saveTweetRecord).toHaveBeenCalledWith(record);
    expect(recordOutput).toHaveBeenCalledWith({
      tweetId: '42',
      outputType: 'tweet-card',
      filename: 'X_alice_t42_m0_card.png',
    });
  });
  it('shares a generated text-only PNG through the existing image share adapter', async () => {
    await controller().shareTweetImage();
    expect(shareImage).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'X_alice_t42_m0_card.png', type: 'image/png' }),
    );
    expect(recordOutput).toHaveBeenCalledWith({
      tweetId: '42',
      outputType: 'shared-image',
      filename: 'X_alice_t42_m0_card.png',
    });
    expect(downloadBlob).not.toHaveBeenCalled();
  });
  it.each(['saveGeneratedCard', 'shareTweetImage'] as const)(
    'does not output a stale result from %s after navigating away',
    async (action) => {
      const c = controller();
      vi.mocked(renderTweetCard).mockImplementation(async () => {
        c.recordRequestId += 1;
        c.currentTweetId = '99';
        return { blob: new Blob(['png']), width: 1600, height: 500 };
      });
      await c[action]();
      expect(shareImage).not.toHaveBeenCalled();
      expect(downloadBlob).not.toHaveBeenCalled();
      expect(recordOutput).not.toHaveBeenCalled();
    },
  );
});
