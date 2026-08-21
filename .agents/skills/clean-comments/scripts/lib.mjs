// Comment tokenizer shared by scan.mjs and verify.mjs.
//
// Walks a file character by character, tracking string, regex, heredoc, and
// block-comment state, and returns the comments plus the code with every
// comment removed. That state is the point: without it, `url = "https://x"`,
// `/https:\/\//`, or a `#` inside a heredoc reads as a comment, and a real
// code change can hide inside what looks like comment text.
//
// The tokenizer errs toward classifying ambiguous text as code: a fake
// comment can hide a code change from verify, while fake code only causes a
// false verify failure that a human then reads.

import path from 'node:path';

const DQ = { q: '"', esc: true };
const SQ = { q: "'", esc: true };
const SQ_RAW = { q: "'", esc: false };
// Backtick strings span lines. Losing that would reset string state at each
// newline, and a `//` on a continuation line would open a fake comment that
// hides real edits from verify.
const BT = { q: '`', esc: true, multiline: true };
const BT_RAW = { q: '`', esc: false, multiline: true };

// /// and //! state a contract (rustdoc, C# XML docs, Doxygen), so they are
// doc comments, not commentary. //// is a divider, not documentation.
const DOC_LINE = ['///', '//!'];
const C_LIKE = { line: ['//'], block: [['/*', '*/']], strings: [DQ, SQ], docLine: DOC_LINE };
const HASH = { line: ['#'], block: [], strings: [DQ, SQ], lineNeedsBoundary: true };
// JS-family: regex literals can contain // and /*.
const JS = { line: ['//'], block: [['/*', '*/']], strings: [DQ, SQ, BT], regex: true };
const JSX = { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']], strings: [DQ, SQ, BT], regex: true };
// CSS-family: an unquoted url(//cdn...) is not a comment.
const CSS = { line: [], block: [['/*', '*/']], strings: [DQ, SQ], urlParen: true };
const SCSS = { line: ['//'], block: [['/*', '*/']], strings: [DQ, SQ], urlParen: true };
// Shell and Ruby: heredoc bodies are data, whatever characters they hold.
const SH = { line: ['#'], block: [], strings: [DQ, SQ_RAW], lineNeedsBoundary: true, heredoc: 'sh' };
const PY = {
  line: ['#'], block: [], strings: [DQ, SQ],
  triple: [['"""', '"""'], ["'''", "'''"]],
};
const YAML = { line: ['#'], block: [], strings: [DQ, SQ_RAW], lineNeedsBoundary: true, blockScalar: true };

const SYNTAX = {
  c: C_LIKE, cc: C_LIKE, cpp: C_LIKE, cxx: C_LIKE, h: C_LIKE, hpp: C_LIKE,
  hh: C_LIKE, cs: C_LIKE, java: C_LIKE, kt: C_LIKE, kts: C_LIKE, scala: C_LIKE,
  groovy: C_LIKE, swift: C_LIKE, m: C_LIKE, mm: C_LIKE, d: C_LIKE, zig: C_LIKE,
  dart: C_LIKE, v: C_LIKE, proto: C_LIKE, tf: C_LIKE, hcl: C_LIKE,
  gradle: C_LIKE,

  php: { line: ['//', '#'], block: [['/*', '*/']], strings: [DQ, SQ] },

  js: JS, jsx: JSX, mjs: JS, cjs: JS, ts: JS, tsx: JSX, mts: JS, cts: JS,
  vue: JSX, svelte: JSX, astro: JSX,

  go: { line: ['//'], block: [['/*', '*/']], strings: [DQ, BT_RAW] },
  // Rust: /* */ nests, and '"' is a char literal, not a string opener.
  rs: { line: ['//'], block: [['/*', '*/']], strings: [DQ], nestedBlock: true, charLit: true, docLine: DOC_LINE },
  css: CSS, scss: SCSS, sass: SCSS, less: SCSS, styl: SCSS,
  sql: { line: ['--'], block: [['/*', '*/']], strings: [DQ, SQ_RAW] },
  graphql: HASH, gql: HASH,

  py: PY, pyi: PY,
  rb: { line: ['#'], block: [['=begin', '=end']], strings: [DQ, SQ], heredoc: 'rb' },
  rake: { line: ['#'], block: [], strings: [DQ, SQ] },
  sh: SH, bash: SH, zsh: SH,
  fish: { line: ['#'], block: [], strings: [DQ, SQ_RAW], lineNeedsBoundary: true },
  ps1: { line: ['#'], block: [['<#', '#>']], strings: [DQ, SQ_RAW], lineNeedsBoundary: true },
  pl: HASH, pm: HASH, r: HASH, jl: HASH, ex: HASH, exs: HASH, cr: HASH,
  yml: YAML, yaml: YAML,
  toml: HASH, tfvars: HASH, cmake: HASH, mk: HASH,
  nim: { line: ['#'], block: [['#[', ']#']], strings: [DQ, SQ], lineNeedsBoundary: true },

  lua: { line: ['--'], block: [['--[[', ']]']], strings: [DQ, SQ] },
  // Haddock doc markers: -- | documents the item below, -- ^ the one before.
  hs: { line: ['--'], block: [['{-', '-}']], strings: [DQ], nestedBlock: true, docLine: ['-- |', '-- ^'] },
  clj: { line: [';'], block: [], strings: [DQ] },
  cljs: { line: [';'], block: [], strings: [DQ] },
  cljc: { line: [';'], block: [], strings: [DQ] },
  edn: { line: [';'], block: [], strings: [DQ] },
  erl: { line: ['%'], block: [], strings: [DQ], lineNeedsBoundary: true },
  hrl: { line: ['%'], block: [], strings: [DQ], lineNeedsBoundary: true },
  ml: { line: [], block: [['(*', '*)']], strings: [DQ] },
  mli: { line: [], block: [['(*', '*)']], strings: [DQ] },
  fs: { line: ['//'], block: [['(*', '*)']], strings: [DQ] },
  fsx: { line: ['//'], block: [['(*', '*)']], strings: [DQ] },
};

export function syntaxFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return SYNTAX[ext] ?? null;
}

const at = (s, i, lit) => s.startsWith(lit, i);

// A `#` in `${x#y}` or `$#` is not a comment. Where the language demands it,
// a hash or percent marker only opens a comment at the start of a line or
// after whitespace.
function boundaryOk(line, i) {
  return i === 0 || /\s/.test(line[i - 1]);
}

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

// True when a line comment at i opens with one of the syntax's doc markers.
// Repeating the marker's last character (////, //!!) makes a divider, and a
// divider judged as documentation would dodge the comment-block rule.
function isDocLine(syn, line, i) {
  return (syn.docLine ?? []).some(
    (d) => at(line, i, d) && line[i + d.length] !== d[d.length - 1],
  );
}

// A regex literal may follow an operator, an opening bracket, or a keyword —
// anywhere a value can start. After a value, a slash is division.
const REGEX_BEFORE = new Set('=(,:[!&|;{}?+-*%<>~^'.split(''));
const REGEX_KEYWORD = /(^|[^\w$])(return|typeof|case|instanceof|in|of|new|delete|void|do|else|yield|await)$/;

// Index just past a regex literal starting at i, or -1 if none closes on this
// line (a real regex cannot span lines, so no close means division).
function scanRegex(line, i) {
  let inClass = false;
  for (let j = i + 1; j < line.length; j++) {
    const ch = line[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      j++;
      while (j < line.length && /[a-z]/i.test(line[j])) j++;
      return j;
    }
  }
  return -1;
}

// Queue heredoc delimiters opened on this line. Matching on the
// comment-stripped code keeps `# use <<EOF` from opening one; a quoted
// "<<EOF" inside a string still can, which errs toward treating the rest of
// the file as code — the safe direction.
function queueHeredocs(code, dialect, queue) {
  const re = dialect === 'sh'
    ? /<<(?!<)([-~]?)\s*(['"]?)([A-Za-z_]\w*)\2/g
    : /<<(?!<)([-~])?(['"]?)([A-Z_]\w*)\2/g;
  for (const m of code.matchAll(re)) {
    queue.push({ delim: m[3], strip: m[1] === '-' || m[1] === '~' });
  }
}

/**
 * Splits source into comments and comment-free code.
 * Returns { comments, codeLines } where codeLines[i] is line i with every
 * comment removed, preserving all other characters.
 */
export function tokenize(source, syn) {
  const lines = source.split('\n');
  const codeLines = [];
  const comments = [];
  let block = null; // { open, end, depth, startLine, col, raw, kind }
  let str = null; // { q, esc, multiline }
  const heredocs = []; // pending { delim, strip }
  let scalar = null; // { indent } while inside a YAML block scalar

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];

    // A shebang is executable metadata: code, and never comment prose.
    if (ln === 0 && line.startsWith('#!')) { codeLines.push(line); continue; }

    if (heredocs.length && !block && !str) {
      const body = heredocs[0].strip ? line.replace(/^[\t ]+/, '') : line;
      if (body === heredocs[0].delim) heredocs.shift();
      codeLines.push(line);
      continue;
    }
    if (scalar && !block && !str) {
      if (line.trim() === '' || indentOf(line) > scalar.indent) {
        codeLines.push(line);
        continue;
      }
      scalar = null;
    }

    let code = '';
    let i = 0;
    let strContinues = false;

    while (i < line.length) {
      if (block) {
        if (syn.nestedBlock) {
          let advanced = false;
          for (let j = i; j < line.length; j++) {
            if (at(line, j, block.open)) { block.depth++; j += block.open.length - 1; continue; }
            if (at(line, j, block.end)) {
              block.depth--;
              if (block.depth === 0) {
                block.raw += line.slice(i, j + block.end.length);
                block.endLine = ln;
                comments.push(block);
                i = j + block.end.length;
                block = null;
                advanced = true;
                break;
              }
              j += block.end.length - 1;
            }
          }
          if (!advanced && block) { block.raw += line.slice(i) + '\n'; i = line.length; }
          continue;
        }
        const e = line.indexOf(block.end, i);
        if (e === -1) {
          block.raw += line.slice(i) + '\n';
          i = line.length;
        } else {
          block.raw += line.slice(i, e + block.end.length);
          block.endLine = ln;
          comments.push(block);
          i = e + block.end.length;
          block = null;
        }
        continue;
      }

      if (str) {
        if (str.esc && line[i] === '\\') {
          // A backslash at end of line continues the string onto the next
          // line in C and JS; dropping that would turn the continuation into
          // fake code with fake comments.
          if (i === line.length - 1) { code += '\\'; i++; strContinues = true; continue; }
          code += line.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (at(line, i, str.q)) { code += str.q; i += str.q.length; str = null; continue; }
        code += line[i++];
        continue;
      }

      let matched = false;

      for (const [open, close] of syn.triple ?? []) {
        if (!at(line, i, open)) continue;
        // A triple-quoted string is a docstring only as the first statement of
        // a module, class, or function. Anywhere else it is a value, and
        // editing it is a code change. A docstring starts its own line: any
        // code before the quote (`query = """`) makes it a value.
        const isDoc = line.slice(0, i).trim() === '' && looksLikeDocstring(lines, ln, i);
        if (isDoc) {
          block = { open, end: close, depth: 1, startLine: ln, col: i, raw: open, kind: 'doc' };
          i += open.length;
        } else {
          str = { q: close, esc: false, multiline: true };
          code += open;
          i += open.length;
        }
        matched = true;
        break;
      }
      if (matched) continue;

      if (syn.charLit && line[i] === "'") {
        const m = /^'(?:\\.|[^'\\])'/.exec(line.slice(i));
        // No close within one char means a lifetime tick, plain code either way.
        const len = m ? m[0].length : 1;
        code += line.slice(i, i + len);
        i += len;
        continue;
      }

      if (syn.urlParen && /^url\(\s*[^"')]/i.test(line.slice(i))) {
        const close = line.indexOf(')', i);
        const end = close === -1 ? line.length : close + 1;
        code += line.slice(i, end);
        i = end;
        continue;
      }

      if (syn.regex && line[i] === '/' && line[i + 1] !== '/' && line[i + 1] !== '*') {
        const prev = code.replace(/\s+$/, '');
        const prevCh = prev.slice(-1);
        if (prevCh === '' || REGEX_BEFORE.has(prevCh) || REGEX_KEYWORD.test(prev)) {
          const end = scanRegex(line, i);
          if (end !== -1) { code += line.slice(i, end); i = end; continue; }
        }
      }

      for (const [open, close] of syn.block) {
        if (!at(line, i, open)) continue;
        block = {
          open, end: close, depth: 1, startLine: ln, col: i, raw: open,
          kind: (open === '/*' && at(line, i, '/**'))
            || (open === '(*' && at(line, i, '(**')) ? 'doc' : 'block',
        };
        i += open.length;
        matched = true;
        break;
      }
      if (matched) continue;

      for (const marker of syn.line) {
        if (!at(line, i, marker)) continue;
        if (syn.lineNeedsBoundary && !boundaryOk(line, i)) continue;
        comments.push({
          startLine: ln, endLine: ln, col: i, raw: line.slice(i), kind: 'line',
          doc: isDocLine(syn, line, i),
        });
        i = line.length;
        matched = true;
        break;
      }
      if (matched) continue;

      const s = syn.strings.find((d) => at(line, i, d.q));
      if (s) {
        str = { q: s.q, esc: s.esc, multiline: s.multiline };
        code += s.q;
        i += s.q.length;
        continue;
      }

      code += line[i++];
    }

    codeLines.push(code);
    if (str && !str.multiline && !strContinues) str = null;

    if (syn.heredoc) queueHeredocs(code, syn.heredoc, heredocs);
    if (syn.blockScalar && /(?:^|:|-)\s*[|>][+-]?\d*$/.test(code.trim())) {
      scalar = { indent: indentOf(line) };
    }
  }

  if (block) { block.endLine = lines.length - 1; comments.push(block); }
  return { comments, codeLines };
}

// A docstring's home is the first statement after a def or class signature,
// or the top of the file. A line that merely ends with ':' (a dict key, an
// if) does not qualify: a bare string there is a value, and misreading it as
// a docstring hides edits from verify.
function looksLikeDocstring(lines, ln, col) {
  for (let k = ln - 1; k >= 0; k--) {
    const prev = lines[k].trim();
    if (!prev || prev.startsWith('#')) continue;
    return /^(def|class|async\s+def)\b.*:\s*$/.test(prev)
      || /^\)\s*(->[^:]*)?:\s*$/.test(prev); // close of a multi-line signature
  }
  return col === 0; // start of file: a module docstring
}

/** Comment markers stripped, so detectors see prose. */
export function commentBody(c) {
  return c.raw
    .replace(/^\/\*+|\*+\/$/g, '')
    .replace(/^(<!--|-->)|-->$/g, '')
    .replace(/^("""|''')|("""|''')$/g, '')
    .replace(/^(=begin|=end)|^\(\*|\*\)$|^\{-|-\}$|^<#|#>$|^#\[|\]#$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/+!?|#+|--+|;+|%+|\*)\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Code with comments removed, blank lines dropped: two files agree here iff
 *  only comment text differs. */
export function codeSkeleton(source, syn) {
  return tokenize(source, syn).codeLines
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');
}
