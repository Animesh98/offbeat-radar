// Reddit fetcher — dispatcher.
//
// Picks one of two backends at runtime:
//   1. OAuth script app (free, but Reddit gates the API behind a manual
//      review process — set REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD).
//   2. Apify reddit-scraper-lite (paid, ~$5/mo, no Reddit auth — set
//      APIFY_TOKEN).
//
// Selection rule: APIFY_TOKEN wins when present and REDDIT_CLIENT_ID is
// absent. If both are set, OAuth wins (free path preferred).
//
// Both paths return the same `{ posts: RawPost[], errors: string[] }` shape
// so the orchestrator doesn't care which one ran.

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fetchAllRedditApify } from './reddit-apify.mjs';

const TOKEN_PATH = 'data/.reddit-token.json';
const OAUTH_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

function env(name, required = true) {
  const v = process.env[name];
  if (required && !v) throw new Error(`Reddit fetcher: missing env ${name}`);
  return v;
}

async function fetchToken() {
  const id = env('REDDIT_CLIENT_ID');
  const secret = env('REDDIT_CLIENT_SECRET');
  const username = env('REDDIT_USERNAME');
  const password = env('REDDIT_PASSWORD');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const userAgent = (process.env.REDDIT_USER_AGENT
    || 'career-ops-offbeat/1.0 (by /u/' + username + ')');

  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'User-Agent': userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username,
      password,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Reddit OAuth failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const cache = {
    access_token: data.access_token,
    token_type: data.token_type,
    expires_at: Date.now() + (data.expires_in - 120) * 1000,
    user_agent: userAgent,
  };
  writeFileSync(TOKEN_PATH, JSON.stringify(cache, null, 2));
  return cache;
}

async function getToken() {
  if (existsSync(TOKEN_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
      if (cached.expires_at && Date.now() < cached.expires_at) return cached;
    } catch {}
  }
  return fetchToken();
}

async function authedGet(path, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `${token.token_type} ${token.access_token}`,
      'User-Agent': token.user_agent,
    },
  });
  if (res.status === 401) throw new Error('Reddit token expired mid-flight; retry.');
  if (!res.ok) throw new Error(`Reddit API ${res.status} on ${path}`);
  return res.json();
}

function passesHeuristics(post, cfg) {
  const flair = (post.link_flair_text || '').toLowerCase();
  const title = (post.title || '').toLowerCase();
  for (const f of cfg.drop_flairs || []) {
    if (flair.includes(f.toLowerCase())) return false;
  }
  for (const kw of cfg.drop_title_keywords || []) {
    if (title.includes(kw.toLowerCase())) return false;
  }
  if (post.removed_by_category || post.banned_by) return false;
  if (post.over_18) return false;
  return true;
}

function normalize(post, sub) {
  return {
    source: `reddit:${sub}`,
    post_id: post.id,
    url: 'https://www.reddit.com' + post.permalink,
    author: post.author,
    title: post.title,
    body: post.selftext || '',
    flair: post.link_flair_text || null,
    created_at: post.created_utc * 1000,
    score: post.score,
    num_comments: post.num_comments,
    raw: post,
  };
}

export async function fetchSubreddit(sub, cfg) {
  const token = await getToken();
  const limit = cfg.posts_per_sub || 100;
  const cutoff = Date.now() - (cfg.fresh_window_hours || 24) * 3600_000;

  const data = await authedGet(`/r/${sub}/new?limit=${limit}`, token);
  const children = data?.data?.children || [];
  const fresh = children
    .map(c => c.data)
    .filter(p => p.created_utc * 1000 >= cutoff)
    .filter(p => passesHeuristics(p, cfg));
  return fresh.map(p => normalize(p, sub));
}

async function fetchAllRedditOAuth(cfg) {
  if (!cfg.enabled) return { posts: [], errors: [] };
  const subs = (cfg.subreddits || []).filter(s => (s.weight ?? 1) > 0);
  const concurrency = 4;
  const out = [];
  const errors = [];

  for (let i = 0; i < subs.length; i += concurrency) {
    const batch = subs.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(s => fetchSubreddit(s.name, cfg).then(posts => ({ sub: s, posts })))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const p of r.value.posts) {
          p.role_focus = r.value.sub.role_focus;
          p.weight = r.value.sub.weight;
          out.push(p);
        }
      } else {
        errors.push(String(r.reason?.message || r.reason));
      }
    }
  }
  return { posts: out, errors };
}

export async function fetchAllReddit(cfg) {
  const hasOAuth = !!process.env.REDDIT_CLIENT_ID;
  const hasApify = !!process.env.APIFY_TOKEN;
  if (hasOAuth) return fetchAllRedditOAuth(cfg);
  if (hasApify) return fetchAllRedditApify(cfg);
  return { posts: [], errors: ['Reddit fetcher: no credentials (set REDDIT_CLIENT_ID or APIFY_TOKEN)'] };
}
