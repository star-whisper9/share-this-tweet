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

export type LoadedAvatar = HTMLImageElement | HTMLCanvasElement;

export function releaseImage(image: LoadedAvatar): void {
  if (image instanceof HTMLCanvasElement) {
    image.width = 0;
    image.height = 0;
  }
  image.removeAttribute('src');
  image.remove();
}

/** Paint monochrome assets through their alpha mask, preserving transparent pixels. */
export async function loadMonochromeIcon(
  name: 'x.svg' | 'grok.svg',
  resources: ImageResources,
  color: string,
): Promise<HTMLCanvasElement> {
  const image = await resources.load(browser.runtime.getURL(`/icons/${name}`));
  const canvas = document.createElement('canvas');
  try {
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法绘制徽标');
    const ratio = Math.min(64 / image.naturalWidth, 64 / image.naturalHeight);
    const width = image.naturalWidth * ratio;
    const height = image.naturalHeight * ratio;
    context.drawImage(image, (64 - width) / 2, (64 - height) / 2, width, height);
    context.globalCompositeOperation = 'source-in';
    context.fillStyle = color;
    context.fillRect(0, 0, 64, 64);
    return canvas;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  } finally {
    releaseImage(image);
  }
}

export async function loadAvatar(
  url: string | undefined,
  resources: ImageResources,
  color = '#17202a',
): Promise<LoadedAvatar | undefined> {
  if (url) {
    try {
      return await resources.load(url);
    } catch {
      resources.checkActive();
    }
  }
  try {
    return await loadMonochromeIcon('x.svg', resources, color);
  } catch {
    resources.checkActive();
    return undefined;
  }
}
