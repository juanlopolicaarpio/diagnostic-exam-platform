import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const REPORT_PATH = path.join(ROOT, "reports", "humanities-literature-taxonomy-seed-report.json");

const CLASSIFICATION_ORDER = ["BMA", "HAMS", "EA", "ITCS", "SM", "HSSC", "ETT", "SNC"];
const IMPORTANCE_TO_WEIGHT = { Low: 1, Medium: 2, High: 3 };

const TAXONOMY = [
  {
    subject: "Humanities",
    topic: "Cultural & Cross-Cultural Understanding",
    items: [
      {
        subtopic: "Relationships of peoples & cultures across time",
        weights: ["Medium", "Medium", "Low", "Low", "Low", "High", "High", "Medium"],
      },
      {
        subtopic: "Divergence/convergence of cultures (Muslim, IPs, etc.)",
        weights: ["Medium", "Medium", "Low", "Low", "Low", "High", "High", "Medium"],
      },
      {
        subtopic: "Universal themes in arts & humanities",
        weights: ["Medium", "Medium", "Medium", "Low", "Low", "High", "High", "Medium"],
      },
      {
        subtopic: "Influence of religion, gov., tech. & social conduct on arts",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "Low"],
      },
      {
        subtopic: "Impact of history, society & environment on art",
        weights: ["Low", "Low", "Medium", "Low", "Low", "High", "High", "Medium"],
      },
    ],
  },
  {
    subject: "Humanities",
    topic: "Nature & Theory of the Arts",
    items: [
      {
        subtopic: "Purposes and functions of the arts",
        weights: ["Medium", "Medium", "Medium", "Medium", "Low", "High", "High", "Medium"],
      },
      {
        subtopic: "Similarities among periods/movements in art",
        weights: ["Low", "Low", "Medium", "Low", "Low", "High", "High", "Low"],
      },
      {
        subtopic: "Relationships between arts/humanities disciplines",
        weights: ["Low", "Low", "Medium", "Low", "Low", "High", "High", "Low"],
      },
      {
        subtopic: "Arts breaking/creating class barriers",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "Low"],
      },
      {
        subtopic: "Role of art and artists in today's society",
        weights: ["Medium", "Low", "Medium", "Medium", "Low", "High", "High", "Medium"],
      },
    ],
  },
  {
    subject: "Humanities",
    topic: "Ethics & Intellectual Responsibility",
    items: [
      {
        subtopic: "Intellectual property, originality & plagiarism",
        weights: ["High", "High", "High", "High", "High", "High", "High", "Medium"],
      },
    ],
  },
  {
    subject: "Humanities",
    topic: "Dance",
    items: [
      {
        subtopic: "Dance: Role in history and culture",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "High"],
      },
      {
        subtopic: "Dance: Characteristics of styles",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "High"],
      },
      {
        subtopic: "Dance: Diversity in local/global forms",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "High"],
      },
    ],
  },
  {
    subject: "Humanities",
    topic: "Music",
    items: [
      {
        subtopic: "Music: Similarities/differences across history",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "Medium"],
      },
      {
        subtopic: "Music: Importance of participation in global culture",
        weights: ["Medium", "Low", "Low", "Low", "Low", "High", "High", "Medium"],
      },
    ],
  },
  {
    subject: "Humanities",
    topic: "Theater & Performing Arts",
    items: [
      {
        subtopic: "Theater: Lighting, music & costuming contributions",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "High"],
      },
    ],
  },
  {
    subject: "Literature",
    topic: "Philippine Literary Canon & Awards",
    items: [
      {
        subtopic: "Names of all Philippine National Artists in Literature & titles of their major works",
        weights: ["Medium", "Medium", "Low", "Low", "Low", "High", "High", "Medium"],
      },
      {
        subtopic: "Names of all members of the Hall of Fame of the Carlos Palanca Memorial Awards in Literature",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "Low"],
      },
    ],
  },
  {
    subject: "Literature",
    topic: "World Literature & Nobel Prize Laureates",
    items: [
      {
        subtopic: "Names of at least 20 Nobel Prize laureates in Literature & titles of at least one major work each",
        weights: ["Medium", "Low", "Low", "Low", "Low", "High", "High", "Low"],
      },
      {
        subtopic: "Titles, authors, plots & three main characters of at least six literary novels in English written by non-Filipinos",
        weights: ["Medium", "Medium", "Low", "Low", "Low", "High", "High", "Low"],
      },
    ],
  },
  {
    subject: "Literature",
    topic: "Philippine Literature in English",
    items: [
      {
        subtopic: "Titles, authors, plots & three main characters of at least six literary novels in English written by Filipinos",
        weights: ["Medium", "Medium", "Low", "Low", "Low", "High", "High", "Medium"],
      },
    ],
  },
  {
    subject: "Literature",
    topic: "Broad Literary Exposure",
    items: [
      {
        subtopic: "Titles & authors of a wide variety of texts from Philippine, Asian, Anglo-American, European, Latin American, African & other literatures",
        weights: ["Medium", "Medium", "Low", "Low", "Low", "High", "High", "Low"],
      },
      {
        subtopic: "Names of at least ten writers from the region where the high school is located",
        weights: ["Low", "Low", "Low", "Low", "Low", "High", "High", "Medium"],
      },
    ],
  },
];

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

async function apiConfig() {
  loadEnv();
  const url = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing Supabase URL/key.");

  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    }),
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
  const token = (await login.json()).access_token;
  return {
    rest: `${url}/rest/v1`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function desiredRows() {
  const rows = [];
  for (const group of TAXONOMY) {
    for (const item of group.items) {
      item.weights.forEach((importanceLabel, index) => {
        const classification_code = CLASSIFICATION_ORDER[index];
        rows.push({
          subject: group.subject,
          topic: group.topic,
          subtopic: item.subtopic,
          classification_code,
          importance_label: importanceLabel,
          importance_weight: IMPORTANCE_TO_WEIGHT[importanceLabel],
        });
      });
    }
  }
  return rows;
}

async function fetchRows(rest, headers, subject) {
  const response = await fetch(
    `${rest}/subtopic_classification_importance?select=id,subject,topic,subtopic,classification_code,importance_label,importance_weight&subject=eq.${encodeURIComponent(subject)}&limit=1000`,
    { headers },
  );
  if (!response.ok) throw new Error(`Failed to fetch ${subject}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function insertRow(rest, headers, payload) {
  const response = await fetch(`${rest}/subtopic_classification_importance`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Insert failed for ${payload.subject} :: ${payload.topic} :: ${payload.subtopic} :: ${payload.classification_code}: ${response.status} ${await response.text()}`);
}

async function patchRow(rest, headers, id, payload) {
  const response = await fetch(`${rest}/subtopic_classification_importance?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Patch failed for ${id}: ${response.status} ${await response.text()}`);
}

async function main() {
  const { rest, headers } = await apiConfig();
  const desired = desiredRows();
  const existing = [
    ...(await fetchRows(rest, headers, "Humanities")),
    ...(await fetchRows(rest, headers, "Literature")),
  ];

  const existingByKey = new Map(
    existing.map((row) => [
      `${normalize(row.subject)}||${normalize(row.topic)}||${normalize(row.subtopic)}||${normalize(row.classification_code)}`,
      row,
    ]),
  );

  const inserts = [];
  const updates = [];
  for (const row of desired) {
    const key = `${normalize(row.subject)}||${normalize(row.topic)}||${normalize(row.subtopic)}||${normalize(row.classification_code)}`;
    const existingRow = existingByKey.get(key);
    if (!existingRow) {
      inserts.push(row);
      continue;
    }

    const patch = {};
    for (const field of ["importance_label", "importance_weight"]) {
      if (normalize(existingRow[field]) !== normalize(row[field])) patch[field] = row[field];
    }
    if (Object.keys(patch).length) updates.push({ id: existingRow.id, patch, key });
  }

  if (APPLY) {
    for (const row of inserts) await insertRow(rest, headers, row);
    for (const row of updates) await patchRow(rest, headers, row.id, row.patch);
  }

  const postExisting = APPLY
    ? [
        ...(await fetchRows(rest, headers, "Humanities")),
        ...(await fetchRows(rest, headers, "Literature")),
      ]
    : existing;

  const postByKey = new Map(
    postExisting.map((row) => [
      `${normalize(row.subject)}||${normalize(row.topic)}||${normalize(row.subtopic)}||${normalize(row.classification_code)}`,
      row,
    ]),
  );

  const missingAfterApply = desired
    .filter((row) => !postByKey.has(`${normalize(row.subject)}||${normalize(row.topic)}||${normalize(row.subtopic)}||${normalize(row.classification_code)}`))
    .map((row) => `${row.subject} :: ${row.topic} :: ${row.subtopic} :: ${row.classification_code}`);

  const mismatchesAfterApply = [];
  for (const row of desired) {
    const key = `${normalize(row.subject)}||${normalize(row.topic)}||${normalize(row.subtopic)}||${normalize(row.classification_code)}`;
    const existingRow = postByKey.get(key);
    if (!existingRow) continue;
    for (const field of ["importance_label", "importance_weight"]) {
      if (normalize(existingRow[field]) !== normalize(row[field])) {
        mismatchesAfterApply.push({ key, field, expected: row[field], actual: existingRow[field] });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    applied: APPLY,
    counts: {
      desiredRows: desired.length,
      existingRows: existing.length,
      inserts: inserts.length,
      updates: updates.length,
    },
    missingAfterApply,
    mismatchesAfterApply,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.counts, null, 2));
  console.log(APPLY ? "Applied humanities/literature taxonomy seed." : "Dry run only. Re-run with --apply to write taxonomy rows.");
  console.log(`Wrote ${path.relative(ROOT, REPORT_PATH)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
