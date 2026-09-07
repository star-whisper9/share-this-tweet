import { describe, expect, it, vi } from 'vitest';
import {
  canShareFile,
  canShareText,
  ShareCancelledError,
  ShareCapabilityError,
  ShareFailedError,
  shareImage,
  shareText,
} from '../src/core/share.js';

function makeFile(): File {
  return new File(['card'], 'tweet-card.png', { type: 'image/png' });
}

describe('native sharing adapter', () => {
  it('keeps text sharing separate from clipboard fallback', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await shareText('tweet text', { share });
    expect(share).toHaveBeenCalledWith({ text: 'tweet text' });
    expect(canShareText({ share })).toBe(true);
    expect(canShareText({})).toBe(false);
  });

  it('requires file capability before image sharing', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const file = makeFile();
    expect(canShareFile(file, { share, canShare: () => true })).toBe(true);
    await shareImage(file, { share, canShare: () => true });
    expect(share).toHaveBeenCalledWith({ files: [file] });
    await expect(shareImage(file, { share, canShare: () => false })).rejects.toBeInstanceOf(
      ShareCapabilityError,
    );
  });

  it('classifies cancellation without creating a fallback action', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    await expect(shareText('tweet text', { share })).rejects.toBeInstanceOf(ShareCancelledError);
    await expect(shareImage(makeFile(), { share, canShare: () => true })).rejects.toBeInstanceOf(
      ShareCancelledError,
    );
  });

  it('keeps the generated image file when image sharing fails', async () => {
    const file = makeFile();
    const share = vi.fn().mockRejectedValue(new Error('share panel failed'));
    const error = await shareImage(file, { share, canShare: () => true }).catch((reason) => reason);
    expect(error).toBeInstanceOf(ShareFailedError);
    expect(error.file).toBe(file);
  });

  it('does not hide unsupported text sharing behind another action', async () => {
    await expect(shareText('tweet text', {})).rejects.toBeInstanceOf(ShareCapabilityError);
  });
});
