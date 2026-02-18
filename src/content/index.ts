/**
 * Content script entry point.
 * Listens for messages from the service worker and dispatches to parser/actions.
 */

import { takeSnapshot, resolveRef, type SnapshotOptions } from './parser';
import { executeAction } from './actions';
import type { Action } from '../types';

// Make functions available on window for debugging
(window as any).__webprowler = {
  takeSnapshot,
  resolveRef,
  executeAction,
};

// ─── Message handler ───

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'GET_SNAPSHOT': {
      const options = (payload ?? {}) as SnapshotOptions;
      try {
        const snapshot = takeSnapshot(options);
        sendResponse({ success: true, data: snapshot });
      } catch (error) {
        sendResponse({ success: false, error: String(error) });
      }
      return false; // synchronous
    }

    case 'EXECUTE_ACTION': {
      const action = payload as Action;
      // Async — must return true
      executeAction(action).then(result => {
        sendResponse(result);
      }).catch(error => {
        sendResponse({ success: false, error: String(error) });
      });
      return true; // async response
    }

    default:
      return false;
  }
});

console.debug('[WebProwler] Content script loaded');
