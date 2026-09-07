import type { MediaRecord } from '../shared/model.js';
import type { DownloadMediaResponse } from '../shared/protocol.js';
import { getMediaDownloadTarget } from './media.js';

export function isAndroidUserAgent(userAgent: string): boolean {
  return /\bAndroid\b/i.test(userAgent);
}

function isDownloadResponse(value: unknown): value is DownloadMediaResponse {
  return typeof value === 'object'
    && value !== null
    && 'ok' in value
    && typeof (value as { ok?: unknown }).ok === 'boolean';
}

async function downloadOnAndroid(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`媒体请求失败：HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('媒体响应为空');

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noreferrer';
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    window.setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }, 1000);
  }
}

export async function downloadMedia(media: MediaRecord, filename: string): Promise<void> {
  const { url } = getMediaDownloadTarget(media);
  if (isAndroidUserAgent(navigator.userAgent)) {
    await downloadOnAndroid(url, filename);
    return;
  }

  const response = await browser.runtime.sendMessage({
    type: 'download-media',
    url,
    filename
  });
  if (!isDownloadResponse(response)) throw new Error('下载服务返回了无效结果');
  if (!response.ok) throw new Error(response.error);
}
