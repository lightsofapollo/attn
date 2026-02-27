import type { ContentPayload, UpdatePayload } from './types';

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

This is a **sample markdown** document for development.

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

const SAMPLE_HTML = markdownToBasicHtml(SAMPLE_MARKDOWN);

function markdownToBasicHtml(md: string): string {
  // Minimal markdown-to-HTML for dev preview (not a full parser)
  let html = md;

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Code blocks
  html = html.replace(/```\w*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

  // Task list items
  html = html.replace(
    /^- \[x\] (.+)$/gm,
    '<li class="task-list-item"><input type="checkbox" checked disabled /> $1</li>'
  );
  html = html.replace(
    /^- \[ \] (.+)$/gm,
    '<li class="task-list-item"><input type="checkbox" disabled /> $1</li>'
  );

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr />');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Paragraphs (lines not already wrapped)
  html = html.replace(/^(?!<[hluobp]|<li|<hr|<pre|<block)(.+)$/gm, '<p>$1</p>');

  // Wrap task list items
  html = html.replace(
    /(<li class="task-list-item">[\s\S]*?<\/li>)/g,
    '<ul class="contains-task-list">$1</ul>'
  );

  return html;
}

type SetContentFn = (data: ContentPayload) => void;
type UpdateContentFn = (data: UpdatePayload) => void;

interface AttnBridge {
  setContent: SetContentFn;
  updateContent: UpdateContentFn;
}

declare global {
  interface Window {
    __attn__?: AttnBridge;
  }
}

export function installMockIpc(): void {
  // Only install if not running inside wry (no native ipc)
  if (window.ipc) return;

  console.log('[attn] Dev mode: installing mock IPC');

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

  // Delay sending initial content until the app mounts and registers handlers
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (window.__attn__?.setContent) {
        window.__attn__.setContent({
          html: SAMPLE_HTML,
          rawMarkdown: SAMPLE_MARKDOWN,
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
          filePath: '/tmp/plan.md',
        });
      }
    }, 50);
  });
}
