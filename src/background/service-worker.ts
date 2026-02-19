/**
 * Service worker — orchestrates everything.
 * Bridges the side panel UI ↔ content scripts ↔ LLM planner.
 */

import type { Action, PageSnapshot, Settings } from '../types';
import { createProvider, type LLMProvider } from '../lib/llm/provider';
import { runPlanner, type PlannerCallbacks } from '../lib/planner';
import {
  startRecording, recordStep, stopRecording,
  listRecordings, getRecordingById, deleteRecording, clearRecordings,
  replayRecording,
  type ReplayCallbacks, type Recording,
} from '../lib/recorder';
import { ensureContentScript, waitForTabReady } from './tab-manager';

// ─── State ───

let currentSettings: Settings | null = null;
let llmProvider: LLMProvider | null = null;
let isRunning = false;
let abortController: AbortController | null = null;

// ─── Settings ───

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  if (stored.settings) {
    currentSettings = stored.settings as Settings;
  } else {
    currentSettings = {
      llm: {
        provider: 'anthropic',
        apiKey: '',
        model: 'claude-sonnet-4-20250514',
        maxTokens: 4096,
      },
      maxTreeDepth: 20,
      maxTreeChars: 30000,
      alwaysVerifyNavigation: true,
    };
  }
  return currentSettings;
}

async function saveSettings(settings: Settings): Promise<void> {
  currentSettings = settings;
  await chrome.storage.local.set({ settings });
  llmProvider = createProvider(settings.llm);
}

// ─── Tab communication ───

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

async function getActiveTabUrl(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? '';
}

async function sendToTab<T>(tabId: number, type: string, payload?: unknown): Promise<T> {
  // Ensure content script is alive before sending
  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, { type, payload });
  if (response?.success === false) {
    throw new Error(response.error || 'Content script error');
  }
  return response?.data ?? response;
}

async function getSnapshot(tabId: number): Promise<PageSnapshot> {
  return sendToTab<PageSnapshot>(tabId, 'GET_SNAPSHOT', {
    filter: 'all',
    maxDepth: currentSettings?.maxTreeDepth ?? 20,
    maxChars: currentSettings?.maxTreeChars ?? 30000,
    viewportOnly: false,
  });
}

async function executeActionOnTab(tabId: number, action: Action): Promise<any> {
  const result = await sendToTab(tabId, 'EXECUTE_ACTION', action);

  // After navigation actions, wait for the new page to be ready
  if (action.kind === 'navigate' || action.kind === 'click') {
    // Give a moment for navigation to start
    await new Promise(resolve => setTimeout(resolve, 400));

    // Check if the tab is doing a full page load
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') {
      await waitForTabReady(tabId);
    } else {
      // SPA / Turbo Drive navigation — tab never enters 'loading'.
      // Wait for the DOM to stop mutating (React/Turbo finished rendering).
      try {
        await sendToTab(tabId, 'WAIT_FOR_DOM_STABLE', { timeout: 5000, stableMs: 500 });
      } catch {
        // Content script disconnected mid-navigation — re-inject and wait a beat
        await new Promise(resolve => setTimeout(resolve, 1200));
        await ensureContentScript(tabId);
      }
    }
  }

  return result;
}

// ─── Side panel communication ───

function broadcastToSidePanel(type: string, payload: unknown) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {
    // Side panel may not be open; that's fine
  });
}

// ─── Main run loop ───

async function runTask(task: string) {
  if (isRunning) {
    broadcastToSidePanel('ERROR', { message: 'Already running a task' });
    return;
  }

  const settings = await loadSettings();
  if (!settings.llm.apiKey) {
    broadcastToSidePanel('ERROR', { message: 'No API key configured. Open settings to add one.' });
    return;
  }

  if (!llmProvider) {
    llmProvider = createProvider(settings.llm);
  }

  isRunning = true;
  abortController = new AbortController();
  broadcastToSidePanel('TASK_STARTED', { task });

  try {
    const tabId = await getActiveTabId();
    const startUrl = await getActiveTabUrl();

    // Start recording
    startRecording(task, startUrl);

    const callbacks: PlannerCallbacks = {
      async getSnapshot() {
        return getSnapshot(tabId);
      },

      async executeAction(action: Action) {
        const result = await executeActionOnTab(tabId, action);
        // Record the step
        const url = await getActiveTabUrl();
        recordStep(action, url, result);
        return result;
      },

      onPlan(plan) {
        broadcastToSidePanel('PLAN_UPDATE', {
          reasoning: plan.reasoning,
          steps: plan.steps.map(s => ({
            description: describeActionBrief(s.action),
            needsVerification: s.needsVerification,
          })),
        });
      },

      onStepStart(step, index) {
        broadcastToSidePanel('STEP_START', {
          index,
          description: describeActionBrief(step.action),
        });
      },

      onStepComplete(step, result) {
        broadcastToSidePanel('STEP_COMPLETE', {
          description: describeActionBrief(step.action),
          success: result.success,
          error: result.error,
        });
      },

      onComplete(reasoning) {
        broadcastToSidePanel('TASK_COMPLETE', { reasoning });
      },

      onError(error) {
        broadcastToSidePanel('ERROR', { message: error });
      },

      onUsage(inputTokens, outputTokens) {
        broadcastToSidePanel('USAGE_UPDATE', { inputTokens, outputTokens });
      },
    };

    await runPlanner(task, llmProvider, callbacks);

    // Stop recording and save
    const recording = await stopRecording();
    if (recording) {
      broadcastToSidePanel('RECORDING_SAVED', {
        id: recording.id,
        task: recording.task,
        stepCount: recording.steps.filter(s => s.success).length,
      });
    }
  } catch (error) {
    await stopRecording();
    broadcastToSidePanel('ERROR', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    isRunning = false;
    abortController = null;
  }
}

// ─── Replay ───

async function runReplay(recordingId: string) {
  if (isRunning) {
    broadcastToSidePanel('ERROR', { message: 'Already running a task' });
    return;
  }

  const recording = await getRecordingById(recordingId);
  if (!recording) {
    broadcastToSidePanel('ERROR', { message: 'Recording not found' });
    return;
  }

  isRunning = true;
  broadcastToSidePanel('REPLAY_STARTED', { task: recording.task, id: recording.id });

  try {
    const tabId = await getActiveTabId();

    const callbacks: ReplayCallbacks = {
      async executeAction(action: Action) {
        return executeActionOnTab(tabId, action);
      },

      onStepStart(step, index) {
        broadcastToSidePanel('STEP_START', {
          index,
          description: describeActionBrief(step.action),
        });
      },

      onStepComplete(step, result) {
        broadcastToSidePanel('STEP_COMPLETE', {
          description: describeActionBrief(step.action),
          success: result.success,
          error: result.error,
        });
      },

      onComplete() {
        broadcastToSidePanel('REPLAY_COMPLETE', { task: recording.task });
      },

      onError(error) {
        broadcastToSidePanel('ERROR', { message: error });
      },
    };

    await replayRecording(recording, callbacks);
  } catch (error) {
    broadcastToSidePanel('ERROR', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    isRunning = false;
  }
}

function describeActionBrief(action: Action): string {
  switch (action.kind) {
    case 'click': return `Click [${action.ref}]`;
    case 'type': return `Type "${action.text.slice(0, 30)}${action.text.length > 30 ? '…' : ''}"`;
    case 'select': return `Select "${action.value}"`;
    case 'scroll': return `Scroll ${action.direction}`;
    case 'navigate': return `Go to ${action.url}`;
    case 'read': return `Read page`;
    case 'wait': return `Wait ${action.ms}ms`;
  }
}

// ─── Message listener ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'RUN_TASK':
      runTask(payload.task);
      sendResponse({ ok: true });
      return false;

    case 'STOP_TASK':
      if (abortController) abortController.abort();
      isRunning = false;
      stopRecording();
      broadcastToSidePanel('TASK_STOPPED', {});
      sendResponse({ ok: true });
      return false;

    case 'GET_SETTINGS':
      loadSettings().then(settings => sendResponse(settings));
      return true;

    case 'SAVE_SETTINGS':
      saveSettings(payload as Settings).then(() => sendResponse({ ok: true }));
      return true;

    case 'GET_STATUS':
      sendResponse({ isRunning });
      return false;

    // ─── Recording endpoints ───

    case 'LIST_RECORDINGS':
      listRecordings().then(recordings => sendResponse(recordings));
      return true;

    case 'DELETE_RECORDING':
      deleteRecording(payload.id).then(() => sendResponse({ ok: true }));
      return true;

    case 'CLEAR_RECORDINGS':
      clearRecordings().then(() => sendResponse({ ok: true }));
      return true;

    case 'REPLAY_RECORDING':
      runReplay(payload.id);
      sendResponse({ ok: true });
      return false;
  }
});

// ─── Per-tab side panel ───
// Panel is tied to the tab it was opened from.
// Switching to a different tab closes it; switching back reopens it.

let panelTabId: number | null = null;

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    panelTabId = tab.id;
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelTabId === null) return;

  if (tabId === panelTabId) {
    // Returning to the panel's tab — reopen it
    try { await chrome.sidePanel.open({ tabId }); } catch { /* requires user gesture in some builds */ }
  } else {
    // Switched away — close the panel
    try {
      await (chrome.sidePanel as any).close({ windowId });
    } catch { /* sidePanel.close not available in this Chrome version */ }
  }
});

console.debug('[WebProwler] Service worker loaded');

// ─── Dev hot-reload (only active when _reload.json exists, i.e. `npm run dev`) ───

let _devReloadToken: number | null = null;

async function checkDevReload() {
  try {
    const res = await fetch(chrome.runtime.getURL('dev-reload.json') + '?t=' + Date.now());
    if (!res.ok) return;
    const { t } = await res.json() as { t: number };
    if (_devReloadToken === null) { _devReloadToken = t; return; } // first check — just store
    if (t !== _devReloadToken) chrome.runtime.reload();
  } catch { /* not in dev mode or file doesn't exist */ }
}

setInterval(checkDevReload, 1000);
