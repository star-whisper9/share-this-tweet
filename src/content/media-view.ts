import {
  buildFrameFilename,
  buildMediaFilename,
  buildSourcedMediaFilename,
} from '../core/filename.js';
import type { MediaRecord } from '../shared/model.js';
import { t } from '../shared/i18n.js';
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
  headingLabel = t('content.selectedMedia'),
  dock?: HTMLElement,
): void {
  const { record, selection } = session;
  if (record.media.length === 0) return;
  const heading = node('div', 'stt-section-label');
  heading.append(node('span', '', headingLabel));
  if (record.media.length > 1)
    heading.append(
      node(
        'span',
        'stt-selection-count',
        t('content.selectedCount', { selected: selection.size, total: record.media.length }),
      ),
    );
  const strip = node('div', 'stt-media-strip');
  strip.dataset.tweetId = record.tweetId;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', t('content.mediaSelection'));
  for (const media of record.media) {
    const selected = selection.has(media.index);
    const label = {
      photo: t('content.photo'),
      animated_gif: t('content.gif'),
      video: t('content.video'),
    }[media.type];
    const choice = node('button', 'stt-media-choice');
    choice.type = 'button';
    choice.dataset.sttFocusKey = `select-${record.tweetId}-${media.index}`;
    choice.disabled = session.isSavingBatch;
    choice.setAttribute('aria-pressed', String(selected));
    choice.setAttribute(
      'aria-label',
      selected
        ? t('content.mediaSelected', { label, index: media.index })
        : `${label} ${media.index}`,
    );
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
    if (dock)
      thumb.append(
        node(
          'span',
          'stt-thumb-index',
          `${media.type === 'photo' ? '' : label + ' '}${media.index}`,
        ),
      );
    choice.append(thumb, node('span', 'stt-media-label', `${label} ${media.index}`));
    strip.append(choice);
  }
  actions.append(heading, strip, mediaActions(session, dock));
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
  if (media.type !== 'photo' && (mediaOptions.video === 'top' || mediaOptions.video === 'bottom'))
    return buildFrameFilename(record, media, settings.filenameTemplate, 'mp4');
  if (media.type !== 'photo' && mediaOptions.video === 'sourced')
    return buildSourcedMediaFilename(record, media, settings.filenameTemplate);
  return buildMediaFilename(record, media, settings.filenameTemplate);
}

function mediaActions(session: ExportSession, dock?: HTMLElement): HTMLElement {
  const { selection, record, mediaOptions } = session;
  const selected = selection.selected(record.media);
  const photos = selected.filter((item) => item.type === 'photo').length;
  const dynamic = selected.length - photos;
  const canStitch =
    record.media.length > 1 &&
    (session.settings.experimentalVideo || record.media.every((item) => item.type === 'photo'));
  const wrapper = node('div', 'stt-media-action');
  wrapper.dataset.tweetId = record.tweetId;
  const state = session.mediaAction('configured');
  wrapper.dataset.state = state.status;
  if (selected.length || canStitch) {
    const settings = node('div', 'stt-save-settings');
    if (photos || canStitch)
      settings.append(
        saveChoices<MediaSaveOptions['photo']>(
          session,
          'photo',
          canStitch
            ? photos
              ? t('content.photoStitch')
              : t('content.stitch')
            : dock
              ? t('content.photo')
              : t('content.photoCount', { count: photos }),
          mediaOptions.photo,
          [
            { value: 'original', label: t('content.original'), symbol: 'original' },
            {
              value: 'top',
              label: dock ? t('content.topFrameShort') : t('content.topFrame'),
              symbol: 'top',
            },
            {
              value: 'bottom',
              label: dock ? t('content.bottomFrameShort') : t('content.bottomFrame'),
              symbol: 'bottom',
            },
          ],
          (photo) => session.configureMedia({ photo }),
        ),
      );
    if (dynamic) {
      const videoChoices: SaveChoice<MediaSaveOptions['video']>[] = [
        { value: 'original', label: t('content.originalFile'), symbol: 'original' },
        { value: 'sourced', label: t('content.writeProvenance'), symbol: 'source' },
      ];
      if (session.settings.experimentalVideo)
        videoChoices.push(
          {
            value: 'top',
            label: dock ? t('content.topFrameShort') : t('content.topFrame'),
            symbol: 'top',
          },
          {
            value: 'bottom',
            label: dock ? t('content.bottomFrameShort') : t('content.bottomFrame'),
            symbol: 'bottom',
          },
        );
      settings.append(
        saveChoices<MediaSaveOptions['video']>(
          session,
          'video',
          dock ? t('content.dynamic') : t('content.dynamicCount', { count: dynamic }),
          mediaOptions.video,
          videoChoices,
          (video) => session.configureMedia({ video }),
        ),
      );
    }
    wrapper.append(settings);
  } else {
    wrapper.append(node('p', 'stt-save-empty', t('content.selectMediaHint')));
  }

  const files: { label: string; filename: string }[] = [];
  let filenameError: string | undefined;
  try {
    for (const item of selected) {
      const type = {
        photo: t('content.photo'),
        video: t('content.video'),
        animated_gif: t('content.gif'),
      }[item.type];
      files.push({ label: `${type} ${item.index}`, filename: outputFilename(session, item) });
    }
  } catch (error) {
    filenameError = error instanceof Error ? error.message : String(error);
  }
  (dock ?? wrapper).append(
    actionButton({
      key: `save-media-${record.tweetId}`,
      label: actionLabel(state, {
        idle: selected.length
          ? t('content.saveMedia', { count: selected.length })
          : t('content.selectMedia'),
        loading: t('content.saving'),
        success: t('content.savedAndSaveAgain', { count: selected.length }),
        error: t('content.retrySave'),
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
  if (canStitch) {
    const stitch = session.action('stitch-media');
    (dock ?? wrapper).append(
      actionButton({
        key: `stitch-media-${record.tweetId}`,
        label: actionLabel(stitch, {
          idle: t('content.stitchAllMedia'),
          loading: t('content.stitching'),
          success: t('content.stitchAgain'),
          error: t('content.retryStitch'),
        }),
        image: 'download',
        state: stitch,
        disabled: session.isSavingBatch,
        onClick: () => {
          void session.stitchMedia();
        },
      }),
    );
    if (stitch.error) wrapper.append(errorDetails(t('content.stitchFailedDetails'), stitch.error));
  }
  if (filenameError) wrapper.append(errorDetails(t('content.filenameUnavailable'), filenameError));
  if (state.error) wrapper.append(errorDetails(t('content.saveFailedDetails'), state.error));
  if (files.length && !filenameError) {
    const details = node('details', 'stt-file-details');
    details.append(node('summary', '', t('content.viewOutputFiles')));
    const list = node('dl', '');
    for (const file of files)
      list.append(node('dt', '', file.label), node('dd', '', file.filename));
    details.append(list);
    if (photos && mediaOptions.photo !== 'original')
      details.append(node('p', '', t('content.transparentFrameWebp')));
    wrapper.append(details);
  }
  return wrapper;
}
