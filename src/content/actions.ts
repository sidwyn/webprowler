/**
 * DOM action executor.
 * Takes an Action and performs it on the real page.
 * Highlights elements during execution.
 */

import type { Action, StepResult } from '../types';
import { resolveRef, takeSnapshot } from './parser';
import { highlightElement, highlightSuccess, highlightError, clearHighlights } from './highlight';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getElement(ref: string): HTMLElement {
  const el = resolveRef(ref);
  if (!el) throw new Error(`Element ${ref} not found (stale ref or removed from DOM)`);
  if (!(el instanceof HTMLElement)) throw new Error(`Element ${ref} is not an HTMLElement`);
  return el;
}

function scrollIntoView(el: HTMLElement) {
  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
}

async function executeClick(ref: string): Promise<void> {
  const el = getElement(ref);
  scrollIntoView(el);
  await delay(50);

  highlightElement(el, { kind: 'click' });
  await delay(300);

  // Focus first (important for dropdowns, menus)
  el.focus();

  // Dispatch real mouse events for frameworks that listen to them
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
  };

  el.dispatchEvent(new MouseEvent('pointerdown', eventInit));
  el.dispatchEvent(new MouseEvent('mousedown', eventInit));
  el.dispatchEvent(new MouseEvent('pointerup', eventInit));
  el.dispatchEvent(new MouseEvent('mouseup', eventInit));
  el.dispatchEvent(new MouseEvent('click', eventInit));

  highlightSuccess(el);
}

async function executeType(ref: string, text: string, clear: boolean): Promise<void> {
  const el = getElement(ref);
  scrollIntoView(el);

  highlightElement(el, { kind: 'type', detail: text });
  await delay(300);

  el.focus();
  await delay(50);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (clear) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Use native setter for React/framework compatibility
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, clear ? text : el.value + text);
    } else {
      el.value = clear ? text : el.value + text;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.contentEditable === 'true') {
    if (clear) el.textContent = '';
    el.textContent = (el.textContent ?? '') + text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  highlightSuccess(el);
}

async function executeSelect(ref: string, value: string): Promise<void> {
  const el = getElement(ref);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`Element ${ref} is not a <select>`);
  }
  scrollIntoView(el);

  highlightElement(el, { kind: 'select', detail: value });
  await delay(300);

  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));

  highlightSuccess(el);
}

async function executeScroll(direction: 'up' | 'down', amount?: number): Promise<void> {
  const distance = amount ?? Math.floor(window.innerHeight * 0.7);
  window.scrollBy({
    top: direction === 'down' ? distance : -distance,
    behavior: 'instant',
  });
  // Wait for any lazy-loaded content
  await delay(300);
}

async function executeNavigate(url: string): Promise<void> {
  window.location.href = url;
  // Navigation will cause a page load; the service worker handles re-injection
}

// ─── Public API ───

export async function executeAction(action: Action): Promise<StepResult> {
  try {
    switch (action.kind) {
      case 'click':
        await executeClick(action.ref);
        break;
      case 'type':
        await executeType(action.ref, action.text, action.clear ?? false);
        break;
      case 'select':
        await executeSelect(action.ref, action.value);
        break;
      case 'scroll':
        await executeScroll(action.direction, action.amount);
        break;
      case 'navigate':
        await executeNavigate(action.url);
        return { success: true }; // Page will reload
      case 'read':
        const snapshot = takeSnapshot({
          filter: 'all',
          viewportOnly: true,
        });
        return { success: true, snapshot };
      case 'wait':
        await delay(action.ms);
        break;
    }

    // Brief pause for DOM to settle after action
    await delay(150);

    return { success: true };
  } catch (error) {
    // Highlight error on the target element if possible
    if ('ref' in action && action.ref) {
      const el = resolveRef(action.ref);
      if (el) highlightError(el);
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
