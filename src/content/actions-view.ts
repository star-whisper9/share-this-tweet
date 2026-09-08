import { isAndroidUserAgent } from '../core/download.js';
import { canShareFile } from '../core/share.js';
import type { ExportSession } from './export-session.js';
import { appendMediaActions } from './media-view.js';
import { actionButton, actionLabel, errorDetails, node } from './ui-components.js';

function cardSaveButton(session: ExportSession, description: string): HTMLButtonElement {
  const state = session.action('save-card');
  const button = actionButton({
    key: 'save-card',
    label: actionLabel(state, {
      idle: '保存推文卡片',
      loading: '正在保存推文卡片…',
      success: '再次保存推文卡片',
      error: '保存推文卡片',
    }),
    description,
    image: 'download',
    state,
    onClick: () => {
      void session.saveCard();
    },
  });
  button.classList.add('stt-share-fallback');
  return button;
}
function canShareImageFile(): boolean {
  try {
    return canShareFile(
      new File(['share-this-tweet'], 'share-this-tweet-card.png', { type: 'image/png' }),
    );
  } catch {
    return false;
  }
}
function shareActions(session: ExportSession): HTMLElement {
  const wrapper = node('div', 'stt-share-actions');
  const text = session.action('share-text');
  const image = session.action('share-image');
  wrapper.append(
    actionButton({
      key: 'share-text',
      label: actionLabel(text, {
        idle: '分享文本',
        loading: '正在分享文本…',
        success: '再次分享文本',
        error: '重试分享文本',
      }),
      image: 'share',
      state: text,
      onClick: () => {
        void session.shareText();
      },
    }),
  );
  if (canShareImageFile()) {
    wrapper.append(
      actionButton({
        key: 'share-image',
        label: actionLabel(image, {
          idle: '分享推文卡片',
          loading: '正在分享推文卡片…',
          success: '再次分享推文卡片',
          error: '重试分享推文卡片',
        }),
        image: 'share',
        state: image,
        onClick: () => {
          void session.shareImage();
        },
      }),
    );
  } else wrapper.append(cardSaveButton(session, '当前环境不支持图片文件分享'));
  if (text.status === 'error')
    wrapper.append(errorDetails('文本分享失败，请重试或改用复制文本。', text.error ?? ''));
  if (image.status === 'error') {
    wrapper.append(errorDetails('推文卡片分享失败，请重试。', image.error ?? ''));
    if (session.hasCard)
      wrapper.append(cardSaveButton(session, '卡片已经生成，只是原生分享没有成功'));
  }
  const save = session.action('save-card');
  if (save.status === 'error')
    wrapper.append(errorDetails('卡片保存失败，请重试。', save.error ?? ''));
  return wrapper;
}
function textAction(session: ExportSession): HTMLElement {
  const state = session.action('copy-text');
  const wrapper = node('div', 'stt-text-action');
  wrapper.dataset.state = state.status;
  wrapper.append(
    actionButton({
      key: 'copy-text',
      label: actionLabel(state, {
        idle: '复制推文文字',
        loading: '正在复制…',
        success: '已复制 · 再复制一次',
        error: '重试复制文字',
      }),
      description: '复制后，直接粘贴到聊天中',
      image: 'copy',
      state,
      primary: session.record.media.length === 0,
      onClick: () => {
        void session.copyText();
      },
    }),
  );
  if (state.status === 'error')
    wrapper.append(errorDetails('没能复制，请重试或检查剪贴板权限。', state.error ?? ''));
  return wrapper;
}

/** Rebuild buttons while preserving the user's focus, expanded details and scroll. */
export function renderActions(sheet: HTMLElement, session: ExportSession): void {
  const actions = sheet.querySelector<HTMLElement>('.stt-sheet-actions');
  if (!actions) return;
  const active =
    document.activeElement instanceof HTMLElement && actions.contains(document.activeElement)
      ? document.activeElement
      : undefined;
  const focusKey = active?.dataset.sttFocusKey;
  const filenameOpen =
    actions.querySelector<HTMLDetailsElement>('.stt-file-details')?.open ?? false;
  const scroll = sheet.querySelector<HTMLElement>('.stt-sheet-scroll');
  const scrollTop = scroll?.scrollTop ?? 0;
  const stripScroll = actions.querySelector<HTMLElement>('.stt-media-strip')?.scrollLeft ?? 0;
  actions.replaceChildren();
  appendMediaActions(actions, session);
  if (isAndroidUserAgent(navigator.userAgent)) actions.append(shareActions(session));
  else {
    actions.append(cardSaveButton(session, '保存正文、作者与来源为 PNG'));
    const save = session.action('save-card');
    if (save.status === 'error')
      actions.append(errorDetails('卡片保存失败，请重试。', save.error ?? ''));
  }
  if (session.record.media.some((media) => media.type !== 'photo')) {
    actions.append(
      node('p', 'stt-sheet-note', '推文卡片不包含视频或 GIF，仅保留正文、照片和来源。'),
    );
  }
  actions.append(textAction(session));
  const details = actions.querySelector<HTMLDetailsElement>('.stt-file-details');
  if (details) details.open = filenameOpen;
  const strip = actions.querySelector<HTMLElement>('.stt-media-strip');
  if (strip) strip.scrollLeft = stripScroll;
  if (scroll) scroll.scrollTop = scrollTop;
  if (!focusKey) return;
  const target = Array.from(actions.querySelectorAll<HTMLElement>('[data-stt-focus-key]')).find(
    (item) => item.dataset.sttFocusKey === focusKey,
  );
  if (target instanceof HTMLButtonElement && !target.disabled)
    target.focus({ preventScroll: true });
  else if (target?.parentElement) {
    target.parentElement.dataset.sttFocusKey = focusKey;
    target.parentElement.setAttribute('tabindex', '-1');
    target.parentElement.focus({ preventScroll: true });
  }
}
