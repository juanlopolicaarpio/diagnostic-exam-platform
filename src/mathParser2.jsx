/**
 * MathRenderer.jsx
 *
 * Clean math rendering component built on react-latex-next.
 *
 * ARCHITECTURE:
 *   1. If content already has LaTeX delimiters → pass straight to react-latex-next
 *   2. If content is raw math text without delimiters → detect math segments,
 *      wrap them in \(...\), then pass to react-latex-next
 *   3. react-latex-next does ALL the actual rendering. We never call KaTeX directly.
 *
 * DESIGN RULES:
 *   - One pass to tokenize, one pass to normalize. No 20-step chained regex.
 *   - Never mutate already-delimited math.
 *   - Prefer false negatives (renders as text) over false positives (mangles prose).
 *   - The REAL fix is to have your AI return delimited LaTeX. This raw-math
 *     detection is a fallback for legacy/uncontrolled content.
 */

import { useMemo } from "react";
import Latex from "react-latex-next";
import "katex/dist/katex.min.css";

// ─── Configuration ───────────────────────────────────────────────────────────

const DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\(", right: "\\)", display: false },
  { left: "$", right: "$", display: false },
];

// ─── Layer 1: Detection ──────────────────────────────────────────────────────
// Does this string already contain LaTeX delimiters?

/**
 * Returns true if the content already has LaTeX delimiters that
 * react-latex-next can handle natively.
 */
export function hasDelimitedMath(text) {
  if (!text) return false;
  const s = String(text);
  if (s.includes("\\(") || s.includes("\\[") || s.includes("$$")) return true;
  // Single-dollar: must have a pair with content between them.
  // Avoid matching currency like "$5" by requiring non-digit after opening $.
  return /\$[^$\d][^$]*\$/.test(s);
}

// ─── Layer 2: Unicode normalization ──────────────────────────────────────────
// Convert unicode math symbols to LaTeX commands. This is safe to run on
// everything because it only touches unambiguous unicode codepoints.

const UNICODE_MAP = {
  // Superscript digits → we handle separately because they need ^{}
  "\u00B2": "^{2}", "\u00B3": "^{3}", "\u00B9": "^{1}",
  "\u2070": "^{0}", "\u2074": "^{4}", "\u2075": "^{5}",
  "\u2076": "^{6}", "\u2077": "^{7}", "\u2078": "^{8}", "\u2079": "^{9}",
  // Greek
  "\u03B1": "\\alpha", "\u03B2": "\\beta", "\u03B3": "\\gamma",
  "\u03B4": "\\delta", "\u03B5": "\\epsilon", "\u03B6": "\\zeta",
  "\u03B7": "\\eta", "\u03B8": "\\theta", "\u03B9": "\\iota",
  "\u03BA": "\\kappa", "\u03BB": "\\lambda", "\u03BC": "\\mu",
  "\u03BD": "\\nu", "\u03BE": "\\xi", "\u03C0": "\\pi",
  "\u03C1": "\\rho", "\u03C3": "\\sigma", "\u03C4": "\\tau",
  "\u03C5": "\\upsilon", "\u03C6": "\\phi", "\u03C7": "\\chi",
  "\u03C8": "\\psi", "\u03C9": "\\omega",
  "\u0398": "\\Theta", "\u03A3": "\\Sigma", "\u03A9": "\\Omega",
  "\u0393": "\\Gamma", "\u0394": "\\Delta", "\u03A0": "\\Pi",
  "\u03A6": "\\Phi", "\u039B": "\\Lambda",
  // Operators & relations
  "\u00D7": "\\times", "\u00F7": "\\div", "\u00B7": "\\cdot",
  "\u2212": "-", "\u00B1": "\\pm", "\u2213": "\\mp",
  "\u2264": "\\leq", "\u2265": "\\geq", "\u2260": "\\neq",
  "\u2248": "\\approx", "\u2261": "\\equiv", "\u221D": "\\propto",
  "\u221E": "\\infty",
  // Set & logic
  "\u2208": "\\in", "\u2209": "\\notin", "\u2282": "\\subset",
  "\u2286": "\\subseteq", "\u222A": "\\cup", "\u2229": "\\cap",
  "\u2200": "\\forall", "\u2203": "\\exists", "\u00AC": "\\neg",
  "\u2227": "\\land", "\u2228": "\\lor",
  "\u21D2": "\\Rightarrow", "\u21D4": "\\Leftrightarrow",
  "\u2192": "\\to", "\u2190": "\\leftarrow",
  // Misc
  "\u221A": "\\sqrt", "\u2202": "\\partial", "\u2207": "\\nabla",
  "\u00A0": " ",
};

const UNICODE_RE = new RegExp(
  "[" + Object.keys(UNICODE_MAP).join("") + "]", "g"
);

function normalizeUnicode(text) {
  return text.replace(UNICODE_RE, (ch) => UNICODE_MAP[ch] || ch);
}

// ─── Layer 3: Raw math → delimited math ──────────────────────────────────────
// This is the fallback for content that arrives WITHOUT delimiters.
// Strategy: identify segments that look like math, wrap them in \(...\).

/**
 * Patterns that strongly indicate a segment is math, not prose.
 * Each pattern is designed to match a complete math expression.
 */
const MATH_SEGMENT_PATTERNS = [
  // Function definitions: f(x) = ..., g(x) = ..., h(y) = ...
  /\b[a-zA-Z]\([^)]*\)\s*=\s*[^,;.!?\n]+/g,

  // Composed functions: f(g(x)), f(g(h(x)))
  /\b[a-zA-Z]\([^)]*\([^)]*\)[^)]*\)/g,

  // Equations with = and variables/operators: 2x + 3 = 7, x^2 - 1 = 0
  /(?<![a-zA-Z])(?:\d+[a-zA-Z]|[a-zA-Z])\s*(?:\^[{\d][^=]*?)?\s*[+\-*/]\s*[^=,;.!?\n]*=\s*[^,;.!?\n]+/g,

  // Expressions with exponents: x^2, x^{n+1}, (a+b)^3
  /(?:\([^)]+\)|[a-zA-Z])\s*\^\s*[{\d(][^,;.!?\s]*/g,

  // Fractions written as a/b or (expr)/(expr)
  /(?:\([^)]+\)|[a-zA-Z0-9]+)\s*\/\s*(?:\([^)]+\)|[a-zA-Z0-9]+)/g,

  // sqrt(...) or nth-root
  /\bsqrt\s*\([^)]*\)/gi,
  /\b\d+(?:st|nd|rd|th)[- ]?root\s*(?:\([^)]*\)|of\s+\S+)/gi,

  // LaTeX commands without delimiters: \frac{}{}, \sqrt{}, etc.
  /\\(?:frac|sqrt|log|sin|cos|tan|cdot|times|div|pm|mp|leq|geq|neq|alpha|beta|gamma|theta|pi|sigma|infty|sum|prod|int|lim|text|mathbb|left|right|begin|end)\b[^$]*/g,

  // Scientific notation: 3.2 × 10^5
  /\d+(?:\.\d+)?\s*(?:\\times|×|[xX])\s*10\s*\^\s*[{(]?-?\d+[})]?/g,

  // Logarithms: log₂(x), log_2(x), log2 x
  /\blog(?:[₀-₉]+|_?\d+|\(\d+\))\s*(?:\([^)]*\)|[a-zA-Z])/gi,

  // Trig: sin²θ, cos^2(x)
  /\b(?:sin|cos|tan|sec|csc|cot)(?:\s*\^\s*\d+)?\s*(?:\([^)]*\)|[a-zA-Z]|\\theta)/gi,

  // Inequalities: x > 3, x ≥ 0, x != 5
  /\b[a-zA-Z]\s*(?:>=|<=|!=|\\leq|\\geq|\\neq)\s*-?\d+(?:\.\d+)?/g,

  // Standalone simple expressions: 3x + 5, 2a - b (only if they have operators)
  /(?<![a-zA-Z])\d+[a-zA-Z]\s*[+\-]\s*(?:\d+[a-zA-Z]|\d+|[a-zA-Z])(?:\s*[+\-]\s*(?:\d+[a-zA-Z]|\d+|[a-zA-Z]))*/g,
];

/**
 * Check if a matched segment is actually math (not a false positive).
 * Filters out things like English words, URLs, etc.
 */
function isLikelyMath(segment) {
  const trimmed = segment.trim();
  if (trimmed.length < 2) return false;

  // Already has LaTeX commands → definitely math
  if (/\\[a-zA-Z]/.test(trimmed)) return true;

  // Has math operators or structures → likely math
  if (/[\^=]/.test(trimmed) && /[a-zA-Z]/.test(trimmed)) return true;
  if (/\d+[a-zA-Z]\s*[+\-]/.test(trimmed)) return true;
  if (/\//.test(trimmed) && /[a-zA-Z]/.test(trimmed) && !/^https?:/.test(trimmed)) return true;

  // If it's purely English words with no math signals, skip it
  const words = trimmed.split(/\s+/);
  const englishWordCount = words.filter((w) => /^[a-zA-Z]{4,}$/.test(w)).length;
  if (englishWordCount > words.length * 0.5) return false;

  return true;
}

/**
 * Normalize a raw math expression into valid LaTeX (without delimiters).
 * This handles the conversion of plain-text math notation to LaTeX commands.
 */
function normalizeExpression(expr) {
  let text = expr.trim();

  // Unicode first (already handled globally, but safe to re-run)
  text = normalizeUnicode(text);

  // sqrt(...) → \sqrt{...}
  text = text.replace(/\bsqrt\s*\(([^)]*)\)/gi, (_, inner) => `\\sqrt{${inner}}`);

  // Exponents: ensure multi-char exponents have braces
  // x^12 → x^{12}, x^-2 → x^{-2}, but x^2 stays x^2
  text = text.replace(/\^\s*\(([^)]+)\)/g, "^{$1}");
  text = text.replace(/\^\s*(-\d+)/g, "^{$1}");
  text = text.replace(/\^\s*(\d{2,})/g, "^{$1}");
  text = text.replace(/\^\s*([a-zA-Z]{2,}[^{]*?)(?=\s|$|[+\-=)<>])/g, "^{$1}");

  // Simple fractions: only when unambiguous (single tokens around /)
  // a/b → \frac{a}{b} but NOT "hello/world"
  text = text.replace(
    /(?<=^|[+\-=(\s])(\d+|[a-zA-Z](?:\^\{?[^}]*\}?)?)\s*\/\s*(\d+|[a-zA-Z](?:\^\{?[^}]*\}?)?)(?=$|[+\-=)\s])/g,
    (_, num, den) => `\\frac{${num}}{${den}}`
  );

  // Grouped fractions: (expr)/(expr) → \frac{expr}{expr}
  text = text.replace(
    /\(([^)]+)\)\s*\/\s*\(([^)]+)\)/g,
    (_, num, den) => `\\frac{${num}}{${den}}`
  );

  // Named functions that KaTeX expects with backslash
  text = text.replace(
    /(?<!\\)\b(sin|cos|tan|sec|csc|cot|log|ln|exp|lim|min|max|gcd|det)\b/g,
    "\\$1"
  );

  // Dot multiplication: standardize
  text = text.replace(/\s+dot\s+/gi, " \\cdot ");
  text = text.replace(/(?<=\d)\s*\*\s*(?=\d)/g, " \\cdot ");

  // Log bases: log_2(x) or log2(x)
  text = text.replace(
    /\\log\s*_?\s*(\d+)\s*\(([^)]*)\)/g,
    "\\log_{$1}($2)"
  );

  // Unicode subscript digits for log bases
  const subDigits = { "₀":"0","₁":"1","₂":"2","₃":"3","₄":"4","₅":"5","₆":"6","₇":"7","₈":"8","₉":"9" };
  text = text.replace(
    /\\log\s*([₀-₉]+)/g,
    (_, subs) => `\\log_{${[...subs].map((c) => subDigits[c] || c).join("")}}`
  );

  return text;
}

/**
 * Take a string with NO delimiters and try to wrap math segments in \(...\).
 * Non-math text is left alone.
 *
 * Strategy: collect all regex matches with their positions, merge overlapping
 * ranges, then wrap each range in delimiters.
 */
function wrapRawMathSegments(text) {
  // Collect all match ranges
  const ranges = [];

  for (const pattern of MATH_SEGMENT_PATTERNS) {
    // Reset lastIndex for global regexes
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      const seg = match[0];
      if (isLikelyMath(seg)) {
        ranges.push({ start: match.index, end: match.index + seg.length });
      }
    }
  }

  if (ranges.length === 0) return text;

  // Sort by start position, then merge overlapping/adjacent ranges
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = ranges[i];
    if (curr.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push(curr);
    }
  }

  // Build result: plain text between ranges, wrapped math inside ranges
  let result = "";
  let cursor = 0;

  for (const range of merged) {
    // Text before this math segment
    result += text.slice(cursor, range.start);

    // The math segment, normalized and wrapped
    const raw = text.slice(range.start, range.end).trim();
    const normalized = normalizeExpression(raw);

    // Strip trailing punctuation out of the math, keep it outside
    const trailingPunc = normalized.match(/[.,;:?!]+$/)?.[0] || "";
    const mathBody = trailingPunc
      ? normalized.slice(0, -trailingPunc.length).trim()
      : normalized;

    result += `\\( ${mathBody} \\)${trailingPunc}`;
    cursor = range.end;
  }

  result += text.slice(cursor);
  return result;
}

// ─── Layer 4: The component ──────────────────────────────────────────────────

/**
 * MathRenderer — the main export.
 *
 * Props:
 *   children (string)  — the content to render
 *   display  (boolean) — if true, forces display mode for the entire content
 *   raw      (boolean) — if true, forces raw-math detection even if no
 *                         delimiters are found. Defaults to true.
 *   style    (object)  — passed to wrapper span
 *   className (string) — passed to wrapper span
 *
 * Usage:
 *
 *   // Content WITH delimiters (ideal path — AI returns proper LaTeX)
 *   <MathRenderer>{"Solve $2x + 3 = 7$ for $x$."}</MathRenderer>
 *
 *   // Content WITHOUT delimiters (fallback — raw math detection)
 *   <MathRenderer>{"Solve 2x + 3 = 7 for x."}</MathRenderer>
 *
 *   // Display mode equation
 *   <MathRenderer>{"$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$"}</MathRenderer>
 *
 *   // Structured blocks from API
 *   <MathRenderer blocks={[
 *     { type: "text", value: "The answer is " },
 *     { type: "math", value: "x = 5" },
 *   ]} />
 */
export function MathRenderer({
  children,
  blocks,
  display = false,
  raw = true,
  style,
  className,
}) {
  const content = useMemo(() => {
    // If structured blocks are provided, convert them to a delimited string
    if (blocks && Array.isArray(blocks)) {
      return blocks
        .map((block) => {
          const type = block.type || "text";
          const val = String(block.value || "");
          if (type === "math" || type === "inlineMath") return `\\( ${normalizeExpression(val)} \\)`;
          if (type === "displayMath" || type === "blockMath") return `\\[ ${normalizeExpression(val)} \\]`;
          return val;
        })
        .join("");
    }

    let text = String(children || "");
    if (!text.trim()) return "";

    // Step 1: Always normalize unicode (safe, no false positives)
    text = normalizeUnicode(text);

    // Step 2: If content already has delimiters, normalize the math inside
    // each delimited region and pass through
    if (hasDelimitedMath(text)) {
      // Normalize the LaTeX inside existing delimiters
      text = text.replace(
        /\\\(([^]*?)\\\)|\\\[([^]*?)\\\]|\$\$([^]*?)\$\$/g,
        (match, inline, display, doubleDollar) => {
          if (inline !== undefined) return `\\( ${normalizeExpression(inline)} \\)`;
          if (display !== undefined) return `\\[ ${normalizeExpression(display)} \\]`;
          if (doubleDollar !== undefined) return `$$ ${normalizeExpression(doubleDollar)} $$`;
          return match;
        }
      );
      // Also handle single-dollar inline: $...$
      // (but not $$, which was already handled above)
      text = text.replace(
        /(?<!\$)\$(?!\$)([^$]+?)\$(?!\$)/g,
        (_, inner) => `$ ${normalizeExpression(inner)} $`
      );
      return text;
    }

    // Step 3: No delimiters found. If raw detection is enabled, try to
    // identify and wrap math segments.
    if (raw) {
      text = wrapRawMathSegments(text);
    }

    // Step 4: If display mode is forced and there's no display delimiter,
    // wrap the whole thing
    if (display && !text.includes("$$") && !text.includes("\\[")) {
      const inner = text.replace(/\\\(\s*/g, "").replace(/\s*\\\)/g, "");
      return `\\[ ${normalizeExpression(inner)} \\]`;
    }

    return text;
  }, [children, blocks, display, raw]);

  return (
    <span style={style} className={className}>
      <Latex delimiters={DELIMITERS} strict={false}>
        {content}
      </Latex>
    </span>
  );
}

// ─── Convenience exports ─────────────────────────────────────────────────────

/**
 * For when you KNOW the content is a single math expression (no mixed text).
 * Wraps it in display or inline delimiters and renders.
 */
export function MathExpr({ children, display = false, style, className }) {
  const latex = useMemo(() => {
    const normalized = normalizeExpression(normalizeUnicode(String(children || "")));
    return display ? `\\[ ${normalized} \\]` : `\\( ${normalized} \\)`;
  }, [children, display]);

  return (
    <span style={style} className={className}>
      <Latex delimiters={DELIMITERS} strict={false}>
        {latex}
      </Latex>
    </span>
  );
}

/**
 * For rendering choice options in quizzes — handles the common case where
 * a choice might be plain text, might be math, might be a mix.
 */
export function MathChoice({ children, style, className }) {
  return (
    <MathRenderer raw={true} style={style} className={className}>
      {children}
    </MathRenderer>
  );
}

export function MathContent({ value, content, blocks, style, className }) {
  return (
    <MathRenderer blocks={blocks} style={style} className={className}>
      {content ?? value}
    </MathRenderer>
  );
}

export function ChoiceContent({ value, style, className }) {
  return (
    <MathChoice style={style} className={className}>
      {value}
    </MathChoice>
  );
}

export default MathRenderer;
