import fs from "node:fs";
import assert from "node:assert/strict";

const source = fs.readFileSync("src/mathContent.jsx", "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/export function/g, "function")
  .replace(/function renderPlainText[\s\S]*?function wrapMath/, "function renderPlainText() {}\n\nfunction wrapMath");

const end = source.indexOf("function renderLatexContent");
if (end === -1) throw new Error("Could not locate render boundary in src/mathContent.jsx");

const preprocessorSource = source.slice(0, end);
const load = new Function(`${preprocessorSource}; return { normalizeMathExpression, convertRawMathToDelimited, normalizeDelimitedContent, shouldAutoConvertContent };`);
const { normalizeMathExpression, convertRawMathToDelimited, normalizeDelimitedContent, shouldAutoConvertContent } = load();

function prepare(content, subject = "Mathematics") {
  return normalizeDelimitedContent(convertRawMathToDelimited(content, subject));
}

const cases = [
  {
    name: "grouped quotient x2 minus 9",
    actual: normalizeMathExpression("(x^2 - 9)/(x - 3)"),
    expected: "\\frac{x^2 - 9}{x - 3}",
  },
  {
    name: "grouped quotient x2 minus 49",
    actual: normalizeMathExpression("(x^2 - 49)/(x - 7)"),
    expected: "\\frac{x^2 - 49}{x - 7}",
  },
  {
    name: "denominator exponent in sentence",
    actual: prepare("If x + 1/x = 8, what is the value of x^2 + 1/x^2?"),
    expected: "If \\( x + \\frac{1}{x} = 8 \\), what is the value of \\( x^2 + \\frac{1}{x^2} \\)?",
  },
  {
    name: "function quotient",
    actual: prepare("If f(x) = x/2, find f(x²) / [f(x)]²."),
    expected: "If \\( f(x)=\\frac{x}{2} \\), find \\( \\frac{f(x^2)}{[f(x)]^2} \\).",
  },
  {
    name: "absolute value with if stays prose",
    actual: prepare("Simplify: |5 - 2t| if t ≤ 5/2."),
    expected: "Simplify: \\( |5 - 2t| \\) if \\( t \\le \\frac{5}{2} \\).",
  },
  {
    name: "division of polynomial monomials",
    actual: prepare("Simplify: (35m^6n^2)/(5m^2n^5)."),
    expected: "Simplify: \\( \\frac{35m^6n^2}{5m^2n^5} \\).",
  },
  {
    name: "factor polynomial terms",
    actual: prepare("Factor completely: 15p^3q - 25p^2q^2 + 10pq."),
    expected: "Factor completely: \\( 15p^3q - 25p^2q^2 + 10pq \\).",
  },
  {
    name: "sqrt with assuming stays prose",
    actual: prepare("Simplify: sqrt(72x^2), assuming x >= 0."),
    expected: "Simplify: \\( \\sqrt{72x^2} \\), assuming \\( x \\ge 0 \\).",
  },
  {
    name: "sqrt answer choice with coefficient",
    actual: prepare("6sqrt(5) - 6"),
    expected: "\\( 6\\sqrt{5} - 6 \\)",
  },
  {
    name: "sum of reciprocal fractions",
    actual: prepare("Express (1/(x+1)) + (1/x) as a single fraction."),
    expected: "Express \\( \\frac{1}{x+1} + \\frac{1}{x} \\) as a single fraction.",
  },
  {
    name: "set-builder choice stays one math span",
    actual: prepare("{x | x > -5/8}"),
    expected: "\\( \\{x \\mid x > -\\frac{5}{8}\\} \\)",
  },
  {
    name: "math italic log variables normalize",
    actual: prepare("If log3 𝑚= 𝑦, express log3 27𝑚2 in terms of 𝑦."),
    expected: "If \\( \\log_3 m= y \\), express \\( \\log_3(27m^2) \\) in terms of \\( y \\).",
  },
  {
    name: "radical quotient with unicode exponents",
    actual: prepare("Simplify the expression (m³·n²)² · √21 / (m²·n·√3)."),
    expected: "Simplify the expression \\( \\frac{(m^3 \\cdot n^2)^2 \\cdot \\sqrt{21}}{m^2 \\cdot n \\cdot \\sqrt{3}} \\).",
  },
  {
    name: "radical quotient keeps if as prose",
    actual: prepare("Simplify the expression sqrt(257) / (x^3 − 5) if x = 5."),
    expected: "Simplify the expression \\( \\frac{\\sqrt{257}}{x^3 - 5} \\) if \\( x=5 \\).",
  },
  {
    name: "factor by grouping wraps polynomial",
    actual: prepare("Factor by grouping: 6x^2 + 9x + 4x + 6."),
    expected: "Factor by grouping: \\( 6x^2 + 9x + 4x + 6 \\).",
  },
  {
    name: "using equation wraps dot multiplication once",
    actual: prepare("Using the equation (6^x)^6 = 6^y dot 6^8, Find x in terms of y?"),
    expected: "Using the equation \\( (6^x)^6 = 6^y \\cdot 6^8 \\), Find x in terms of \\( y \\)?",
  },
];

for (const testCase of cases) {
  const canonicalize = value => value
    .replace(/\\\(\s*/g, "\\(")
    .replace(/\s*\\\)/g, "\\)")
    .replace(/\s*=\s*/g, "=")
    .replace(/\s*\\cdot\s*/g, "")
    .replace(/\^\{([A-Za-z0-9-])\}/g, "^$1")
    .replace(/\s+/g, " ");
  const compactActual = canonicalize(testCase.actual);
  const compactExpected = canonicalize(testCase.expected);
  assert.equal(compactActual, compactExpected, testCase.name);
}

const nonMathSamples = [
  "The passage says x^2 is written on the board.",
  "Read the expression 1/2 as part of the quoted text.",
  "Cause: Effect",
  "Type: Example",
];

for (const sample of nonMathSamples) {
  assert.equal(shouldAutoConvertContent(sample, "Reading"), false, `Reading should not auto-convert: ${sample}`);
  assert.equal(shouldAutoConvertContent(sample, "English"), false, `English should not auto-convert: ${sample}`);
  assert.equal(shouldAutoConvertContent(sample, "Filipino"), false, `Filipino should not auto-convert: ${sample}`);
}

console.log(`Passed ${cases.length} math pattern tests.`);
