/**
 * Task recorder + replay.
 *
 * Records the sequence of actions executed during a task run,
 * saves them to chrome.storage, and can replay them without LLM calls.
 */

import type { Action, StepResult } from '../../types';

export interface RecordedStep {
  action: Action;
  /** URL at time of execution */
  url: string;
  /** Timestamp */
  timestamp: number;
  /** Whether the step succeeded */
  success: boolean;
  error?: string;
}

export interface Recording {
  id: string;
  /** Original user task description */
  task: string;
  /** Starting URL */
  startUrl: string;
  steps: RecordedStep[];
  createdAt: number;
  /** Total duration in ms */
  duration: number;
}

// ─── Active recording state ───

let activeRecording: Recording | null = null;

export function startRecording(task: string, startUrl: string): void {
  activeRecording = {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    task,
    startUrl,
    steps: [],
    createdAt: Date.now(),
    duration: 0,
  };
}

export function recordStep(action: Action, url: string, result: StepResult): void {
  if (!activeRecording) return;

  activeRecording.steps.push({
    action,
    url,
    timestamp: Date.now(),
    success: result.success,
    error: result.error,
  });
}

export async function stopRecording(): Promise<Recording | null> {
  if (!activeRecording) return null;

  const recording = activeRecording;
  recording.duration = Date.now() - recording.createdAt;
  activeRecording = null;

  // Only save if there were successful steps
  if (recording.steps.some(s => s.success)) {
    await saveRecording(recording);
  }

  return recording;
}

export function isRecording(): boolean {
  return activeRecording !== null;
}

// ─── Storage ───

const STORAGE_KEY = 'recordings';
const MAX_RECORDINGS = 50;

async function getRecordings(): Promise<Recording[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] ?? [];
}

async function saveRecording(recording: Recording): Promise<void> {
  const recordings = await getRecordings();
  recordings.unshift(recording);

  // Keep only the most recent
  if (recordings.length > MAX_RECORDINGS) {
    recordings.splice(MAX_RECORDINGS);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: recordings });
}

export async function listRecordings(): Promise<Recording[]> {
  return getRecordings();
}

export async function getRecordingById(id: string): Promise<Recording | null> {
  const recordings = await getRecordings();
  return recordings.find(r => r.id === id) ?? null;
}

export async function deleteRecording(id: string): Promise<void> {
  const recordings = await getRecordings();
  const filtered = recordings.filter(r => r.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
}

export async function clearRecordings(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}

// ─── Replay ───

export interface ReplayCallbacks {
  executeAction(action: Action): Promise<StepResult>;
  onStepStart(step: RecordedStep, index: number): void;
  onStepComplete(step: RecordedStep, result: StepResult): void;
  onComplete(recording: Recording): void;
  onError(error: string, step: RecordedStep, index: number): void;
}

export async function replayRecording(
  recording: Recording,
  callbacks: ReplayCallbacks,
): Promise<void> {
  const successfulSteps = recording.steps.filter(s => s.success);

  for (let i = 0; i < successfulSteps.length; i++) {
    const step = successfulSteps[i];
    callbacks.onStepStart(step, i);

    // Delay between steps to let DOM settle and make it visible to user
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const result = await callbacks.executeAction(step.action);
    callbacks.onStepComplete(step, result);

    if (!result.success) {
      callbacks.onError(
        `Replay failed at step ${i + 1}: ${result.error ?? 'Unknown error'}`,
        step,
        i,
      );
      return;
    }

    // Wait for page to settle after action
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  callbacks.onComplete(recording);
}
