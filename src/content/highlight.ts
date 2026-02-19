/**
 * Visual element highlighting during execution.
 * Shows a colored overlay + tooltip on elements as they're acted upon.
 */

const HIGHLIGHT_DURATION = 1500;
const STYLES_ID = 'webprowler-highlight-styles';

function ensureStyles() {
  if (document.getElementById(STYLES_ID)) return;

  const style = document.createElement('style');
  style.id = STYLES_ID;
  style.textContent = `
    .wp-highlight-overlay {
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      border: 2px solid #3b82f6;
      border-radius: 4px;
      background: rgba(59, 130, 246, 0.12);
      transition: opacity 0.3s ease;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3), 0 0 20px rgba(59, 130, 246, 0.15);
    }

    .wp-highlight-overlay.wp-success {
      border-color: #22c55e;
      background: rgba(34, 197, 94, 0.12);
      box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.3), 0 0 20px rgba(34, 197, 94, 0.15);
    }

    .wp-highlight-overlay.wp-error {
      border-color: #ef4444;
      background: rgba(239, 68, 68, 0.12);
      box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.3), 0 0 20px rgba(239, 68, 68, 0.15);
    }

    .wp-highlight-overlay.wp-fade-out {
      opacity: 0;
    }

    .wp-highlight-tooltip {
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      background: #0a0a0c;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 12px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid #27272a;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      white-space: nowrap;
      transition: opacity 0.3s ease;
    }

    .wp-highlight-tooltip.wp-fade-out {
      opacity: 0;
    }

    .wp-highlight-tooltip .wp-action-icon {
      margin-right: 4px;
    }

    @keyframes wp-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    .wp-highlight-overlay.wp-pulse {
      animation: wp-pulse 0.8s ease-in-out infinite;
    }

    @keyframes wp-scan-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes wp-scan-out {
      from { opacity: 1; }
      to   { opacity: 0; }
    }

    .wp-scan-frame {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      border: 2px solid rgba(59, 130, 246, 0.55);
      box-shadow: inset 0 0 40px rgba(59, 130, 246, 0.06);
      animation: wp-scan-in 0.15s ease-out;
    }

    .wp-scan-frame.wp-scan-fade {
      animation: wp-scan-out 0.35s ease-out forwards;
    }

    .wp-scan-label {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(10, 10, 12, 0.88);
      color: #93c5fd;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 12px;
      border-radius: 99px;
      border: 1px solid rgba(59, 130, 246, 0.25);
      pointer-events: none;
      z-index: 2147483647;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

function getActionIcon(kind: string): string {
  switch (kind) {
    case 'click': return '👆';
    case 'type': return '⌨️';
    case 'select': return '📋';
    case 'scroll': return '📜';
    case 'read': return '👁️';
    default: return '🐾';
  }
}

function getActionLabel(kind: string, detail?: string): string {
  switch (kind) {
    case 'click': return 'Clicking';
    case 'type': return `Typing "${detail?.slice(0, 30) ?? ''}"`;
    case 'select': return `Selecting "${detail ?? ''}"`;
    case 'scroll': return `Scrolling ${detail ?? 'down'}`;
    case 'read': return 'Reading page';
    default: return kind;
  }
}

export interface HighlightOptions {
  kind: string;
  detail?: string;
  duration?: number;
}

let activeOverlay: HTMLElement | null = null;
let activeTooltip: HTMLElement | null = null;
let cleanupTimeout: ReturnType<typeof setTimeout> | null = null;

function cleanup() {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
  if (cleanupTimeout) {
    clearTimeout(cleanupTimeout);
    cleanupTimeout = null;
  }
}

export function highlightElement(el: Element, options: HighlightOptions): void {
  cleanup();
  ensureStyles();

  const rect = el.getBoundingClientRect();

  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'wp-highlight-overlay wp-pulse';
  overlay.style.left = `${rect.left - 3}px`;
  overlay.style.top = `${rect.top - 3}px`;
  overlay.style.width = `${rect.width + 6}px`;
  overlay.style.height = `${rect.height + 6}px`;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  // Tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'wp-highlight-tooltip';
  tooltip.innerHTML = `<span class="wp-action-icon">${getActionIcon(options.kind)}</span>${getActionLabel(options.kind, options.detail)}`;

  // Position tooltip above element, or below if not enough space
  const tooltipY = rect.top > 40 ? rect.top - 34 : rect.bottom + 8;
  tooltip.style.left = `${Math.max(4, rect.left)}px`;
  tooltip.style.top = `${tooltipY}px`;
  document.body.appendChild(tooltip);
  activeTooltip = tooltip;

  const duration = options.duration ?? HIGHLIGHT_DURATION;

  cleanupTimeout = setTimeout(() => {
    overlay.classList.remove('wp-pulse');
    overlay.classList.add('wp-fade-out');
    tooltip.classList.add('wp-fade-out');

    setTimeout(() => cleanup(), 300);
  }, duration);
}

export function highlightSuccess(el: Element): void {
  if (activeOverlay) {
    activeOverlay.classList.remove('wp-pulse');
    activeOverlay.classList.add('wp-success');

    setTimeout(() => {
      if (activeOverlay) {
        activeOverlay.classList.add('wp-fade-out');
        if (activeTooltip) activeTooltip.classList.add('wp-fade-out');
        setTimeout(() => cleanup(), 300);
      }
    }, 600);
  }
}

export function highlightError(el: Element): void {
  if (activeOverlay) {
    activeOverlay.classList.remove('wp-pulse');
    activeOverlay.classList.add('wp-error');

    setTimeout(() => {
      if (activeOverlay) {
        activeOverlay.classList.add('wp-fade-out');
        if (activeTooltip) activeTooltip.classList.add('wp-fade-out');
        setTimeout(() => cleanup(), 300);
      }
    }, 1200);
  }
}

export function clearHighlights(): void {
  cleanup();
}

// ─── Full-page scan overlay ───

let scanFrame: HTMLElement | null = null;
let scanLabel: HTMLElement | null = null;
let scanHideTimer: ReturnType<typeof setTimeout> | null = null;

export function showPageScan(label = 'Reading page…'): void {
  ensureStyles();
  hidePageScan(); // clear any previous

  const frame = document.createElement('div');
  frame.className = 'wp-scan-frame';
  document.documentElement.appendChild(frame);
  scanFrame = frame;

  const lbl = document.createElement('div');
  lbl.className = 'wp-scan-label';
  lbl.textContent = label;
  document.documentElement.appendChild(lbl);
  scanLabel = lbl;
}

export function hidePageScan(): void {
  if (scanHideTimer) { clearTimeout(scanHideTimer); scanHideTimer = null; }
  if (scanFrame) {
    scanFrame.classList.add('wp-scan-fade');
    const f = scanFrame, l = scanLabel;
    scanFrame = null; scanLabel = null;
    scanHideTimer = setTimeout(() => { f.remove(); l?.remove(); }, 380);
  }
}
