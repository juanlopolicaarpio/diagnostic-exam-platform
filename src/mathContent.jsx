import katex from "katex";
import "katex/dist/katex.min.css";

const MATH_DELIMITER_RE = /(\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$)/g;
const DOT_OP_RE = /[\u00b7\u00d7*]/g;
const MATH_WORDS = new Set(["sqrt", "root", "of", "frac", "cdot", "div", "times", "sin", "cos", "tan", "log", "ln", "cm", "mm", "m", "km"]);

function readStructured(value) {
  if (!value) return null;
  if (Array.isArray(value)) return { promptBlocks: value };
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { promptBlocks: parsed };
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    return null;
  }

  return null;
}

export function containsMath(content) {
  const text = String(content || "");
  return text.includes("\\(") || text.includes("\\[") || text.includes("$$");
}

function shouldAutoConvertSubject(subject) {
  const normalized = String(subject || "").trim().toLowerCase();
  return normalized === "mathematics"
    || normalized === "math"
    || normalized === "maths"
    || normalized === "science"
    || normalized === "physics"
    || normalized === "chemistry"
    || normalized === "biology"
    || normalized.includes("mathematics")
    || normalized.includes("math")
    || normalized.includes("science")
    || normalized.includes("physics")
    || normalized.includes("chemistry")
    || normalized.includes("biology");
}

function hasBareLatexCommand(content) {
  return /\\(?:frac|sqrt|cdot|left|right|log|times|in|ne|le|ge|mathbb)\b/.test(String(content || ""));
}

function hasStrongRawMathSignal(content) {
  const text = String(content || "");
  return hasBareLatexCommand(text)
    || /\blog[\u2080-\u2089]\s*[A-Za-z0-9(]/i.test(text)
    || /\blog\s*\(\s*\d+\s*\)\s*[A-Za-z0-9(]/i.test(text)
    || /\blog_?\d+\s*[A-Za-z0-9(]/i.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:\u00d7|x|X|\\times)\s*10(?:\^?\s*-?\d+|\d+)\b/.test(text)
    || /[A-Za-z0-9)}\]]\s+dot\s+[A-Za-z0-9([{]/i.test(text)
    || /[A-Za-z0-9)\]}]\s*\^\s*\(?[A-Za-z0-9/+\-]+\)?/.test(text)
    || /[A-Za-z0-9)\]}]\s*(?:\/|[\u00b7\u00d7*])\s*[A-Za-z0-9([{\u221a\\]/.test(text)
    || /\b\d+[A-Za-z]\s*\{?\s*\|[^|]+\|\s*\}?/.test(text)
    || /[A-Za-z0-9)]\s*\/\s*\|[^|]+\|/.test(text)
    || /\b[A-Za-z]\s*(?:>=|<=|\u2260|!=)\s*-?\d+(?:\.\d+)?/.test(text);
}

function shouldAutoConvertContent(content, subject) {
  if (!shouldAutoConvertSubject(subject)) return false;

  return hasBareLatexCommand(content)
    || isMathOnlyContent(content)
    || hasStrongRawMathSignal(content);
}

function hasRawMathSignal(content) {
  const text = String(content || "");
  return /\\(?:frac|sqrt|cdot|left|right|log|times|mid|in|ne|le|ge|mathbb)\b/.test(text)
    || /\blog[\u2080-\u2089]\s*[A-Za-z0-9(]/i.test(text)
    || /\blog\s*\(\s*\d+\s*\)\s*[A-Za-z0-9(]/i.test(text)
    || /\blog_?\d+\s*[A-Za-z0-9(]/i.test(text)
    || /\bsqrt\s*\(/i.test(text)
    || /\b\d*\s*sqrt\s*\(/i.test(text)
    || /\b\d+(?:st|nd|rd|th)-root\b/i.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:\u00d7|x|X|\\times)\s*10(?:\^?\s*-?\d+|\d+)\b/.test(text)
    || /[A-Za-z0-9)}\]]\s+dot\s+[A-Za-z0-9([{]/i.test(text)
    || /\b(?:\d+(?:\.\d+)?\s*)?(?:cm|mm|m|km)\s*\^\s*\d+\b/i.test(text)
    || /(?:\d+(?:\.\d+)?|\([^()]+\))\s*\u03c0(?:\s*\/\s*\d+)?/i.test(text)
    || /\b(?:sin|cos|tan|sec|csc|cot)\s*\^\s*\d+\s*[\u03b8A-Za-z]/i.test(text)
    || /\b[A-Za-z]\([^)]*\)\s*=/.test(text)
    || /\b[A-Za-z]\([^)]*\([^)]*\)[^)]*\)/.test(text)
    || /[\u00b2\u00b3\u00b9\u2070-\u2079]\s*\u221a/.test(text)
    || /\u221a\s*[A-Za-z0-9]/.test(text)
    || /\b[A-Za-z]\s*(?:>=|<=|>|<|\u2260|!=)\s*-?\d+(?:\.\d+)?/.test(text)
    || /[A-Za-z0-9)\]}]\s*\^\s*\(?[A-Za-z0-9/+\-]+\)?/.test(text)
    || /\b\d*[A-Za-z]\^\d+[A-Za-z]?(?:\s*[+\-]\s*\d*[A-Za-z]\^\d+[A-Za-z]?)+/.test(text)
    || /\b\d*[A-Za-z]\^[{\d][A-Za-z0-9{}^]*(?:\s*[+\-]\s*\d*[A-Za-z]\^[{\d][A-Za-z0-9{}^]*)+/.test(text)
    || /\b[A-Z]{1,3}\s*=\s*(?:[A-Za-z]|\([^()]+\)\s*\^\s*\d+|-?\d+(?:\.\d+)?)\b/.test(text)
    || /\([^()]+\)\s*\^\s*\d+/.test(text)
    || /\{[^{}]*(?:\u2208|\u2260|\|)[^{}]*\}/.test(text)
    || /\|[^|]+\|/.test(text)
    || /\b\d+[A-Za-z]\s*\{?\s*\|[^|]+\|\s*\}?/.test(text)
    || /[A-Za-z0-9)]\s*\/\s*\|[^|]+\|/.test(text)
    || /[A-Za-z0-9)\]}]\s*(?:\/|[\u00b7\u00d7*])\s*[A-Za-z0-9([{\u221a\\]/.test(text);
}

function isMathOnlyContent(content) {
  const text = String(content || "").trim();
  if (!text || containsMath(text) || !hasRawMathSignal(text)) return false;
  if (!/^[A-Za-z0-9\s()[\]{}+\-*/^=:.,?|\u00b7\u00d7\u221a\u00b2\u00b3\u00b9\u2070-\u2079\u03b8\u03c0\u2208\u2260\\]+$/.test(text)) return false;

  const words = text.match(/[A-Za-z]+/g) || [];
  return words.every((word) => word.length <= 2 || MATH_WORDS.has(word.toLowerCase()));
}

function repairMalformedLatex(value) {
  return String(value || "")
    .replace(/([A-Za-z])\^\{(\d+)([A-Za-z])\}\^(\d+)/g, "$1^$2 \\cdot $3^$4")
    .replace(/([A-Za-z])\^(\d+)\{([A-Za-z])\}\^(\d+)/g, "$1^$2 $3^$4")
    .replace(/([A-Za-z])\^\{(\d+)\}/g, (_, base, exponent) => {
      return exponent.length === 1 ? `${base}^${exponent}` : `${base}^{${exponent}}`;
    });
}

function normalizePlainTextSpacing(value) {
  return normalizeInputEncoding(value)
    .replace(/\)\s*(equivalentto|equivalent\s+to)\b/gi, ") equivalent to")
    .replace(/\\\)\s*(equivalentto|equivalent\s+to)\b/gi, "\\) equivalent to")
    .replace(/\bequivalentto\b/gi, "equivalent to")
    .replace(/\bequalto\b/gi, "equal to")
    .replace(/\bwhat\s+isy\b/gi, "what is y")
    .replace(/\b(to|from|into|onto|is|if|find|simplify)(if|to|x)\b/gi, "$1 $2")
    .replace(/\b(where|and|or|if|when)([A-Za-z])(?=\s*(?:[<>=\u2260^()+\-/*]|\b))/gi, "$1 $2")
    .replace(/(\d)\s*(and|or|where|if)([A-Za-z])(?=\s*(?:[<>=\u2260^()+\-/*]|\b))/gi, "$1 $2 $3")
    .replace(/([A-Za-z])\s*(and|or)([A-Za-z])(?=\s*(?:[<>=\u2260^()+\-/*]|\b))/gi, "$1 $2 $3")
    .replace(/\s+/g, " ");
}

function normalizeInputEncoding(value) {
  const mathItalicLower = Array.from("𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧");
  const mathItalicUpper = Array.from("𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍");
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  let text = String(value || "")
    .replace(/Â²/g, "²")
    .replace(/Â³/g, "³")
    .replace(/Â¹/g, "¹")
    .replace(/Â·/g, "·")
    .replace(/Ã—/g, "×")
    .replace(/âˆš/g, "√")
    .replace(/â‰¤/g, "≤")
    .replace(/â‰¥/g, "≥")
    // The U+00A0 below is part of the mojibake byte sequence being matched
    // (double-encoded not-equals), not stray formatting. Removing it breaks the repair.
    // eslint-disable-next-line no-irregular-whitespace
    .replace(/â‰ /g, "≠")
    .replace(/âˆ’/g, "−")
    .replace(/ð‘š/g, "m")
    .replace(/ð‘¦/g, "y");

  for (let index = 0; index < lower.length; index += 1) {
    text = text
      .replaceAll(mathItalicLower[index], lower[index])
      .replaceAll(mathItalicUpper[index], upper[index]);
  }

  return text;
}

function normalizeUnicodeMathSyntax(value) {
  const superscriptMap = {
    "\u2070": "0",
    "\u00b9": "1",
    "\u00b2": "2",
    "\u00b3": "3",
    "\u2074": "4",
    "\u2075": "5",
    "\u2076": "6",
    "\u2077": "7",
    "\u2078": "8",
    "\u2079": "9",
  };

  let text = normalizeInputEncoding(value);
  text = text.replace(/([\u00b2\u00b3\u00b9\u2070-\u2079]+)\s*\u221a/g, (_, degree) => {
    return `${[...degree].map((ch) => superscriptMap[ch] || ch).join("")}\\sqrt`;
  });
  text = text.replace(/([A-Za-z0-9)}\]])([\u00b2\u00b3\u00b9\u2070-\u2079]+)/g, (_, base, exponent) => {
    return `${base}^${[...exponent].map((ch) => superscriptMap[ch] || ch).join("")}`;
  });
  return text;
}

function unwrapMathDelimiters(value) {
  const text = String(value || "").trim();
  if (text.startsWith("\\(") && text.endsWith("\\)")) return text.slice(2, -2);
  if (text.startsWith("\\[") && text.endsWith("\\]")) return text.slice(2, -2);
  if (text.startsWith("$$") && text.endsWith("$$")) return text.slice(2, -2);
  return text;
}

function stripOuterParens(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("(") || !text.endsWith(")")) return text;

  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    if (text[i] === ")") depth -= 1;
    if (depth === 0 && i < text.length - 1) return text;
  }
  return text.slice(1, -1).trim();
}

function splitTopLevel(value, separators) {
  const text = String(value || "");
  let depth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && separators.includes(ch)) {
      return [text.slice(0, i).trim(), ch, text.slice(i + 1).trim()];
    }
  }

  return null;
}

function normalizeRadicand(value) {
  const text = String(value || "").trim();
  const exponentSum = text.match(/^([A-Za-z0-9]+)\s*\^\s*([A-Za-z0-9]+)\s*([+-])\s*([A-Za-z0-9]+)$/);
  if (exponentSum) {
    const [, base, left, op, right] = exponentSum;
    return `${base}^{${left}${op}${right}}`;
  }
  return normalizeMathExpression(text);
}

function normalizeRoots(value) {
  return String(value || "")
    .replace(/\b(\d+)\s*\\sqrt\s*\(([^()]*)\)/gi, (_, degree, radicand) => {
      return `\\sqrt[${degree}]{${normalizeRadicand(radicand)}}`;
    })
    .replace(/\b(\d+)(?:st|nd|rd|th)-root\s*\(([^()]*)\)/gi, (_, degree, radicand) => {
      return `\\sqrt[${degree}]{${normalizeRadicand(radicand)}}`;
    })
    .replace(/\b(\d+)(?:st|nd|rd|th)-root\s+of\s+([A-Za-z0-9^()+\-/*]+)/gi, (_, degree, radicand) => {
      return `\\sqrt[${degree}]{${normalizeRadicand(radicand)}}`;
    })
    .replace(/\bsqrt\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (_, radicand) => {
      return `\\sqrt{${normalizeMathExpression(radicand)}}`;
    })
    .replace(/\b(\d+)\s*sqrt\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (_, coefficient, radicand) => {
      return `${coefficient}\\sqrt{${normalizeMathExpression(radicand)}}`;
    })
    .replace(/\u221a\s*([A-Za-z0-9]+(?:\^\s*\(?[A-Za-z0-9/+\-]+\)?)?)/g, (_, radicand) => {
      return `\\sqrt{${normalizeMathExpression(radicand)}}`;
    });
}

function normalizeUnits(value) {
  return String(value || "")
    .replace(/\b(\d+(?:\.\d+)?)\s*(cm|mm|km)\s*\^\s*(\d+)\b/gi, (_, number, unit, exponent) => {
      return `${number}\\text{ ${unit}}^${exponent}`;
    })
    .replace(/\b(\d+(?:\.\d+)?)\s+(m)\s*\^\s*(\d+)\b/gi, (_, number, unit, exponent) => {
      return `${number}\\text{ ${unit}}^${exponent}`;
    })
    .replace(/\b(\d+(?:\.\d+)?)\s*(cm|mm|km)\b/gi, (_, number, unit) => {
      return `${number}\\text{ ${unit}}`;
    })
    .replace(/\b(\d+(?:\.\d+)?)\s+(m)\b/gi, (_, number, unit) => {
      return `${number}\\text{ ${unit}}`;
    })
    .replace(/\b(cm|mm|km)\s*\^\s*(\d+)\b/gi, (_, unit, exponent) => {
      return `\\text{${unit}}^${exponent}`;
    });
}

function normalizePi(value) {
  return String(value || "")
    .replace(/\u03c0/g, "\\pi")
    .replace(/\(([^()/]+)\s*\/\s*([^()]+)\)\s*\\pi/g, (_, numerator, denominator) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{${normalizeMathExpression(denominator)}}\\pi`;
    })
    .replace(/(\d+(?:\.\d+)?)\s*\\pi\s*\/\s*(\d+(?:\.\d+)?)/g, (_, numerator, denominator) => {
      return `\\frac{${numerator}\\pi}{${denominator}}`;
    });
}

function normalizeGreek(value) {
  return String(value || "")
    .replace(/\u03b8/g, "\\theta")
    .replace(/\u0398/g, "\\Theta");
}

function normalizeTrig(value) {
  return String(value || "")
    .replace(/\b(sin|cos|tan|sec|csc|cot)\s*\^\s*(\d+)\s*(\\theta|\\Theta|[A-Za-z])/gi, (_, fn, exponent, arg) => {
      return `\\${fn.toLowerCase()}^${exponent}${arg}`;
    })
    .replace(/\b(sin|cos|tan|sec|csc|cot)\s*(\\theta|\\Theta|[A-Za-z])/gi, (_, fn, arg) => {
      return `\\${fn.toLowerCase()}${arg}`;
    });
}

function normalizeLogs(value) {
  const subscriptDigits = {
    "\u2080": "0",
    "\u2081": "1",
    "\u2082": "2",
    "\u2083": "3",
    "\u2084": "4",
    "\u2085": "5",
    "\u2086": "6",
    "\u2087": "7",
    "\u2088": "8",
    "\u2089": "9",
  };

  return String(value || "")
    .replace(/(?<!\\)\blog([\u2080-\u2089]+)\s+(\d+)([A-Za-z])(\d+)\b/g, (_, base, coefficient, variable, exponent) => {
      const normalizedBase = [...base].map(ch => subscriptDigits[ch] || ch).join("");
      return `\\log_${normalizedBase}(${coefficient}${variable}^${exponent})`;
    })
    .replace(/(?<!\\)\blog([\u2080-\u2089]+)\s+([A-Za-z])\b/g, (_, base, argument) => {
      const normalizedBase = [...base].map(ch => subscriptDigits[ch] || ch).join("");
      return `\\log_${normalizedBase} ${argument}`;
    })
    .replace(/(?<!\\)\blog\s*\(\s*(\d+)\s*\)\s+(\d+)([A-Za-z])(\d+)\b/g, (_, base, coefficient, variable, exponent) => {
      return `\\log_${base}(${coefficient}${variable}^${exponent})`;
    })
    .replace(/(?<!\\)\blog\s*\(\s*(\d+)\s*\)\s+([A-Za-z])\b/g, (_, base, argument) => {
      return `\\log_${base} ${argument}`;
    })
    .replace(/(?<!\\)\blog_?(\d+)\s+(\d+)([A-Za-z])(\d+)\b/g, (_, base, coefficient, variable, exponent) => {
      return `\\log_${base}(${coefficient}${variable}^${exponent})`;
    })
    .replace(/(?<!\\)\blog_?(\d+)\s+(\d+[A-Za-z]\^\{?\d+\}?)(?!\w)/g, (_, base, argument) => {
      return `\\log_${base}(${normalizeMathExpression(argument)})`;
    })
    .replace(/(?<!\\)\blog_?(\d+)\s+([A-Za-z])\b/g, (_, base, argument) => {
      return `\\log_${base} ${argument}`;
    })
    .replace(/\\log_?(\d+)\s+(\d+)([A-Za-z])(\d+)\b/g, (_, base, coefficient, variable, exponent) => {
      return `\\log_${base}(${coefficient}${variable}^${exponent})`;
    })
    .replace(/\\log_?(\d+)\s+([A-Za-z])\b/g, (_, base, argument) => {
      return `\\log_${base} ${argument}`;
    });
}

function normalizeScientificNotation(value) {
  return String(value || "")
    .replace(/\b(\d+(?:\.\d+)?)\s*(?:\u00d7|x|X|\\times)\s*10\s*\^\s*\(?(-?\d+)\)?\b/g, (_, coefficient, exponent) => {
      return `${coefficient}\\times 10^{${exponent}}`;
    })
    .replace(/\b(\d+(?:\.\d+)?)\s*(?:\u00d7|x|X|\\times)\s*10\s*(-\d+)\b/g, (_, coefficient, exponent) => {
      return `${coefficient}\\times 10^{${exponent}}`;
    })
    .replace(/\b(\d+(?:\.\d+)?)\s*(?:\u00d7|x|X|\\times)\s*10(\d+)\b/g, (_, coefficient, exponent) => {
      return `${coefficient}\\times 10^{${exponent}}`;
    });
}

function normalizeTextOperators(value) {
  return String(value || "")
    .replace(/\bdot\b/gi, "\\cdot");
}

function normalizeSetNotation(value) {
  return String(value || "")
    .replace(/\u2208/g, "\\in")
    .replace(/\u2260/g, "\\ne")
    .replace(/\{([^{}]*(?:\\in|\\ne|\|)[^{}]*)\}/g, (_, body) => {
      if (/^\s*(?:\|[^|]+\||\\mid[^\\]+\\mid|\\mid[A-Za-z0-9(][^\\]*\\mid)\s*$/.test(body)) return `{${body}}`;
      const normalizedBody = body
        .replace(/\|/g, "\\mid")
        .replace(/\\in\s+R\b/g, "\\in \\mathbb{R}");
      return `\\{${normalizedBody}\\}`;
    });
}

function normalizeRelations(value) {
  return String(value || "")
    .replace(/\u2260/g, "\\ne")
    .replace(/\u2264/g, "\\le")
    .replace(/\u2265/g, "\\ge")
    .replace(/<=/g, "\\le")
    .replace(/>=/g, "\\ge")
    .replace(/!=/g, "\\ne");
}

function normalizeAbsoluteValue(value) {
  return String(value || "")
    .replace(/\\mid\s*([^\\]+?)\s*\\mid/g, "|$1|")
    .replace(/\\mid([A-Za-z0-9(][^\\]*?)\\mid/g, "|$1|");
}

function normalizeExponents(value) {
  return String(value || "")
    .replace(/\^\s+/g, "^")
    .replace(/([A-Za-z0-9)}\]])\s*\^\s*(-\d+)/g, (_, base, exponent) => {
      return `${base}^{${exponent}}`;
    })
    .replace(/([A-Za-z0-9)}\]])\s*\^\s*\(([^)]+)\)/g, (_, base, exponent) => {
      const fraction = splitTopLevel(exponent, "/");
      if (fraction) {
        return `${base}^{\\frac{${normalizeMathExpression(fraction[0])}}{${normalizeMathExpression(fraction[2])}}}`;
      }
      return `${base}^{${normalizeMathExpression(exponent)}}`;
    })
    .replace(/([A-Za-z0-9)}\]])\s*\^\s*([A-Za-z0-9]+)/g, (_, base, exponent) => {
      return exponent.length === 1 ? `${base}^${exponent}` : `${base}^{${exponent}}`;
    });
}

function normalizeAdjacentVariableExponents(value) {
  return String(value || "")
    .replace(/([A-Za-z])\^\{(\d+)([A-Za-z])\}/g, "$1^$2$3")
    .replace(/([A-Za-z])\^\{([^{}]+)\}([A-Za-z])/g, "$1^{$2}$3")
    .replace(/([A-Za-z])\^([A-Za-z0-9-]+)([A-Za-z])/g, (_, variable, exponent, nextVariable) => {
      return `${variable}${exponent.length === 1 ? `^${exponent}` : `^{${exponent}}`}${nextVariable}`;
    });
}

function normalizeParenthesizedFractions(value) {
  return String(value || "")
    .replace(/\((\d+)\s*\/\s*(\d+)\)/g, (_, numerator, denominator) => {
      return `\\frac{${numerator}}{${denominator}}`;
    });
}

function normalizeStandaloneFractions(value) {
  return String(value || "")
    .replace(/\b(\d+)\s*\/\s*(\d+)\b/g, (_, numerator, denominator) => {
      return `\\frac{${numerator}}{${denominator}}`;
    });
}

function normalizeDenominatorExponentFractions(value) {
  return String(value || "")
    .replace(/(?<!\^)\b(\d+|[A-Za-z])\s*\/\s*([A-Za-z])\s*\^\s*(-?\d+|[A-Za-z])\b/g, (_, numerator, base, exponent) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{${base}^${exponent}}`;
    })
    .replace(/(?<!\^)\b(\d+|[A-Za-z])\s*\/\s*\(([^()]*[A-Za-z0-9][^()]*)\)/g, (_, numerator, denominator) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{${normalizeMathExpression(denominator)}}`;
    });
}

function normalizeSimpleAlgebraFractions(value) {
  return String(value || "")
    .replace(/\b(\d+|[A-Za-z])\s*\/\s*([A-Za-z])\b(?!\s*\^)/g, (_, numerator, denominator) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{${denominator}}`;
    });
}

function normalizeFunctionFractions(value) {
  return String(value || "")
    .replace(/([A-Za-z]\([^)]*\)\s*=\s*)([A-Za-z0-9^{}]+)\s*\/\s*\(([^()]+)\)/g, (_, prefix, numerator, denominator) => {
      return `${prefix}\\frac{${normalizeMathExpression(numerator)}}{${normalizeMathExpression(denominator)}}`;
    })
    .replace(/([A-Za-z]\([^)]*\)\s*=\s*)([A-Za-z0-9^{}]+)\s*\/\s*(\d+)\b/g, (_, prefix, numerator, denominator) => {
      return `${prefix}\\frac{${normalizeMathExpression(numerator)}}{${denominator}}`;
    })
    .replace(/([A-Za-z]\([^)]*\))\s*\/\s*\[([^\]]+)\]\s*\^\s*([A-Za-z0-9{}-]+)/g, (_, numerator, denominator, exponent) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{[${normalizeMathExpression(denominator)}]^{${normalizeMathExpression(exponent)}}}`;
    });
}

function normalizeMalformedDomainFraction(value) {
  return String(value || "")
    .replace(/\b(\d+[A-Za-z])\s*(?:\/\s*)?\{?\s*\|\s*([^|]+?)\s*\|\s*\}?/g, (_, numerator, denominator) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{|${normalizeMathExpression(denominator)}|}`;
    });
}

function normalizeGroupedQuotients(value) {
  return String(value || "")
    .replace(/(?<![A-Za-z])\(([^()]+)\)\s*\/\s*\(([^()]+)\)/g, (_, numerator, denominator) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{${normalizeMathExpression(denominator)}}`;
    })
    .replace(/(?<![A-Za-z])\(([^()]+)\)\s*\/\s*\[([^\]]+)\]/g, (_, numerator, denominator) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{[${normalizeMathExpression(denominator)}]}`;
    });
}

function cleanFractionPart(value) {
  return normalizeMathExpression(stripOuterParens(value))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTopLevelFraction(value) {
  const text = String(value || "");
  if (/[=<>]/.test(text)) return text;

  const split = splitTopLevel(text, "/");
  if (!split) return text;

  const [left, , right] = split;
  if (!left || !right) return text;
  return `\\frac{${cleanFractionPart(left)}}{${cleanFractionPart(right)}}`;
}

function normalizeExpressionOverGroupedDenominator(value) {
  return String(value || "")
    .replace(/(?<![\\{^])\b([A-Za-z0-9][A-Za-z0-9^{}]*)\s*\/\s*\(([^()]+)\)/g, (_, numerator, denominator) => {
      return `\\frac{${normalizeMathExpression(numerator)}}{${normalizeMathExpression(denominator)}}`;
    });
}

export function normalizeMathExpression(value) {
  let text = unwrapMathDelimiters(value)
    .replace(/\u00a0/g, " ")
    .replace(/\u2212/g, "-")
    .trim();

  text = normalizeUnicodeMathSyntax(text);
  text = repairMalformedLatex(text);
  text = normalizeGreek(text);
  text = normalizePi(text);
  text = normalizeRoots(text);
  text = normalizeUnits(text);
  text = normalizeTrig(text);
  text = normalizeLogs(text);
  text = normalizeScientificNotation(text);
  text = normalizeTextOperators(text);
  text = normalizeSetNotation(text);
  text = normalizeRelations(text);
  text = normalizeAbsoluteValue(text);
  text = normalizeMalformedDomainFraction(text);
  text = normalizeFunctionFractions(text);
  text = normalizeGroupedQuotients(text);
  text = normalizeDenominatorExponentFractions(text);
  text = normalizeParenthesizedFractions(text);
  text = normalizeExponents(text);
  text = normalizeAdjacentVariableExponents(text);
  text = normalizeSimpleAlgebraFractions(text);
  text = normalizeStandaloneFractions(text);
  text = normalizeExpressionOverGroupedDenominator(text);
  text = normalizeTopLevelFraction(text);
  text = text.replace(DOT_OP_RE, "\\cdot ");
  text = repairMalformedLatex(text);

  return text
    .replace(/(?<!\\)\b(sin|cos|tan|sec|csc|cot|log|ln)\b/gi, "\\$1")
    .replace(/\s*\\cdot\s*/g, " \\cdot ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderPlainText(value, style, className) {
  return (
    <span style={style} className={className}>
      {String(value || "")}
    </span>
  );
}

function wrapMath(value, displayMode) {
  const math = normalizeMathExpression(value);
  return displayMode ? `\\[${math}\\]` : `\\( ${math} \\)`;
}

function protectDelimitedMath(source) {
  const protectedValues = [];
  const text = String(source || "").replace(MATH_DELIMITER_RE, (match) => {
    const token = `@@MATH_${protectedValues.length}@@`;
    protectedValues.push(match);
    return token;
  });
  return { text, protectedValues };
}

function restoreDelimitedMath(source, protectedValues) {
  return String(source || "").replace(/@@MATH_(\d+)@@/g, (_, index) => protectedValues[Number(index)] ?? "");
}

function withProtectedMath(source, callback) {
  const { text, protectedValues } = protectDelimitedMath(source);
  return restoreDelimitedMath(callback(text), protectedValues);
}

function wrapRawMathSegment(segment) {
  const source = String(segment || "");
  const trailing = source.match(/[.,;:?!]+$/)?.[0] || "";
  const body = trailing ? source.slice(0, -trailing.length) : source;
  return `${wrapMath(body, false)}${trailing}`;
}

function findBalancedGroupEnd(source, openIndex) {
  if (source[openIndex] !== "{") return -1;
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return i + 1;
  }
  return -1;
}

function findBareLatexRange(source, start) {
  if (source.startsWith("\\frac", start)) {
    let cursor = start + "\\frac".length;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    const firstEnd = findBalancedGroupEnd(source, cursor);
    if (firstEnd === -1) return null;
    cursor = firstEnd;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    const secondEnd = findBalancedGroupEnd(source, cursor);
    if (secondEnd === -1) return null;
    return { start, end: secondEnd };
  }

  if (source.startsWith("\\sqrt", start)) {
    let cursor = start + "\\sqrt".length;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
    if (source[cursor] === "[") {
      const close = source.indexOf("]", cursor);
      if (close === -1) return null;
      cursor = close + 1;
      while (/\s/.test(source[cursor] || "")) cursor += 1;
    }
    const groupEnd = findBalancedGroupEnd(source, cursor);
    if (groupEnd === -1) return null;
    return { start, end: groupEnd };
  }

  if (source.startsWith("\\log", start)) {
    const match = source.slice(start).match(/^\\log(?:_\{?\d+\}?)?\s*\(?[A-Za-z0-9^{}]+(?:\))?(?:\s*=\s*[A-Za-z0-9^{}]+)?/);
    if (!match) return null;
    return { start, end: start + match[0].length };
  }

  return null;
}

function wrapBareLatexCommands(source) {
  const text = String(source || "");
  let result = "";
  let cursor = 0;

  while (cursor < text.length) {
    const next = text.slice(cursor).search(/\\(?:frac|sqrt|log)\b/);
    if (next === -1) {
      result += text.slice(cursor);
      break;
    }

    const start = cursor + next;
    const range = findBareLatexRange(text, start);
    if (!range) {
      result += text.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }

    result += text.slice(cursor, range.start);
    result += wrapMath(text.slice(range.start, range.end), false);
    cursor = range.end;
  }

  return result;
}

export function convertRawMathToDelimited(content) {
  const source = normalizeUnicodeMathSyntax(normalizePlainTextSpacing(content));
  if (!hasRawMathSignal(source)) return source;
  if (isMathOnlyContent(source)) return wrapMath(source, false);

  let converted = source;

  converted = withProtectedMath(converted, wrapBareLatexCommands);

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\{[^{}]*(?:\u2208|\u2260|\|)[^{}]*\}/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(Simplify the expression)\s+(.+?)(?=(?:,\s*(?:where|if|assuming)\b|\s+if\s+[A-Za-z]\s*(?:=|>=|<=|>|<|\u2260|\u2264|\u2265|!=))|[.?]|$)/gi,
    (match, label, rawExpression) => {
      if (!hasRawMathSignal(rawExpression)) return match;
      return `${label} ${wrapRawMathSegment(rawExpression.trim())}`;
    },
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(Using the equation)\s+(.+?)(?=,\s*(?:find|what|which)\b|[.?]|$)/gi,
    (match, label, rawExpression) => {
      if (!hasRawMathSignal(rawExpression)) return match;
      return `${label} ${wrapRawMathSegment(rawExpression.trim())}`;
    },
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(Simplify(?:\s+\w+)?:)\s+(.+?)(?=(?:,\s*(?:where|if|assuming)\b|\s+if\s+[A-Za-z]\s*(?:>=|<=|>|<|\u2260|\u2264|\u2265|!=))|[.?]|$)/gi,
    (match, label, rawExpression) => {
      if (!hasRawMathSignal(rawExpression)) return match;
      return `${label} ${wrapRawMathSegment(rawExpression.trim())}`;
    },
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(Factor (?:completely|by grouping):)\s+(.+?)([.?])/gi,
    (match, label, rawExpression, punctuation) => {
      if (!hasRawMathSignal(rawExpression)) return match;
      return `${label} ${wrapRawMathSegment(rawExpression.trim())}${punctuation}`;
    },
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(If)\s+(.+?),\s+(what is the value of)\s+(.+?)([.?])/gi,
    (match, label, condition, prompt, expression, punctuation) => {
      if (!hasRawMathSignal(condition) && !hasRawMathSignal(expression)) return match;
      return `${label} ${wrapRawMathSegment(condition.trim())}, ${prompt} ${wrapRawMathSegment(expression.trim())}${punctuation}`;
    },
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\([^()]+\)\s*\/\s*\([^()]+\)(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b\d+[A-Za-z]\s*(?:\/\s*)?\{?\s*\|\s*[^|]+?\s*\|\s*\}?/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(if)\s+([A-Za-z]\s*(?:=|>=|<=|>|<|\u2260|\u2264|\u2265|!=)\s*-?(?:\d+\s*\/\s*\d+|\d+(?:\.\d+)?))/gi,
    (_, label, rawExpression) => `${label} ${wrapRawMathSegment(rawExpression.trim())}`,
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(assuming)\s+([A-Za-z]\s*(?:>=|<=|>|<|\u2260|\u2264|\u2265|!=)\s*-?(?:\d+\s*\/\s*\d+|\d+(?:\.\d+)?))/gi,
    (_, label, rawExpression) => `${label} ${wrapRawMathSegment(rawExpression.trim())}`,
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z]\([^)]*\)\s*\/\s*\[[^\]]+\]\s*\^\s*(?:\{[^{}]+\}|[A-Za-z0-9-]+)(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\(\s*1\s*\/\s*\(([^()]+)\)\s*\)\s*\+\s*\(\s*1\s*\/\s*([A-Za-z])\s*\)/g,
    (_, firstDenominator, secondDenominator) => wrapRawMathSegment(`1/(${firstDenominator}) + 1/${secondDenominator}`),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\((?:\d+\s*\/\s*)?[^()]*[A-Za-z][^()]*\)\s*\+\s*\((?:\d+\s*\/\s*)?[^()]*[A-Za-z][^()]*\)/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z]\([^)]*\)\s*=\s*[^,.;?]+?(?=\s+(?:where|if|when|and|or|which|what|find)\b|[,.;?]|$)/g,
    (match) => hasRawMathSignal(match) ? wrapRawMathSegment(match) : match,
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z]\([^)]*\)(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z]\s*(?:>=|<=|>|<|\u2260|!=)\s*-?\d+(?:\.\d+)?(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b(?:log_?\d+|log[\u2080-\u2089]+|log\s*\(\s*\d+\s*\))\s+[A-Za-z]\s*=\s*[A-Za-z0-9]+(?![\w@])/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b(?:log_?\d+|log[\u2080-\u2089]+|log\s*\(\s*\d+\s*\))\s+\d+[A-Za-z](?:\^?\d+)?(?![\w@])/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b(?:log_?\d+|log[\u2080-\u2089]+|log\s*\(\s*\d+\s*\))\s+[A-Za-z](?![\w@])/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(in terms of)\s+([A-Za-z])\b/gi,
    (_, label, variable) => `${label} ${wrapMath(variable, false)}`,
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b\d+(?:\.\d+)?\s*(?:\u00d7|x|X|\\times)\s*10(?:\s*\^\s*\(?-?\d+\)?|\s*-?\d+|\d+)\b/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z0-9(){}\[\]]+(?:\s*\^\s*\(?[A-Za-z0-9/+-]+\)?)?(?:\s+dot\s+[A-Za-z0-9(){}\[\]]+(?:\s*\^\s*\(?[A-Za-z0-9/+-]+\)?)*)(?:\s*=\s*[A-Za-z0-9(){}\[\]]+(?:\s*\^\s*\(?[A-Za-z0-9/+-]+\)?)?)?/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z0-9]+(?:\^\s*\(?[A-Za-z0-9/+-]+\)?)?\s*\/\s*\|[^|]+\|/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(triangle|angle)\s+([A-Z]{2,3})\b/g,
    (_, label, name) => `${label} ${wrapMath(name, false)}`,
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b\d+(?:\.\d+)?\s*(?:cm|mm|m|km)(?:\s*\^\s*\d+)?\b/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(?:cm|mm|m|km)\s*\^\s*\d+\b/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])(?:\d+(?:\.\d+)?|\([^()]+\))\s*\u03c0(?:\s*\/\s*\d+(?:\.\d+)?)?/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(expression|equation)\s+(.+?)(?=\s+(?:if|when|where|find|what|which|then)\b|[.?]|$)/gi,
    (match, label, rawExpression) => {
      if (!hasRawMathSignal(rawExpression)) return match;
      return `${label} ${wrapRawMathSegment(rawExpression.trim())}`;
    },
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /\b(?:Given that|Given)\s+(.+?)(?=,\s|\s+what\b|\s+find\b|[.?]|$)/gi,
    (match, rawExpression) => {
      if (!hasRawMathSignal(rawExpression)) return match;
      return match.replace(rawExpression, wrapRawMathSegment(rawExpression.trim()));
    },
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z]\([^)]*\([^)]*\)[^)]*\)(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b(?:sin|cos|tan|sec|csc|cot)\s*\^\s*\d+\s*[\u03b8A-Za-z](?:\s*[+\-=]\s*\??)?/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Z]{1,3}\s*=\s*(?:\([^()]+\)\s*\^\s*\d+|[A-Za-z]\s*\^\s*\d+|[A-Za-z]|-?\d+(?:\.\d+)?)(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])(?:[\u00b2\u00b3\u00b9\u2070-\u2079]+\s*\u221a\s*\([^)]*\)|sqrt\s*\((?:[^()]|\([^()]*\))*\)|\d+(?:st|nd|rd|th)-root\s*(?:\([^)]*\)|of\s+[A-Za-z0-9^()+\-/*]+)|\u221a\s*[A-Za-z0-9]+)(?:\s*(?:\/|[\u00b7\u00d7*]|\+|-)\s*(?:\([^)]*\)|\u221a\s*[A-Za-z0-9]+|[A-Za-z0-9^()+\-/*]+))*/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b\d*\s*sqrt\s*\([^)]*\)(?:\s*[+\-]\s*\d+)?/gi,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])(?:\(?[A-Za-z0-9\u221a]+(?:\^\s*\(?[A-Za-z0-9/+-]+\)?)?\)?\s*(?:=|\/|[\u00b7\u00d7*])\s*)+\(?[A-Za-z0-9\u221a]+(?:\^\s*\(?[A-Za-z0-9/+-]+\)?)?\)?/g,
    (match) => hasRawMathSignal(match) ? wrapRawMathSegment(match) : match,
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z]\s*=\s*-?\d+(?:\.\d+)?\b/g,
    (match) => wrapMath(match, false),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\([^()]+\)\s*\^\s*\d+(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  converted = withProtectedMath(converted, (text) => text.replace(
    /(?<![\w@])\b[A-Za-z]\s*\^\s*\d+(?![\w@])/g,
    (match) => wrapRawMathSegment(match),
  ));

  return converted;
}

function normalizeDelimitedContent(value) {
  const source = normalizePlainTextSpacing(value);
  let result = "";
  let last = 0;
  let match;

  MATH_DELIMITER_RE.lastIndex = 0;
  while ((match = MATH_DELIMITER_RE.exec(source)) !== null) {
    result += source.slice(last, match.index);
    result += match[2] !== undefined
      ? wrapMath(match[2], false)
      : wrapMath(match[3] ?? match[4] ?? "", true);
    last = MATH_DELIMITER_RE.lastIndex;
  }

  result += source.slice(last);
  return normalizeInlineMathSpacing(result);
}

function normalizeInlineMathSpacing(value) {
  return String(value || "")
    .replace(/\\\(\s*/g, "\\( ")
    .replace(/\s*\\\)/g, " \\)")
    .replace(/([^\s([{])\\\(/g, "$1 \\(")
    .replace(/\\\)(?=[^\s.,;:?!)\]}])/g, "\\) ")
    .replace(/\s*\\\(\s*/g, " \\( ")
    .replace(/\s*\\\)\s*/g, " \\) ")
    .replace(/\s+([.,;:?!])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/\\\)\s*(equivalentto|equivalent\s+to)\b/gi, "\\) equivalent to")
    .replace(/\bequivalentto\b/gi, "equivalent to")
    .replace(/\bequalto\b/gi, "equal to")
    .replace(/\bwhat\s+isy\b/gi, "what is y");
}

function renderLatexPieces(value) {
  const source = normalizeDelimitedContent(value);
  const pieces = [];
  let last = 0;
  let match;

  MATH_DELIMITER_RE.lastIndex = 0;
  while ((match = MATH_DELIMITER_RE.exec(source)) !== null) {
    if (match.index > last) pieces.push(source.slice(last, match.index));

    const inlineMath = match[2];
    const displayMath = match[3] ?? match[4];
    const math = inlineMath !== undefined ? inlineMath : displayMath;
    const displayMode = inlineMath === undefined;

    pieces.push({
      displayMode,
      html: katex.renderToString(math, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
      }),
    });

    last = MATH_DELIMITER_RE.lastIndex;
  }

  if (last < source.length) pieces.push(source.slice(last));
  return pieces;
}

function renderLatexContent(value, style, className) {
  const pieces = renderLatexPieces(value);

  return (
    <span style={style} className={className}>
      {pieces.map((piece, index) => {
        if (typeof piece === "string") return <span key={index}>{piece}</span>;
        const Tag = piece.displayMode ? "div" : "span";
        return <Tag key={index} dangerouslySetInnerHTML={{ __html: piece.html }} />;
      })}
    </span>
  );
}

function blocksToDelimitedContent(blocks) {
  return blocks.map((block) => {
    const type = block.type || "text";
    if (type === "inlineMath" || type === "math") return wrapMath(block.value, false);
    if (type === "blockMath" || type === "displayMath") return wrapMath(block.value, true);
    return String(block.value || "");
  }).join("");
}

function renderBlocks(blocks, style, className) {
  const hasMathBlock = blocks.some((block) => {
    const type = block.type || "text";
    return type === "inlineMath" || type === "math" || type === "blockMath" || type === "displayMath";
  });

  if (hasMathBlock) return renderLatexContent(blocksToDelimitedContent(blocks), style, className);

  return (
    <span style={style} className={className}>
      {blocks.map((block, index) => <span key={index}>{String(block.value || "")}</span>)}
    </span>
  );
}

export function RenderContent({ value, content, blocks, style, className, subject }) {
  if (blocks) return renderBlocks(blocks, style, className);

  const source = content ?? value;
  const structured = readStructured(source);
  if (structured?.promptBlocks) return renderBlocks(structured.promptBlocks, style, className);
  if (structured?.blocks) return renderBlocks(structured.blocks, style, className);

  if (containsMath(source)) return renderLatexContent(source, style, className);

  if (shouldAutoConvertContent(source, subject)) {
    const prepared = convertRawMathToDelimited(source);
    if (containsMath(prepared)) return renderLatexContent(prepared, style, className);
  }

  return renderPlainText(source, style, className);
}

export function MathContent(props) {
  return <RenderContent {...props} />;
}

export function MathText({ content, children, style, className, subject }) {
  return <RenderContent value={content ?? children} style={style} className={className} subject={subject} />;
}

export function ChoiceContent({ value, type, style, className, subject }) {
  const structured = readStructured(value);
  const choiceType = type || structured?.type;
  const choiceValue = structured?.value ?? value;

  if (choiceType === "math") {
    return renderLatexContent(wrapMath(choiceValue, false), style, className);
  }

  return <RenderContent value={choiceValue} style={style} className={className} subject={subject} />;
}
