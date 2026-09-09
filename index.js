// ─────────────────────────────────────────────────────────────
// RCRSB Commissioning — sync API
//
// This Worker is the ONLY thing that holds real database credentials.
// The static site (GitHub Pages) never sees a Turso token — it can only
// call the four narrow endpoints below, each of which runs one fixed,
// parameterized SQL statement. There is no "run arbitrary SQL" endpoint.
//
// Required environment variables / secrets (set in the Cloudflare
// dashboard under Workers → your worker → Settings → Variables):
//   TURSO_DB_URL      e.g. https://rcrsb-commissioning-yourname.turso.io
//   TURSO_AUTH_TOKEN  a token from `turso db tokens create <db-name>`
//   ALLOWED_ORIGIN    the exact origin your site is served from, e.g.
//                      https://yourorg.github.io  (comma-separate if more than one)
// ─────────────────────────────────────────────────────────────

const ALLOWED_PROJECTS = new Set(["rcrsb"]);
const ALLOWED_CHECK_KEYS = new Set(["power", "network", "function"]);
const ALLOWED_CHECK_VALUES = new Set(["pass", "fail", null]);
const ALLOWED_SEVERITIES = new Set(["minor", "major", "critical"]);
const ID_PATTERN = /^[a-z0-9-]{1,80}$/;
const MAX_TEXT_LEN = 2000;
const MAX_NAME_LEN = 120;

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}),
  });
}

function badRequest(msg, extraHeaders) {
  return json({ error: msg }, 400, extraHeaders);
}

// ---------- Turso (SQLite) access — server-side only ----------
function tArg(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") return { type: "integer", value: String(v) };
  return { type: "text", value: String(v) };
}

async function runSql(env, statements) {
  const url = `${env.TURSO_DB_URL.replace(/\/$/, "")}/v2/pipeline`;
  const body = {
    requests: [
      ...statements.map((s) => ({
        type: "execute",
        stmt: { sql: s.sql, args: (s.args || []).map(tArg) },
      })),
      { type: "close" },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Turso request failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const out = await res.json();
  for (const r of out.results || []) {
    if (r.type === "error") throw new Error(`SQL error: ${r.error?.message || "unknown"}`);
  }
  return out.results;
}

function cellsToObject(cols, cells) {
  const obj = {};
  cols.forEach((c, i) => {
    obj[c.name] = cells[i] ? cells[i].value : null;
  });
  return obj;
}

async function ensureTables(env) {
  await runSql(env, [
    {
      sql: `CREATE TABLE IF NOT EXISTS checklist (
              project_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              power TEXT,
              network TEXT,
              function TEXT,
              updated_by TEXT,
              updated_at TEXT,
              PRIMARY KEY (project_id, device_id)
            )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS punch (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              device_id TEXT,
              device_name TEXT,
              location TEXT,
              description TEXT,
              severity TEXT,
              status TEXT NOT NULL DEFAULT 'open',
              reported_by TEXT,
              created_at TEXT,
              resolved_by TEXT,
              resolved_at TEXT
            )`,
    },
  ]);
}

// ---------- request handlers ----------
async function handleGetState(env, url) {
  const project = url.searchParams.get("project") || "";
  if (!ALLOWED_PROJECTS.has(project)) return badRequest("Unknown project");

  const results = await runSql(env, [
    { sql: "SELECT * FROM checklist WHERE project_id = ?", args: [project] },
    { sql: "SELECT * FROM punch WHERE project_id = ?", args: [project] },
  ]);

  const checklistRows = results[0]?.response?.result;
  const punchRows = results[1]?.response?.result;

  const checklist = {};
  (checklistRows?.rows || []).forEach((cells) => {
    const row = cellsToObject(checklistRows.cols, cells);
    checklist[row.device_id] = {
      power: row.power,
      network: row.network,
      function: row.function,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  });

  const punches = (punchRows?.rows || []).map((cells) => {
    const row = cellsToObject(punchRows.cols, cells);
    return {
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      location: row.location,
      description: row.description,
      severity: row.severity,
      status: row.status,
      reportedBy: row.reported_by,
      createdAt: row.created_at,
      resolvedBy: row.resolved_by || undefined,
      resolvedAt: row.resolved_at || undefined,
    };
  });

  return { checklist, punches };
}

async function handleSetCheck(env, body) {
  const { project, deviceId, key, value, updatedBy } = body;
  if (!ALLOWED_PROJECTS.has(project)) throw new HttpError(400, "Unknown project");
  if (!ID_PATTERN.test(deviceId || "")) throw new HttpError(400, "Invalid deviceId");
  if (!ALLOWED_CHECK_KEYS.has(key)) throw new HttpError(400, "Invalid check key");
  if (!ALLOWED_CHECK_VALUES.has(value)) throw new HttpError(400, "Invalid check value");
  const who = String(updatedBy || "Unnamed tech").slice(0, MAX_NAME_LEN);

  // `key` is interpolated directly into the column name/list below, which is
  // normally an injection risk — it's safe here ONLY because it was just
  // checked against ALLOWED_CHECK_KEYS and can be nothing but 'power',
  // 'network', or 'function'. The actual value is still a bound parameter.
  await runSql(env, [
    {
      sql: `INSERT INTO checklist (project_id, device_id, ${key}, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id, device_id) DO UPDATE SET
              ${key} = excluded.${key},
              updated_by = excluded.updated_by,
              updated_at = excluded.updated_at`,
      args: [project, deviceId, value, who, new Date().toISOString()],
    },
  ]);

  return { ok: true };
}

async function handleAddPunch(env, body) {
  const { project, deviceId, deviceName, location, description, severity, reportedBy } = body;
  if (!ALLOWED_PROJECTS.has(project)) throw new HttpError(400, "Unknown project");
  if (!ID_PATTERN.test(deviceId || "")) throw new HttpError(400, "Invalid deviceId");
  if (!ALLOWED_SEVERITIES.has(severity)) throw new HttpError(400, "Invalid severity");
  const desc = String(description || "").trim().slice(0, MAX_TEXT_LEN);
  if (!desc) throw new HttpError(400, "Description is required");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await runSql(env, [
    {
      sql: `INSERT INTO punch (id, project_id, device_id, device_name, location, description, severity, status, reported_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      args: [
        id,
        project,
        deviceId,
        String(deviceName || "").slice(0, MAX_NAME_LEN),
        String(location || "").slice(0, MAX_NAME_LEN),
        desc,
        severity,
        String(reportedBy || "Unnamed tech").slice(0, MAX_NAME_LEN),
        now,
      ],
    },
  ]);

  return { id };
}

async function handleTogglePunch(env, body) {
  const { project, id, actorName } = body;
  if (!ALLOWED_PROJECTS.has(project)) throw new HttpError(400, "Unknown project");
  if (!id || String(id).length > 100) throw new HttpError(400, "Invalid punch id");
  const who = String(actorName || "Unnamed tech").slice(0, MAX_NAME_LEN);
  const now = new Date().toISOString();

  await runSql(env, [
    {
      sql: `UPDATE punch SET
              status = CASE WHEN status = 'open' THEN 'resolved' ELSE 'open' END,
              resolved_by = CASE WHEN status = 'open' THEN ? ELSE NULL END,
              resolved_at = CASE WHEN status = 'open' THEN ? ELSE NULL END
            WHERE id = ? AND project_id = ?`,
      args: [who, now, id, project],
    },
  ]);

  return { ok: true };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (!env.TURSO_DB_URL || !env.TURSO_AUTH_TOKEN) {
      return json({ error: "Worker is not configured (missing Turso credentials)" }, 500, headers);
    }

    try {
      await ensureTables(env);

      if (url.pathname === "/api/state" && request.method === "GET") {
        const data = await handleGetState(env, url);
        return json(data, 200, headers);
      }

      if (url.pathname === "/api/check" && request.method === "POST") {
        const body = await request.json();
        const data = await handleSetCheck(env, body);
        return json(data, 200, headers);
      }

      if (url.pathname === "/api/punch" && request.method === "POST") {
        const body = await request.json();
        const data = await handleAddPunch(env, body);
        return json(data, 200, headers);
      }

      if (url.pathname === "/api/punch/toggle" && request.method === "POST") {
        const body = await request.json();
        const data = await handleTogglePunch(env, body);
        return json(data, 200, headers);
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "rcrsb-commissioning-sync" }, 200, headers);
      }

      return json({ error: "Not found" }, 404, headers);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.error(e);
      return json({ error: e.message || "Internal error" }, status, headers);
    }
  },
};
