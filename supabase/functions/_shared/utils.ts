// ============================================================================
// EDGE FUNCTIONS — _shared/utils.ts
// ============================================================================
// Shared utilities used by ALL Edge Functions.
//
// In Supabase Edge Functions, files in the "_shared" folder are importable
// by any function. This avoids duplicating auth checks, CORS headers,
// error formatting, and client creation across 6 endpoints.
//
// HOW SUPABASE EDGE FUNCTIONS WORK:
//   1. They run on Deno (not Node.js) — that's why imports use URLs
//   2. Each function lives in its own folder: supabase/functions/<name>/
//   3. The _shared folder is accessible to all functions
//   4. Environment variables (SUPABASE_URL, keys) are auto-injected
//   5. You deploy with: supabase functions deploy <name>
//
// TWO CLIENTS PATTERN:
//   - userClient: Uses the student's JWT token. Queries respect RLS.
//     Use for reads the student is allowed to do.
//   - adminClient: Uses the service-role key. Bypasses RLS.
//     Use for privileged writes (grading answers, writing scores).
//   The Edge Function decides which client to use for each operation.
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── CORS Headers ──
// Required for browser-based frontends to call your Edge Functions.
// The frontend runs on a different domain than your Supabase project,
// so the browser blocks requests unless these headers are present.
export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("CORS_ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ── Handle CORS Preflight ──
// Browsers send an OPTIONS request before the real request to check
// if CORS is allowed. This handles that automatically.
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

// ── Create Supabase Clients ──
// Returns both a user-scoped client (respects RLS) and an admin client
// (bypasses RLS for privileged operations).
export function createClients(req: Request): {
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
} {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization")!;

  // User client: acts as the authenticated student
  // All queries go through RLS — student can only see their own data
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  // Admin client: bypasses RLS for privileged operations
  // Used for: grading answers (reading correct_answer), writing scores,
  // creating session data on behalf of the user
  const adminClient = createClient(supabaseUrl, supabaseServiceKey);

  return { userClient, adminClient };
}

// ── Authenticate User ──
// Extracts and verifies the user from the JWT token.
// Returns the user object or throws an error.
export async function authenticateUser(
  userClient: SupabaseClient
): Promise<{ id: string; email?: string }> {
  const {
    data: { user },
    error,
  } = await userClient.auth.getUser();

  if (error || !user) {
    throw new ApiError(401, "Not authenticated. Please log in.");
  }

  return user;
}

// ── Error Handling ──
// Custom error class that carries an HTTP status code.
// Throw this anywhere in your Edge Function logic and the
// top-level handler will catch it and return the right status.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ── JSON Response Helpers ──
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Top-Level Error Handler ──
// Wraps any Edge Function handler to catch errors uniformly.
// Usage: serve(withErrorHandling(async (req) => { ... }))
export function withErrorHandling(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    // Handle CORS preflight
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err.status, err.message);
      }
      console.error("Unexpected error:", err);
      return errorResponse(500, "Internal server error");
    }
  };
}

// ── Section Configuration ──
// The official exam sections in fixed order with their timing.
// This is the single source of truth for section names, order, and limits.
export const SECTION_CONFIG = [
  { name: "language",       displayName: "Language",                   questionCount: 30, timeLimitSeconds: 1080 },
  { name: "reading",        displayName: "Reading",                    questionCount: 30, timeLimitSeconds: 1410 },
  { name: "math",           displayName: "Mathematics",                questionCount: 40, timeLimitSeconds: 3000 },
  { name: "science",        displayName: "Science",                    questionCount: 40, timeLimitSeconds: 2000 },
  { name: "social_studies", displayName: "Social Studies",             questionCount: 15, timeLimitSeconds:  540 },
  { name: "logic",          displayName: "Logic / Abstract Reasoning", questionCount: 15, timeLimitSeconds: 1125 },
] as const;

// Section names in order — used for determining "next section"
export const SECTION_ORDER = SECTION_CONFIG.map((s) => s.name);
export type SectionName = typeof SECTION_ORDER[number];

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSectionName(value: string): value is SectionName {
  return (SECTION_ORDER as readonly string[]).includes(value);
}

export function requireSectionName(value: string, fieldName = "section"): SectionName {
  if (!isSectionName(value)) {
    throw new ApiError(
      400,
      `Invalid ${fieldName}: ${value}. Valid: ${SECTION_ORDER.join(", ")}`
    );
  }

  return value;
}

export function requireUuid(value: string, fieldName: string): string {
  if (!UUID_REGEX.test(value)) {
    throw new ApiError(400, `Invalid ${fieldName}.`);
  }

  return value;
}

// Max session age before it expires (24 hours)
export const SESSION_MAX_AGE_HOURS = 24;
