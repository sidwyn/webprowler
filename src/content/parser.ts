/**
 * Accessibility tree parser.
 * Runs inside the content script context (has full DOM access).
 * Produces a compact text representation of the page for LLM consumption.
 */

import type { PageNode, PageSnapshot } from '../types';

// ─── Role mapping ───

const TAG_TO_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  input: 'textbox',
  textarea: 'textbox',
  select: 'combobox',
  option: 'option',
  img: 'img',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  section: 'region',
  article: 'article',
  form: 'form',
  table: 'table',
  thead: 'rowgroup',
  tbody: 'rowgroup',
  tr: 'row',
  th: 'columnheader',
  td: 'cell',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  dialog: 'dialog',
  details: 'group',
  summary: 'button',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  label: 'label',
};

const INPUT_TYPE_ROLES: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  submit: 'button',
  reset: 'button',
  button: 'button',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  number: 'spinbutton',
  password: 'textbox',
  date: 'textbox',
  time: 'textbox',
};

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'meta', 'link', 'br', 'hr', 'svg', 'path',
  'defs', 'clippath', 'lineargradient', 'radialgradient', 'stop', 'symbol',
  'use', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse',
]);

// ─── Ref management ───

let refCounter = 0;
const elementsByRef = new Map<string, WeakRef<Element>>();
const refsByElement = new WeakMap<Element, string>();

function getOrCreateRef(el: Element): string {
  const existing = refsByElement.get(el);
  if (existing) {
    // Verify the WeakRef still points to this element
    const stored = elementsByRef.get(existing)?.deref();
    if (stored === el) return existing;
  }
  const ref = `e${++refCounter}`;
  elementsByRef.set(ref, new WeakRef(el));
  refsByElement.set(el, ref);
  return ref;
}

export function resolveRef(ref: string): Element | null {
  return elementsByRef.get(ref)?.deref() ?? null;
}

// ─── Visibility checks ───

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;

  // Quick attribute checks
  if (el.ariaHidden === 'true') return false;
  if (el.hidden) return false;

  // Style checks (expensive, but necessary)
  const style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;

  // Size check
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;

  return true;
}

function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const margin = 100; // Include elements slightly off-screen
  return (
    rect.bottom > -margin &&
    rect.top < window.innerHeight + margin &&
    rect.right > -margin &&
    rect.left < window.innerWidth + margin
  );
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['a', 'button', 'input', 'textarea', 'select', 'summary'].includes(tag)) return true;
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
  if ((el as HTMLElement).contentEditable === 'true') return true;
  if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return true;
  // Check for cursor pointer (common for clickable divs)
  const style = getComputedStyle(el);
  if (style.cursor === 'pointer') return true;
  return false;
}

// ─── Name extraction ───

function getAccessibleName(el: Element): string {
  const tag = el.tagName.toLowerCase();

  // aria-label takes priority
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map(id => {
      const target = document.getElementById(id);
      return target?.textContent?.trim() ?? '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  // Select: show selected option text
  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    return sel.options[sel.selectedIndex]?.text?.trim() ?? '';
  }

  // Inputs
  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    // Associated label
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label?.textContent) return label.textContent.trim();
    }
    return input.placeholder || input.title || input.name || '';
  }

  // Images
  if (tag === 'img') {
    return (el as HTMLImageElement).alt || el.getAttribute('title') || '';
  }

  // For buttons/links/headings: direct text content (shallow)
  if (['button', 'a', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label'].includes(tag)) {
    return getShallowText(el).trim();
  }

  return '';
}

function getShallowText(el: Element): string {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childTag = (child as Element).tagName.toLowerCase();
      // Include inline elements' text, skip block-level
      if (['span', 'strong', 'em', 'b', 'i', 'small', 'code', 'mark'].includes(childTag)) {
        text += child.textContent ?? '';
      }
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

// ─── Role resolution ───

function getRole(el: Element): string {
  // Explicit ARIA role
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();

  // Input type specialization
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type || 'text';
    return INPUT_TYPE_ROLES[type] ?? 'textbox';
  }

  return TAG_TO_ROLE[tag] ?? '';
}

// ─── Properties ───

function getProps(el: Element): Record<string, string> {
  const props: Record<string, string> = {};
  const tag = el.tagName.toLowerCase();

  if (tag === 'a') {
    const href = el.getAttribute('href');
    if (href) props.href = href;
  }

  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    if (input.value) props.value = input.value;
    if (input.type === 'checkbox' || input.type === 'radio') {
      props.checked = String(input.checked);
    }
    if (input.disabled) props.disabled = 'true';
    if (input.readOnly) props.readonly = 'true';
    if (input.type && input.type !== 'text') props.type = input.type;
  }

  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    if (sel.value) props.value = sel.value;
  }

  if (el.getAttribute('aria-expanded')) {
    props.expanded = el.getAttribute('aria-expanded')!;
  }
  if (el.getAttribute('aria-selected')) {
    props.selected = el.getAttribute('aria-selected')!;
  }
  if (el.getAttribute('aria-disabled') === 'true') {
    props.disabled = 'true';
  }

  return props;
}

// ─── Tree building ───

function buildNode(el: Element, depth: number, maxDepth: number): PageNode | null {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;
  if (!isVisible(el)) return null;
  if (depth > maxDepth) return null;

  const role = getRole(el);
  const interactive = isInteractive(el);
  const name = getAccessibleName(el);
  const props = getProps(el);

  // Build children
  const children: PageNode[] = [];
  for (const child of el.children) {
    const childNode = buildNode(child, depth + 1, maxDepth);
    if (childNode) children.push(childNode);
  }

  // Prune: skip non-semantic containers with only one child (div > div > button → button)
  if (!role && !interactive && !name && children.length === 1) {
    return children[0];
  }

  // Prune: skip empty non-interactive non-semantic nodes with no children
  if (!role && !interactive && !name && children.length === 0) {
    // Check for meaningful text content
    const text = getShallowText(el);
    if (!text) return null;
  }

  // Only assign refs to elements we might interact with or need to reference
  const ref = (interactive || role) ? getOrCreateRef(el) : '';

  return { ref, role, name, tag, props, interactive, depth, children };
}

// ─── Serialization ───

function serializeNode(node: PageNode, indent: number, lines: string[], maxChars: number, charCount: { count: number }): void {
  if (charCount.count >= maxChars) return;

  const parts: string[] = [];
  const pad = '  '.repeat(indent);

  // Role or tag
  parts.push(node.role || node.tag);

  // Name in quotes
  if (node.name) {
    parts.push(`"${node.name}"`);
  }

  // Ref
  if (node.ref) {
    parts.push(`[${node.ref}]`);
  }

  // Key props inline
  for (const [k, v] of Object.entries(node.props)) {
    parts.push(`${k}=${v}`);
  }

  const line = `${pad}${parts.join(' ')}`;
  charCount.count += line.length + 1;
  lines.push(line);

  // Recurse children
  for (const child of node.children) {
    serializeNode(child, indent + 1, lines, maxChars, charCount);
  }
}

// ─── Public API ───

export interface SnapshotOptions {
  /** 'all' includes everything visible, 'interactive' only interactive elements */
  filter?: 'all' | 'interactive';
  /** Max tree depth */
  maxDepth?: number;
  /** Max output chars */
  maxChars?: number;
  /** Only include elements in the viewport */
  viewportOnly?: boolean;
}

export function takeSnapshot(options: SnapshotOptions = {}): PageSnapshot {
  const {
    filter = 'all',
    maxDepth = 12,
    maxChars = 30000,
    viewportOnly = true,
  } = options;

  refCounter = 0;
  elementsByRef.clear();

  const root = document.body ?? document.documentElement;
  const tree = buildNode(root, 0, maxDepth);

  if (!tree) {
    return {
      url: location.href,
      title: document.title,
      tree: '(empty page)',
      interactiveCount: 0,
      timestamp: Date.now(),
    };
  }

  // Filter and serialize
  const lines: string[] = [];
  const charCount = { count: 0 };
  let interactiveCount = 0;

  function walk(node: PageNode) {
    if (viewportOnly && node.ref) {
      const el = resolveRef(node.ref);
      if (el && !isInViewport(el)) return;
    }

    if (filter === 'interactive' && !node.interactive && node.children.length === 0) {
      return;
    }

    if (node.interactive) interactiveCount++;

    serializeNode(node, 0, lines, maxChars, charCount);
    // Children are handled by serializeNode recursively
  }

  // Serialize top-level (serializeNode handles recursion)
  serializeNode(tree, 0, lines, maxChars, charCount);

  // Count interactive elements
  function countInteractive(node: PageNode) {
    if (node.interactive) interactiveCount++;
    for (const child of node.children) countInteractive(child);
  }
  countInteractive(tree);

  return {
    url: location.href,
    title: document.title,
    tree: lines.join('\n'),
    interactiveCount,
    timestamp: Date.now(),
  };
}
