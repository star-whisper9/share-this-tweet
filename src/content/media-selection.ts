import type { MediaRecord } from '../shared/model.js';

/** Selection belongs to one tweet and survives incremental media responses. */
export class MediaSelection {
  private readonly indexes = new Set<number>();
  private initialized = false;
  private primaryIndex?: number;

  get size(): number {
    return this.indexes.size;
  }
  get primary(): number | undefined {
    return this.primaryIndex;
  }
  has(index: number): boolean {
    return this.indexes.has(index);
  }

  reconcile(media: MediaRecord[]): void {
    const available = new Set(media.map((item) => item.index));
    for (const index of this.indexes) {
      if (!available.has(index)) this.indexes.delete(index);
    }
    if (this.primaryIndex !== undefined && !available.has(this.primaryIndex)) {
      this.primaryIndex = undefined;
    }
    this.primaryIndex ??= this.indexes.values().next().value;
    if (!this.initialized && media.length > 0) {
      this.initialized = true;
      this.primaryIndex ??= media[0].index;
      this.indexes.add(this.primaryIndex);
    }
  }

  toggle(index: number, media: MediaRecord[]): void {
    if (!media.some((item) => item.index === index)) return;
    if (this.indexes.has(index)) {
      this.indexes.delete(index);
      this.primaryIndex = this.indexes.values().next().value;
    } else {
      this.indexes.add(index);
      this.primaryIndex = index;
    }
  }

  selected(media: MediaRecord[]): MediaRecord[] {
    return media.filter((item) => this.indexes.has(item.index));
  }
}
