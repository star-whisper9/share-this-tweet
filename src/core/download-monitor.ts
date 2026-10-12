import { getLocale, t, type Locale } from '../shared/i18n.js';

export const DOWNLOAD_COMPLETION_TIMEOUT_MS = 30 * 60_000;
export class DownloadTimeoutError extends Error {
  constructor(locale: Locale) {
    super(t('core.background.downloadTimeout', {}, locale));
    this.name = 'DownloadTimeoutError';
  }
}
type DownloadState = 'complete' | 'interrupted';
const pendingDownloads = new Map<number, (state: DownloadState, error?: string) => void>();

browser.downloads?.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted')
    pendingDownloads.get(delta.id)?.(state, delta.error?.current);
});

/** Query after subscribing so completion before registration cannot leave a waiter hanging. */
export function waitForBrowserDownload(
  downloadId: number,
  { locale = getLocale(), signal }: { locale?: Locale; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (!pendingDownloads.has(downloadId)) return;
      pendingDownloads.delete(downloadId);
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void =>
      finish(new DOMException(t('jobs.cancelled', {}, locale), 'AbortError'));
    pendingDownloads.set(downloadId, (state, error) => {
      finish(
        state === 'complete'
          ? undefined
          : new Error(
              t(
                'core.background.downloadInterrupted',
                { error: error ? `：${error}` : '' },
                locale,
              ),
            ),
      );
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(
      () => finish(new DownloadTimeoutError(locale)),
      DOWNLOAD_COMPLETION_TIMEOUT_MS,
    );
    void Promise.resolve()
      .then(() => browser.downloads.search({ id: downloadId }))
      .then(([item]) => {
        if (!item) finish(new Error(t('core.background.noDownloadTask', {}, locale)));
        else if (item.state === 'complete' || item.state === 'interrupted')
          pendingDownloads.get(downloadId)?.(item.state, item.error);
      })
      .catch((error: unknown) =>
        finish(
          new Error(
            t(
              'core.background.downloadStateUnknown',
              { message: error instanceof Error ? error.message : String(error) },
              locale,
            ),
          ),
        ),
      );
  });
}
