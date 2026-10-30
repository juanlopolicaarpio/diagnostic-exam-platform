function stripMathMarkup(value) {
  return String(value || "")
    .replace(/\\\(|\\\)|\\\[|\\\]|\$\$/g, "")
    .replace(/\\log/g, "log")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNumericAnswer(value) {
  const text = stripMathMarkup(value)
    .replace(/,/g, "")
    .replace(/^[-+]?z\s*=\s*/i, "")
    .trim();
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function solveSimpleLogQuestion(questionText) {
  const text = stripMathMarkup(questionText);
  const match = text.match(/\blog_?(\d+)\s+([A-Za-z])\s*=\s*(-?\d+)\b/i);
  if (!match) return null;

  const base = Number(match[1]);
  const exponent = Number(match[3]);
  if (!Number.isFinite(base) || !Number.isFinite(exponent)) return null;

  return base ** exponent;
}

export function validateMathItem(item) {
  const subject = String(item?.subject || "").trim().toLowerCase();
  if (subject !== "mathematics") return { checked: false, valid: true };

  const expected = solveSimpleLogQuestion(item.question_text);
  if (expected === null) return { checked: false, valid: true };

  const letters = ["a", "b", "c", "d", "e"];
  const choices = Object.fromEntries(letters.map(letter => [letter, normalizeNumericAnswer(item[`choice_${letter}`])]));
  const included = Object.values(choices).some(value => value === expected);
  const keyed = choices[String(item.correct_answer || "").toLowerCase()] === expected;

  return {
    checked: true,
    valid: included && keyed,
    expected,
    included,
    keyed,
    reason: included
      ? `Answer key does not match computed value ${expected}.`
      : `Computed value ${expected} is not present in the choices.`,
  };
}
