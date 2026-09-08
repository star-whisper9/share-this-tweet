import { expect, it } from 'vitest';
import { tagRanges, tagRunsForLines } from '../src/core/card-tags.js';

it('accepts spaces, line endings and end of text while excluding embedded hashes and punctuation', () => {
  const text = '#中文 #tag_2 C#code ##heading #comma, #newline\n#windows\r\n#end';
  expect(tagRanges(text).map(({ start, end }) => text.slice(start, end))).toEqual([
    '#中文',
    '#tag_2',
    '#newline',
    '#windows',
    '#end',
  ]);
});
it('preserves the match across wraps without coloring an unmatched identical occurrence', () => {
  const text = '#longtag then #longtag,';
  const lines = ['#long', 'tag then ', '#longtag,'];
  const runs = tagRunsForLines(text, lines);
  expect(
    runs.map((line) =>
      line
        .filter((run) => run.tag)
        .map((run) => run.text)
        .join(''),
    ),
  ).toEqual(['#long', 'tag', '']);
  expect(runs.map((line) => line.map((run) => run.text).join(''))).toEqual(lines);
});
