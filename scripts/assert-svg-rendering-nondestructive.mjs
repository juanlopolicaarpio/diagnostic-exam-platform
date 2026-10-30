import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "src", "visualContent.jsx");
const source = fs.readFileSync(file, "utf8");

const forbidden = [
  "normalizeSvg",
  "normalizedPaint",
  "shouldBlackenColor",
  "addWhiteBackground",
  "removeEmbeddedAnswers",
  "DOMParser",
  "XMLSerializer",
  "dangerouslySetInnerHTML",
  "preserveOriginalSvg",
  "preserve_original_svg",
];

const found = forbidden.filter((token) => source.includes(token));
if (found.length) {
  console.error(
    `SVG rendering must stay non-destructive in src/visualContent.jsx. Remove: ${found.join(", ")}`,
  );
  process.exit(1);
}

if (!source.includes("authoredSvgDataUrl") || !source.includes("src={authoredSvgDataUrl(loadedSvg)}")) {
  console.error("SVG rendering must use the authoredSvgDataUrl <img> path.");
  process.exit(1);
}

if (!source.includes("ensureSvgCssVars") || !source.includes("data-svg-vars")) {
  console.error("SVG data URLs must include the CSS variable shim to prevent var(...) paints from rendering black.");
  process.exit(1);
}

if (!source.includes("stripEmbeddedAnswerMarkup") || !source.includes("hasEmbeddedAnswerLabel")) {
  console.error("SVG rendering must strip embedded answer labels without DOM parsing or color normalization.");
  process.exit(1);
}
