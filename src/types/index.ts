// ─── Page Representation ───

export interface PageNode {
  /** Short stable ref like "e1", "e2" */
  ref: string;
  /** ARIA role or semantic role derived from tag */
  role: string;
  /** Accessible name (label, aria-label, text content, etc.) */
  name: string;
  /** Tag name lowercase */
  tag: string;
  /** Interactive properties (href, value, placeholder, checked, etc.) */
  props: Record<string, string>;
  /** Whether this element is interactive (clickable/typable) */
  interactive: boolean;
  /** Depth in tree for indentation */
  depth: number;
  /** Children nodes */
  children: PageNode[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Compact text representation of the a11y tree */
  tree: string;
  /** Total interactive elements found */
  interactiveCount: number;
  /** Timestamp of snapshot */
  timestamp: number;
}

// ─── Actions ───

export type ActionKind = 'click' | 'type' | 'select' | 'scroll' | 'navigate' | 'read' | 'wait';

export interface BaseAction {
  kind: ActionKind;
}

export interface ClickAction extends BaseAction {
  kind: 'click';
  ref: string;
}

export interface TypeAction extends BaseAction {
  kind: 'type';
  ref: string;
  text: string;
  /** Clear existing value first */
  clear?: boolean;
}

export interface SelectAction extends BaseAction {
  kind: 'select';
  ref: string;
  value: string;
}

export interface ScrollAction extends BaseAction {
  kind: 'scroll';
  direction: 'up' | 'down';
  amount?: number;
}

export interface NavigateAction extends BaseAction {
  kind: 'navigate';
  url: string;
}

export interface ReadAction extends BaseAction {
  kind: 'read';
  /** Optional ref to read a subtree instead of full page */
  ref?: string;
}

export interface WaitAction extends BaseAction {
  kind: 'wait';
  ms: number;
}

export type Action = ClickAction | TypeAction | SelectAction | ScrollAction | NavigateAction | ReadAction | WaitAction;

// ─── Planner ───

export interface PlannedStep {
  action: Action;
  /** What we expect to happen after this action */
  expectation?: string;
  /** Does this action require verification before proceeding? */
  needsVerification: boolean;
}

export interface Plan {
  steps: PlannedStep[];
  reasoning: string;
}

export interface StepResult {
  success: boolean;
  /** New page snapshot after action (if needsVerification) */
  snapshot?: PageSnapshot;
  error?: string;
}

// ─── LLM ───

export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  /** Custom base URL (for Ollama, proxies, etc.) */
  baseUrl?: string;
  maxTokens?: number;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ─── Messages between extension components ───

export type MessageType =
  | 'GET_SNAPSHOT'
  | 'EXECUTE_ACTION'
  | 'SNAPSHOT_RESULT'
  | 'ACTION_RESULT'
  | 'CHAT_MESSAGE'
  | 'PLAN_UPDATE'
  | 'ERROR';

export interface ExtMessage {
  type: MessageType;
  payload: unknown;
}

// ─── Settings ───

export interface Settings {
  llm: LLMConfig;
  /** Max tree depth for a11y parsing */
  maxTreeDepth: number;
  /** Max chars for serialized tree */
  maxTreeChars: number;
  /** Auto-verify after navigation actions */
  alwaysVerifyNavigation: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
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
