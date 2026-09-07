import type { ExtensionMessage } from '../shared/protocol.js';

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isExtensionMessage(message)) return;

  // Background routing is intentionally empty during workspace bootstrap.
  // Media download and platform-specific behavior will be added in v0.1 slices.
  void message;
});

function isExtensionMessage(message: unknown): message is ExtensionMessage {
  return typeof message === 'object' && message !== null && 'type' in message;
}
