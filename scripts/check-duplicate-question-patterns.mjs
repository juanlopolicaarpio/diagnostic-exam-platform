import fs from "node:fs";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

const url = process.env.VITE_SUPABASE_URL.replace(/\/$/, "");
const key = process.env.VITE_SUPABASE_ANON_KEY;
const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: key, "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
});
if (!login.ok) throw new Error(await login.text());
const token = (await login.json()).access_token;
const headers = { apikey: key, Authorization: `Bearer ${token}` };
const response = await fetch(`${url}/rest/v1/questions?select=id,question_text,choice_a,choice_b,choice_c,choice_d,choice_e&subject=eq.Filipino%20Language&instruction_id=not.is.null&limit=1000`, { headers });
if (!response.ok) throw new Error(await response.text());
const rows = await response.json();

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/â€œ|â€|["'?.,:;]/g, "")
    .replace(/\b(ana|mina|jun|lito|sofia|carlo|nico|ben|rosa|maya|arman|lira|tino|bea|alon|paolo|rhea|lea|marco|dario|ramon|mara|leo)\b/g, "NAME")
    .replace(/\s+/g, " ")
    .trim();
}

const groups = new Map();
for (const row of rows.filter((row) => row.choice_e)) {
  const key = [
    `question:${normalize(row.question_text)}`,
    `choices:${["choice_a", "choice_b", "choice_c", "choice_d", "choice_e"].map((field) => normalize(row[field])).sort().join(" / ")}`,
  ].join(" -- ");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const duplicates = [...groups.values()].filter((group) => group.length > 1);
console.log(JSON.stringify({
  fullChoiceRows: rows.filter((row) => row.choice_e).length,
  duplicateChoicePatternGroups: duplicates.length,
  duplicateChoicePatternRows: duplicates.reduce((sum, group) => sum + group.length, 0),
}, null, 2));
for (const group of duplicates) {
  console.log(group.map((row) => `${row.id} ${row.question_text}`).join("\n"));
}
