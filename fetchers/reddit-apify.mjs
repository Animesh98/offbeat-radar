// Reddit fetcher — Apify backend.
//
// Uses the trudax/reddit-scraper-lite actor via the synchronous
// `run-sync-get-dataset-items` endpoint. One call returns N posts as JSON,
// no pagination dance.
//
// Cost (free-tier): ~$0.30 per 1000 posts. ~25 subs × ~25 fresh posts/run ≈
// 600 posts/run × 48 runs/day = ~$5/mo. Free tier credit is $5/mo so OOP ~$0.
//
// Requires APIFY_TOKEN in env. Used as fallback when REDDIT_CLIENT_ID is
// absent (i.e., we don't have approved Reddit API access yet).

const ACTOR_ID = 'trudax~reddit-scraper-lite';
const ENDPOINT = (token, timeout) =>
  `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}&timeout=${timeout}`;

function passesHeuristics(post, cfg) {
  const flair = (post.flair || '').toLowerCase();
  const title = (post.title || '').toLowerCase();
  for (const f of cfg.drop_flairs || []) {
    if (flair.includes(f.toLowerCase())) return false;
  }
  for (const kw of cfg.drop_title_keywords || []) {
    if (title.includes(kw.toLowerCase())) return false;
  }
  if (post.over18) return false;
  return true;
}

function normalize(item) {
  // Apify returns "t3_1t550ia"; strip the prefix to get a stable Reddit
  // post id (matches what /r/{sub}/new.json returns under .data.id).
  const rawId = String(item.id || '');
  const post_id = rawId.startsWith('t3_') ? rawId.slice(3) : rawId;
  const sub = (item.parsedCommunityName || (item.communityName || '').replace(/^r\//, '')).trim();
  const created = item.createdAt ? Date.parse(item.createdAt) : Date.now();
  return {
    source: `reddit:${sub}`,
    post_id,
    url: item.url || `https://www.reddit.com/r/${sub}/comments/${post_id}/`,
    author: item.username || null,
    title: item.title || '',
    body: item.body || '',
    flair: item.flair || null,
    created_at: created,
    score: item.upVotes || 0,
    num_comments: item.numberOfComments || 0,
    raw: item,
  };
}

async function runActor(startUrls, maxItems, token, timeoutSec = 90) {
  const res = await fetch(ENDPOINT(token, timeoutSec), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls,
      maxItems,
      maxPostCount: maxItems,
      skipComments: true,
      skipUserPosts: true,
      scrollTimeout: 40,
      type: 'posts',
      proxy: { useApifyProxy: true },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Apify ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Apify: non-array response');
  return data;
}

export async function fetchAllRedditApify(cfg) {
  if (!cfg.enabled) return { posts: [], errors: [] };
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN missing in env');

  const subs = (cfg.subreddits || []).filter(s => (s.weight ?? 1) > 0);
  if (!subs.length) return { posts: [], errors: [] };

  const cutoff = Date.now() - (cfg.fresh_window_hours || 24) * 3600_000;
  const perSub = Math.min(cfg.posts_per_sub || 25, 50);
  const maxItems = Math.max(perSub * subs.length, 50);
  const out = [];
  const errors = [];

  // Empirically, Apify's reddit-scraper-lite times out around 120s when given
  // many subs at once. Smaller chunks parallelize at our end and keep each
  // sync run well under the cap.
  const chunkSize = 4;
  const chunks = [];
  for (let i = 0; i < subs.length; i += chunkSize) {
    chunks.push(subs.slice(i, i + chunkSize));
  }

  // Limit concurrent Apify runs to be polite (and stay under free-tier
  // memory limits, which scale with parallel runs).
  const parallel = 3;
  for (let i = 0; i < chunks.length; i += parallel) {
    const wave = chunks.slice(i, i + parallel);
    const results = await Promise.allSettled(wave.map(async (chunk) => {
      const startUrls = chunk.map(s => ({ url: `https://www.reddit.com/r/${s.name}/new/` }));
      const items = await runActor(startUrls, perSub * chunk.length, token, 90);
      return { chunk, items };
    }));
    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push(`Apify run: ${r.reason?.message || r.reason}`);
        continue;
      }
      const { chunk, items } = r.value;
      const subMeta = new Map(chunk.map(s => [s.name.toLowerCase(), s]));
      for (const item of items) {
        const p = normalize(item);
        if (p.created_at < cutoff) continue;
        if (!passesHeuristics(p, cfg)) continue;
        const subName = p.source.replace(/^reddit:/, '').toLowerCase();
        const meta = subMeta.get(subName);
        if (meta) {
          p.role_focus = meta.role_focus;
          p.weight = meta.weight;
        }
        out.push(p);
      }
    }
  }
  return { posts: out, errors };
}
