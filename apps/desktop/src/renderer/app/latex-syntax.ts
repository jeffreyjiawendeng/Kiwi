/**
 * LaTeX source, read well enough to colour it.
 *
 * Not a parser. Nothing here builds a tree or understands what a command means; it walks the
 * source once and says which stretches are commands, maths, comments, environment names, and
 * braces, so the editor can paint them. Source that does not compile still has to be coloured:
 * a brace that is never closed is the most likely thing a person is looking at when they turn
 * the colour on, so every scan here stops at the end of the buffer rather than giving up.
 *
 * Everything is offsets into the string the caller passed. The editor holds the buffer.
 */

export type TokenKind = "command" | "environment" | "math" | "comment" | "brace";

export interface SyntaxToken {
  kind: TokenKind;
  from: number;
  to: number;
}

/** Half-open, like everything else here: `from` is included and `to` is not. */
export interface SourceRange {
  from: number;
  to: number;
}

/** One stretch of the source as the editor paints it. */
export interface SourceSpan {
  text: string;
  kind: TokenKind | null;
  /** Part of the pair the caret is sitting on. */
  match: boolean;
}

const LETTER = /[A-Za-z]/u;

function isLetter(char: string | undefined): boolean {
  return char !== undefined && LETTER.test(char);
}

/** Where the line the offset is on ends, or the end of the buffer for the last one. */
function lineEnd(source: string, at: number): number {
  const found = source.indexOf("\n", at);
  return found === -1 ? source.length : found;
}

/**
 * The environment name after `\begin` or `\end`, as `{`, the name, and `}`.
 *
 * Returns where it left off, which is where it started when what follows is not a name at all.
 * `\begin` on its own line with the name on the next one is not read as an environment; TeX
 * would take it, but a person editing has almost certainly not finished typing.
 */
function readEnvironmentName(source: string, at: number, tokens: SyntaxToken[]): number {
  let open = at;
  while (source[open] === " " || source[open] === "\t") open += 1;
  if (source[open] !== "{") return at;
  const close = source.indexOf("}", open + 1);
  if (close === -1) return at;
  const name = source.slice(open + 1, close);
  if (name.includes("\n")) return at;
  tokens.push({ kind: "brace", from: open, to: open + 1 });
  if (close > open + 1) tokens.push({ kind: "environment", from: open + 1, to: close });
  tokens.push({ kind: "brace", from: close, to: close + 1 });
  return close + 1;
}

/**
 * A backslash and what it introduces.
 *
 * `\[` and `\(` open maths rather than name a command, and `\%` is two characters that stand for
 * one, neither is a word, and both would be read wrongly by looking only at letters.
 */
function readCommand(source: string, at: number, tokens: SyntaxToken[]): number {
  const next = source[at + 1];
  if (next === undefined) {
    tokens.push({ kind: "command", from: at, to: at + 1 });
    return at + 1;
  }
  if (next === "[" || next === "(") {
    const closer = next === "[" ? "\\]" : "\\)";
    const found = source.indexOf(closer, at + 2);
    const end = found === -1 ? source.length : found + closer.length;
    tokens.push({ kind: "math", from: at, to: end });
    return end;
  }
  if (!isLetter(next)) {
    tokens.push({ kind: "command", from: at, to: at + 2 });
    return at + 2;
  }
  let end = at + 1;
  while (isLetter(source[end])) end += 1;
  if (source[end] === "*") end += 1;
  const name = source.slice(at + 1, end);
  tokens.push({ kind: "command", from: at, to: end });
  if (name !== "begin" && name !== "end") return end;
  return readEnvironmentName(source, end, tokens);
}

/** `$...$` and `$$...$$`. An escaped `\$` inside does not close it. */
function readDollarMath(source: string, at: number, tokens: SyntaxToken[]): number {
  const display = source[at + 1] === "$";
  let scan = at + (display ? 2 : 1);
  while (scan < source.length) {
    const char = source[scan];
    if (char === "\\") {
      scan += 2;
      continue;
    }
    if (char === "$") {
      if (!display) {
        tokens.push({ kind: "math", from: at, to: scan + 1 });
        return scan + 1;
      }
      if (source[scan + 1] === "$") {
        tokens.push({ kind: "math", from: at, to: scan + 2 });
        return scan + 2;
      }
    }
    scan += 1;
  }
  tokens.push({ kind: "math", from: at, to: source.length });
  return source.length;
}

/**
 * The whole buffer, in order, with nothing overlapping.
 *
 * Maths is one token rather than a region with commands coloured inside it. The colour is there
 * to say where the maths is; a second colouring inside it says less and costs more.
 */
export function tokenizeLatex(source: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === "%") {
      const end = lineEnd(source, at);
      tokens.push({ kind: "comment", from: at, to: end });
      at = end;
    } else if (char === "\\") {
      at = readCommand(source, at, tokens);
    } else if (char === "$") {
      at = readDollarMath(source, at, tokens);
    } else if (char === "{" || char === "}") {
      tokens.push({ kind: "brace", from: at, to: at + 1 });
      at += 1;
    } else {
      at += 1;
    }
  }
  return tokens;
}

export interface DelimiterPair {
  open: number;
  close: number;
}

/**
 * Braces and brackets that close, paired innermost first.
 *
 * A comment is skipped whole, and a backslash takes the character after it with it, so `\{` and a
 * `%` on a line of prose never pair with anything. One that never closes is simply not in the
 * list, which is what makes an unbalanced document safe to sit in.
 */
export function delimiterPairs(source: string): DelimiterPair[] {
  const pairs: DelimiterPair[] = [];
  const braces: number[] = [];
  const brackets: number[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === "%") {
      at = lineEnd(source, at);
      continue;
    }
    if (char === "\\") {
      // Two characters, whether it is an escape or the start of a word: the letters of a command
      // hold no delimiters either way.
      at += 2;
      continue;
    }
    if (char === "{") braces.push(at);
    else if (char === "[") brackets.push(at);
    else if (char === "}" || char === "]") {
      const open = (char === "}" ? braces : brackets).pop();
      if (open !== undefined) pairs.push({ open, close: at });
    }
    at += 1;
  }
  return pairs;
}

export interface EnvironmentPair {
  begin: SourceRange;
  end: SourceRange;
  name: string;
}

/**
 * `\begin{proof}` with the `\end{proof}` that closes it.
 *
 * Matched by name as well as by nesting. An `\end` that names something else is left alone rather
 * than closing whatever happens to be open: the document is being typed, and closing the wrong
 * environment would draw a pair that is not there.
 */
export function environmentPairs(source: string): EnvironmentPair[] {
  const tokens = tokenizeLatex(source);
  const open: Array<{ name: string; range: SourceRange }> = [];
  const pairs: EnvironmentPair[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "command") continue;
    const word = source.slice(token.from, token.to);
    if (word !== "\\begin" && word !== "\\end") continue;
    const name = tokens[index + 2];
    const closer = tokens[index + 3];
    if (name === undefined || name.kind !== "environment") continue;
    if (closer === undefined || closer.kind !== "brace") continue;
    const range: SourceRange = { from: token.from, to: closer.to };
    const label = source.slice(name.from, name.to);
    if (word === "\\begin") {
      open.push({ name: label, range });
      continue;
    }
    const started = open.at(-1);
    if (started === undefined || started.name !== label) continue;
    open.pop();
    pairs.push({ begin: started.range, end: range, name: label });
  }
  return pairs;
}

function holds(range: SourceRange, at: number): boolean {
  return at >= range.from && at <= range.to;
}

/**
 * The pair the caret is on, if it is on one.
 *
 * An environment is answered first and from anywhere inside `\begin{...}`, because that is the
 * pair a person standing there is asking about. A brace is answered only from beside it, and the
 * one behind the caret wins, which is where it lands after typing a closing brace.
 */
export function matchDelimiters(source: string, caret: number): [SourceRange, SourceRange] | null {
  for (const pair of environmentPairs(source)) {
    if (holds(pair.begin, caret) || holds(pair.end, caret)) return [pair.begin, pair.end];
  }
  const pairs = delimiterPairs(source);
  for (const side of [caret - 1, caret]) {
    const pair = pairs.find((one) => one.open === side || one.close === side);
    if (pair !== undefined) {
      return [
        { from: pair.open, to: pair.open + 1 },
        { from: pair.close, to: pair.close + 1 },
      ];
    }
  }
  return null;
}

/**
 * The buffer cut into the stretches the editor paints, covering it exactly and in order.
 *
 * Cut at every token edge and at both edges of the matched pair, then joined back up wherever two
 * neighbours would be painted the same way. What comes out is a list to render, not a list of
 * tokens: a run of ordinary prose between two commands is one span, however long it is.
 */
export function highlightSpans(source: string, caret: number | null): SourceSpan[] {
  const tokens = tokenizeLatex(source);
  const marks = caret === null ? [] : (matchDelimiters(source, caret) ?? []);
  const cuts = new Set<number>([0, source.length]);
  for (const token of tokens) {
    cuts.add(token.from);
    cuts.add(token.to);
  }
  for (const mark of marks) {
    cuts.add(mark.from);
    cuts.add(mark.to);
  }
  const edges = [...cuts].sort((left, right) => left - right);
  const spans: SourceSpan[] = [];
  // Both lists are in order, so the token covering each stretch is found by walking, not searching.
  let cursor = 0;
  for (const [index, from] of edges.entries()) {
    const to = edges[index + 1];
    if (to === undefined || to <= from) continue;
    let token = tokens[cursor];
    while (token !== undefined && token.to <= from) {
      cursor += 1;
      token = tokens[cursor];
    }
    const kind = token !== undefined && token.from <= from ? token.kind : null;
    const match = marks.some((mark) => mark.from <= from && mark.to >= to);
    const last = spans.at(-1);
    if (last !== undefined && last.kind === kind && last.match === match) {
      last.text += source.slice(from, to);
      continue;
    }
    spans.push({ text: source.slice(from, to), kind, match });
  }
  return spans;
}
