/** Resource budgets can be bypassed by an explicit forced export, unlike format validation. */
export class ProcessingLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessingLimitError';
  }
}

export class ExportItemsError extends Error {
  constructor(
    message: string,
    readonly canForceRetry: boolean,
  ) {
    super(message);
    this.name = 'ExportItemsError';
  }
}

export const IMAGE_BUDGET = { side: 16384, pixels: 32000000 } as const;
export const STITCH_BUDGET = { side: 24000, pixels: 64000000 } as const;
export function exceedsImageBudget(
  width: number,
  height: number,
  budget: { side: number; pixels: number } = IMAGE_BUDGET,
): boolean {
  return width > budget.side || height > budget.side || width * height > budget.pixels;
}
