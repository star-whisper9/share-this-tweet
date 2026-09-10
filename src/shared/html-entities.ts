const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/** Decode the HTML character references emitted by X's text APIs exactly once. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const codePoint = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}
