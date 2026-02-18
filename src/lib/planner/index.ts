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
 */

import type { LLMMessage, Plan, PlannedStep, PageSnapshot, StepResult, Action } from '../../types';
import type { LLMProvider } from '../llm/provider';
import { SYSTEM_PROMPT, buildUserMessage, buildVerificationMessage } from '../llm/prompts';

export interface PlannerCallbacks {
  /** Get a snapshot of the current page */
  getSnapshot(): Promise<PageSnapshot>;
  /** Execute an action on the page */
  executeAction(action: Action): Promise<StepResult>;
  /** Called when the planner produces a new plan */
  onPlan(plan: Plan): void;
  /** Called when a step starts executing */
  onStepStart(step: PlannedStep, index: number): void;
  /** Called when a step completes */
  onStepComplete(step: PlannedStep, result: StepResult): void;
  /** Called when the task is complete */
  onComplete(reasoning: string): void;
  /** Called on error */
  onError(error: string): void;
  /** Called with token usage info */
  onUsage(inputTokens: number, outputTokens: number): void;
}

const MAX_ITERATIONS = 15;

function parsePlan(raw: string): Plan {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(cleaned);

  if (!parsed.reasoning || !Array.isArray(parsed.steps)) {
    throw new Error('Invalid plan format: missing "reasoning" or "steps"');
  }

  return parsed as Plan;
}

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

/** Classify whether an action inherently requires verification */
function actionNeedsVerification(action: Action): boolean {
  switch (action.kind) {
    case 'click': return true;   // Clicks can trigger navigation, modals, state changes
    case 'navigate': return true;
    case 'scroll': return true;  // New content may load
    case 'type': return false;   // Typing is generally safe to chain
    case 'select': return false;
    case 'read': return false;
    case 'wait': return false;
  }
}

export async function runPlanner(
  task: string,
  llm: LLMProvider,
  callbacks: PlannerCallbacks,
): Promise<void> {
  const conversationHistory: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  let totalInput = 0;
  let totalOutput = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // 1. Get current page state
    const snapshot = await callbacks.getSnapshot();
    const snapshotText = `URL: ${snapshot.url}\nTitle: ${snapshot.title}\nInteractive elements: ${snapshot.interactiveCount}\n\n${snapshot.tree}`;

    // 2. Build message
    if (iteration === 0) {
      conversationHistory.push({
        role: 'user',
        content: buildUserMessage(task, snapshotText),
      });
    }
    // For subsequent iterations, the verification message was already added

    // 3. Ask LLM for a plan
    let plan: Plan;
    try {
      const response = await llm.chat(conversationHistory);

      if (response.usage) {
        totalInput += response.usage.inputTokens;
        totalOutput += response.usage.outputTokens;
        callbacks.onUsage(totalInput, totalOutput);
      }

      conversationHistory.push({ role: 'assistant', content: response.content });

      plan = parsePlan(response.content);
    } catch (error) {
      callbacks.onError(`Failed to get plan from LLM: ${error}`);
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

      // Force verification for inherently risky actions
      const shouldVerify = step.needsVerification || actionNeedsVerification(step.action);

      callbacks.onStepStart(step, i);

      const result = await callbacks.executeAction(step.action);
      callbacks.onStepComplete(step, result);

      if (!result.success) {
        // Step failed — feed error back to LLM and replan
        const errorSnapshot = await callbacks.getSnapshot();
        const errorSnapshotText = `URL: ${errorSnapshot.url}\nTitle: ${errorSnapshot.title}\nInteractive elements: ${errorSnapshot.interactiveCount}\n\n${errorSnapshot.tree}`;

        conversationHistory.push({
          role: 'user',
          content: `## Error\nAction failed: ${result.error}\n\n${buildVerificationMessage(describeAction(step.action), errorSnapshotText)}`,
        });
        needsReplan = true;
        break;
      }

      // Verify if needed (and not the last step — next iteration will snapshot anyway)
      if (shouldVerify && i < plan.steps.length - 1) {
        const verifySnapshot = await callbacks.getSnapshot();
        const verifyText = `URL: ${verifySnapshot.url}\nTitle: ${verifySnapshot.title}\nInteractive elements: ${verifySnapshot.interactiveCount}\n\n${verifySnapshot.tree}`;

        conversationHistory.push({
          role: 'user',
          content: buildVerificationMessage(describeAction(step.action), verifyText),
        });
        needsReplan = true;
        break; // Go back to LLM for updated plan
      }
    }

    // If all steps executed without needing replan, add a verification for the next iteration
    if (!needsReplan) {
      const finalSnapshot = await callbacks.getSnapshot();
      const finalText = `URL: ${finalSnapshot.url}\nTitle: ${finalSnapshot.title}\nInteractive elements: ${finalSnapshot.interactiveCount}\n\n${finalSnapshot.tree}`;

      const lastAction = plan.steps[plan.steps.length - 1];
      conversationHistory.push({
        role: 'user',
        content: buildVerificationMessage(describeAction(lastAction.action), finalText),
      });
    }

    // Trim conversation history to avoid context overflow (keep system + last 10 messages)
    if (conversationHistory.length > 12) {
      const system = conversationHistory[0];
      conversationHistory.splice(1, conversationHistory.length - 11);
      conversationHistory[0] = system;
    }
  }

  callbacks.onError(`Max iterations (${MAX_ITERATIONS}) reached. Task may be incomplete.`);
}
