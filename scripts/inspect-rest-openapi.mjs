import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const envPath = path.join(ROOT, name);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!process.env[key]) process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
}

async function main() {
  loadEnv();
  const url = process.env.VITE_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing Supabase URL/key.");

  let bearer = key;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      }),
    });
    if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
    bearer = (await login.json()).access_token;
  }

  const response = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${bearer}` },
  });
  console.log(response.status, response.statusText);
  const data = await response.json();
  const paths = Object.keys(data.paths || {}).map((item) => item.replace(/^\//, ""));
  console.log(paths.sort().join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
