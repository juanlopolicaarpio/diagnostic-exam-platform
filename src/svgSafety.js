// ═══════════════════════════════════════════════════════════════
// SVG SAFETY CHECK
// ═══════════════════════════════════════════════════════════════
// Inline SVG arriving from outside the app (AI generation, CSV import) is
// rendered into the page, so it is attacker-controlled markup until proven
// otherwise. This is the one gate every such path goes through.
//
// Lives in its own module so non-React code (the CSV importer, node tests)
// can use it without importing a hook.
// ═══════════════════════════════════════════════════════════════

export function svgLooksSafe(value) {
  const svg = String(value || "").trim();
  return svg.startsWith("<svg") && svg.includes("</svg>") &&
    !/script|foreignObject|<image|href=|onload=|onclick=|onerror=/i.test(svg);
}
