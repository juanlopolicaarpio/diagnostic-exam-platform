import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "reports");
const JSON_REPORT = path.join(REPORT_DIR, "render-audit.json");
const MD_REPORT = path.join(REPORT_DIR, "render-audit.md");
const FIELD_NAMES = ["question_text", "choice_a", "choice_b", "choice_c", "choice_d", "choice_e"];
const SUBJECT_RE = /(math|mathematics|science|physics|chemistry|biology)/i;

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!process.env[key]) process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

async function apiConfig() {
  loadEnv();
  const url = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY.");

  let bearer = key;
  const email = process.env.ADMIN_EMAIL || argValue("--email");
  const password = process.env.ADMIN_PASSWORD || argValue("--password");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && email && password) {
    const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw new Error(`Login failed: ${response.status} ${await response.text()}`);
    bearer = (await response.json()).access_token;
  }

  return {
    rest: `${url}/rest/v1`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
  };
}

async function fetchQuestions(rest, headers) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      select: "id,subject,topic,subtopic,question_text,choice_a,choice_b,choice_c,choice_d,choice_e,correct_answer,status",
      order: "subject.asc,topic.asc,subtopic.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await fetch(`${rest}/questions?${params}`, { headers });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${await response.text()}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function visibleTextFromHtml(html) {
  return decodeEntities(String(html || "")
    .replace(/<annotation\b[\s\S]*?<\/annotation>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function hasMathSignal(value) {
  const text = String(value || "");
  return /\\(?:frac|sqrt|log|times|cdot|le|ge|ne|mid)\b/.test(text)
    || /\blog_?\d|\blog\s*\(\s*\d+\s*\)/i.test(text)
    || /\bsqrt\s*\(/i.test(text)
    || /\bdot\b/i.test(text)
    || /[A-Za-z0-9)}\]]\s*\^\s*\(?[-A-Za-z0-9/+]+\)?/.test(text)
    || /[A-Za-z0-9)]\s*\/\s*\|[^|]+\|/.test(text)
    || /\b\d+[A-Za-z]\s*\{?\s*\|[^|]+\|\s*\}?/.test(text)
    || /\b[A-Za-z]\s*(?:<=|>=|!=|\u2260)\s*-?\d+(?:\.\d+)?/.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:x|X|\u00d7|\\times)\s*10(?:\^?-?\d+|\d+)\b/.test(text);
}

function flagRendered({ raw, html, visible }) {
  const flags = [];
  const text = visible || "";
  const rawText = String(raw || "");

  const checks = [
    ["visible_raw_frac", /\\frac/],
    ["visible_raw_sqrt", /\\sqrt/],
    ["visible_raw_log", /\blog_?\d|\blog\s*\(\s*\d+\)|\\log/i],
    ["visible_mid_abs", /\\mid|midx/i],
    ["visible_dot_word", /\bdot\b/i],
    ["visible_raw_relation", /<=|>=|!=/],
    ["visible_answer_leak", /\bCORRECT\b/],
    ["visible_broken_domain_fraction", /\b\d+[A-Za-z]\s*\{\s*\|[^|]+\|\s*\}/],
    ["visible_fraction_lost_exponent", /\/\s*[A-Za-z]\s+\d\b|\\frac\{1\}\{[A-Za-z]\}\s*\d\b/],
    ["visible_grouped_fraction_mangled", /[A-Za-z]\^?\d?\s*-\s*\(\s*\d+\s*\/\s*[A-Za-z]\s*-/],
  ];
  for (const [name, regex] of checks) {
    if (regex.test(text)) flags.push(name);
  }

  if (/(?:\\frac|\\sqrt|\\log|\\times|\\cdot)/.test(rawText) && !/class="katex/.test(html)) {
    flags.push("raw_latex_not_rendered");
  }
  if (/katex-error|ParseError|KaTeX parse error/i.test(html) || /ParseError|KaTeX parse error/i.test(text)) {
    flags.push("katex_parse_error");
  }

  return [...new Set(flags)];
}

function markdown(report) {
  const lines = [
    "# Render Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Rows scanned: ${report.counts.scanned}`,
    `Rows in scope: ${report.counts.inScope}`,
    `Fields rendered: ${report.counts.fieldsRendered}`,
    `Failing fields: ${report.counts.failingFields}`,
    `Failing rows: ${report.counts.failingRows}`,
    "",
    "## Failure Counts",
    "",
    ...Object.entries(report.flagCounts).sort((a, b) => b[1] - a[1]).map(([flag, count]) => `- ${flag}: ${count}`),
    "",
    "## First 50 Failures",
    "",
  ];

  for (const item of report.failures.slice(0, 50)) {
    lines.push(`### ${item.id} · ${item.field}`);
    lines.push(`Subject: ${item.subject || ""} | Topic: ${item.topic || ""} | Subtopic: ${item.subtopic || ""}`);
    lines.push(`Flags: ${item.flags.join(", ")}`);
    lines.push(`Raw: ${item.raw}`);
    lines.push(`Visible: ${item.visible}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const { rest, headers } = await apiConfig();
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  try {
    const [{ MathContent }] = await Promise.all([vite.ssrLoadModule("/src/mathContent.jsx")]);
    const allRows = await fetchQuestions(rest, headers);
    const inScope = allRows.filter(row => SUBJECT_RE.test(row.subject || "") || FIELD_NAMES.some(field => hasMathSignal(row[field])));
    const failures = [];
    const flagCounts = {};
    let fieldsRendered = 0;

    for (const row of inScope) {
      for (const field of FIELD_NAMES) {
        const raw = row[field];
        if (!raw) continue;
        fieldsRendered += 1;
        const html = renderToStaticMarkup(React.createElement(MathContent, { value: raw, subject: row.subject }));
        const visible = visibleTextFromHtml(html);
        const flags = flagRendered({ raw, html, visible });
        if (!flags.length) continue;
        for (const flag of flags) flagCounts[flag] = (flagCounts[flag] || 0) + 1;
        failures.push({
          id: row.id,
          field,
          subject: row.subject,
          topic: row.topic,
          subtopic: row.subtopic,
          flags,
          raw,
          visible,
          htmlExcerpt: html.slice(0, 1000),
        });
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      counts: {
        scanned: allRows.length,
        inScope: inScope.length,
        fieldsRendered,
        failingFields: failures.length,
        failingRows: new Set(failures.map(item => item.id)).size,
      },
      flagCounts,
      failures,
    };

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(JSON_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(MD_REPORT, markdown(report));
    console.log(JSON.stringify(report.counts, null, 2));
    console.log("flagCounts", JSON.stringify(flagCounts, null, 2));
    console.log(`Wrote ${path.relative(ROOT, JSON_REPORT)}`);
    console.log(`Wrote ${path.relative(ROOT, MD_REPORT)}`);
  } finally {
    await vite.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
