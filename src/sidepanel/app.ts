/**
 * Side panel app — thin UI layer.
 * Sends tasks to service worker, renders status updates, manages recordings.
 */

// ─── DOM refs ───

const $ = (sel: string) => document.querySelector(sel)!;

const settingsBtn = $('#settings-btn') as HTMLButtonElement;
const settingsPanel = $('#settings-panel') as HTMLDivElement;
const providerSelect = $('#llm-provider') as HTMLSelectElement;
const apiKeyInput = $('#api-key') as HTMLInputElement;
const modelInput = $('#model-name') as HTMLInputElement;
const baseUrlInput = $('#base-url') as HTMLInputElement;
const baseUrlField = $('#base-url-field') as HTMLElement;
const saveSettingsBtn = $('#save-settings') as HTMLButtonElement;

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

// ─── Settings UI ───

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  recordingsPanel.classList.add('hidden');
});

providerSelect.addEventListener('change', () => {
  const needsBaseUrl = ['ollama', 'custom'].includes(providerSelect.value);
  baseUrlField.classList.toggle('hidden', !needsBaseUrl);

  const placeholders: Record<string, string> = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    gemini: 'gemini-2.0-flash',
    ollama: 'llama3.3',
    custom: 'model-name',
  };
  modelInput.placeholder = placeholders[providerSelect.value] ?? '';
});

saveSettingsBtn.addEventListener('click', async () => {
  const settings = {
    llm: {
      provider: providerSelect.value,
      apiKey: apiKeyInput.value,
      model: modelInput.value || modelInput.placeholder,
      baseUrl: baseUrlInput.value || undefined,
      maxTokens: 4096,
    },
    maxTreeDepth: 12,
    maxTreeChars: 30000,
    alwaysVerifyNavigation: true,
  };

  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: settings });
  settingsPanel.classList.add('hidden');
  addMessage('system', 'Settings saved ✓');
});

async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (settings?.llm) {
    providerSelect.value = settings.llm.provider;
    apiKeyInput.value = settings.llm.apiKey || '';
    modelInput.value = settings.llm.model || '';
    baseUrlInput.value = settings.llm.baseUrl || '';
    providerSelect.dispatchEvent(new Event('change'));
  }
}
loadSettings();

// ─── Recordings UI ───

recordingsBtn.addEventListener('click', () => {
  recordingsPanel.classList.toggle('hidden');
  settingsPanel.classList.add('hidden');
  if (!recordingsPanel.classList.contains('hidden')) {
    loadRecordings();
  }
});

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
        <span class="recording-task">${escapeHtml(rec.task.slice(0, 60))}${rec.task.length > 60 ? '…' : ''}</span>
        <span class="recording-meta">${timeStr} · ${successSteps} steps · ${formatDuration(rec.duration)}</span>
      </div>
      <div class="recording-actions">
        <button class="btn-sm btn-replay" data-id="${rec.id}" title="Replay">▶️</button>
        <button class="btn-sm btn-delete" data-id="${rec.id}" title="Delete">🗑️</button>
      </div>
    `;
    recordingsList.appendChild(div);
  }

  // Event delegation for recording buttons
  recordingsList.querySelectorAll('.btn-replay').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id!;
      chrome.runtime.sendMessage({ type: 'REPLAY_RECORDING', payload: { id } });
      recordingsPanel.classList.add('hidden');
      addMessage('system', '🔄 Replaying recorded task...');
      setRunning(true);
      setStatus('Replaying...');
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// ─── Chat UI ───

function addMessage(type: string, text: string) {
  const div = document.createElement('div');
  div.className = `message ${type}`;
  div.innerHTML = `<p>${escapeHtml(text)}</p>`;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setRunning(running: boolean) {
  sendBtn.classList.toggle('hidden', running);
  stopBtn.classList.toggle('hidden', !running);
  taskInput.disabled = running;
  statusBar.classList.toggle('hidden', !running);
}

function setStatus(text: string) {
  statusText.innerHTML = `<span class="spinner"></span>${escapeHtml(text)}`;
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

  addMessage('user', task);
  taskInput.value = '';
  setRunning(true);
  setStatus('Starting...');

  chrome.runtime.sendMessage({ type: 'RUN_TASK', payload: { task } });
}

// ─── Listen for updates from service worker ───

chrome.runtime.onMessage.addListener((message) => {
  const { type, payload } = message;

  switch (type) {
    case 'TASK_STARTED':
      setStatus('Reading page...');
      break;

    case 'PLAN_UPDATE':
      addMessage('plan', `💭 ${payload.reasoning}`);
      for (const step of payload.steps) {
        addMessage('system', `→ ${step.description}${step.needsVerification ? ' (will verify)' : ''}`);
      }
      setStatus('Executing...');
      break;

    case 'STEP_START':
      setStatus(`Step ${payload.index + 1}: ${payload.description}`);
      break;

    case 'STEP_COMPLETE':
      if (payload.success) {
        addMessage('step', `✓ ${payload.description}`);
      } else {
        addMessage('step failed', `✗ ${payload.description}: ${payload.error}`);
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
      addMessage('assistant', `✅ Replay complete: ${payload.task}`);
      setRunning(false);
      break;

    case 'RECORDING_SAVED':
      addMessage('system', `📹 Recorded ${payload.stepCount} steps. View in Recordings.`);
      break;

    case 'ERROR':
      addMessage('error', `Error: ${payload.message}`);
      setRunning(false);
      break;

    case 'USAGE_UPDATE':
      tokenCount.textContent = `${payload.inputTokens.toLocaleString()} in / ${payload.outputTokens.toLocaleString()} out`;
      break;
  }
});
