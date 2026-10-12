import { readMediaSourceInWorker } from '../core/media-source-client.js';
import type { MediaSourceMetadata } from '../shared/media-source.js';
import { getLocale, t } from '../shared/i18n.js';

export function mountSourceReader() {
  const sourceMediaInput = document.querySelector<HTMLInputElement>('[data-source-media-input]');
  const sourceMediaDrop = document.querySelector<HTMLElement>('[data-source-media-drop]');
  const sourceMediaStatus = document.querySelector<HTMLOutputElement>('[data-source-media-status]');
  const sourceMediaResult = document.querySelector<HTMLElement>('[data-source-media-result]');
  let sourceReadController: AbortController | undefined;
  let displayedSource: { source: MediaSourceMetadata; filename: string } | undefined;
  // The reader only inspects bounded metadata in its Worker, so it can accept
  // larger local files than the background network-download path buffers.
  const MAX_LOCAL_SOURCE_FILE_SIZE = 2 * 1024 * 1024 * 1024;
  function setSourceMediaStatus(message: string): void {
    if (sourceMediaStatus) sourceMediaStatus.textContent = message;
  }

  function verifiedSourceUrl(source: MediaSourceMetadata): string {
    const url = new URL(source.tweetUrl);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'x.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !new RegExp(`^/(?:[A-Za-z0-9_]{1,15}|i)/status/${source.tweetId}$`).test(url.pathname)
    )
      throw new Error(t('options.records.invalidUrl'));
    return url.href;
  }

  function renderSourceMedia(source: MediaSourceMetadata, filename: string): void {
    displayedSource = { source, filename };
    const update = (selector: string, value: string): void => {
      const element = sourceMediaResult?.querySelector<HTMLElement>(selector);
      if (element) element.textContent = value;
    };
    update('[data-source-file]', filename);
    update('[data-source-publisher]', `${source.publisher.name} · ${source.publisher.handle}`);
    update('[data-source-tweet-id]', source.tweetId);
    update(
      '[data-source-media-kind]',
      t(
        source.media.type === 'animated_gif'
          ? 'gif.reader.kind'
          : 'options.records.source.kindVideo',
        { index: source.media.index },
      ),
    );
    update(
      '[data-source-published-at]',
      source.publishedAt
        ? new Date(source.publishedAt).toLocaleString(getLocale())
        : t('options.records.unknown'),
    );
    update('[data-source-tool]', `${source.tool.name} ${source.tool.version}`);
    const link = sourceMediaResult?.querySelector<HTMLAnchorElement>('[data-source-link]');
    if (link) link.href = verifiedSourceUrl(source);
    if (sourceMediaResult) sourceMediaResult.hidden = false;
  }

  async function readSourceMedia(file: File): Promise<void> {
    displayedSource = undefined;
    sourceReadController?.abort(new Error(t('options.source.cancelled')));
    const controller = new AbortController();
    sourceReadController = controller;
    if (sourceMediaResult) sourceMediaResult.hidden = true;
    if (file.size > MAX_LOCAL_SOURCE_FILE_SIZE) {
      setSourceMediaStatus(t('options.records.source.failedLarge'));
      if (sourceReadController === controller) sourceReadController = undefined;
      return;
    }
    setSourceMediaStatus(t('options.records.source.reading', { filename: file.name }));
    try {
      const source = await readMediaSourceInWorker(file, { signal: controller.signal });
      if (sourceReadController !== controller) return;
      if (!source) {
        setSourceMediaStatus(t('gif.reader.none'));
        return;
      }
      renderSourceMedia(source, file.name);
      setSourceMediaStatus(t('options.records.source.done'));
    } catch (error) {
      if (sourceReadController !== controller) return;
      setSourceMediaStatus(
        t('options.records.source.failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      if (sourceReadController === controller) sourceReadController = undefined;
    }
  }

  sourceMediaInput?.addEventListener('change', () => {
    const file = sourceMediaInput.files?.[0];
    sourceMediaInput.value = '';
    if (file) void readSourceMedia(file);
  });
  sourceMediaDrop?.addEventListener('click', () => sourceMediaInput?.click());
  sourceMediaDrop?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    sourceMediaInput?.click();
  });
  for (const type of ['dragenter', 'dragover'] as const)
    sourceMediaDrop?.addEventListener(type, (event: DragEvent) => {
      event.preventDefault();
      if (sourceMediaDrop) sourceMediaDrop.dataset.dragging = 'true';
    });
  for (const type of ['dragleave', 'drop'] as const)
    sourceMediaDrop?.addEventListener(type, (event: DragEvent) => {
      event.preventDefault();
      if (sourceMediaDrop) delete sourceMediaDrop.dataset.dragging;
      if (type === 'drop') {
        const file = event.dataTransfer?.files[0];
        if (file) void readSourceMedia(file);
      }
    });

  return {
    relocalize(): void {
      if (displayedSource && !sourceMediaResult?.hidden)
        renderSourceMedia(displayedSource.source, displayedSource.filename);
    },
    dispose(): void {
      sourceReadController?.abort(new Error(t('options.source.cancelled')));
      sourceReadController = undefined;
    },
  };
}
