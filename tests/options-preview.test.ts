import { afterEach, expect, it, vi } from 'vitest';
import { recordPreviewText } from '../src/options/record-preview.js';
import { mountTemplateGuide } from '../src/options/template-guide.js';
import { renderTemplate } from '../src/core/template.js';
import type { TweetRecord } from '../src/shared/model.js';

vi.mock('../src/core/template.js', () => ({
  DATE_FORMATS: [],
  fieldsForScope: () => [],
  renderTemplate: vi.fn((value: string) => value),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('preserves the quoted body and its line breaks in a stored record preview', () => {
  const quote: TweetRecord = {
    tweetId: '2',
    url: 'https://x.com/a/status/2',
    author: { id: '1', handle: 'a', name: 'A' },
    text: 'quoted first line\nquoted second line',
    media: [],
  };
  const record: TweetRecord = {
    ...quote,
    tweetId: '3',
    text: 'parent body',
    quote: { status: 'available', tweetId: quote.tweetId, record: quote },
  };
  const preview = recordPreviewText(record);
  expect(preview).toContain(record.text);
  expect(preview).toContain(quote.text);
});

// Only the event lifecycle is under test; layout and product copy are irrelevant.
class GuideElement extends EventTarget {
  value = '{tweet.text}';
  childElementCount = 0;
  append(...children: unknown[]): void {
    this.childElementCount += children.length;
  }
  replaceChildren(): void {
    this.childElementCount = 0;
  }
  setAttribute(): void {}
}

it('releases input listeners before a template guide is remounted', () => {
  vi.stubGlobal('document', { createElement: () => new GuideElement() });
  const container = new GuideElement() as unknown as HTMLElement;
  const input = new GuideElement() as unknown as HTMLInputElement;
  const mount = () =>
    mountTemplateGuide(
      container,
      input,
      'textTemplate',
      () => true,
      () => {},
    );
  const dispose = mount();
  dispose();
  const disposeAgain = mount();
  vi.mocked(renderTemplate).mockClear();
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('templatechange'));
  expect(renderTemplate).toHaveBeenCalledTimes(2);
  disposeAgain();
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('templatechange'));
  expect(renderTemplate).toHaveBeenCalledTimes(2);
});
