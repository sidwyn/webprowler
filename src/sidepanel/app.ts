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

const welcomeCard = $('#welcome') as HTMLDivElement;
const dismissWelcome = $('#dismiss-welcome') as HTMLButtonElement;

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
    { value: 'claude-opus-4-0626', label: 'Claude Opus 4' },
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-haiku-4-20250414', label: 'Claude Haiku 4' },
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
  anthropic: 'claude-sonnet-4-20250514',
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

/** Lightweight markdown: **bold**, `code`, [link](url) */
function renderMarkdownLite(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// ─── Chat UI ───

let thinkingEl: HTMLElement | null = null;

function addTaskDivider() {
  const div = document.createElement('div');
  div.className = 'task-divider';
  div.innerHTML = `<span class="task-time">${fmtTime()}</span>`;
  messagesDiv.appendChild(div);
}

function addMessage(type: string, text: string) {
  removeThinking();

  const div = document.createElement('div');
  div.className = `message ${type}`;

  if (type === 'step' || type === 'step failed') {
    const icon = type === 'step failed' ? '✗' : '✓';
    div.innerHTML = `<span class="step-icon">${icon}</span><p>${esc(text)}</p>`;
  } else {
    div.innerHTML = `<p>${renderMarkdownLite(text)}</p>`;
  }

  messagesDiv.appendChild(div);
  scrollToBottom();
}

function addPlanGroup(reasoning: string, steps: Array<{ description: string; needsVerification: boolean }>) {
  removeThinking();

  const group = document.createElement('div');
  group.className = 'plan-group';

  let collapsed = false;
  const stepsId = `steps-${Date.now()}`;

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

  // Toggle collapse
  const toggleBtn = group.querySelector('.plan-toggle') as HTMLButtonElement;
  const stepsDiv = group.querySelector(`#${stepsId}`) as HTMLDivElement;
  toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    stepsDiv.classList.toggle('collapsed', collapsed);
    toggleBtn.textContent = collapsed ? `${steps.length} steps ▸` : `${steps.length} steps ▾`;
  });

  messagesDiv.appendChild(group);
  scrollToBottom();
}

function showThinking() {
  removeThinking();
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.innerHTML = `
    <span class="thinking-dot"></span>
    <span class="thinking-dot"></span>
    <span class="thinking-dot"></span>
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
  sendBtn.classList.toggle('hidden', running);
  stopBtn.classList.toggle('hidden', !running);
  taskInput.disabled = running;
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
  }
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_TASK' });
});

function sendTask() {
  const task = taskInput.value.trim();
  if (!task) return;

  // Remove welcome card on first task
  welcomeCard?.remove();
  chrome.storage.local.set({ welcomeDismissed: true });

  addTaskDivider();
  addMessage('user', task);
  taskInput.value = '';
  taskInput.style.height = 'auto';
  userScrolledUp = false; // Reset scroll lock for new task
  setRunning(true);
  setStatus('Starting…');
  showThinking();

  chrome.runtime.sendMessage({ type: 'RUN_TASK', payload: { task } });
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
      break;

    case 'TASK_STOPPED':
      addMessage('system', 'Task stopped.');
      setRunning(false);
      break;

    case 'REPLAY_STARTED':
      setStatus(`Replaying: ${payload.task}`);
      break;

    case 'REPLAY_COMPLETE':
      addMessage('assistant', `Replay complete: **${payload.task}**`);
      setRunning(false);
      break;

    case 'RECORDING_SAVED':
      addMessage('system', `📹 Recorded ${payload.stepCount} steps`);
      break;

    case 'ERROR':
      addMessage('error', payload.message);
      setRunning(false);
      break;

    case 'USAGE_UPDATE':
      tokenCount.textContent = `${payload.inputTokens.toLocaleString()} in / ${payload.outputTokens.toLocaleString()} out`;
      break;
  }
});
