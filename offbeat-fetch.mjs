#!/usr/bin/env node
/**
 * offbeat-fetch.mjs — Reddit + HN job-radar orchestrator
 *
 * Pipeline:
 *   fetchers (Reddit, HN) → seen-set filter → heuristic drop → Haiku normalize
 *      → cross-source dedup → upsert scored → POST APPLY rows to dashboard
 *      → log run
 *
 * Idempotent: re-runs are cheap because the seen-set prevents re-classifying
 * already-seen posts. The seen-set saves Haiku tokens but does NOT save
 * Apify cost (Apify runs before seen-set; see fetchers/reddit-apify.mjs).
 * Designed for systemd-timer invocation; cadence depends on backend
 * (see SETUP.md): every 6h on Apify-only, hourly on Reddit OAuth.
 *
 * Usage:
 *   node offbeat-fetch.mjs           # full run
 *   node offbeat-fetch.mjs --dry     # fetch + classify, don't trigger tailor
 *   node offbeat-fetch.mjs --verbose
 */

import { readFileSync, existsSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import yaml from 'js-yaml';

import {
  startRun, finishRun, isSeen, markSeen, upsertScored,
  existingByCompanyRole, setTailoredPath,
} from './fetchers/seen.mjs';
import { fetchAllReddit } from './fetchers/reddit.mjs';
import { fetchAllHN } from './fetchers/hn.mjs';
import { fetchAllHNJobs } from './fetchers/hn-jobs.mjs';
import { normalizeBatch } from './fetchers/normalize.mjs';

// ── Env ─────────────────────────────────────────────────────────────
loadEnv({ path: '.env', quiet: true });
// Optional secondary env files (paths can be set via OFFBEAT_EXTRA_ENV_FILES,
// colon-separated). Useful when sharing creds across multiple tools.
for (const p of (process.env.OFFBEAT_EXTRA_ENV_FILES || '').split(':').filter(Boolean)) {
  loadEnv({ path: p, quiet: true });
}

const DRY = process.argv.includes('--dry');
const VERBOSE = process.argv.includes('--verbose');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : 0;
const log = (...a) => console.log(...a);
const vlog = (...a) => { if (VERBOSE) console.log(...a); };

const CONFIG_PATH = 'config/offbeat.yml';
const APPLICATIONS_PATH = 'data/applications.md';
const DASHBOARD_URL = process.env.OFFBEAT_DASHBOARD_URL || 'http://127.0.0.1:8001';

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`config not found: ${CONFIG_PATH}`);
  return yaml.load(readFileSync(CONFIG_PATH, 'utf-8'));
}

// Cross-source dedup: parse applications.md (simple grep) for existing
// company::role combos in the last N days.
function loadApplicationsRoles(windowDays = 14) {
  if (!existsSync(APPLICATIONS_PATH)) return new Set();
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const cutoff = new Date(Date.now() - windowDays * 86400_000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const set = new Set();
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim());
    // Format: | # | YYYY-MM-DD | Company | Role | ...
    if (cells.length < 5) continue;
    const date = cells[2];
    const company = cells[3];
    const role = cells[4];
    if (!date || date === 'Date' || date === '---' || date < cutoffStr) continue;
    if (!company || !role) continue;
    set.add(`${company.toLowerCase()}::${role.toLowerCase()}`);
  }
  return set;
}

async function maybeAutoTailor(scoredId, post, normalized) {
  if (DRY) { vlog('[dry] would tailor', scoredId); return; }
  if (normalized.verdict !== 'APPLY') return;
  const token = process.env.CAREER_OPS_EXT_TOKEN;
  if (!token) { vlog('no EXT token; skipping auto-tailor'); return; }

  // Build a JD-shaped payload from the Reddit/HN post.
  const job = normalized.job || {};
  const text = [
    `Source: ${post.source}`,
    `Author: u/${post.author}`,
    `Posted: ${new Date(post.created_at).toISOString()}`,
    `URL: ${post.url}`,
    `Role: ${job.role || post.title}`,
    `Company: ${job.company || '(not stated)'}`,
    `Location: ${job.location || 'Unknown'} (${job.remote || 'unknown'})`,
    `Compensation: ${job.comp_range || 'Not stated'}`,
    `Apply via: ${job.contact_method || 'unknown'} — ${job.contact_value || job.apply_url || post.url}`,
    '',
    '─── ORIGINAL POST ───',
    post.title,
    '',
    post.body || '(empty body)',
  ].join('\n');

  if (text.length < 250) {
    vlog('post too short for tailor pipeline:', post.post_id);
    return;
  }

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/extension/jd`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: post.url,
        title: job.role || post.title,
        company_hint: job.company || '',
        text,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`dashboard ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    vlog(`auto-tailor queued: job_id=${data.job_id}`);
    // Don't block on tailor completion — record job_id; the tailored .tex
    // path will be filled by a follow-up call (or by the digest reading
    // the dashboard state).
    setTailoredPath(scoredId, `pending:${data.job_id}`);
  } catch (e) {
    vlog(`auto-tailor failed: ${e.message}`);
  }
}

async function main() {
  const cfg = loadConfig();
  const runId = startRun('fetch');
  const started = Date.now();
  const allErrors = [];
  let postsSeen = 0, postsNew = 0, postsKept = 0;

  try {
    // 1. Fetch in parallel.
    log('→ fetching Reddit + HN + HN /jobs...');
    const [reddit, hn, hnjobs] = await Promise.all([
      fetchAllReddit(cfg.reddit).catch(e => ({ posts: [], errors: [String(e.message)] })),
      fetchAllHN(cfg.hn).catch(e => ({ posts: [], errors: [String(e.message)] })),
      fetchAllHNJobs(cfg.hn_jobs).catch(e => ({ posts: [], errors: [String(e.message)] })),
    ]);
    allErrors.push(...reddit.errors, ...hn.errors, ...hnjobs.errors);
    const all = [...reddit.posts, ...hn.posts, ...hnjobs.posts];
    postsSeen = all.length;
    log(`  reddit: ${reddit.posts.length}  hn: ${hn.posts.length}  hn-jobs: ${hnjobs.posts.length}  errors: ${reddit.errors.length + hn.errors.length + hnjobs.errors.length}`);

    // 2. Filter out posts we've already classified.
    let fresh = all.filter(p => !isSeen(p.source, p.post_id));
    if (LIMIT > 0) fresh = fresh.slice(0, LIMIT);
    postsNew = fresh.length;
    log(`→ ${fresh.length} new posts (${all.length - fresh.length} previously seen)`);
    if (!fresh.length) {
      finishRun(runId, { ok: true, postsSeen, postsNew, postsKept, error: allErrors.join(' | ') || null });
      return;
    }

    // 3. Mark all as seen up front so a crash mid-classify doesn't re-bill.
    for (const p of fresh) markSeen(p.source, p.post_id);

    // 4. Normalize via Haiku.
    log(`→ classifying ${fresh.length} posts via Haiku...`);
    const profileSummary = cfg.profile?.summary || '';
    const { results, errors: normErrors } = await normalizeBatch(fresh, cfg.normalize, profileSummary);
    allErrors.push(...normErrors);
    log(`  classified: ${results.length}  errors: ${normErrors.length}`);

    // 5. Filter to keep classifications + apply confidence floor.
    const keepClass = new Set(cfg.normalize.keep || ['HIRING']);
    const minConf = cfg.normalize.min_confidence || 0.55;
    const candidates = results.filter(({ result }) =>
      keepClass.has(result.classification) && (result.confidence ?? 0) >= minConf
    );
    log(`→ ${candidates.length} HIRING candidates after confidence filter`);

    // 6. Cross-source dedup: against career-ops applications + our own scored history.
    const appsKeys = loadApplicationsRoles(cfg.dedup?.cross_source_window_days || 7);
    const dedupWindow = cfg.dedup?.cross_source_window_days || 7;

    for (const { post, result } of candidates) {
      const job = result.job || {};
      const company = job.company || null;
      const role = job.role || post.title;
      const key = company ? `${company.toLowerCase()}::${role.toLowerCase()}` : null;

      if (key && appsKeys.has(key)) {
        vlog(`  dedup (applications.md): ${company} :: ${role}`);
        continue;
      }
      if (company && existingByCompanyRole(company, role, dedupWindow)) {
        vlog(`  dedup (offbeat history): ${company} :: ${role}`);
        continue;
      }

      // 7. Threshold by digest_threshold.
      const score = result.score ?? 0;
      const minDigestScore = cfg.scoring?.digest_threshold ?? 5.0;

      // Insert into scored regardless (even SKIP/HOLD — useful for status counts),
      // but auto-tailor only runs for APPLY anyway.
      const id = upsertScored({
        source: post.source,
        post_id: post.post_id,
        url: post.url,
        author: post.author || null,
        company: company,
        role: role,
        location: job.location || null,
        remote: job.remote || null,
        comp_range: job.comp_range || null,
        contact_method: job.contact_method || null,
        contact_value: job.contact_value || null,
        apply_url: job.apply_url || null,
        classification: result.classification,
        confidence: result.confidence ?? null,
        score: score,
        verdict: result.verdict || null,
        reasoning: result.reasoning || null,
        raw: JSON.stringify(post.raw || {}).slice(0, 50_000),
        created_at: post.created_at,
        ingested_at: Date.now(),
      }).lastInsertRowid;

      if (score >= minDigestScore) postsKept++;

      // 8. Auto-tailor for APPLY.
      if (result.verdict === 'APPLY') {
        await maybeAutoTailor(id, post, result);
      }
    }

    log(`→ ${postsKept} kept above digest threshold (${cfg.scoring?.digest_threshold ?? 5.0})`);
    finishRun(runId, { ok: true, postsSeen, postsNew, postsKept,
      error: allErrors.length ? allErrors.slice(0, 5).join(' | ') : null });
  } catch (e) {
    console.error('fetch failed:', e);
    finishRun(runId, { ok: false, postsSeen, postsNew, postsKept, error: String(e.message || e) });
    process.exit(1);
  }
  log(`✓ done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main();
