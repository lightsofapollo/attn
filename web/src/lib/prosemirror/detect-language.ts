/**
 * Heuristic language detection for untagged code fences.
 *
 * Policy: confident-match-or-nothing. A wrong guess (rust keywords lighting
 * up inside a config sample) is worse than plain text, so a language is only
 * returned when its evidence score clears a floor AND beats every other
 * candidate outright. Results are cached per block content — detection runs
 * on every ProseMirror decoration pass.
 */

const SAMPLE_LIMIT = 4000;
const CACHE_LIMIT = 500;

const cache = new Map<string, string | undefined>();

export function detectLanguage(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  const sample = trimmed.slice(0, SAMPLE_LIMIT);
  const key = `${trimmed.length}:${sample.slice(0, 200)}`;
  const hit = cache.get(key);
  if (hit !== undefined || cache.has(key)) return hit;
  const result = detect(trimmed, sample);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}

function detect(full: string, sample: string): string | undefined {
  // Unambiguous structural signatures first.
  const shebang = /^#!\S*(?:\/|\benv\s+)(\w+)/.exec(sample);
  if (shebang) {
    const interp = shebang[1];
    if (interp === 'bash' || interp === 'sh' || interp === 'zsh') return 'bash';
    if (interp.startsWith('python')) return 'python';
    if (interp === 'node') return 'javascript';
  }

  if (/^[[{]/.test(sample)) {
    try {
      JSON.parse(full);
      return 'json';
    } catch {
      /* not JSON — fall through */
    }
  }

  if (/^<\?xml/i.test(sample)) return 'xml';
  if (/^<!doctype html|^<html\b/i.test(sample)) return 'html';

  const lines = sample.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return undefined;

  if (lines.filter((l) => /^(\+\+\+ |--- |@@ )/.test(l)).length >= 2) return 'diff';

  // Scored candidates: each hit is one piece of independent evidence.
  const scores = new Map<string, number>();
  const add = (lang: string, condition: boolean | number): void => {
    const points = typeof condition === 'number' ? condition : condition ? 1 : 0;
    if (points > 0) scores.set(lang, (scores.get(lang) ?? 0) + points);
  };

  add('rust', /\bfn\s+\w+\s*(<[^>]*>)?\s*\(/.test(sample));
  add('rust', /\blet\s+(mut\s+)?\w+\s*(:|=)/.test(sample));
  add('rust', /\b(impl|trait)\s+\w+/.test(sample));
  add('rust', /\buse\s+\w+(::\w+)+/.test(sample));
  add('rust', /\bpub\s+(fn|struct|enum|mod)\b/.test(sample) || /#\[derive\(/.test(sample));

  add('python', /^\s*def\s+\w+\s*\(.*\)\s*:/m.test(sample));
  add('python', /^\s*(from\s+[\w.]+\s+)?import\s+[\w.,\s]+$/m.test(sample));
  add('python', /^\s*class\s+\w+(\(.*\))?\s*:/m.test(sample));
  add('python', /\bself\b/.test(sample) || /^\s*(elif|except)\b/m.test(sample));

  const tsSignals =
    Number(/:\s*(string|number|boolean|void|unknown)\b/.test(sample)) +
    Number(/\binterface\s+\w+\s*\{/.test(sample)) +
    Number(/\btype\s+\w+\s*=/.test(sample));
  const jsSignals =
    Number(/\b(const|let|var)\s+[\w$]+\s*=/.test(sample)) +
    Number(/=>/.test(sample)) +
    Number(/\bfunction\s*[\w$]*\s*\(/.test(sample)) +
    Number(/^\s*(import\s.*from\s+['"]|export\s+(default|const|function|class)\b)/m.test(sample));
  add(tsSignals > 0 ? 'typescript' : 'javascript', jsSignals + tsSignals);

  add('go', /^package\s+\w+$/m.test(sample) ? 2 : 0);
  add('go', /\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\s*\(/.test(sample));
  add('go', /:=/.test(sample));

  add('sql', /^\s*(select|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(table|index|view)|alter\s+table)\b/im.test(sample) ? 2 : 0);
  add('sql', /\b(where|join|group\s+by|order\s+by)\b/i.test(sample));

  add('css', /^[\s]*[.#@:]?[\w-]+[^{;]*\{[^}]*:[^}]*\}/s.test(sample) && /:\s*[^;{]+;/.test(sample) ? 2 : 0);

  add('html', (sample.match(/<\/?[a-z][\w-]*(\s[^<>]*)?>/gi)?.length ?? 0) >= 4 ? 2 : 0);

  add('toml', /^\[[\w."'-]+\]\s*$/m.test(sample) && /^[\w."'-]+\s*=\s*\S/m.test(sample) ? 2 : 0);

  // Line-shape languages: demand that MOST of the block looks like them.
  const shellLines = nonEmpty.filter((l) =>
    /^\s*(\$\s+|#(?!!)\s)/.test(l)
    || /^\s*(cd|ls|cat|git|npm|npx|pnpm|yarn|cargo|curl|wget|echo|export|source|mkdir|rm|cp|mv|task|make|brew|apt|docker|kubectl|python3?|node|ssh|scp|chmod|grep|sed|awk|tar)\b/.test(l),
  ).length;
  add('bash', shellLines >= 2 && shellLines / nonEmpty.length > 0.5 ? 3 : 0);

  const yamlLines = nonEmpty.filter((l) => /^\s*([\w."'/-]+:\s+\S|[\w."'-]+:\s*$|- )/.test(l)).length;
  const yamlHostile = /[;{}]\s*$/m.test(sample) || /\b(const|let|function|def|fn)\b/.test(sample);
  add('yaml', !yamlHostile && yamlLines >= 3 && yamlLines / nonEmpty.length > 0.6 ? 3 : 0);

  let best: string | undefined;
  let bestScore = 0;
  let runnerUp = 0;
  for (const [lang, score] of scores) {
    if (score > bestScore) {
      runnerUp = bestScore;
      best = lang;
      bestScore = score;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  // Floor of 2 independent signals, and a strict lead over the runner-up.
  return bestScore >= 2 && bestScore > runnerUp ? best : undefined;
}
