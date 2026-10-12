import {
  clearStoredRecords,
  deleteStoredTweetRecord,
  exportStorageRecords,
  importStorageRecords,
  listStorageRecords,
} from '../core/storage-client.js';
import type { OutputRecord, StorageArchive, StoredTweetRecord } from '../shared/storage-model.js';
import { recordPreviewText } from './record-preview.js';
import { getLocale, t } from '../shared/i18n.js';

export function mountRecordBrowser() {
  const recordSearch = document.querySelector<HTMLInputElement>('[data-record-search]');
  const recordList = document.querySelector<HTMLElement>('[data-record-list]');
  const recordSummary = document.querySelector<HTMLElement>('[data-record-summary]');
  const recordEmpty = document.querySelector<HTMLElement>('[data-record-empty]');
  const recordStatus = document.querySelector<HTMLOutputElement>('[data-record-status]');
  const recordDetail = document.querySelector<HTMLElement>('[data-record-detail]');
  const recordDetailEmpty = document.querySelector<HTMLElement>('[data-record-detail-empty]');
  const recordImport = document.querySelector<HTMLInputElement>('[data-record-import]');
  let storedTweetRecords: StoredTweetRecord[] = [];
  let storedOutputRecords: OutputRecord[] = [];
  let selectedRecordId = '';
  let recordsLoading = false;
  let recordsLoaded = false;
  function setRecordStatus(message: string): void {
    if (recordStatus) recordStatus.textContent = message;
  }

  function formatRecordDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocale());
  }

  function getRecordOutputs(tweetId: string): OutputRecord[] {
    return storedOutputRecords.filter((output) => output.tweetId === tweetId);
  }

  function recordMatches(record: StoredTweetRecord, query: string): boolean {
    if (!query) return true;
    const outputs = getRecordOutputs(record.tweetId);
    const haystack = [
      record.tweetId,
      record.url,
      record.text,
      record.author.handle,
      record.author.name,
      ...outputs.map((output) => output.filename ?? ''),
    ]
      .join('\n')
      .toLocaleLowerCase();
    return haystack.includes(query.toLocaleLowerCase());
  }

  function renderRecordDetail(): void {
    const record = storedTweetRecords.find((item) => item.tweetId === selectedRecordId);
    if (!record) {
      if (recordDetail) recordDetail.hidden = true;
      if (recordDetailEmpty) recordDetailEmpty.hidden = false;
      return;
    }
    if (recordDetail) recordDetail.hidden = false;
    if (recordDetailEmpty) recordDetailEmpty.hidden = true;
    const update = (selector: string, value: string): void => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) element.textContent = value;
    };
    update(
      '[data-record-author]',
      record.author.name || record.author.handle || t('options.records.unknownAuthor'),
    );
    update(
      '[data-record-handle]',
      record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : '',
    );
    update('[data-record-tweet-id]', record.tweetId);
    update('[data-record-saved-at]', formatRecordDate(record.savedAt));
    const link = document.querySelector<HTMLAnchorElement>('[data-record-link]');
    if (link) link.href = record.url;
    update('[data-record-text]', recordPreviewText(record));
    const outputs = getRecordOutputs(record.tweetId);
    const outputLabels: Record<string, string> = {
      'original-media': t('options.records.output.originalMedia'),
      'sourced-media': t('options.records.output.sourcedMedia'),
      'framed-image': t('options.records.output.framedImage'),
      'tweet-card': t('options.records.output.tweetCard'),
      'row-tweet-card': t('options.records.output.rowTweetCard'),
      'stitched-video': t('dynamic.stitchedVideo'),
      'framed-video': t('dynamic.framedVideo'),
      'stitched-image': t('options.records.output.stitchedImage'),
      'shared-text': t('options.records.output.sharedText'),
      'shared-image': t('options.records.output.sharedImage'),
      'copied-text': t('options.records.output.copiedText'),
    };
    update(
      '[data-record-output-summary]',
      outputs.length === 0
        ? t('options.records.noOutputs')
        : t('options.records.outputSummary', {
            count: outputs.length,
            outputs: outputs
              .map((output) => outputLabels[output.outputType] ?? output.outputType)
              .join(getLocale() === 'en' ? ', ' : '、'),
          }),
    );
    const outputList = document.querySelector<HTMLElement>('[data-record-output-list]');
    outputList?.replaceChildren();
    for (const output of outputs) {
      const item = document.createElement('div');
      item.className = 'record-output-item';
      const label = document.createElement('strong');
      label.textContent = outputLabels[output.outputType] ?? output.outputType;
      const detail = document.createElement('span');
      detail.textContent = [output.filename, formatRecordDate(output.createdAt)]
        .filter(Boolean)
        .join(' · ');
      item.append(label, detail);
      outputList?.append(item);
    }
  }

  function renderRecords(): void {
    const query = recordSearch?.value.trim() ?? '';
    const filtered = storedTweetRecords.filter((record) => recordMatches(record, query));
    if (recordSummary) {
      recordSummary.textContent = recordsLoading
        ? t('options.records.loading')
        : t('options.records.summary', {
            total: storedTweetRecords.length,
            shown: filtered.length,
          });
    }
    if (recordList) recordList.replaceChildren();
    if (filtered.length === 0) {
      if (recordEmpty) recordEmpty.hidden = false;
    } else {
      if (recordEmpty) recordEmpty.hidden = true;
      if (!filtered.some((record) => record.tweetId === selectedRecordId)) {
        selectedRecordId = filtered[0]!.tweetId;
      }
      for (const record of filtered) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'record-item';
        button.setAttribute('role', 'listitem');
        button.setAttribute('aria-pressed', String(record.tweetId === selectedRecordId));
        const title = document.createElement('strong');
        title.textContent = `${record.author.name || t('options.records.unknownAuthor')} · ${record.author.handle ? `@${record.author.handle.replace(/^@+/, '')}` : t('options.records.unknownHandle')}`;
        const meta = document.createElement('span');
        meta.textContent = `${record.tweetId} · ${formatRecordDate(record.savedAt)} · ${t('options.records.outputs', { count: getRecordOutputs(record.tweetId).length })}`;
        button.append(title, meta);
        button.addEventListener('click', () => {
          selectedRecordId = record.tweetId;
          renderRecords();
        });
        recordList?.append(button);
      }
    }
    renderRecordDetail();
  }

  async function loadRecords(): Promise<void> {
    if (recordsLoading) return;
    recordsLoading = true;
    renderRecords();
    try {
      const records = await listStorageRecords();
      storedTweetRecords = records.tweetRecords;
      storedOutputRecords = records.outputRecords;
      recordsLoaded = true;
      setRecordStatus('');
    } catch (error) {
      storedTweetRecords = [];
      storedOutputRecords = [];
      setRecordStatus(
        t('options.records.source.failed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      recordsLoading = false;
      renderRecords();
    }
  }

  function downloadJsonArchive(archive: StorageArchive): void {
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `share-this-tweet-records-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportRecords(): Promise<void> {
    try {
      downloadJsonArchive(await exportStorageRecords());
      setRecordStatus(t('options.records.exported'));
    } catch (error) {
      setRecordStatus(
        t('options.records.exportFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function importRecords(file: File): Promise<void> {
    try {
      const archive = JSON.parse(await file.text()) as StorageArchive;
      await importStorageRecords(archive);
      selectedRecordId = '';
      setRecordStatus(t('options.records.imported'));
      await loadRecords();
    } catch (error) {
      setRecordStatus(
        t('options.records.importFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function deleteSelectedRecord(): Promise<void> {
    if (!selectedRecordId || !window.confirm(t('options.records.deleteConfirm'))) return;
    try {
      await deleteStoredTweetRecord(selectedRecordId);
      selectedRecordId = '';
      setRecordStatus(t('options.records.deleted'));
      await loadRecords();
    } catch (error) {
      setRecordStatus(
        t('options.records.deleteFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function clearRecords(): Promise<void> {
    if (!window.confirm(t('options.records.clearConfirm'))) return;
    try {
      await clearStoredRecords();
      selectedRecordId = '';
      setRecordStatus(t('options.records.cleared'));
      await loadRecords();
    } catch (error) {
      setRecordStatus(
        t('options.records.clearFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  recordSearch?.addEventListener('input', () => renderRecords());
  document.querySelector('[data-record-refresh]')?.addEventListener('click', () => {
    void loadRecords();
  });
  document.querySelector('[data-record-export]')?.addEventListener('click', () => {
    void exportRecords();
  });
  document.querySelector('[data-record-import-button]')?.addEventListener('click', () => {
    recordImport?.click();
  });
  recordImport?.addEventListener('change', () => {
    const file = recordImport.files?.[0];
    recordImport.value = '';
    if (file) void importRecords(file);
  });
  document.querySelector('[data-record-delete]')?.addEventListener('click', () => {
    void deleteSelectedRecord();
  });
  document.querySelector('[data-record-clear]')?.addEventListener('click', () => {
    void clearRecords();
  });

  return {
    render: renderRecords,
    ensureLoaded(): void {
      if (!recordsLoaded) void loadRecords();
    },
  };
}
