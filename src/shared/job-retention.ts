/** Wall-clock retention; startup catches up after Firefox has been closed. */
const DAY = 24 * 60 * 60 * 1000;
export const JOB_RETENTION = {
  androidSaved: DAY,
  androidUnsaved: 7 * DAY,
  desktopUnsaved: DAY,
  diagnostics: 7 * DAY,
  history: 30 * DAY,
  sweepInterval: 15 * 60 * 1000,
} as const;
export function fileCacheDeadline(saved: boolean, android: boolean, now: number): number {
  return (
    now +
    (android
      ? saved
        ? JOB_RETENTION.androidSaved
        : JOB_RETENTION.androidUnsaved
      : saved
        ? 0
        : JOB_RETENTION.desktopUnsaved)
  );
}
