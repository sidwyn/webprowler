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

// ─── DOM stability detection ───

/**
 * Resolves when the DOM has had no mutations for `stableMs` ms,
 * or after `timeoutMs` ms regardless.
 * Used to detect when SPA frameworks (React, Turbo Drive, etc.) finish rendering.
 */
function waitForDOMStable(stableMs: number, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    const done = () => {
      if (stableTimer) clearTimeout(stableTimer);
      observer.disconnect();
      resolve();
    };

    const resetStableTimer = () => {
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(done, stableMs);
    };

    const observer = new MutationObserver(resetStableTimer);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: false,
    });

    // Hard timeout
    setTimeout(done, timeoutMs);
    // Start stability timer immediately (in case DOM is already idle)
    resetStableTimer();
  });
}

// ─── Message handler ───

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'PING': {
      sendResponse({ pong: true });
      return false;
    }

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

    case 'WAIT_FOR_DOM_STABLE': {
      const { timeout = 5000, stableMs = 500 } = (payload ?? {}) as { timeout?: number; stableMs?: number };
      waitForDOMStable(stableMs, timeout).then(() => {
        sendResponse({ success: true });
      });
      return true; // async
    }

    default:
      return false;
  }
});

console.debug('[WebProwler] Content script loaded');
