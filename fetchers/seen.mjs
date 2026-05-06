// SQLite store for the offbeat scraper.
//
//   seen_posts   layer-1 dedup: never re-process the same source post.
//   scored       normalized + scored JD records, source of truth for the digest.
//   runs         operational log: when fetch/digest fired, counts, errors.
//
// Single file at data/offbeat.db. WAL mode so concurrent fetch+digest is safe.

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen_posts (
  source     TEXT NOT NULL,
  post_id    TEXT NOT NULL,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (source, post_id)
);
CREATE INDEX IF NOT EXISTS idx_seen_at ON seen_posts(seen_at);

CREATE TABLE IF NOT EXISTS scored (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,        -- e.g. 'reddit:forhire' or 'hn:hiring'
  post_id         TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  author          TEXT,
  company         TEXT,
  role            TEXT    NOT NULL,
  location        TEXT,
  remote          TEXT,                    -- remote|hybrid|onsite|unknown
  comp_range      TEXT,
  contact_method  TEXT,                    -- DM|email|form|comment
  contact_value   TEXT,
  apply_url       TEXT,
  classification  TEXT    NOT NULL,        -- HIRING|SEEKING|...
  confidence      REAL,
  score           REAL,                    -- 0..10 from smart-filter
  verdict         TEXT,                    -- APPLY|LEAN-APPLY|SKIP|HOLD
  reasoning       TEXT,
  raw             TEXT,                    -- JSON of original post
  created_at      INTEGER NOT NULL,        -- post creation epoch
  ingested_at     INTEGER NOT NULL,        -- when we scored it
  digested_at     INTEGER,                 -- when it was emailed (NULL = pending)
  skipped         INTEGER DEFAULT 0,       -- 1 if user clicked Skip
  tailored_path   TEXT,                    -- path to auto-tailored .tex if APPLY
  UNIQUE(source, post_id)
);
CREATE INDEX IF NOT EXISTS idx_scored_pending  ON scored(digested_at, skipped);
CREATE INDEX IF NOT EXISTS idx_scored_company  ON scored(company, role);
CREATE INDEX IF NOT EXISTS idx_scored_ingested ON scored(ingested_at);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,            -- 'fetch' | 'digest'
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  ok          INTEGER NOT NULL DEFAULT 0,
  posts_seen  INTEGER DEFAULT 0,
  posts_new   INTEGER DEFAULT 0,
  posts_kept  INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_kind_started ON runs(kind, started_at);
`;

let _db;

export function db(path = 'data/offbeat.db') {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.exec(SCHEMA);
  return _db;
}

export function markSeen(source, postId) {
  db().prepare(
    'INSERT OR IGNORE INTO seen_posts (source, post_id, seen_at) VALUES (?, ?, ?)'
  ).run(source, postId, Date.now());
}

export function isSeen(source, postId) {
  const row = db().prepare(
    'SELECT 1 FROM seen_posts WHERE source = ? AND post_id = ?'
  ).get(source, postId);
  return !!row;
}

export function pruneSeen(olderThanDays = 30) {
  const cutoff = Date.now() - olderThanDays * 86400_000;
  return db().prepare('DELETE FROM seen_posts WHERE seen_at < ?').run(cutoff).changes;
}

export function upsertScored(row) {
  return db().prepare(`
    INSERT INTO scored (
      source, post_id, url, author, company, role, location, remote,
      comp_range, contact_method, contact_value, apply_url,
      classification, confidence, score, verdict, reasoning, raw,
      created_at, ingested_at
    ) VALUES (
      @source, @post_id, @url, @author, @company, @role, @location, @remote,
      @comp_range, @contact_method, @contact_value, @apply_url,
      @classification, @confidence, @score, @verdict, @reasoning, @raw,
      @created_at, @ingested_at
    )
    ON CONFLICT(source, post_id) DO UPDATE SET
      score = excluded.score,
      verdict = excluded.verdict,
      reasoning = excluded.reasoning
  `).run(row);
}

export function pendingDigestRows({ minScore = 5.0, max = 12 } = {}) {
  return db().prepare(`
    SELECT * FROM scored
    WHERE digested_at IS NULL
      AND skipped = 0
      AND classification = 'HIRING'
      AND COALESCE(score, 0) >= ?
    ORDER BY score DESC, ingested_at DESC
    LIMIT ?
  `).all(minScore, max);
}

export function markDigested(ids) {
  if (!ids.length) return 0;
  const now = Date.now();
  const stmt = db().prepare('UPDATE scored SET digested_at = ? WHERE id = ?');
  const tx = db().transaction((rows) => {
    for (const id of rows) stmt.run(now, id);
  });
  tx(ids);
  return ids.length;
}

export function markSkipped(id) {
  return db().prepare('UPDATE scored SET skipped = 1 WHERE id = ?').run(id).changes;
}

export function setTailoredPath(id, path) {
  return db().prepare('UPDATE scored SET tailored_path = ? WHERE id = ?').run(path, id).changes;
}

// Cross-source dedup against career-ops's main tracker is done in
// orchestrator.js (it loads applications.md via parsers there). Here we
// only handle source-internal dedup against our own scored history.
export function existingByCompanyRole(company, role, windowDays = 7) {
  if (!company || !role) return null;
  const cutoff = Date.now() - windowDays * 86400_000;
  return db().prepare(`
    SELECT id, source, post_id FROM scored
    WHERE LOWER(company) = LOWER(?) AND LOWER(role) = LOWER(?)
      AND ingested_at >= ?
    LIMIT 1
  `).get(company, role, cutoff);
}

export function startRun(kind) {
  return db().prepare(
    'INSERT INTO runs (kind, started_at) VALUES (?, ?)'
  ).run(kind, Date.now()).lastInsertRowid;
}

export function finishRun(id, { ok, postsSeen, postsNew, postsKept, emailsSent, error }) {
  return db().prepare(`
    UPDATE runs SET
      ended_at = ?, ok = ?, posts_seen = ?, posts_new = ?,
      posts_kept = ?, emails_sent = ?, error = ?
    WHERE id = ?
  `).run(Date.now(), ok ? 1 : 0, postsSeen ?? 0, postsNew ?? 0,
    postsKept ?? 0, emailsSent ?? 0, error || null, id);
}

// Used by the direct backend's adaptive-delay logic. Returns a 0..1 ratio
// of fetch runs in the last `n` rows that ended with an error. Stateless;
// reads straight from the runs table so it survives restarts.
export function recentFailureRate(n = 6) {
  const rows = db().prepare(
    "SELECT error FROM runs WHERE kind='fetch' ORDER BY id DESC LIMIT ?"
  ).all(n);
  if (!rows.length) return 0;
  const failed = rows.filter(r => r.error && r.error.length).length;
  return failed / rows.length;
}

export function statusSnapshot() {
  const lastFetch = db().prepare(
    "SELECT * FROM runs WHERE kind='fetch' ORDER BY id DESC LIMIT 1"
  ).get();
  const lastDigest = db().prepare(
    "SELECT * FROM runs WHERE kind='digest' ORDER BY id DESC LIMIT 1"
  ).get();
  const counts = db().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN classification='HIRING' THEN 1 ELSE 0 END) AS hiring,
      SUM(CASE WHEN digested_at IS NULL AND skipped=0 AND classification='HIRING'
          THEN 1 ELSE 0 END) AS pending_digest,
      SUM(CASE WHEN verdict='APPLY' THEN 1 ELSE 0 END) AS apply_count
    FROM scored WHERE ingested_at >= ?
  `).get(Date.now() - 7 * 86400_000);
  const recentErrors = db().prepare(`
    SELECT kind, started_at, error FROM runs
    WHERE error IS NOT NULL AND started_at >= ?
    ORDER BY id DESC LIMIT 5
  `).all(Date.now() - 24 * 3600_000);
  return { lastFetch, lastDigest, counts, recentErrors };
}
