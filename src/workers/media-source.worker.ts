import { embedMp4Source, readMp4Source } from '../core/mp4-source.js';
import { parseMediaSourceMetadata } from '../shared/media-source.js';

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
      ? (value as { id?: unknown; type?: unknown; blob?: unknown; source?: unknown })
      : {};
  const id = typeof request.id === 'string' ? request.id : '';
  try {
    if (!id || id.length > 100 || !(request.blob instanceof Blob))
      throw new Error('媒体处理请求无效');
    let result: unknown;
    if (request.type === 'embed') {
      result = await embedMp4Source(request.blob, parseMediaSourceMetadata(request.source));
    } else if (request.type === 'read') {
      result = await readMp4Source(request.blob);
    } else throw new Error('媒体处理请求类型无效');
    scope.postMessage({ id, ok: true, result });
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
