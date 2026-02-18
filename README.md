# 🐾 WebProwler

Open-source AI web agent. Navigate any website with natural language.

> **Status:** Early development. Not yet usable.

## What is this?

A Chrome extension that lets you control any web page through natural language. Instead of taking screenshots and guessing pixels (like some other tools), WebProwler reads the page's accessibility tree — the same semantic structure screen readers use — to understand what's on the page and interact with it precisely.

## How it works

1. You type a task in the sidebar ("search for X and click the first result")
2. WebProwler reads the page's a11y tree → compact text representation
3. Sends the tree + your task to an LLM (your choice of provider)
4. LLM plans 1-3 micro-steps with verification checkpoints
5. Extension executes each step on the real DOM
6. After risky actions (clicks, navigation), re-reads the page and re-plans
7. Repeats until done

## Key design decisions

- **A11y tree over screenshots** — 10-100x fewer tokens, faster, more accurate for most pages
- **Micro-batch planning** — 1-3 steps at a time, not blind multi-step chains. Risky actions (clicks, navigation) always trigger re-verification.
- **LLM-agnostic** — Bring your own API key. Supports Anthropic, OpenAI, Google Gemini, Ollama (local), or any OpenAI-compatible endpoint.
- **No headless browser** — Runs in your actual Chrome session. Pages are already rendered, JS executed, authenticated. No rendering problems.

## Setup

```bash
npm install
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `dist/` folder
4. Click the WebProwler icon → opens side panel
5. Add your API key in settings

## Development

```bash
npm run dev   # watch mode — rebuilds on file changes
```

## Architecture

```
src/
  background/        Service worker — orchestration
  content/           Content script — DOM parsing + action execution
    parser.ts        A11y tree → compact text serialization
    actions.ts       Click, type, scroll, etc. on real DOM
  sidepanel/         Chat UI (Chrome side panel)
  lib/
    llm/             Provider abstraction (Anthropic, OpenAI, Gemini, Ollama)
    planner/         Micro-batch planner with checkpoint verification
  types/             Shared TypeScript types
```

## Roadmap

- [ ] Core a11y tree parsing + serialization
- [ ] Basic action execution (click, type, scroll)
- [ ] Micro-batch planner with verification
- [ ] Side panel chat UI
- [ ] Multi-provider LLM support
- [ ] Site-specific adapters for common sites
- [ ] Form auto-fill
- [ ] Task recording + replay
- [ ] Visual element highlighting during execution

## License

MIT
