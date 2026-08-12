import { takeSnapshot } from '../../shared/snapshot';
import type { OffscreenMessage } from '../../shared/types';

/**
 * MV3 service workers have no DOMParser. This offscreen document exists for
 * exactly one job: parse fetched HTML and run the shared snapshot logic on
 * it, so fetch-first checks never need to spin up a real tab.
 */
chrome.runtime.onMessage.addListener(
  (message: OffscreenMessage, _sender, sendResponse) => {
    if (message.kind === 'parse-html-check') {
      const doc = new DOMParser().parseFromString(message.html, 'text/html');
      sendResponse(takeSnapshot(doc, message.spec, false));
    }
    return false;
  },
);
