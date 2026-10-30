import { MathContent } from "./mathContent";

const UNDERLINE_STYLE = {
  textDecoration: "underline",
  textDecorationColor: "#f59e0b",
  textUnderlineOffset: 3,
  textDecorationThickness: 2,
};

function normalizeReplacementText(value) {
  return String(value || "")
    .trim()
    .replace(/[.,;:]$/, "")
    .replace(/\s+/g, " ");
}

function findNormalizedRange(source, target) {
  const sourceText = String(source || "");
  const targetText = normalizeReplacementText(target);
  if (!sourceText || !targetText) return null;

  const normalizedSource = sourceText.replace(/\s+/g, " ");
  const direct = normalizedSource.toLowerCase().indexOf(targetText.toLowerCase());
  if (direct === -1) return null;

  let normalizedPos = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < sourceText.length; i += 1) {
    if (normalizedPos === direct && start === -1) start = i;
    if (normalizedPos === direct + targetText.length) {
      end = i;
      break;
    }
    if (/\s/.test(sourceText[i])) {
      if (normalizedSource[normalizedPos] === " ") normalizedPos += 1;
    } else {
      normalizedPos += 1;
    }
  }
  if (start !== -1 && end === -1) end = sourceText.length;
  return start === -1 ? null : { start, end };
}

function getCombiningUnderlineSegments(value) {
  const chars = Array.from(String(value || ""));
  if (!chars.includes("\u0332")) return null;

  const pieces = [];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === "\u0332") continue;

    let underlined = false;
    let j = i + 1;
    while (chars[j] === "\u0332") {
      underlined = true;
      j += 1;
    }
    pieces.push({ text: char, underlined });
  }

  pieces.forEach((piece, index) => {
    if (
      /^\s+$/.test(piece.text)
      && pieces[index - 1]?.underlined
      && pieces[index + 1]?.underlined
    ) {
      piece.underlined = true;
    }
  });

  return pieces.reduce((segments, piece) => {
    const previous = segments[segments.length - 1];
    if (previous && previous.underlined === piece.underlined) {
      previous.text += piece.text;
    } else {
      segments.push({ ...piece });
    }
    return segments;
  }, []);
}

function renderSegments(segments, style, subject) {
  const rootStyle = { whiteSpace: "pre-line", ...style };
  return (
    <span style={rootStyle}>
      {segments.map((segment, index) => (
        segment.underlined ? (
          <span key={index} style={UNDERLINE_STYLE}>
            <MathContent value={segment.text} subject={subject} />
          </span>
        ) : (
          <MathContent key={index} value={segment.text} subject={subject} />
        )
      ))}
    </span>
  );
}

export function QuestionWithUnderline({ text, choiceA, style, subject }) {
  const combiningSegments = getCombiningUnderlineSegments(text);
  if (combiningSegments) return renderSegments(combiningSegments, style, subject);

  if (!text || !choiceA) return <MathContent value={text} style={style} subject={subject} />;

  const isReplacement = /select\s+best\s+replacement/i.test(text);
  if (!isReplacement) return <MathContent value={text} style={style} subject={subject} />;

  const mainText = String(text).replace(/\s*[-–—]+\s*Select best replacement.*$/i, "").trimEnd();
  const suffix = String(text).slice(mainText.length);
  const range = findNormalizedRange(mainText, choiceA);
  if (!range) return <MathContent value={text} style={style} subject={subject} />;

  return (
    <span style={{ whiteSpace: "pre-line", ...style }}>
      <MathContent value={mainText.slice(0, range.start)} subject={subject} />
      <span style={UNDERLINE_STYLE}>
        <MathContent value={mainText.slice(range.start, range.end)} subject={subject} />
      </span>
      <MathContent value={mainText.slice(range.end)} subject={subject} />
      <MathContent value={suffix} style={{ color: "#64748b", fontSize: "0.85em" }} subject={subject} />
    </span>
  );
}
