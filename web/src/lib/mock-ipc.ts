import type { ContentPayload, InitPayload, UpdatePayload } from './types';

const SAMPLE_MARKDOWN = `# Project Plan

## Phase 1: Setup

- [x] Initialize repository
- [x] Set up CI/CD pipeline
- [ ] Configure linting rules

## Phase 2: Core Features

- [ ] Implement user authentication
- [ ] Build dashboard view
- [x] Create database schema

## Notes

This is a **sample markdown** document with ~~strikethrough~~ for development.

### Code Example

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

### Links

See [the docs](https://example.com) for more info.

> This is a blockquote with some important context
> that spans multiple lines.

---

| Feature | Status |
|---------|--------|
| Auth    | Done   |
| API     | WIP    |
| UI      | Todo   |
`;

type SetContentFn = (data: ContentPayload) => void;
type UpdateContentFn = (data: UpdatePayload) => void;

interface AttnBridge {
  setContent: SetContentFn;
  updateContent: UpdateContentFn;
}

declare global {
  interface Window {
    __attn__?: AttnBridge;
    __attn_init__?: InitPayload;
  }
}

export function installMockIpc(): void {
  // Only install if not running inside wry (no native ipc)
  if (window.ipc) return;

  console.log('[attn] Dev mode: installing mock IPC');

  // Set up mock init payload — now sends raw markdown, ProseMirror renders it
  window.__attn_init__ = {
    markdown: SAMPLE_MARKDOWN,
    structure: {
      phases: [
        { title: 'Phase 1: Setup', progress: { done: 2, total: 3 } },
        { title: 'Phase 2: Core Features', progress: { done: 1, total: 3 } },
      ],
      tasks: [
        { line: 5, text: 'Initialize repository', checked: true },
        { line: 6, text: 'Set up CI/CD pipeline', checked: true },
        { line: 7, text: 'Configure linting rules', checked: false },
        { line: 11, text: 'Implement user authentication', checked: false },
        { line: 12, text: 'Build dashboard view', checked: false },
        { line: 13, text: 'Create database schema', checked: true },
      ],
      file_refs: [],
    },
    theme: 'light',
  };

  // Mock window.ipc.postMessage
  window.ipc = {
    postMessage(message: string) {
      const parsed = JSON.parse(message) as { type: string };
      console.log('[attn] IPC out:', parsed);

      if (parsed.type === 'quit') {
        console.log('[attn] Quit requested (ignored in dev mode)');
      }
    },
  };
}
