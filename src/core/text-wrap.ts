/** Wrap by Unicode code point, preserving whitespace and explicit line breaks. */
export function wrapText(
  text: string,
  maxWidth: number,
  measureText: (text: string) => { width: number },
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let current = '';
    for (const character of paragraph) {
      const candidate = current + character;
      if (current && measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = character;
      } else current = candidate;
    }
    lines.push(current);
  }
  return lines;
}
