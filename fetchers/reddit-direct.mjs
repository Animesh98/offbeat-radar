// Reddit fetcher — direct unauth backend.
//
// Hits old.reddit.com's `.json` endpoint with a polite User-Agent and no
// auth. Free, no credentials needed. On 403/429/503 from the primary,
// falls back through a small list of redlib mirrors before giving up
// on a sub.
//
// Adaptive backoff: per-sub spacing doubles when recent fetch runs have
// been failing (read from the runs table via recentFailureRate).
//
// Volume context: at 4–10 active subs × hourly cadence we make ~96–240
// requests/day, well under Reddit's documented unauth ~10/min limit.
// Reliability risk is User-Agent / IP-reputation 403, not raw rate.

import { normalize, passesHeuristics } from './reddit.mjs';
import { recentFailureRate } from './seen.mjs';

const BASE_DELAY_MS = 1500;
const MAX_DELAY_MS = 12000;
const PER_REQ_TIMEOUT_MS = 15000;
const RETRY_AFTER_MS = 5000;

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

function adaptiveDelay() {
  const rate = recentFailureRate(6);
  const factor = Math.min(8, 1 + Math.floor(rate * 8));
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * factor);
}

async function tryUrl(url, userAgent) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
    });
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      throw new Error(`blocked:${res.status}`);
    }
    if (!res.ok) throw new Error(`http:${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const isBlocked = e => /^(blocked|http:5)/.test(String(e?.message || ''));

async function fetchOne(sub, limit, userAgent, mirrors) {
  const directUrl = `https://old.reddit.com/r/${sub}/new.json?limit=${limit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try { return { data: await tryUrl(directUrl, userAgent), via: 'old.reddit' }; }
    catch (e) {
      if (!isBlocked(e)) throw e;
      if (attempt === 0) await SLEEP(RETRY_AFTER_MS);
    }
  }

  for (const m of mirrors) {
    const base = m.replace(/\/$/, '');
    const url = `${base}/r/${sub}/new.json?limit=${limit}`;
    try { return { data: await tryUrl(url, userAgent), via: base }; }
    catch { /* try next mirror */ }
  }

  throw new Error(`all backends 403'd for r/${sub}`);
}

export async function fetchAllRedditDirect(cfg) {
  if (!cfg.enabled) return { posts: [], errors: [] };
  const subs = (cfg.subreddits || []).filter(s => (s.weight ?? 1) > 0);
  if (!subs.length) return { posts: [], errors: [] };

  const cutoff = Date.now() - (cfg.fresh_window_hours || 24) * 3600_000;
  const limit = cfg.posts_per_sub || 25;
  const ua = cfg.user_agent || 'offbeat-radar/1.0';
  const mirrors = cfg.mirror_list || [];
  const delay = adaptiveDelay();

  const out = [];
  const errors = [];

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    if (i > 0) await SLEEP(delay);

    try {
      const { data, via } = await fetchOne(s.name, limit, ua, mirrors);
      const children = data?.data?.children || [];
      for (const c of children) {
        const p = c.data || {};
        if (!p.id) continue;
        if ((p.created_utc || 0) * 1000 < cutoff) continue;
        if (!passesHeuristics(p, cfg)) continue;
        const np = normalize(p, s.name);
        np.role_focus = s.role_focus;
        np.weight = s.weight;
        out.push(np);
      }
      if (via !== 'old.reddit') {
        errors.push(`r/${s.name}: served via mirror ${via}`);
      }
    } catch (e) {
      errors.push(`r/${s.name}: ${e.message || e}`);
    }
  }

  return { posts: out, errors };
}
