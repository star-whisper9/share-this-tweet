export interface CardTextRun {
  text: string;
  start: number;
  tag: boolean;
}

/** Match in the original text, before visual wrapping can alter tag boundaries. */
export function tagRanges(text: string): Array<{ start: number; end: number }> {
  return Array.from(text.matchAll(/(^|\s)(#[\p{L}\p{N}_]+)(?= |\r?\n|$)/gu), (match) => {
    const start = match.index! + match[1].length;
    return { start, end: start + match[2].length };
  });
}

export function tagRunsForLines(text: string, lines: string[]): CardTextRun[][] {
  const ranges = tagRanges(text);
  let cursor = 0;
  return lines.map((line) => {
    const offset = line ? text.indexOf(line, cursor) : cursor;
    if (offset < 0) throw new Error('卡片正文折行无法对应原文');
    cursor = offset + line.length;
    const runs: CardTextRun[] = [];
    let start = 0;
    for (const range of ranges) {
      const from = Math.max(0, range.start - offset);
      const to = Math.min(line.length, range.end - offset);
      if (from >= to) continue;
      if (from > start) runs.push({ text: line.slice(start, from), start, tag: false });
      runs.push({ text: line.slice(from, to), start: from, tag: true });
      start = to;
    }
    if (start < line.length) runs.push({ text: line.slice(start), start, tag: false });
    return runs;
  });
}
