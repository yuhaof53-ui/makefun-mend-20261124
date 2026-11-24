// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files, in four formats:
// a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
// V4A patch format, and text-editor tool calls as JSON. Every file is changed
// or nothing is. Implements SPEC.md version 1 in full: the command line, the
// output and exit codes, safe paths, format detection, line matching at three
// tiers, all four readers, and the all-or-nothing write. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and no
 * empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file split into its lines, its line break and whether it ends with one. */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One line normalised for matching at a tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at a tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in lines, with its occurrences. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, with those occurrences. */
function findTierFrom(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk or chunk: a context line, a removed line, an added line. */
interface Item {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/** Replace the matched lines at pos with the items' new lines. Context lines
 * are written as the file's own matched lines, never the patch's; at tier 2
 * every other line of N is re-indented from O's first line's leading
 * whitespace to the file's first matched line's. */
function applyItems(fileLines: string[], pos: number, items: Item[], tier: number): string[] {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      nCtx.push(o.length);
      o.push(it.text);
      n.push(it.text);
    } else if (it.kind === 'del') {
      o.push(it.text);
    } else {
      nCtx.push(-1);
      n.push(it.text);
    }
  }
  const f = pos < fileLines.length ? lead(fileLines[pos]!) : '';
  const p = o.length > 0 ? lead(o[0]!) : '';
  const out: string[] = [];
  for (let k = 0; k < n.length; k++) {
    const ci = nCtx[k]!;
    if (ci >= 0) {
      out.push(fileLines[pos + ci]!);
    } else if (tier === 2) {
      const line = n[k]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    } else {
      out.push(n[k]!);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
}

type Edit = (tree: Tree, ctx: Ctx) => void;

/** Detect the patch's format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fp = splitFile(before);
      if (line < 0 || line > fp.lines.length) throw new Fail('no-match', p);
      fp.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(fp));
    };
  }
  return null;
}

/** The JSON edits of a patch: one array, or one edit object a line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** ------- unified diffs (SPEC.md section 6) ------- */

interface Hunk {
  a: number;
  items: Item[];
  /** a `\` line follows the hunk's last context or `+` line */
  backslashAfterLast: boolean;
  /** a `\` line follows the hunk's last `+` line */
  backslashAfterLastPlus: boolean;
}

/** Read a hunk's body starting at `start`: the body lines, and where it ends. */
function readHunkBody(
  lines: string[],
  start: number,
): { items: Item[]; backslashAfterLast: boolean; backslashAfterLastPlus: boolean; next: number } {
  const body: string[] = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const items: Item[] = [];
  let lastCtxAdd = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ')) {
      items.push({ kind: 'ctx', text: l.slice(1) });
      lastCtxAdd = k;
    } else if (l.startsWith('-')) {
      items.push({ kind: 'del', text: l.slice(1) });
    } else if (l.startsWith('+')) {
      items.push({ kind: 'add', text: l.slice(1) });
      lastCtxAdd = k;
      lastPlus = k;
    } else if (l.startsWith('\\')) {
      // refers to the body line before it
    } else {
      items.push({ kind: 'ctx', text: '' });
      lastCtxAdd = k;
    }
  }
  const after = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]!.startsWith('\\');
  return {
    items,
    backslashAfterLast: after(lastCtxAdd),
    backslashAfterLastPlus: after(lastPlus),
    next: i,
  };
}

/** Parse a unified patch into its edits. */
function parseUnified(lines: string[]): Edit[] {
  interface Raw {
    pairOld?: string;
    pairNew?: string;
    renOld?: string;
    renNew?: string;
    diffOld?: string;
    diffNew?: string;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  }
  const sections: Raw[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const markerPath = (l: string): string => {
    let t = l.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return t.trim();
  };
  let cur: Raw | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1], diffNew: m[2], create: false, del: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = { create: false, del: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      // fall through: the header branch below reads the pair
    }
    if (cur !== null && inHeader && l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx === undefined || !nx.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      cur.pairOld = markerPath(l);
      cur.pairNew = markerPath(nx);
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('+++ ')) {
      cur.pairNew = markerPath(l);
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('rename from ')) {
      cur.renOld = l.slice('rename from '.length);
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('rename to ')) {
      cur.renNew = l.slice('rename to '.length);
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('new file mode')) {
      cur.create = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('deleted file mode')) {
      cur.del = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = readHunkBody(lines, i + 1);
      cur.hunks.push({
        a: Number(m[1]),
        items: body.items,
        backslashAfterLast: body.backslashAfterLast,
        backslashAfterLastPlus: body.backslashAfterLastPlus,
      });
      inHeader = false;
      i = body.next;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniEdit(s, stripAB));
}

/** One unified section as an edit. */
function uniEdit(
  s: {
    pairOld?: string;
    pairNew?: string;
    renOld?: string;
    renNew?: string;
    diffOld?: string;
    diffNew?: string;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  },
  stripAB: (p: string) => string,
): Edit {
  const devNull = (p: string | undefined): string | null | undefined =>
    p === undefined ? undefined : p === '/dev/null' ? null : p;
  const oldRaw =
    s.pairOld !== undefined ? stripAB(s.pairOld) : s.renOld !== undefined ? s.renOld : s.diffOld;
  const newRaw =
    s.pairNew !== undefined ? stripAB(s.pairNew) : s.renNew !== undefined ? s.renNew : s.diffNew;
  const oldPath = devNull(oldRaw);
  const newPath = devNull(newRaw);
  let kind: 'create' | 'delete' | 'move' | 'change';
  let path = '';
  let oldP = '';
  let newP = '';
  if (oldPath === null || s.create) {
    kind = 'create';
    path = newPath ?? '';
  } else if (newPath === null || s.del) {
    kind = 'delete';
    path = oldPath ?? '';
  } else if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) {
    kind = 'move';
    oldP = oldPath;
    newP = newPath;
  } else {
    kind = 'change';
    path = oldPath ?? newPath ?? '';
  }
  const hunks = s.hunks;
  return (tree, ctx) => {
    if (kind === 'create') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const plus: string[] = [];
      for (const h of hunks) for (const it of h.items) if (it.kind === 'add') plus.push(it.text);
      let finalBreak = true;
      for (let k = hunks.length - 1; k >= 0; k--) {
        const h = hunks[k]!;
        if (h.items.some((it) => it.kind === 'add')) {
          finalBreak = !h.backslashAfterLastPlus;
          break;
        }
      }
      tree.now.set(path, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (kind === 'move') {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const text = applyUniHunks(before, hunks, ctx.strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      ctx.moves.push([oldP, newP]);
      return;
    }
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    tree.now.set(path, applyUniHunks(before, hunks, ctx.strict, path));
  };
}

/** Apply a section's hunks in order to a file's text. */
function applyUniHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const fp = splitFile(before);
  const lines = [...fp.lines];
  let curFinal = fp.final;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: string[] = [];
    for (const it of h.items) {
      if (it.kind === 'ctx' || it.kind === 'del') o.push(it.text);
      if (it.kind === 'ctx' || it.kind === 'add') n.push(it.text);
    }
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...n);
      if (atEnd) curFinal = !h.backslashAfterLast;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const atEnd = pos + o.length === lines.length;
    const repl = applyItems(lines, pos, h.items, found.tier);
    lines.splice(pos, o.length, ...repl);
    if (atEnd) curFinal = !h.backslashAfterLast;
    d += n.length - o.length;
  }
  return joinFile({ lines, br: fp.br, final: curFinal });
}

/** ------- SEARCH/REPLACE blocks (SPEC.md section 7) ------- */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse SEARCH/REPLACE blocks into their edits. */
function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < n) {
    const l = lines[i]!;
    if (l.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!;
        if (t.trim() === '') continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let k = i + 1;
      while (k < n && lines[k]!.trimEnd() !== '=======') k++;
      if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, k);
      let m = k + 1;
      while (m < n && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') m++;
      if (m >= n) throw new Exit2(`error: parse ${searchLine}`);
      const newLines = lines.slice(k + 1, m);
      blocks.push({ path, oldLines, newLines });
      prevPath = path;
      prevEnd = m;
      i = m + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b));
}

/** One SEARCH/REPLACE block as an edit. */
function srEdit(b: SrBlock): Edit {
  const path = b.path;
  const oldLines = b.oldLines;
  const newLines = b.newLines;
  return (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fp = splitFile(before);
    const found = findTier(fp.lines, oldLines, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const items: Item[] = [
      ...oldLines.map((t): Item => ({ kind: 'del' as const, text: t })),
      ...newLines.map((t): Item => ({ kind: 'add' as const, text: t })),
    ];
    const repl = applyItems(fp.lines, pos, items, found.tier);
    const out = [...fp.lines.slice(0, pos), ...repl, ...fp.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines: out, br: fp.br, final: fp.final }));
  };
}

/** ------- V4A patches (SPEC.md section 8) ------- */

interface V4AChunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

/** Parse a V4A patch into its edits. */
function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSec {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLine: number;
    start: number;
    end: number;
  }
  const raws: RawSec[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    }
    if (kind !== null) {
      const path = l.slice(prefix.length).trim();
      let j = i + 1;
      while (j < last) {
        const t = lines[j]!;
        if (
          t.startsWith('*** Add File: ') ||
          t.startsWith('*** Delete File: ') ||
          t.startsWith('*** Update File: ')
        )
          break;
        j++;
      }
      raws.push({ kind, path, headerLine: i + 1, start: i + 1, end: j });
      i = j;
      continue;
    }
    if (blank(l)) {
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (raws.length === 0) throw new Exit2('error: parse 1');
  return raws.map((r) => v4aEdit(r, lines));
}

/** One V4A section as an edit. */
function v4aEdit(
  r: { kind: 'add' | 'delete' | 'update'; path: string; headerLine: number; start: number; end: number },
  lines: string[],
): Edit {
  let content = lines.slice(r.start, r.end);
  while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
  const lineNo = (k: number): number => r.start + k + 1;
  if (r.kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < content.length; k++) {
      const l = content[k]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${lineNo(k)}`);
    }
    const path = r.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (r.kind === 'delete') {
    for (let k = 0; k < content.length; k++) {
      if (!blank(content[k]!)) throw new Exit2(`error: parse ${lineNo(k)}`);
    }
    const path = r.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0]!.startsWith('*** Move to: ')) {
    moveTo = content[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  for (let k = idx; k < content.length; k++) {
    const l = content[k]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo(k)}`);
        cur = { anchor: null, items: [], eof: false };
        chunks.push(cur);
      }
      if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) cur.items.push({ kind: 'del', text: l.slice(1) });
      else if (l.startsWith('+')) cur.items.push({ kind: 'add', text: l.slice(1) });
      else cur.items.push({ kind: 'ctx', text: '' });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(k)}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${r.headerLine}`);
  const path = r.path;
  const move = moveTo;
  return (tree, ctx) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (move !== null && !safe(move)) throw new Fail('unsafe', move);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const fp = splitFile(before);
    const fileLines = [...fp.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTierFrom(fileLines, [ch.anchor], cursor, ctx.strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const o: string[] = [];
      const n: string[] = [];
      for (const it of ch.items) {
        if (it.kind === 'ctx' || it.kind === 'del') o.push(it.text);
        if (it.kind === 'ctx' || it.kind === 'add') n.push(it.text);
      }
      if (o.length === 0) {
        const at = ch.eof ? fileLines.length : cursor;
        fileLines.splice(at, 0, ...n);
        cursor = at + n.length;
        continue;
      }
      let found: { tier: number; occ: number[] } | null = null;
      if (ch.eof) {
        const tiers = ctx.strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = occurrences(fileLines, o, t).filter(
            (p) => p >= cursor && p + o.length === fileLines.length,
          );
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
      } else {
        found = findTierFrom(fileLines, o, cursor, ctx.strict);
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const repl = applyItems(fileLines, pos, ch.items, found.tier);
      fileLines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }
    const text = joinFile({ lines: fileLines, br: fp.br, final: fp.final });
    if (move !== null) {
      tree.now.set(path, null);
      tree.now.set(move, text);
      ctx.moves.push([path, move]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** ------- command line, output and exit codes (SPEC.md sections 1, 2, 10) ------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { strict, moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  interface Row {
    key: string;
    line: string;
    move?: [string, string];
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const [old, nw] of ctx.moves) {
    const oc = changed.get(old);
    const nc = changed.get(nw);
    if (
      oc !== undefined &&
      oc.was !== null &&
      oc.now === null &&
      nc !== undefined &&
      nc.was === null &&
      nc.now !== null
    ) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}`, move: [old, nw] });
      used.add(old);
      used.add(nw);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const r of rows) {
      if (r.move !== undefined) {
        const [old, nw] = r.move;
        rmSync(old, { force: true });
        mkdirSync(dirname(nw), { recursive: true });
        writeFileSync(nw, tree.now.get(nw)!);
      } else if (r.line.startsWith('D ')) {
        rmSync(r.line.slice(2), { force: true });
      } else {
        const p = r.line.slice(2);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, tree.now.get(p)!);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
