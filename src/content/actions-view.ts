import { translationWarning } from '../shared/translation.js';
import type { ExportSession } from './export-session.js';
import { appendMediaActions } from './media-view.js';
import { actionButton, actionLabel, errorDetails, node } from './ui-components.js';

function cardSaveButton(session: ExportSession): HTMLButtonElement {
  const state = session.action('save-card');
  const button = actionButton({
    key: 'save-card',
    label: actionLabel(state, {
      idle: '保存推文卡片',
      loading: '正在保存推文卡片…',
      success: '再次保存推文卡片',
      error: '保存推文卡片',
    }),
    image: 'download',
    state,
    onClick: () => {
      void session.saveCard();
    },
  });
  return button;
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
  const expandedFiles = new Set(
    Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-action'))
      .filter((group) => group.querySelector<HTMLDetailsElement>('.stt-file-details')?.open)
      .map((group) => group.dataset.tweetId),
  );
  const stripPositions = new Map(
    Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-strip')).map((strip) => [
      strip.dataset.tweetId,
      strip.scrollLeft,
    ]),
  );
  const scroll = sheet.querySelector<HTMLElement>('.stt-sheet-scroll');
  const scrollTop = scroll?.scrollTop ?? 0;
  actions.replaceChildren();
  for (const [label, record] of [
    ['主推文', session.record],
    ['引用推文', session.quoted?.record],
  ] as const) {
    const warning = translationWarning(record?.translation);
    if (warning) {
      const message = node('p', 'stt-translation-warning', `翻译警告 · ${label}：${warning}`);
      message.setAttribute('role', 'status');
      actions.append(message);
    }
  }
  appendMediaActions(actions, session, session.record.quote ? '主推文媒体' : '所选媒体');
  if (session.quoted) appendMediaActions(actions, session.quoted, '引用推文媒体');
  actions.append(
    node(
      'div',
      'stt-section-label',
      session.record.quote ? '整条推文（包含一层引用）' : '整条推文',
    ),
  );
  const exports = node('div', 'stt-export-grid');
  exports.append(cardSaveButton(session), textAction(session));
  actions.append(exports);
  const save = session.action('save-card');
  if (save.status === 'error')
    actions.append(errorDetails('卡片保存失败，请重试。', save.error ?? ''));
  for (const group of Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-action'))) {
    const details = group.querySelector<HTMLDetailsElement>('.stt-file-details');
    if (details) details.open = expandedFiles.has(group.dataset.tweetId);
  }
  for (const strip of Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-strip'))) {
    strip.scrollLeft = stripPositions.get(strip.dataset.tweetId) ?? 0;
  }
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
