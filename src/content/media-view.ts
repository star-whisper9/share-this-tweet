import {
  buildFrameFilename,
  buildMediaFilename,
  buildSourcedMediaFilename,
} from '../core/filename.js';
import type { MediaRecord } from '../shared/model.js';
import type { ExportSession, MediaSaveOptions } from './export-session.js';
import {
  actionButton,
  actionLabel,
  errorDetails,
  icon,
  node,
  thumbnailURL,
} from './ui-components.js';

export function appendMediaActions(
  actions: HTMLElement,
  session: ExportSession,
  headingLabel = '所选媒体',
): void {
  const { record, selection } = session;
  if (record.media.length === 0) return;
  const heading = node('div', 'stt-section-label');
  heading.append(node('span', '', headingLabel));
  if (record.media.length > 1)
    heading.append(
      node('span', 'stt-selection-count', `已选 ${selection.size} / ${record.media.length}`),
    );
  const strip = node('div', 'stt-media-strip');
  strip.dataset.tweetId = record.tweetId;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', '选择媒体');
  for (const media of record.media) {
    const selected = selection.has(media.index);
    const label = { photo: '照片', animated_gif: 'GIF', video: '视频' }[media.type];
    const choice = node('button', 'stt-media-choice');
    choice.type = 'button';
    choice.dataset.sttFocusKey = `select-${record.tweetId}-${media.index}`;
    choice.disabled = session.isSavingBatch;
    choice.setAttribute('aria-pressed', String(selected));
    choice.setAttribute('aria-label', `${label} ${media.index}${selected ? '，已选中' : ''}`);
    choice.addEventListener('click', () => session.toggleMedia(media.index));
    const thumb = node('span', 'stt-media-thumb');
    thumb.append(icon(media.type === 'photo' ? 'photo' : 'video'));
    const url = thumbnailURL(media);
    if (url) {
      const image = node('img', '');
      image.src = url;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      thumb.append(image);
    }
    const check = node('span', 'stt-thumb-check');
    check.append(icon('check'));
    thumb.append(check);
    choice.append(thumb, node('span', 'stt-media-label', `${label} ${media.index}`));
    strip.append(choice);
  }
  actions.append(heading, strip, mediaActions(session));
}

interface SaveChoice<T extends string> {
  value: T;
  label: string;
  symbol: 'original' | 'top' | 'bottom' | 'source';
}

function saveChoices<T extends string>(
  session: ExportSession,
  kind: 'photo' | 'video',
  title: string,
  selected: T,
  choices: SaveChoice<T>[],
  onSelect: (value: T) => void,
): HTMLElement {
  const row = node('div', 'stt-save-setting');
  const heading = node('div', 'stt-save-setting-label', title);
  heading.id = `stt-save-${session.record.tweetId}-${kind}`;
  const group = node('div', 'stt-save-choices');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', heading.id);
  for (const choice of choices) {
    const button = node('button', 'stt-save-choice');
    button.type = 'button';
    button.disabled = session.isSavingBatch;
    button.dataset.sttFocusKey = `save-choice-${session.record.tweetId}-${kind}-${choice.value}`;
    button.setAttribute('aria-pressed', String(choice.value === selected));
    const symbol = node('span', 'stt-save-symbol');
    symbol.dataset.format = choice.symbol;
    symbol.setAttribute('aria-hidden', 'true');
    symbol.append(
      icon(kind === 'photo' ? 'photo' : choice.symbol === 'source' ? 'share' : 'video'),
    );
    button.append(symbol, node('span', '', choice.label));
    button.addEventListener('click', () => onSelect(choice.value));
    group.append(button);
  }
  row.append(heading, group);
  return row;
}

function outputFilename(session: ExportSession, media: MediaRecord): string {
  const { record, settings, mediaOptions } = session;
  if (media.type === 'photo' && mediaOptions.photo !== 'original')
    return buildFrameFilename(record, media, settings.filenameTemplate);
  if (media.type !== 'photo' && mediaOptions.video === 'sourced')
    return buildSourcedMediaFilename(record, media, settings.filenameTemplate);
  return buildMediaFilename(record, media, settings.filenameTemplate);
}

function mediaActions(session: ExportSession): HTMLElement {
  const { selection, record, mediaOptions } = session;
  const selected = selection.selected(record.media);
  const photos = selected.filter((item) => item.type === 'photo').length;
  const dynamic = selected.length - photos;
  const wrapper = node('div', 'stt-media-action');
  wrapper.dataset.tweetId = record.tweetId;
  const state = session.mediaAction('configured');
  wrapper.dataset.state = state.status;
  if (selected.length) {
    const settings = node('div', 'stt-save-settings');
    if (photos)
      settings.append(
        saveChoices<MediaSaveOptions['photo']>(
          session,
          'photo',
          `照片 · ${photos}`,
          mediaOptions.photo,
          [
            { value: 'original', label: '原图', symbol: 'original' },
            { value: 'top', label: '上方画框', symbol: 'top' },
            { value: 'bottom', label: '下方画框', symbol: 'bottom' },
          ],
          (photo) => session.configureMedia({ photo }),
        ),
      );
    if (dynamic)
      settings.append(
        saveChoices<MediaSaveOptions['video']>(
          session,
          'video',
          `视频 / GIF · ${dynamic}`,
          mediaOptions.video,
          [
            { value: 'original', label: '原文件', symbol: 'original' },
            { value: 'sourced', label: '写入来源', symbol: 'source' },
          ],
          (video) => session.configureMedia({ video }),
        ),
      );
    wrapper.append(settings);
    if (dynamic && mediaOptions.video === 'sourced')
      wrapper.append(
        node('p', 'stt-save-hint', '作者与原推链接写入文件，不加水印。平台转码可能移除。'),
      );
  } else {
    wrapper.append(node('p', 'stt-save-empty', '选择上方媒体，再设置保存方式。'));
  }

  const files: { label: string; filename: string }[] = [];
  let filenameError: string | undefined;
  try {
    for (const item of selected) {
      const type = { photo: '照片', video: '视频', animated_gif: 'GIF' }[item.type];
      files.push({ label: `${type} ${item.index}`, filename: outputFilename(session, item) });
    }
  } catch (error) {
    filenameError = error instanceof Error ? error.message : String(error);
  }
  wrapper.append(
    actionButton({
      key: `save-media-${record.tweetId}`,
      label: actionLabel(state, {
        idle: selected.length ? `保存 ${selected.length} 项媒体` : '请选择媒体',
        loading: '正在保存…',
        success: `已保存 · 再保存 ${selected.length} 项`,
        error: '重试保存',
      }),
      image: 'download',
      state,
      primary: true,
      disabled: session.isSavingBatch || !selected.length || !!filenameError,
      onClick: () => {
        void session.saveSelected('configured');
      },
    }),
  );
  if (filenameError)
    wrapper.append(errorDetails('文件名暂不可用，请检查文件名模板。', filenameError));
  if (state.error) wrapper.append(errorDetails('保存未完成，可重试或切换保存方式。', state.error));
  if (files.length && !filenameError) {
    const details = node('details', 'stt-file-details');
    details.append(node('summary', '', '查看输出文件'));
    const list = node('dl', '');
    for (const file of files)
      list.append(node('dt', '', file.label), node('dd', '', file.filename));
    details.append(list);
    if (photos && mediaOptions.photo !== 'original')
      details.append(node('p', '', '透明图片的画框文件使用 .webp。'));
    wrapper.append(details);
  }
  return wrapper;
}
