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
      maxTreeDepth: 12,
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
  const response = await chrome.tabs.sendMessage(tabId, { type, payload });
  if (response?.success === false) {
    throw new Error(response.error || 'Content script error');
  }
  return response?.data ?? response;
}

async function getSnapshot(tabId: number): Promise<PageSnapshot> {
  return sendToTab<PageSnapshot>(tabId, 'GET_SNAPSHOT', {
    filter: 'all',
    maxDepth: currentSettings?.maxTreeDepth ?? 12,
    maxChars: currentSettings?.maxTreeChars ?? 30000,
    viewportOnly: true,
  });
}

async function executeActionOnTab(tabId: number, action: Action): Promise<any> {
  return sendToTab(tabId, 'EXECUTE_ACTION', action);
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

// ─── Open side panel on icon click ───

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

console.debug('[WebProwler] Service worker loaded');
