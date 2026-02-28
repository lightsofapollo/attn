import type { FileType, PlanStructure } from './types';

const EXTENSIONS_BY_TYPE: Record<FileType, string[]> = {
  markdown: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
  unsupported: [],
  directory: [],
};

const FILE_PATH_HINTS: string[] = [
  '.rs',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.java',
  '.md',
  '.css',
  '.html',
  '.json',
  '.toml',
  '.yaml',
  '.yml',
  '.sql',
  '.sh',
  '.bash',
  '.svelte',
  '.vue',
];

export function detectFileType(path: string): FileType {
  const ext = path.split('.').pop()?.toLowerCase();

  for (const [fileType, exts] of Object.entries(EXTENSIONS_BY_TYPE)) {
    if (exts.includes(ext ?? '') && fileType !== 'unsupported' && fileType !== 'directory') {
      return fileType as FileType;
    }
  }

  return 'unsupported';
}

export function looksLikeFilePath(token: string): boolean {
  if (token.length < 4 || !token.includes('/')) {
    return false;
  }

  return FILE_PATH_HINTS.some((ext) => token.endsWith(ext));
}

export function extractStructureFromMarkdown(markdown: string): PlanStructure {
  const phases: PlanStructure['phases'] = [];
  const tasks: PlanStructure['tasks'] = [];
  const fileRefs: string[] = [];
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith('## ')) {
      phases.push({
        title: trimmed.replace(/^#+\s*/, ''),
        progress: { done: 0, total: 0 },
      });
    }

    if (trimmed.startsWith('- [x] ') || trimmed.startsWith('- [X] ')) {
      const text = trimmed.slice(6);
      tasks.push({ line: i + 1, text, checked: true });
      const phase = phases.at(-1);
      if (phase) {
        phase.progress.total += 1;
        phase.progress.done += 1;
      }
    } else if (trimmed.startsWith('- [ ] ')) {
      const text = trimmed.slice(6);
      tasks.push({ line: i + 1, text, checked: false });
      const phase = phases.at(-1);
      if (phase) {
        phase.progress.total += 1;
      }
    }

    for (const word of trimmed.split(/\s+/)) {
      const cleaned = word.replace(/^[`"'()]+|[`"'()]+$/g, '');
      if (looksLikeFilePath(cleaned)) {
        fileRefs.push(cleaned);
      }
    }
  }

  return { phases, tasks, file_refs: fileRefs };
}

export function markdownSourceUrl(path: string): string {
  return `attn://localhost${encodeURI(path)}`;
}

export async function loadMarkdownFromPath(path: string): Promise<string> {
  const response = await fetch(markdownSourceUrl(path), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`failed to fetch markdown: ${response.status}`);
  }
  return response.text();
}
