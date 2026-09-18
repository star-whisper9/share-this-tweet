import { translationWarning } from '../shared/translation.js';
import type { ExportSession } from './export-session.js';
import { appendMediaActions } from './media-view.js';
import { actionButton, actionLabel, errorDetails, node } from './ui-components.js';

function cardSaveButton(session: ExportSession, row = false, mobile = false): HTMLButtonElement {
  const key = row ? 'save-row-card' : 'save-card';
  const state = session.action(key);
  const label = mobile ? (row ? '单行卡片' : '网格卡片') : row ? '保存单行卡片' : '保存推文卡片';
  const button = actionButton({
    key,
    label: actionLabel(state, {
      idle: label,
      loading: '正在保存…',
      success: `再次${label}`,
      error: label,
    }),
    image: 'download',
    disabled:
      row && session.record.media.length < 2 && (session.quoted?.record.media.length ?? 0) < 2,
    state,
    onClick: () => {
      void session.saveCard(row);
    },
  });
  return button;
}
function textAction(session: ExportSession, mobile = false, errors?: HTMLElement): HTMLElement {
  const state = session.action('copy-text');
  const wrapper = node('div', 'stt-text-action');
  wrapper.dataset.state = state.status;
  wrapper.append(
    actionButton({
      key: 'copy-text',
      label: actionLabel(state, {
        idle: mobile ? '复制文字' : '复制推文文字',
        loading: '正在复制…',
        success: mobile ? '再次复制' : '已复制 · 再复制一次',
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
    (errors ?? wrapper).append(
      errorDetails('没能复制，请重试或检查剪贴板权限。', state.error ?? ''),
    );
  return wrapper;
}

interface ActionsViewState {
  scope: 'main' | 'quote';
  expandedFiles: Map<string, boolean>;
  stripPositions: Map<string, number>;
}
const views = new WeakMap<HTMLElement, ActionsViewState>();

/** Rebuild buttons while preserving the user's focus, expanded details and scroll. */
export function renderActions(sheet: HTMLElement, session: ExportSession, mobile = false): void {
  const actions = sheet.querySelector<HTMLElement>('.stt-sheet-actions');
  const dock = sheet.querySelector<HTMLElement>('.stt-mobile-dock');
  if (!actions || !dock) return;
  const state: ActionsViewState = views.get(sheet) ?? {
    scope: 'main',
    expandedFiles: new Map(),
    stripPositions: new Map(),
  };
  views.set(sheet, state);
  if (!session.record.quote) state.scope = 'main';
  const active =
    document.activeElement instanceof HTMLElement &&
    (actions.contains(document.activeElement) || dock.contains(document.activeElement))
      ? document.activeElement
      : undefined;
  const focusKey = active?.dataset.sttFocusKey;
  for (const group of Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-action'))) {
    if (group.dataset.tweetId)
      state.expandedFiles.set(
        group.dataset.tweetId,
        group.querySelector<HTMLDetailsElement>('.stt-file-details')?.open ?? false,
      );
  }
  for (const strip of Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-strip'))) {
    if (strip.dataset.tweetId) state.stripPositions.set(strip.dataset.tweetId, strip.scrollLeft);
  }
  const scroll = sheet.querySelector<HTMLElement>('.stt-sheet-scroll');
  const scrollTop = scroll?.scrollTop ?? 0;
  actions.replaceChildren();
  dock.replaceChildren();
  dock.hidden = !mobile;
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
  if (mobile) {
    if (session.record.quote) {
      const tabs = node('div', 'stt-media-tabs');
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', '媒体所属推文');
      for (const [scope, label] of [
        ['main', '主推文'],
        ['quote', '引用推文'],
      ] as const) {
        const button = node('button', '', label);
        button.type = 'button';
        button.dataset.sttFocusKey = `scope-${scope}`;
        button.setAttribute('aria-pressed', String(state.scope === scope));
        button.addEventListener('click', () => {
          state.scope = scope;
          renderActions(sheet, session, mobile);
        });
        tabs.append(button);
      }
      actions.append(tabs);
    }
    const target = state.scope === 'quote' ? session.quoted : session;
    if (target?.record.media.length) appendMediaActions(actions, target, '媒体', dock);
    else if (state.scope === 'quote')
      actions.append(
        node('p', 'stt-save-empty', target ? '引用推文没有媒体。' : '引用内容暂不可用。'),
      );
    dock.setAttribute(
      'aria-label',
      state.scope === 'quote' ? '引用媒体及整条推文操作' : '主推文媒体及整条推文操作',
    );
  } else {
    appendMediaActions(actions, session, session.record.quote ? '主推文媒体' : '所选媒体');
    if (session.quoted) appendMediaActions(actions, session.quoted, '引用推文媒体');
    actions.append(
      node(
        'div',
        'stt-section-label',
        session.record.quote ? '整条推文（包含一层引用）' : '整条推文',
      ),
    );
  }
  const exports = node('div', 'stt-export-grid');
  exports.setAttribute('role', 'group');
  exports.setAttribute('aria-label', session.record.quote ? '整条推文，包含一层引用' : '整条推文');
  exports.append(
    cardSaveButton(session, false, mobile),
    cardSaveButton(session, true, mobile),
    textAction(session, mobile, mobile ? actions : undefined),
  );
  (mobile ? dock : actions).append(exports);
  for (const key of ['save-card', 'save-row-card'] as const) {
    const save = session.action(key);
    if (save.status === 'error')
      actions.append(errorDetails('卡片保存失败，请重试。', save.error ?? ''));
  }
  for (const group of Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-action'))) {
    const details = group.querySelector<HTMLDetailsElement>('.stt-file-details');
    if (details) details.open = state.expandedFiles.get(group.dataset.tweetId ?? '') ?? false;
  }
  for (const strip of Array.from(actions.querySelectorAll<HTMLElement>('.stt-media-strip'))) {
    strip.scrollLeft = state.stripPositions.get(strip.dataset.tweetId ?? '') ?? 0;
  }
  if (scroll) scroll.scrollTop = scrollTop;
  if (!focusKey) return;
  const target = Array.from(sheet.querySelectorAll<HTMLElement>('[data-stt-focus-key]')).find(
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
