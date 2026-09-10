import {
  buildFrameFilename,
  buildMediaFilename,
  buildSourcedMediaFilename,
} from '../core/filename.js';
import { FRAME_ORIENTATIONS, type FrameOrientation } from '../core/frame.js';
import type { MediaRecord } from '../shared/model.js';
import type { ExportSession } from './export-session.js';
import {
  actionButton,
  actionLabel,
  errorDetails,
  icon,
  node,
  thumbnailURL,
} from './ui-components.js';

const directions: Record<FrameOrientation, string> = { top: '上方', bottom: '下方' };

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
  const media = record.media.find((item) => item.index === selection.primary) ?? record.media[0];
  actions.append(heading, strip, mediaActions(session, media));
}

function frameActions(session: ExportSession, media: MediaRecord): HTMLElement {
  const grid = node('div', 'stt-frame-direction-grid');
  const batch = session.selection.size > 1;
  for (const orientation of FRAME_ORIENTATIONS) {
    const state = session.mediaAction('framed', orientation);
    const preferred = orientation === session.settings.frameOrientation;
    const direction = directions[orientation];
    const labels = batch
      ? {
          idle: `保存已选媒体（带${direction}画框）`,
          loading: '正在保存已选媒体…',
          success: `再次保存已选媒体（带${direction}画框）`,
          error: `重试保存已选媒体（带${direction}画框）`,
        }
      : {
          idle: `保存${direction}画框`,
          loading: `正在制作${direction}画框…`,
          success: `再保存一张${direction}画框`,
          error: `重试${direction}画框`,
        };
    const button = actionButton({
      key: `frame-${session.record.tweetId}-${media.index}-${orientation}`,
      label: actionLabel(state, labels),
      image: 'frame',
      state,
      primary: preferred,
      disabled: session.isSavingBatch || session.selection.size === 0,
      onClick: () => {
        void session.saveSelected('framed', orientation);
      },
    });
    if (preferred)
      button.querySelector('.stt-command-copy')?.append(node('small', 'stt-default-badge', '默认'));
    button.classList.add('stt-media-frame-button');
    grid.append(button);
  }
  return grid;
}

function mediaActions(session: ExportSession, media: MediaRecord): HTMLElement {
  const { selection, record, settings } = session;
  const wrapper = node('div', 'stt-media-action');
  wrapper.dataset.tweetId = record.tweetId;
  const batch = selection.size > 1;
  const photo = media.type === 'photo';
  const state = session.mediaAction('original');
  const sourcedState = session.mediaAction('sourced');
  wrapper.dataset.state = state.status;
  const selectedMedia = selection.selected(record.media);
  const selectedPhotos = selectedMedia.some((item) => item.type === 'photo');
  const selectedDynamicMedia = selectedMedia.find((item) => item.type !== 'photo');
  const selectedDynamic = selectedDynamicMedia !== undefined;
  if (selection.size === 0 || photo || (batch && selectedPhotos)) {
    wrapper.append(frameActions(session, media));
    if (batch && selection.selected(record.media).some((item) => item.type !== 'photo'))
      wrapper.append(node('p', 'stt-sheet-note', '画框仅用于照片，视频和 GIF 原样保存。'));
    const error = FRAME_ORIENTATIONS.map(
      (orientation) => session.mediaAction('framed', orientation).error,
    ).find(Boolean);
    if (error)
      wrapper.append(
        errorDetails(
          batch ? '部分带画框媒体保存失败，请重试。' : '这次画框没能生成，请重试。',
          error,
        ),
      );
  }
  const mediaLabel = { photo: '原图', animated_gif: 'GIF 视频', video: '视频' }[media.type];
  const labels = batch
    ? {
        idle: `保存已选媒体（${selection.size}）`,
        loading: '正在保存已选媒体…',
        success: `再次保存已选媒体（${selection.size}）`,
        error: '重试保存已选媒体',
      }
    : {
        idle: `保存${mediaLabel}`,
        loading: '正在保存…',
        success: `再次保存${mediaLabel}`,
        error: `重试保存${mediaLabel}`,
      };
  const button = actionButton({
    key: batch
      ? `download-selected-${record.tweetId}`
      : `download-${record.tweetId}-${media.index}`,
    label: actionLabel(state, labels),
    image: 'download',
    state,
    primary: !selectedDynamic,
    disabled: session.isSavingBatch || selection.size === 0,
    onClick: () => {
      void session.saveSelected('original');
    },
  });
  let filename: string | undefined;
  let sourcedFilename: string | undefined;
  if (selection.size > 0) {
    try {
      filename = buildMediaFilename(record, media, settings.filenameTemplate);
      if (selectedDynamicMedia)
        sourcedFilename = buildSourcedMediaFilename(
          record,
          selectedDynamicMedia,
          settings.filenameTemplate,
        );
    } catch (error) {
      button.disabled = true;
      wrapper.append(
        errorDetails(
          '请先检查设置中的文件名模板。',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  if (selectedDynamic) {
    const sourceLabels = batch
      ? {
          idle: `保存已选媒体并保留来源（${selection.size}）`,
          loading: '正在写入来源并保存…',
          success: `再次保存并保留来源（${selection.size}）`,
          error: '重试写入来源并保存',
        }
      : {
          idle: `保存${mediaLabel}并保留来源`,
          loading: '正在写入来源并保存…',
          success: `再次保存${mediaLabel}并保留来源`,
          error: '重试写入来源并保存',
        };
    wrapper.append(
      actionButton({
        key: batch
          ? `download-sourced-selected-${record.tweetId}`
          : `download-sourced-${record.tweetId}-${media.index}`,
        label: actionLabel(sourcedState, sourceLabels),
        description: batch
          ? '视频和 GIF 写入来源；照片保持原样'
          : '不覆盖画面与声音；平台转码后可能被清除',
        image: 'download',
        state: sourcedState,
        primary: true,
        disabled: session.isSavingBatch || selection.size === 0,
        onClick: () => {
          void session.saveSelected('sourced');
        },
      }),
    );
  }
  wrapper.append(button);
  if (state.error)
    wrapper.append(
      errorDetails(
        batch ? '部分原始媒体保存失败，请重试。' : '没能保存，请检查网络后重试。',
        state.error,
      ),
    );
  if (sourcedState.error)
    wrapper.append(
      errorDetails(
        batch
          ? '部分媒体未能写入来源，请重试或明确选择原样保存。'
          : '没能写入来源，请重试或明确选择原样保存。',
        sourcedState.error,
      ),
    );
  if (filename) {
    const details = node('details', 'stt-file-details');
    details.append(node('summary', '', '查看保存文件名'));
    const list = node('dl', '');
    list.append(node('dt', '', photo ? '原图' : '视频'), node('dd', '', filename));
    if (sourcedFilename) list.append(node('dt', '', '保留来源'), node('dd', '', sourcedFilename));
    if (photo) {
      let frameFilename: string;
      try {
        frameFilename = buildFrameFilename(record, media, settings.filenameTemplate);
      } catch {
        frameFilename = '文件名暂不可用，请检查模板。';
      }
      list.append(node('dt', '', '画框'), node('dd', '', `${frameFilename}（透明图片使用 .webp）`));
    }
    details.append(list);
    wrapper.append(details);
  }
  return wrapper;
}
