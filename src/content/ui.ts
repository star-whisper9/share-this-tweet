import { getTweetIdFromPath } from '../shared/model.js';

export class ShareEnhancerController {
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    // v0.1 UI implementation starts here. The controller is intentionally
    // route-aware so timeline cards remain outside the initial feature scope.
    void getTweetIdFromPath(location.pathname);
  }

  stop(): void {
    this.started = false;
  }
}
