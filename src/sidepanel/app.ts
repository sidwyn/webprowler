/**
 * Side panel app.
 * Handles chat UI, settings, recordings, and smart auto-scroll.
 */

// ─── DOM refs ───

const $ = (sel: string) => document.querySelector(sel)!;

const settingsBtn = $('#settings-btn') as HTMLButtonElement;
const settingsPanel = $('#settings-panel') as HTMLDivElement;
const providerSelect = $('#llm-provider') as HTMLSelectElement;
const apiKeyInput = $('#api-key') as HTMLInputElement;
const apiKeyLink = $('#api-key-link') as HTMLAnchorElement;
const modelSelect = $('#model-name') as HTMLSelectElement;
const baseUrlInput = $('#base-url') as HTMLInputElement;
const baseUrlField = $('#base-url-field') as HTMLElement;
const saveSettingsBtn = $('#save-settings') as HTMLButtonElement;
const providerBadge = $('#provider-badge') as HTMLSpanElement;

const chatDiv = $('#chat') as HTMLDivElement;
const messagesDiv = $('#messages') as HTMLDivElement;
const statusBar = $('#status-bar') as HTMLDivElement;
const statusText = $('#status-text') as HTMLSpanElement;
const tokenCount = $('#token-count') as HTMLSpanElement;

const taskInput = $('#task-input') as HTMLTextAreaElement;
const sendBtn = $('#send-btn') as HTMLButtonElement;
const stopBtn = $('#stop-btn') as HTMLButtonElement;

const recordingsBtn = $('#recordings-btn') as HTMLButtonElement;
const recordingsPanel = $('#recordings-panel') as HTMLDivElement;
const recordingsList = $('#recordings-list') as HTMLDivElement;

const tabTitleEl = $('#tab-title') as HTMLSpanElement;
const tabFaviconEl = $('#tab-favicon') as HTMLImageElement;

const welcomeCard = $('#welcome') as HTMLDivElement;
const dismissWelcome = $('#dismiss-welcome') as HTMLButtonElement;

// ─── Message History ───

type HistoryItem =
  | { kind: 'divider'; time: string; tabTitle?: string; timestamp: number }
  | { kind: 'message'; type: string; text: string; timestamp: number }
  | { kind: 'plan'; reasoning: string; steps: Array<{ description: string; needsVerification: boolean }>; timestamp: number };

const HISTORY_MAX_ITEMS = 400;
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let chatHistory: HistoryItem[] = [];
let isRestoringHistory = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function schedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    const trimmed = chatHistory.filter(h => h.timestamp > cutoff).slice(-HISTORY_MAX_ITEMS);
    chrome.storage.local.set({ chatHistory: trimmed });
  }, 500);
}

async function restoreHistory() {
  const data = await chrome.storage.local.get('chatHistory');
  const items: HistoryItem[] = data.chatHistory ?? [];
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const fresh = items.filter(h => h.timestamp > cutoff);
  if (fresh.length === 0) return;

  chatHistory = fresh;
  isRestoringHistory = true;
  welcomeCard?.remove();
  for (const item of fresh) {
    if (item.kind === 'divider') renderTaskDivider(item.time, item.tabTitle);
    else if (item.kind === 'message') renderMessage(item.type, item.text);
    else if (item.kind === 'plan') renderPlanGroup(item.reasoning, item.steps);
  }
  isRestoringHistory = false;
  scrollToBottom();
}

// ─── Task queue (for chaining) ───

let isRunning = false;
const taskQueue: string[] = [];

// ─── Auto-scroll logic ───

let userScrolledUp = false;

chatDiv.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = chatDiv;
  // If user scrolled more than 60px from bottom, they're reading history
  userScrolledUp = scrollHeight - scrollTop - clientHeight > 60;
});

function scrollToBottom() {
  if (!userScrolledUp) {
    chatDiv.scrollTop = chatDiv.scrollHeight;
  }
}

// ─── Auto-resize textarea ───

taskInput.addEventListener('input', () => {
  taskInput.style.height = 'auto';
  taskInput.style.height = Math.min(taskInput.scrollHeight, 120) + 'px';
});

// ─── Input history (terminal-style ↑/↓) ───

const inputHistory: string[] = [];
let historyIndex = -1;   // -1 = looking at the live draft
let historyDraft = '';   // saved draft while browsing history

function isOnFirstLine(): boolean {
  return !taskInput.value.slice(0, taskInput.selectionStart).includes('\n');
}

function isOnLastLine(): boolean {
  return !taskInput.value.slice(taskInput.selectionStart).includes('\n');
}

function applyHistoryValue(val: string) {
  taskInput.value = val;
  taskInput.style.height = 'auto';
  taskInput.style.height = Math.min(taskInput.scrollHeight, 120) + 'px';
  // Place cursor at end, like a real terminal
  requestAnimationFrame(() => {
    taskInput.selectionStart = taskInput.selectionEnd = taskInput.value.length;
  });
}

// ─── Welcome card ───

dismissWelcome.addEventListener('click', () => {
  welcomeCard.remove();
  chrome.storage.local.set({ welcomeDismissed: true });
});

async function checkWelcome() {
  const data = await chrome.storage.local.get('welcomeDismissed');
  if (data.welcomeDismissed) {
    welcomeCard?.remove();
  }
}
checkWelcome();
restoreHistory();

// ─── Active tab display ───

async function updateTabBar() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const title = tab.title || tab.url || 'Unknown tab';
    tabTitleEl.textContent = title.length > 60 ? title.slice(0, 57) + '…' : title;

    if (tab.favIconUrl) {
      tabFaviconEl.src = tab.favIconUrl;
      tabFaviconEl.classList.remove('hidden');
    } else {
      tabFaviconEl.classList.add('hidden');
    }
  } catch {
    // Side panel may open before a tab is active
  }
}

updateTabBar();

chrome.tabs.onActivated.addListener(() => updateTabBar());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.title || changeInfo.favIconUrl || changeInfo.status === 'complete') {
    updateTabBar();
  }
});

// ─── Settings UI ───

function togglePanel(panel: HTMLElement, btn: HTMLElement) {
  const isOpen = !panel.classList.contains('hidden');
  // Close all panels
  settingsPanel.classList.add('hidden');
  recordingsPanel.classList.add('hidden');
  settingsBtn.classList.remove('active');
  recordingsBtn.classList.remove('active');
  // Toggle this one
  if (!isOpen) {
    panel.classList.remove('hidden');
    btn.classList.add('active');
  }
}

settingsBtn.addEventListener('click', () => togglePanel(settingsPanel, settingsBtn));
recordingsBtn.addEventListener('click', () => {
  togglePanel(recordingsPanel, recordingsBtn);
  if (!recordingsPanel.classList.contains('hidden')) loadRecordings();
});

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
  custom: 'Custom',
};

const PROVIDER_MODELS: Record<string, Array<{ value: string; label: string }>> = {
  anthropic: [
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
  ],
  gemini: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  ],
  ollama: [
    { value: 'llama3.3', label: 'Llama 3.3' },
    { value: 'qwen2.5', label: 'Qwen 2.5' },
    { value: 'mistral', label: 'Mistral' },
  ],
  custom: [],
};

const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
  ollama: 'llama3.3',
  custom: '',
};

function populateModels(provider: string, selectedModel?: string) {
  const models = PROVIDER_MODELS[provider] ?? [];
  modelSelect.innerHTML = '';

  if (provider === 'custom' || provider === 'ollama') {
    // For custom/ollama, also allow free-text via a "custom" option
    // But we still show known models for ollama
  }

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }

  // Add a "Custom…" option for typing a model name
  if (models.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '───────────';
    modelSelect.appendChild(sep);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Custom model…';
  modelSelect.appendChild(customOpt);

  // Select the right model
  if (selectedModel && models.some(m => m.value === selectedModel)) {
    modelSelect.value = selectedModel;
  } else if (selectedModel && selectedModel !== '__custom__') {
    // It's a custom model value — add it as an option
    const opt = document.createElement('option');
    opt.value = selectedModel;
    opt.textContent = selectedModel;
    modelSelect.insertBefore(opt, modelSelect.firstChild);
    modelSelect.value = selectedModel;
  } else {
    modelSelect.value = DEFAULT_MODELS[provider] ?? '';
  }
}

function updateKeyLink(provider: string) {
  const url = PROVIDER_KEY_URLS[provider];
  if (url) {
    apiKeyLink.href = url;
    apiKeyLink.classList.remove('hidden');
  } else {
    apiKeyLink.classList.add('hidden');
  }
}

// Handle "Custom model…" selection — prompt for model name
modelSelect.addEventListener('change', () => {
  if (modelSelect.value === '__custom__') {
    const name = prompt('Enter model name:');
    if (name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      modelSelect.insertBefore(opt, modelSelect.firstChild);
      modelSelect.value = name;
    } else {
      // Revert to first option
      modelSelect.selectedIndex = 0;
    }
  }
});

// Open key URL in a new tab when link is clicked
apiKeyLink.addEventListener('click', (e) => {
  e.preventDefault();
  const url = apiKeyLink.href;
  if (url && url !== '#') {
    chrome.tabs.create({ url });
  }
});

providerSelect.addEventListener('change', () => {
  const val = providerSelect.value;
  baseUrlField.classList.toggle('hidden', !['ollama', 'custom'].includes(val));
  populateModels(val);
  updateKeyLink(val);
});

function updateProviderBadge(provider?: string) {
  if (provider && PROVIDER_LABELS[provider]) {
    providerBadge.textContent = PROVIDER_LABELS[provider];
    providerBadge.classList.remove('hidden');
  } else {
    providerBadge.classList.add('hidden');
  }
}

saveSettingsBtn.addEventListener('click', async () => {
  const settings = {
    llm: {
      provider: providerSelect.value,
      apiKey: apiKeyInput.value,
      model: modelSelect.value === '__custom__' ? '' : modelSelect.value || DEFAULT_MODELS[providerSelect.value] || '',
      baseUrl: baseUrlInput.value || undefined,
      maxTokens: 4096,
    },
    maxTreeDepth: 12,
    maxTreeChars: 30000,
    alwaysVerifyNavigation: true,
  };

  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: settings });
  settingsPanel.classList.add('hidden');
  settingsBtn.classList.remove('active');
  updateProviderBadge(settings.llm.provider);
  addMessage('system', 'Settings saved ✓');
});

async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (settings?.llm) {
    providerSelect.value = settings.llm.provider;
    apiKeyInput.value = settings.llm.apiKey || '';
    baseUrlInput.value = settings.llm.baseUrl || '';
    baseUrlField.classList.toggle('hidden', !['ollama', 'custom'].includes(settings.llm.provider));
    populateModels(settings.llm.provider, settings.llm.model);
    updateKeyLink(settings.llm.provider);
    updateProviderBadge(settings.llm.apiKey ? settings.llm.provider : undefined);
  }
}
loadSettings();

// ─── Recordings UI ───

async function loadRecordings() {
  const recordings = await chrome.runtime.sendMessage({ type: 'LIST_RECORDINGS' });
  recordingsList.innerHTML = '';

  if (!recordings || recordings.length === 0) {
    recordingsList.innerHTML = '<p class="empty-state">No recordings yet. Complete a task to create one.</p>';
    return;
  }

  for (const rec of recordings) {
    const successSteps = rec.steps.filter((s: any) => s.success).length;
    const date = new Date(rec.createdAt);
    const timeStr = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const div = document.createElement('div');
    div.className = 'recording-item';
    div.innerHTML = `
      <div class="recording-info">
        <span class="recording-task">${esc(rec.task.slice(0, 60))}${rec.task.length > 60 ? '…' : ''}</span>
        <span class="recording-meta">${timeStr} · ${successSteps} steps · ${fmtDuration(rec.duration)}</span>
      </div>
      <div class="recording-actions">
        <button class="btn-sm btn-replay" data-id="${rec.id}" title="Replay">▶️</button>
        <button class="btn-sm btn-delete" data-id="${rec.id}" title="Delete">🗑️</button>
      </div>
    `;
    recordingsList.appendChild(div);
  }

  recordingsList.querySelectorAll('.btn-replay').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      chrome.runtime.sendMessage({ type: 'REPLAY_RECORDING', payload: { id } });
      recordingsPanel.classList.add('hidden');
      recordingsBtn.classList.remove('active');
      addMessage('system', '🔄 Replaying recorded task…');
      setRunning(true);
      setStatus('Replaying…');
    });
  });

  recordingsList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.id!;
      await chrome.runtime.sendMessage({ type: 'DELETE_RECORDING', payload: { id } });
      loadRecordings();
    });
  });
}

// ─── Helpers ───

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function fmtTime(): string {
  return new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Inline markdown: **bold**, `code`, [link](url) */
function renderInline(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/** Block markdown: numbered lists, bullets, paragraphs, inline formatting */
function renderMarkdownLite(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let listType: 'ol' | 'ul' | null = null;

  const closeList = () => {
    if (listType) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); listType = null; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const olMatch = line.match(/^(\d+)[.)]\s+(.+)/);
    const ulMatch = line.match(/^[-*]\s+(.+)/);

    if (olMatch) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${renderInline(olMatch[2])}</li>`);
    } else if (ulMatch) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${renderInline(ulMatch[1])}</li>`);
    } else {
      closeList();
      if (line === '') {
        out.push('<div class="md-gap"></div>');
      } else {
        out.push(`<p>${renderInline(line)}</p>`);
      }
    }
  }
  closeList();
  return out.join('');
}

// ─── Chat UI ───

let thinkingEl: HTMLElement | null = null;

function renderTaskDivider(time: string, tabTitle?: string) {
  const div = document.createElement('div');
  div.className = 'task-divider';
  let inner = `<span class="task-time">${esc(time)}</span>`;
  if (tabTitle) {
    const short = tabTitle.length > 40 ? tabTitle.slice(0, 37) + '…' : tabTitle;
    inner += `<span class="task-tab">${esc(short)}</span>`;
  }
  div.innerHTML = inner;
  messagesDiv.appendChild(div);
}

function addTaskDivider(tabTitle?: string) {
  const time = fmtTime();
  renderTaskDivider(time, tabTitle);
  if (!isRestoringHistory) {
    chatHistory.push({ kind: 'divider', time, tabTitle, timestamp: Date.now() });
    schedSave();
  }
}

function renderMessage(type: string, text: string) {
  const div = document.createElement('div');
  div.className = `message ${type}`;

  if (type === 'step' || type === 'step failed') {
    const icon = type === 'step failed' ? '✗' : '✓';
    div.innerHTML = `<span class="step-icon">${icon}</span><p>${esc(text)}</p>`;
  } else {
    div.innerHTML = `<p>${renderMarkdownLite(text)}</p>`;
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.title = 'Copy';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      copyBtn.style.color = '#4ade80';
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        copyBtn.style.color = '';
      }, 1200);
    });
  });
  div.appendChild(copyBtn);
  messagesDiv.appendChild(div);
}

function addMessage(type: string, text: string) {
  removeThinking();
  renderMessage(type, text);
  if (!isRestoringHistory) {
    chatHistory.push({ kind: 'message', type, text, timestamp: Date.now() });
    schedSave();
  }
  scrollToBottom();
}

function renderPlanGroup(reasoning: string, steps: Array<{ description: string; needsVerification: boolean }>) {
  const group = document.createElement('div');
  group.className = 'plan-group';

  let collapsed = false;
  const stepsId = `steps-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  group.innerHTML = `
    <div class="plan-header">
      <span class="plan-reasoning">${renderMarkdownLite(reasoning)}</span>
      <button class="plan-toggle" data-target="${stepsId}">${steps.length} steps ▾</button>
    </div>
    <div class="plan-steps" id="${stepsId}">
      ${steps.map(s => `
        <div class="plan-step">
          <span class="step-bullet"></span>
          <span>${esc(s.description)}</span>
          ${s.needsVerification ? '<span class="verify-tag">verify</span>' : ''}
        </div>
      `).join('')}
    </div>
  `;

  const toggleBtn = group.querySelector('.plan-toggle') as HTMLButtonElement;
  const stepsDiv = group.querySelector(`#${stepsId}`) as HTMLDivElement;
  toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    stepsDiv.classList.toggle('collapsed', collapsed);
    toggleBtn.textContent = collapsed ? `${steps.length} steps ▸` : `${steps.length} steps ▾`;
  });

  messagesDiv.appendChild(group);
}

function addPlanGroup(reasoning: string, steps: Array<{ description: string; needsVerification: boolean }>) {
  removeThinking();
  renderPlanGroup(reasoning, steps);
  if (!isRestoringHistory) {
    chatHistory.push({ kind: 'plan', reasoning, steps, timestamp: Date.now() });
    schedSave();
  }
  scrollToBottom();
}

const THINKING_LABELS = [
  'Thinking…', 'Brewing…', 'Plotting…', 'Scheming…', 'Pondering…',
  'Crunching…', 'Sniffing around…', 'Digging in…', 'On the case…',
  'One sec…', 'Connecting dots…', 'Reading the room…', 'Cooking…',
];
let thinkingLabelIdx = 0;

function showThinking() {
  removeThinking();
  const label = THINKING_LABELS[thinkingLabelIdx % THINKING_LABELS.length];
  thinkingLabelIdx++;

  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.innerHTML = `
    <span class="thinking-dot"></span>
    <span class="thinking-dot"></span>
    <span class="thinking-dot"></span>
    <span class="thinking-label">${esc(label)}</span>
  `;
  messagesDiv.appendChild(thinkingEl);
  scrollToBottom();
}

function removeThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function setRunning(running: boolean) {
  isRunning = running;
  // Input stays enabled so users can queue the next message while running
  taskInput.placeholder = running ? 'Queue next task…' : 'What should I do on this page?';
  sendBtn.classList.toggle('hidden', running);
  stopBtn.classList.toggle('hidden', !running);
  statusBar.classList.toggle('hidden', !running);
}

function setStatus(text: string) {
  statusText.innerHTML = `<span class="spinner"></span>${esc(text)}`;
}

// ─── Task execution ───

sendBtn.addEventListener('click', () => sendTask());

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTask();
    return;
  }

  if (e.key === 'ArrowUp' && isOnFirstLine()) {
    if (inputHistory.length === 0) return;
    e.preventDefault();
    if (historyIndex === -1) {
      // Save the current draft before navigating away
      historyDraft = taskInput.value;
      historyIndex = inputHistory.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    }
    applyHistoryValue(inputHistory[historyIndex]);
    return;
  }

  if (e.key === 'ArrowDown' && isOnLastLine()) {
    if (historyIndex === -1) return; // Nothing to go forward to
    e.preventDefault();
    if (historyIndex < inputHistory.length - 1) {
      historyIndex++;
      applyHistoryValue(inputHistory[historyIndex]);
    } else {
      // Reached the end — restore draft
      historyIndex = -1;
      applyHistoryValue(historyDraft);
      historyDraft = '';
    }
    return;
  }
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_TASK' });
});

async function startTask(task: string) {
  welcomeCard?.remove();
  chrome.storage.local.set({ welcomeDismissed: true });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  addTaskDivider(tab?.title);
  addMessage('user', task);
  userScrolledUp = false;
  setRunning(true);
  setStatus('Starting…');
  showThinking();

  chrome.runtime.sendMessage({ type: 'RUN_TASK', payload: { task } });
}

async function sendTask() {
  const task = taskInput.value.trim();
  if (!task) return;

  // Push to input history (↑/↓ navigation)
  if (inputHistory[inputHistory.length - 1] !== task) {
    inputHistory.push(task);
  }
  historyIndex = -1;
  historyDraft = '';

  taskInput.value = '';
  taskInput.style.height = 'auto';

  if (isRunning) {
    // Queue it — show confirmation in chat
    taskQueue.push(task);
    addMessage('system', `⏳ Queued: "${task.length > 60 ? task.slice(0, 57) + '…' : task}"`);
    return;
  }

  await startTask(task);
}

// ─── Listen for updates from service worker ───

chrome.runtime.onMessage.addListener((message) => {
  const { type, payload } = message;

  switch (type) {
    case 'TASK_STARTED':
      setStatus('Reading page…');
      break;

    case 'PLAN_UPDATE':
      addPlanGroup(payload.reasoning, payload.steps);
      setStatus('Executing…');
      break;

    case 'STEP_START':
      setStatus(`Step ${payload.index + 1}: ${payload.description}`);
      showThinking();
      break;

    case 'STEP_COMPLETE':
      if (payload.success) {
        addMessage('step', payload.description);
      } else {
        addMessage('step failed', `${payload.description}: ${payload.error}`);
      }
      break;

    case 'TASK_COMPLETE':
      addMessage('assistant', payload.reasoning);
      setRunning(false);
      if (taskQueue.length > 0) {
        const next = taskQueue.shift()!;
        setTimeout(() => startTask(next), 300);
      }
      break;

    case 'TASK_STOPPED':
      addMessage('system', 'Task stopped.');
      taskQueue.length = 0; // Clear queue on manual stop
      setRunning(false);
      break;

    case 'REPLAY_STARTED':
      setStatus(`Replaying: ${payload.task}`);
      break;

    case 'REPLAY_COMPLETE':
      addMessage('assistant', `Replay complete: **${payload.task}**`);
      setRunning(false);
      if (taskQueue.length > 0) {
        const next = taskQueue.shift()!;
        setTimeout(() => startTask(next), 300);
      }
      break;

    case 'RECORDING_SAVED':
      // Recording saved silently — recordings UI is hidden
      break;

    case 'ERROR':
      addMessage('error', payload.message);
      taskQueue.length = 0; // Clear queue on error
      setRunning(false);
      break;

    case 'USAGE_UPDATE':
      tokenCount.textContent = `${payload.inputTokens.toLocaleString()} in / ${payload.outputTokens.toLocaleString()} out`;
      break;
  }
});
