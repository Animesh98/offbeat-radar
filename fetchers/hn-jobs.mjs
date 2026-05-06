// Hacker News /jobs fetcher — official Firebase API.
//
// Pulls the ~30 currently active "job" stories from
//   https://hacker-news.firebaseio.com/v0/jobstories.json
// and fetches each item's metadata (title, url, time). Job items have no
// `text` body, so we follow the URL — most point to
// `ycombinator.com/companies/{slug}/jobs/{id}` (a public 200-OK page) or
// to external ATS hosts (ashbyhq, lever, greenhouse). We strip HTML and
// truncate to ~4KB so Haiku has enough JD context to score.
//
// Free, no auth. The HN /jobs feed is effectively a curated subset of
// workatastartup.com (gated), so this gives us most of the YC startup
// signal without the login wall.
//
// Cost-safe: we short-circuit on the seen-set BEFORE fetching the URL
// body, so already-classified posts cost only one cheap Firebase round-trip.

import { isSeen } from './seen.mjs';

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
const PER_REQ_TIMEOUT_MS = 10000;
const SOURCE = 'hn:jobs';

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res.json();
  } finally { clearTimeout(t); }
}

async function fetchBody(url, userAgent) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': userAgent, 'Accept': 'text/html,*/*' },
    });
    if (!res.ok) return '';
    const html = await res.text();
    return stripHtml(html).slice(0, 4000);
  } catch {
    return '';
  } finally { clearTimeout(t); }
}

export async function fetchAllHNJobs(cfg) {
  if (!cfg?.enabled) return { posts: [], errors: [] };

  const cutoff = Date.now() - (cfg.fresh_window_hours || 168) * 3600_000; // 7d default — YC jobs cycle slowly
  const ua = cfg.user_agent || 'offbeat-radar/1.0 (+jobs)';
  const enrich = cfg.enrich_body !== false;
  const errors = [];

  let ids;
  try {
    ids = await fetchJSON(`${FIREBASE}/jobstories.json`);
  } catch (e) {
    return { posts: [], errors: [`HN jobstories list: ${e.message}`] };
  }
  if (!Array.isArray(ids)) return { posts: [], errors: ['HN jobstories: non-array response'] };

  const max = Math.min(cfg.max_jobs || 40, ids.length);
  const slice = ids.slice(0, max);

  // Fetch item metadata in parallel (cheap Firebase calls).
  const items = await Promise.allSettled(slice.map(id => fetchJSON(`${FIREBASE}/item/${id}.json`)));

  // Filter to NEW jobs only (skip seen-set to avoid wasted body fetches).
  const fresh = [];
  for (const r of items) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const it = r.value;
    if (it.type !== 'job') continue;
    if (!it.id || !it.title) continue;
    if ((it.time || 0) * 1000 < cutoff) continue;
    if (isSeen(SOURCE, String(it.id))) continue;
    fresh.push(it);
  }

  // Fetch bodies sequentially with light spacing (be polite to YC + external ATS).
  const out = [];
  for (const it of fresh) {
    let body = '';
    if (enrich && it.url) {
      body = await fetchBody(it.url, ua);
      await new Promise(r => setTimeout(r, 500));
    }
    out.push({
      source: SOURCE,
      post_id: String(it.id),
      url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      author: it.by || null,
      title: it.title,
      body,
      flair: 'YC',
      created_at: (it.time || 0) * 1000,
      score: it.score || 0,
      num_comments: 0,
      raw: it,
    });
  }

  return { posts: out, errors };
}
