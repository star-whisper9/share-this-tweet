import { embedMp4Source, readMp4Source } from '../core/mp4-source.js';
import { embedGifSource, readGifSource } from '../core/gif-source.js';
import { parseMediaSourceMetadata } from '../shared/media-source.js';
import { isLocale, t, type Locale } from '../shared/i18n.js';

// A classic dedicated Worker bundle. Keeping this local type avoids mixing DOM and
// WebWorker ambient libraries for the rest of the extension's TypeScript build.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  void respond(event.data);
};

async function respond(value: unknown): Promise<void> {
  const request =
    typeof value === 'object' && value !== null
      ? (value as {
          id?: unknown;
          type?: unknown;
          blob?: unknown;
          source?: unknown;
          locale?: unknown;
          format?: unknown;
        })
      : {};
  const id = typeof request.id === 'string' ? request.id : '';
  const locale: Locale = isLocale(request.locale) ? request.locale : 'zh-CN';
  try {
    if (!id || id.length > 100 || !(request.blob instanceof Blob))
      throw new Error(t('core.worker.invalidRequest', {}, locale));
    let result: unknown;
    if (
      request.format !== undefined &&
      (typeof request.format !== 'string' || !['mp4', 'gif', 'auto'].includes(request.format))
    )
      throw new Error(t('core.worker.invalidRequest', {}, locale));
    if (request.type === 'embed') {
      if (request.format === 'auto') throw new Error(t('core.worker.invalidRequest', {}, locale));
      result = await (request.format === 'gif' ? embedGifSource : embedMp4Source)(
        request.blob,
        parseMediaSourceMetadata(request.source),
      );
    } else if (request.type === 'read') {
      let format = request.format;
      if (format === 'auto') {
        const bytes = new Uint8Array(await request.blob.slice(0, 12).arrayBuffer());
        const signature = String.fromCharCode(...bytes.subarray(0, 6));
        if (signature === 'GIF87a' || signature === 'GIF89a') format = 'gif';
        else if (bytes.length >= 8 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp')
          format = 'mp4';
        else throw new Error(t('core.worker.unsupportedMedia', {}, locale));
      }
      result = await (format === 'gif' ? readGifSource : readMp4Source)(request.blob);
    } else throw new Error(t('core.worker.invalidRequestType', {}, locale));
    scope.postMessage({ id, ok: true, result });
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
