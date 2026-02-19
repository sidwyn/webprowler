/**
 * Micro-batch planner with checkpoints.
 *
 * Flow:
 * 1. Get page snapshot
 * 2. Send snapshot + user task to LLM → get 1-3 planned steps
 * 3. Execute steps one by one:
 *    - If step needs verification: re-snapshot and feed back to LLM
 *    - If step doesn't need verification: execute and continue
 *    - If step fails: stop, re-snapshot, ask LLM to replan
 * 4. Repeat until LLM returns empty steps (task complete) or max iterations
 *
 * Resilience:
 * - Retries malformed JSON up to 2 times with corrective prompts
 * - Retries API errors (429, 500+) with exponential backoff
 * - Smart context trimming preserves original task + recent state
 */

import type { LLMMessage, Plan, PlannedStep, PageSnapshot, StepResult, Action } from '../../types';
import type { LLMProvider } from '../llm/provider';
import { SYSTEM_PROMPT, buildUserMessage, buildVerificationMessage } from '../llm/prompts';

export interface PlannerCallbacks {
  getSnapshot(): Promise<PageSnapshot>;
  executeAction(action: Action): Promise<StepResult>;
  onPlan(plan: Plan): void;
  onStepStart(step: PlannedStep, index: number): void;
  onStepComplete(step: PlannedStep, result: StepResult): void;
  onComplete(reasoning: string): void;
  onError(error: string): void;
  onUsage(inputTokens: number, outputTokens: number): void;
  onRateLimit(waitMs: number, attempt: number): void;
}

const MAX_ITERATIONS = 15;
const MAX_JSON_RETRIES = 2;
const MAX_API_RETRIES = 5; // increased — rate limits need more patience

// ─── JSON parsing with recovery ───

function parsePlan(raw: string): Plan {
  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  // Try to extract JSON from mixed content (LLM sometimes adds text around it)
  if (!cleaned.startsWith('{')) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Try fixing common issues: trailing commas, single quotes
    cleaned = cleaned
      .replace(/,\s*([}\]])/g, '$1')  // trailing commas
      .replace(/'/g, '"');             // single quotes
    parsed = JSON.parse(cleaned); // let it throw if still broken
  }

  if (!parsed.reasoning || typeof parsed.reasoning !== 'string') {
    throw new Error('Missing "reasoning" string in plan');
  }

  if (!Array.isArray(parsed.steps)) {
    throw new Error('Missing "steps" array in plan');
  }

  // Validate each step has a valid action
  for (const step of parsed.steps) {
    if (!step.action?.kind) {
      throw new Error(`Invalid step: missing action.kind`);
    }
    const validKinds = ['click', 'type', 'select', 'scroll', 'navigate', 'read', 'wait'];
    if (!validKinds.includes(step.action.kind)) {
      throw new Error(`Invalid action kind: ${step.action.kind}`);
    }
    // Default needsVerification
    if (typeof step.needsVerification !== 'boolean') {
      step.needsVerification = actionNeedsVerification(step.action);
    }
  }

  return parsed as Plan;
}

// ─── API call with retries ───

function classifyError(msg: string): 'tpm' | 'rpm' | 'server' | 'fatal' {
  if (msg.includes('429') || msg.includes('rate')) {
    // Token-per-minute limits reset on a ~60s window — need longer waits
    if (msg.includes('tokens per minute') || msg.includes('input tokens per minute') ||
        msg.includes('output tokens per minute')) return 'tpm';
    return 'rpm';
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') ||
      msg.includes('529') || msg.includes('overloaded')) return 'server';
  return 'fatal';
}

function backoffMs(kind: 'tpm' | 'rpm' | 'server', attempt: number): number {
  switch (kind) {
    case 'tpm':    // TPM resets every minute — start at 15s, cap at 65s
      return Math.min(15_000 * Math.pow(1.5, attempt), 65_000);
    case 'rpm':    // RPM — start at 5s, cap at 60s
      return Math.min(5_000 * Math.pow(2, attempt), 60_000);
    case 'server': // Transient server errors — start at 2s
      return Math.min(2_000 * Math.pow(2, attempt), 16_000);
  }
}

async function callLLMWithRetry(
  llm: LLMProvider,
  messages: LLMMessage[],
  onWait: (waitMs: number, attempt: number) => void,
): Promise<{ content: string; usage?: { inputTokens: number; outputTokens: number } }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      return await llm.chat(messages);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const kind = classifyError(lastError.message);

      if (kind === 'fatal' || attempt === MAX_API_RETRIES) throw lastError;

      const waitMs = backoffMs(kind, attempt);
      onWait(waitMs, attempt + 1);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw lastError!;
}

// ─── Get plan with JSON retry ───

async function getPlanFromLLM(
  llm: LLMProvider,
  conversationHistory: LLMMessage[],
  onUsage: (input: number, output: number) => void,
  totalUsage: { input: number; output: number },
  onWait: (waitMs: number, attempt: number) => void,
): Promise<{ plan: Plan; rawResponse: string }> {
  let lastParseError: string | null = null;

  for (let jsonAttempt = 0; jsonAttempt <= MAX_JSON_RETRIES; jsonAttempt++) {
    // If previous attempt had a parse error, add a corrective message
    if (lastParseError && jsonAttempt > 0) {
      conversationHistory.push({
        role: 'user',
        content: `Your previous response was not valid JSON. Error: ${lastParseError}\n\nRespond with ONLY a JSON object like: {"reasoning": "...", "steps": [...]}. No text before or after the JSON.`,
      });
    }

    const response = await callLLMWithRetry(llm, conversationHistory, onWait);

    if (response.usage) {
      totalUsage.input += response.usage.inputTokens;
      totalUsage.output += response.usage.outputTokens;
      onUsage(totalUsage.input, totalUsage.output);
    }

    try {
      const plan = parsePlan(response.content);

      // Success — add the response to history
      // If we had corrective messages, remove them first
      if (jsonAttempt > 0) {
        // Remove the corrective prompt we added
        while (conversationHistory.length > 1 &&
          conversationHistory[conversationHistory.length - 1].role === 'user' &&
          conversationHistory[conversationHistory.length - 1].content.includes('not valid JSON')) {
          conversationHistory.pop();
        }
      }

      conversationHistory.push({ role: 'assistant', content: response.content });
      return { plan, rawResponse: response.content };
    } catch (parseError) {
      lastParseError = parseError instanceof Error ? parseError.message : String(parseError);

      // Add the bad response so the LLM can see what it said
      conversationHistory.push({ role: 'assistant', content: response.content });

      if (jsonAttempt === MAX_JSON_RETRIES) {
        throw new Error(`LLM returned invalid JSON after ${MAX_JSON_RETRIES + 1} attempts. Last error: ${lastParseError}`);
      }
    }
  }

  throw new Error('Unreachable');
}

// ─── Helpers ───

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'click': return `Clicked [${action.ref}]`;
    case 'type': return `Typed "${action.text}" into [${action.ref}]${action.clear ? ' (cleared first)' : ''}`;
    case 'select': return `Selected "${action.value}" in [${action.ref}]`;
    case 'scroll': return `Scrolled ${action.direction}`;
    case 'navigate': return `Navigated to ${action.url}`;
    case 'read': return `Read page`;
    case 'wait': return `Waited ${action.ms}ms`;
  }
}

function actionNeedsVerification(action: Action): boolean {
  switch (action.kind) {
    case 'click': return true;
    case 'navigate': return true;
    case 'scroll': return true;
    case 'type': return false;
    case 'select': return false;
    case 'read': return false;
    case 'wait': return false;
  }
}

function formatSnapshot(snapshot: PageSnapshot): string {
  return `URL: ${snapshot.url}\nTitle: ${snapshot.title}\nInteractive elements: ${snapshot.interactiveCount}\n\n${snapshot.tree}`;
}

/**
 * Smart context trimming.
 * Keeps: system prompt + first user message (original task) + most recent messages.
 * This ensures the LLM always knows what the original task is.
 */
function trimConversation(history: LLMMessage[], maxMessages: number = 14): void {
  if (history.length <= maxMessages) return;

  // history[0] = system, history[1] = first user message (the task)
  // Keep those two + the most recent (maxMessages - 2) messages
  const keepFromEnd = maxMessages - 2;
  const recentStart = history.length - keepFromEnd;

  if (recentStart <= 2) return; // Already short enough

  history.splice(2, recentStart - 2);
}

// ─── Main planner loop ───

export async function runPlanner(
  task: string,
  llm: LLMProvider,
  callbacks: PlannerCallbacks,
): Promise<void> {
  const conversationHistory: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  const totalUsage = { input: 0, output: 0 };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // 1. Get current page state
    let snapshot: PageSnapshot;
    try {
      snapshot = await callbacks.getSnapshot();
    } catch (error) {
      // Content script may not be injected yet (e.g. after navigation)
      // Wait and retry once
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        snapshot = await callbacks.getSnapshot();
      } catch (retryError) {
        callbacks.onError(`Cannot read page: ${retryError}. The content script may not be loaded on this page.`);
        return;
      }
    }

    const snapshotText = formatSnapshot(snapshot);

    // 2. Build message
    if (iteration === 0) {
      conversationHistory.push({
        role: 'user',
        content: buildUserMessage(task, snapshotText),
      });
    }

    // 3. Get plan with JSON retry
    let plan: Plan;
    try {
      const result = await getPlanFromLLM(
        llm,
        conversationHistory,
        callbacks.onUsage,
        totalUsage,
        callbacks.onRateLimit,
      );
      plan = result.plan;
    } catch (error) {
      callbacks.onError(`Failed to get plan: ${error instanceof Error ? error.message : error}`);
      return;
    }

    callbacks.onPlan(plan);

    // 4. Empty steps = task complete
    if (plan.steps.length === 0) {
      callbacks.onComplete(plan.reasoning);
      return;
    }

    // 5. Execute steps with checkpoint logic
    let needsReplan = false;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const shouldVerify = step.needsVerification || actionNeedsVerification(step.action);

      callbacks.onStepStart(step, i);

      const result = await callbacks.executeAction(step.action);
      callbacks.onStepComplete(step, result);

      if (!result.success) {
        // Wait a moment then get fresh snapshot for error recovery
        await new Promise(resolve => setTimeout(resolve, 500));

        let errorSnapshot: PageSnapshot;
        try {
          errorSnapshot = await callbacks.getSnapshot();
        } catch {
          // If snapshot fails after error, provide minimal context
          errorSnapshot = { url: 'unknown', title: 'unknown', tree: '(unable to read page)', interactiveCount: 0, timestamp: Date.now() };
        }

        conversationHistory.push({
          role: 'user',
          content: `## Error\nAction failed: ${result.error}\n\n${buildVerificationMessage(describeAction(step.action), formatSnapshot(errorSnapshot))}`,
        });
        needsReplan = true;
        break;
      }

      // Verify after risky actions (but not if it's the last step — next iteration handles it)
      if (shouldVerify && i < plan.steps.length - 1) {
        // Wait for navigation/DOM to settle
        await new Promise(resolve => setTimeout(resolve, 500));

        let verifySnapshot: PageSnapshot;
        try {
          verifySnapshot = await callbacks.getSnapshot();
        } catch {
          // Snapshot failed — page probably navigated, retry after delay
          await new Promise(resolve => setTimeout(resolve, 1500));
          try {
            verifySnapshot = await callbacks.getSnapshot();
          } catch {
            verifySnapshot = { url: 'unknown', title: 'unknown', tree: '(page is loading or unreachable)', interactiveCount: 0, timestamp: Date.now() };
          }
        }

        conversationHistory.push({
          role: 'user',
          content: buildVerificationMessage(describeAction(step.action), formatSnapshot(verifySnapshot)),
        });
        needsReplan = true;
        break;
      }
    }

    // All steps completed without mid-plan replan — verify final state
    if (!needsReplan) {
      await new Promise(resolve => setTimeout(resolve, 500));

      let finalSnapshot: PageSnapshot;
      try {
        finalSnapshot = await callbacks.getSnapshot();
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1500));
        try {
          finalSnapshot = await callbacks.getSnapshot();
        } catch {
          finalSnapshot = { url: 'unknown', title: 'unknown', tree: '(page is loading or unreachable)', interactiveCount: 0, timestamp: Date.now() };
        }
      }

      const lastAction = plan.steps[plan.steps.length - 1];
      conversationHistory.push({
        role: 'user',
        content: buildVerificationMessage(describeAction(lastAction.action), formatSnapshot(finalSnapshot)),
      });
    }

    // Smart context trimming
    trimConversation(conversationHistory);
  }

  callbacks.onError(`Max iterations (${MAX_ITERATIONS}) reached. Task may be incomplete.`);
}
