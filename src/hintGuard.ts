/**
 * HintLab hint guard.
 *
 * Before a hint is stored or sent to the student, it is checked here. If it
 * contains a fenced code block, inline code that is more than a short
 * identifier/expression, multiple source-code-like lines, or anything that looks
 * like a rewritten solution, it is rejected (and give_hint returns an error so
 * the model rephrases without code).
 */

export interface HintCheck {
  ok: boolean;
  reason?: string;
}

/** Builtins whose `name(` form is a strong signal of a code expression. */
const CODE_FUNCTION_RE =
  /\b(?:range|len|sum|print|printf|scanf|input|append|split|map|list|int|float|str|lower|replace|strip|reversed|enumerate|zip|sorted|min|max|open|read|write|fgets|gets|puts)\s*\(/;

/** A single line that looks like actual source code / a rewritten solution. */
const CODE_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*(def|class|import|from|return|print|printf|scanf|#include|else|elif)\b/,
  /^\s*(for|while|if)\s*\(/, // C control structures
  /^\s*(for|while|if|elif|else)\b[^:]*:$/, // Python control structures ending in ":"
  /\bfor\s+\w+\s+in\s/, // Python for ... in
  CODE_FUNCTION_RE,
  /[A-Za-z_]\w*\s*(?:=|\+=|-=|\*=|\/=|%=)\s*[^=]/, // assignment
  /\b(?:int|float|double|char|void|long|short|unsigned)\s+\w+\s*[=;(\[]/, // C declaration
  /(?:\(float\)|\(int\)|\(double\)|\(char\))/, // C casts (e.g. (float) sum / n)
  /;\s*$/, // trailing semicolon (C statement)
  /->/, // C struct/member dereference
];

function looksLikeCodeLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  return CODE_LINE_PATTERNS.some((re) => re.test(s));
}

/**
 * Check a hint's text. Returns `{ ok: true }` when it is safe to show, otherwise
 * `{ ok: false, reason }` describing what made it look like code.
 */
export function checkHint(text: string): HintCheck {
  const t = text.trim();
  if (!t) return { ok: false, reason: "empty hint" };

  // 1. Fenced code blocks.
  if (t.includes("```")) {
    return { ok: false, reason: "contains a fenced code block" };
  }

  // 2. Inline code spans: allow only a short identifier/expression.
  const inline = t.matchAll(/`([^`\n]+)`/g);
  for (const m of inline) {
    const code = m[1].trim();
    if (code.length > 20) {
      return { ok: false, reason: "inline code is longer than a short identifier/expression" };
    }
    // Reject inline code that is clearly an expression rather than a plain name.
    if (/[(){}=<>;,]|->/.test(code)) {
      return { ok: false, reason: "inline code looks like an expression" };
    }
  }

  // 3. Any line that looks like source code / a rewritten solution.
  const lines = t.split("\n");
  if (lines.some(looksLikeCodeLine)) {
    return { ok: false, reason: "text looks like source code or a rewritten solution" };
  }

  return { ok: true };
}
