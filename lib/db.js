// Database access. In production this is Neon Postgres (DATABASE_URL, added
// from Vercel → Storage → Neon). Without DATABASE_URL, local development uses
// PGlite: a real Postgres compiled to WebAssembly, stored in ./data/pglite.
// Both run the same SQL.

let client = null;
let ready = null;

async function connect() {
  if (process.env.DATABASE_URL) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    return { query: (text, params) => sql.query(text, params) };
  }
  if (process.env.VERCEL) throw new Error('DATABASE_URL is not set. Add Neon from Vercel → Storage.');
  // Kept out of the static import graph so Vercel never bundles PGlite.
  const name = '@electric-sql/pglite';
  const { PGlite } = await import(name);
  const dir = process.env.PGLITE_DIR || './data/pglite';
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  return { query: async (text, params) => (await db.query(text, params)).rows };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    sub TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    bio TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    banned BOOLEAN NOT NULL DEFAULT FALSE,
    jace_banned BOOLEAN NOT NULL DEFAULT FALSE,
    jace_muted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS users_username ON users (lower(username))`,
  `CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    mime TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    author_sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    prep_time INT NOT NULL DEFAULT 0,
    servings INT NOT NULL DEFAULT 1,
    ingredients JSONB NOT NULL,
    steps JSONB NOT NULL,
    image_url TEXT,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'published',
    safety_notes JSONB NOT NULL DEFAULT '[]',
    mod_reasons JSONB NOT NULL DEFAULT '[]',
    takedown_reason TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS recipes_list ON recipes (status, verified DESC, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS recipes_author ON recipes (author_sub)`,
];

/** Runs a parameterized query ($1, $2, …) and returns the rows. */
export async function query(text, params = []) {
  if (!ready) {
    ready = (async () => {
      client = await connect();
      for (const stmt of SCHEMA) await client.query(stmt, []);
    })().catch((e) => { ready = null; throw e; });
  }
  await ready;
  return client.query(text, params);
}

export async function one(text, params) {
  return (await query(text, params))[0] || null;
}
