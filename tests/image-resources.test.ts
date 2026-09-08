import { afterEach, expect, it, vi } from 'vitest';
import { ImageResources } from '../src/core/image-resources.js';

afterEach(() => vi.unstubAllGlobals());

it('deduplicates requests, evicts compressed sources within the budget, and retries failures', async () => {
  const fetcher = vi.fn(async () => new Response(new Blob(['1234'])));
  vi.stubGlobal('fetch', fetcher);
  const resources = new ImageResources(4);
  await Promise.all([resources.fetch('a'), resources.fetch('a')]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await resources.fetch('a');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await resources.fetch('b');
  await resources.fetch('a');
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockRejectedValueOnce(new Error());
  await expect(resources.fetch('c')).rejects.toThrow(Error);
  await resources.fetch('c');
  expect(fetcher).toHaveBeenCalledTimes(5);
  resources.dispose();
  await expect(resources.fetch('c')).rejects.toThrow();
});

it('limits requests and aborts active and queued work on disposal', async () => {
  const fetcher = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
          once: true,
        });
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const resources = new ImageResources();
  const requests = ['a', 'b', 'c'].map((url) => resources.fetch(url));
  const settled = Promise.allSettled(requests);
  expect(fetcher).toHaveBeenCalledTimes(2);
  resources.dispose();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
