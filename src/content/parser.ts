/**
 * Accessibility tree parser.
 * Runs inside the content script context (has full DOM access).
 * Produces a compact text representation of the page for LLM consumption.
 *
 * Supports:
 * - Standard DOM elements
 * - Shadow DOM (open shadow roots)
 * - Same-origin iframes
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
  'template', 'slot',
]);

// ─── Ref management ───

let refCounter = 0;
const elementsByRef = new Map<string, WeakRef<Element>>();
const refsByElement = new WeakMap<Element, string>();

function getOrCreateRef(el: Element): string {
  const existing = refsByElement.get(el);
  if (existing) {
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
  if (el.ariaHidden === 'true') return false;
  if (el.hidden) return false;

  const style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;

  return true;
}

function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const margin = 100;
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
  const role = el.getAttribute('role');
  if (role === 'button' || role === 'link' || role === 'tab' ||
      role === 'menuitem' || role === 'option' || role === 'switch') return true;
  // cursor: pointer check (common for clickable divs/spans)
  try {
    const style = getComputedStyle(el);
    if (style.cursor === 'pointer') return true;
  } catch { /* cross-origin iframe element */ }
  return false;
}

// ─── Name extraction ───

function getAccessibleName(el: Element): string {
  const tag = el.tagName.toLowerCase();

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts = labelledBy.split(/\s+/).map(id => {
      const target = root.getElementById?.(id) ?? document.getElementById(id);
      return target?.textContent?.trim() ?? '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    return sel.options[sel.selectedIndex]?.text?.trim() ?? '';
  }

  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    if (input.id) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const label = (root.querySelector?.(`label[for="${CSS.escape(input.id)}"]`) ??
                     document.querySelector(`label[for="${CSS.escape(input.id)}"]`));
      if (label?.textContent) return label.textContent.trim();
    }
    return input.placeholder || input.title || input.name || '';
  }

  if (tag === 'img') {
    return (el as HTMLImageElement).alt || el.getAttribute('title') || '';
  }

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
      if (['span', 'strong', 'em', 'b', 'i', 'small', 'code', 'mark', 'u', 'sub', 'sup'].includes(childTag)) {
        text += child.textContent ?? '';
      }
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

// ─── Role resolution ───

function getRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();

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

  if (el.getAttribute('aria-expanded')) props.expanded = el.getAttribute('aria-expanded')!;
  if (el.getAttribute('aria-selected')) props.selected = el.getAttribute('aria-selected')!;
  if (el.getAttribute('aria-disabled') === 'true') props.disabled = 'true';
  if (el.getAttribute('aria-current')) props.current = el.getAttribute('aria-current')!;

  return props;
}

// ─── Tree building (with shadow DOM + iframe support) ───

function getChildElements(el: Element): Element[] {
  const children: Element[] = [];

  // 1. Shadow DOM — if the element has an open shadow root, traverse it
  if (el.shadowRoot) {
    for (const child of el.shadowRoot.children) {
      children.push(child);
    }
    return children; // Shadow root replaces light DOM children for rendering
  }

  // 2. Regular children
  for (const child of el.children) {
    children.push(child);
  }

  return children;
}

function buildNode(el: Element, depth: number, maxDepth: number, viewportOnly: boolean): PageNode | null {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return null;
  if (!isVisible(el)) return null;
  if (depth > maxDepth) return null;
  if (viewportOnly && !isInViewport(el)) return null;

  // 3. Iframes — try to access same-origin iframe content
  if (tag === 'iframe') {
    try {
      const iframe = el as HTMLIFrameElement;
      const iframeDoc = iframe.contentDocument;
      if (iframeDoc?.body) {
        const iframeNode = buildNode(iframeDoc.body, depth + 1, maxDepth, viewportOnly);
        if (iframeNode) {
          const ref = getOrCreateRef(el);
          return {
            ref,
            role: 'iframe',
            name: iframe.title || iframe.name || '',
            tag: 'iframe',
            props: iframe.src ? { src: iframe.src } : {},
            interactive: false,
            depth,
            children: iframeNode.children,
          };
        }
      }
    } catch {
      // Cross-origin iframe — can't access, just note it exists
      const ref = getOrCreateRef(el);
      return {
        ref,
        role: 'iframe',
        name: (el as HTMLIFrameElement).title || '(cross-origin)',
        tag: 'iframe',
        props: {},
        interactive: false,
        depth,
        children: [],
      };
    }
    return null;
  }

  const role = getRole(el);
  const interactive = isInteractive(el);
  const name = getAccessibleName(el);
  const props = getProps(el);

  // Build children (handles shadow DOM)
  const children: PageNode[] = [];
  for (const child of getChildElements(el)) {
    const childNode = buildNode(child, depth + 1, maxDepth, viewportOnly);
    if (childNode) children.push(childNode);
  }

  // Prune: skip non-semantic containers with only one child
  if (!role && !interactive && !name && children.length === 1) {
    return children[0];
  }

  // Prune: skip empty non-interactive non-semantic leaf nodes
  if (!role && !interactive && !name && children.length === 0) {
    const text = getShallowText(el);
    if (!text) return null;
  }

  const ref = (interactive || role) ? getOrCreateRef(el) : '';

  return { ref, role, name, tag, props, interactive, depth, children };
}

// ─── Serialization ───

function serializeNode(node: PageNode, indent: number, lines: string[], maxChars: number, charCount: { count: number }): void {
  if (charCount.count >= maxChars) return;

  const parts: string[] = [];
  const pad = '  '.repeat(indent);

  parts.push(node.role || node.tag);

  if (node.name) {
    // Truncate very long names (e.g., paragraph text used as name)
    const displayName = node.name.length > 80 ? node.name.slice(0, 77) + '…' : node.name;
    parts.push(`"${displayName}"`);
  }

  if (node.ref) {
    parts.push(`[${node.ref}]`);
  }

  for (const [k, v] of Object.entries(node.props)) {
    // Truncate long prop values
    const displayVal = v.length > 60 ? v.slice(0, 57) + '…' : v;
    parts.push(`${k}=${displayVal}`);
  }

  const line = `${pad}${parts.join(' ')}`;
  charCount.count += line.length + 1;
  lines.push(line);

  for (const child of node.children) {
    serializeNode(child, indent + 1, lines, maxChars, charCount);
  }
}

// ─── Public API ───

export interface SnapshotOptions {
  filter?: 'all' | 'interactive';
  maxDepth?: number;
  maxChars?: number;
  viewportOnly?: boolean;
}

export function takeSnapshot(options: SnapshotOptions = {}): PageSnapshot {
  const {
    filter = 'all',
    maxDepth = 12,
    maxChars = 30000,
    viewportOnly = true,
  } = options;

  // Reset refs for fresh snapshot
  refCounter = 0;
  elementsByRef.clear();

  const root = document.body ?? document.documentElement;
  const tree = buildNode(root, 0, maxDepth, viewportOnly);

  if (!tree) {
    return {
      url: location.href,
      title: document.title,
      tree: '(empty page)',
      interactiveCount: 0,
      timestamp: Date.now(),
    };
  }

  // Serialize
  const lines: string[] = [];
  const charCount = { count: 0 };

  if (filter === 'interactive') {
    // Only serialize interactive subtrees
    serializeInteractive(tree, 0, lines, maxChars, charCount);
  } else {
    serializeNode(tree, 0, lines, maxChars, charCount);
  }

  // Count interactive elements
  let interactiveCount = 0;
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

/** Serialize only branches that contain interactive elements */
function serializeInteractive(node: PageNode, indent: number, lines: string[], maxChars: number, charCount: { count: number }): void {
  if (charCount.count >= maxChars) return;

  const hasInteractive = nodeHasInteractive(node);
  if (!hasInteractive) return;

  // Serialize this node
  const parts: string[] = [];
  const pad = '  '.repeat(indent);
  parts.push(node.role || node.tag);
  if (node.name) {
    const displayName = node.name.length > 80 ? node.name.slice(0, 77) + '…' : node.name;
    parts.push(`"${displayName}"`);
  }
  if (node.ref) parts.push(`[${node.ref}]`);
  for (const [k, v] of Object.entries(node.props)) {
    const displayVal = v.length > 60 ? v.slice(0, 57) + '…' : v;
    parts.push(`${k}=${displayVal}`);
  }

  const line = `${pad}${parts.join(' ')}`;
  charCount.count += line.length + 1;
  lines.push(line);

  for (const child of node.children) {
    serializeInteractive(child, indent + 1, lines, maxChars, charCount);
  }
}

function nodeHasInteractive(node: PageNode): boolean {
  if (node.interactive) return true;
  return node.children.some(c => nodeHasInteractive(c));
}
