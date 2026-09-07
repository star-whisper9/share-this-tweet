import type { DownloadMediaResponse, ExtensionMessage } from '../shared/protocol.js';

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isExtensionMessage(message) || message.type !== 'download-media') return;
  return downloadMedia(message.url, message.filename);
});

function isExtensionMessage(message: unknown): message is ExtensionMessage {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false;
  const candidate = message as { type?: unknown; url?: unknown; filename?: unknown };
  return (
    candidate.type === 'download-media' &&
    typeof candidate.url === 'string' &&
    typeof candidate.filename === 'string'
  );
}

async function downloadMedia(url: string, filename: string): Promise<DownloadMediaResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: '媒体地址无效' };
  }

  if (
    parsed.protocol !== 'https:' ||
    !['pbs.twimg.com', 'video.twimg.com'].includes(parsed.hostname)
  ) {
    return { ok: false, error: '媒体地址不属于允许的 X 媒体域名' };
  }
  if (!filename || /[\\/\u0000]/.test(filename)) {
    return { ok: false, error: '文件名无效' };
  }

  try {
    const downloadId = await browser.downloads.download({
      url,
      filename,
      saveAs: false,
    });
    return { ok: true, downloadId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `下载失败：${message}` };
  }
}
