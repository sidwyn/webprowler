/**
 * Tab manager.
 * Handles content script re-injection after navigation and tab updates.
 * Chrome MV3 content scripts declared in manifest.json auto-inject on new
 * navigations, but only for top-level frames matching the URL pattern.
 * This module handles edge cases:
 *   - Ensuring the content script is ready before we message it
 *   - Re-injecting if the content script doesn't respond (e.g., crashed, CSP)
 *   - Tracking which tabs have the content script active
 */

const CONTENT_SCRIPT_PATH = 'content/index.js';
const INJECT_TIMEOUT_MS = 5000;
const PING_TIMEOUT_MS = 1000;

/**
 * Ping a tab to check if the content script is alive.
 */
async function pingTab(tabId: number): Promise<boolean> {
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'PING' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT_MS)
      ),
    ]);
    return (response as any)?.pong === true;
  } catch {
    return false;
  }
}

/**
 * Inject the content script into a tab.
 */
async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_PATH],
    });
  } catch (error) {
    // Common reasons: chrome:// URLs, devtools, PDFs, extensions page
    throw new Error(`Cannot inject content script: ${error}`);
  }
}

/**
 * Ensure the content script is loaded and responsive on the given tab.
 * Injects it if necessary. Retries once after a delay.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  // First, check if it's already there
  if (await pingTab(tabId)) return;

  // Try injecting
  await injectContentScript(tabId);

  // Give it a moment to initialize
  await new Promise(resolve => setTimeout(resolve, 200));

  // Verify
  if (await pingTab(tabId)) return;

  // One more try after a longer wait (page may still be loading)
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (await pingTab(tabId)) return;

  throw new Error('Content script failed to load. The page may block extensions (e.g., chrome:// pages).');
}

/**
 * Wait for a tab to finish loading (after navigation).
 */
export function waitForTabLoad(tabId: number, timeoutMs: number = INJECT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // Resolve anyway — the tab might be usable even if 'complete' wasn't fired
      resolve();
    }, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small extra delay for JS frameworks to hydrate
        setTimeout(resolve, 300);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Full flow: wait for tab load → ensure content script → ready.
 * Use this after navigation actions.
 */
export async function waitForTabReady(tabId: number): Promise<void> {
  await waitForTabLoad(tabId);
  await ensureContentScript(tabId);
}
