/** Compressed sources only: decoded full-size images are owned by each renderer. */
export class ImageResources {
  private readonly controller = new AbortController();
  private readonly blobs = new Map<string, Blob>();
  private readonly pending = new Map<string, Promise<Blob>>();
  private bytes = 0;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly budget = 32 * 1024 * 1024) {}

  dispose(): void {
    this.controller.abort();
    this.blobs.clear();
    this.bytes = 0;
  }

  checkActive(): void {
    this.controller.signal.throwIfAborted();
  }

  async fetch(url: string): Promise<Blob> {
    this.checkActive();
    const cached = this.blobs.get(url);
    if (cached) {
      this.blobs.delete(url);
      this.blobs.set(url, cached);
      return cached;
    }
    const existing = this.pending.get(url);
    if (existing) return existing;
    const request = this.request(url);
    this.pending.set(url, request);
    try {
      return await request;
    } finally {
      this.pending.delete(url);
    }
  }

  private async request(url: string): Promise<Blob> {
    // Reserve slots when handing them to waiters, so newly arriving work cannot jump the queue.
    if (this.running >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      this.checkActive();
      const response = await fetch(url, { credentials: 'omit', signal: this.controller.signal });
      if (!response.ok) throw new Error(`图片请求失败：HTTP ${response.status}`);
      const blob = await response.blob();
      this.checkActive();
      if (!blob.size) throw new Error('图片响应为空');
      if (blob.size <= this.budget) {
        while (this.bytes + blob.size > this.budget || this.blobs.size >= 16) {
          const oldest = this.blobs.keys().next().value!;
          this.bytes -= this.blobs.get(oldest)!.size;
          this.blobs.delete(oldest);
        }
        this.blobs.set(url, blob);
        this.bytes += blob.size;
      }
      return blob;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  async load(url: string): Promise<HTMLImageElement> {
    const blob = await this.fetch(url);
    this.checkActive();
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const signal = this.controller.signal;
        const abort = () => finish(signal.reason);
        const finish = (error?: unknown) => {
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        };
        image.onload = () => finish();
        image.onerror = () => finish(new Error('图片无法解码'));
        signal.addEventListener('abort', abort, { once: true });
        image.src = objectUrl;
      });
      this.checkActive();
      return image;
    } catch (error) {
      const cached = this.blobs.get(url);
      if (cached) {
        this.bytes -= cached.size;
        this.blobs.delete(url);
      }
      releaseImage(image);
      throw error;
    } finally {
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(objectUrl);
    }
  }
}

export function releaseImage(image: HTMLImageElement): void {
  image.removeAttribute('src');
  image.remove();
}

export async function loadAvatar(
  url: string | undefined,
  resources: ImageResources,
): Promise<HTMLImageElement | undefined> {
  const urls = [
    url,
    browser.runtime.getURL('/icons/x.png'),
    browser.runtime.getURL('/icons/x.svg'),
  ];
  for (const source of urls) {
    if (!source) continue;
    try {
      return await resources.load(source);
    } catch {
      resources.checkActive();
      // Avatars have an explicit built-in logo fallback; photo failures remain fatal.
    }
  }
  return undefined;
}
