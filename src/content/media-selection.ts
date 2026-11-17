import type { MediaRecord } from '../shared/model.js';

/** Selection belongs to one tweet and survives incremental media responses. */
export class MediaSelection {
  private readonly indexes = new Set<number>();
  private initialized = false;

  get size(): number {
    return this.indexes.size;
  }
  has(index: number): boolean {
    return this.indexes.has(index);
  }

  reconcile(media: MediaRecord[]): void {
    const available = new Set(media.map((item) => item.index));
    for (const index of this.indexes) {
      if (!available.has(index)) this.indexes.delete(index);
    }
    if (!this.initialized && media.length > 0) {
      this.initialized = true;
      this.indexes.add(media[0].index);
    }
  }

  toggle(index: number, media: MediaRecord[]): void {
    if (!media.some((item) => item.index === index)) return;
    if (this.indexes.has(index)) {
      this.indexes.delete(index);
    } else {
      this.indexes.add(index);
    }
  }

  selectRange(start: number, end: number, media: MediaRecord[]): void {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start > end ||
      !media.some((item) => item.index === start) ||
      !media.some((item) => item.index === end)
    )
      throw new RangeError('Invalid media range');
    this.indexes.clear();
    for (const item of media) {
      if (item.index >= start && item.index <= end) this.indexes.add(item.index);
    }
  }

  toggleAll(media: MediaRecord[]): void {
    const allSelected = media.every((item) => this.indexes.has(item.index));
    this.indexes.clear();
    if (!allSelected) for (const item of media) this.indexes.add(item.index);
  }

  selected(media: MediaRecord[]): MediaRecord[] {
    return media.filter((item) => this.indexes.has(item.index));
  }
}
