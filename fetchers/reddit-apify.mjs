// Reddit fetcher — Apify backend.
//
// Uses the trudax/reddit-scraper-lite actor via the synchronous
// `run-sync-get-dataset-items` endpoint. One call returns N posts as JSON,
// no pagination dance.
//
// COST: trudax/reddit-scraper-lite is Pay-Per-Result at $3.40 per 1,000
// dataset items. The free Apify plan gives $5/mo credit ≈ 1,470 items/mo.
//
// Important: the local seen-set in offbeat.db filters posts BEFORE Haiku
// classification, but Apify is called BEFORE the seen-set runs (see
// offbeat-fetch.mjs orchestration). So Apify bills us for every item it
// extracts each run, including repeats from prior runs. Cost scales with
// subs × posts_per_sub × runs/day, not with unique-posts/day.
//
// Shipped default (4 subs × posts_per_sub=8 × every-6h cadence) ≈
// 3,840 items/mo ≈ $13/mo gross ≈ $8/mo OOP after free credit. Stay
// inside that envelope on the Apify path; bigger setups belong on
// Reddit OAuth (Option A in SETUP.md).
//
// TIMEOUTS: the actor's default `timeoutSecs` is 300s (per its run options
// schema). We DO NOT pass a `?timeout=` query param — that param sets the
// run's hard kill deadline, and a value below the actor's natural runtime
// (with proxy + scroll + multiple startUrls) just produces TIMED-OUT runs.
// Instead we keep chunks small enough to comfortably finish under 300s.
//
// Requires APIFY_TOKEN in env. Used as fallback when REDDIT_CLIENT_ID is
// absent (i.e., we don't have approved Reddit API access yet).

const ACTOR_ID = 'trudax~reddit-scraper-lite';
const ENDPOINT = (token) =>
  `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`;

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

async function runActor(startUrls, maxItems, perSub, token) {
  // Note on knobs (see input schema at https://apify.com/trudax/reddit-scraper-lite):
  //   maxItems     — global cap across the whole run.
  //   maxPostCount — per-startUrl cap (per subreddit). We set it to perSub
  //                  so one heavy sub can't swallow the whole budget.
  //   skipCommunity / skipComments / skipUserPosts — strip the actor's
  //                  default community-page + comment + user-post passes;
  //                  we only want post listings.
  const res = await fetch(ENDPOINT(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls,
      maxItems,
      maxPostCount: perSub,
      skipComments: true,
      skipUserPosts: true,
      skipCommunity: true,
      scrollTimeout: 40,
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

  // Smaller chunks finish well under the actor's 300s default timeout
  // even on slow subs + residential proxy. chunkSize=2 ≈ ~30–60s per run
  // in practice and gives us better failure isolation (one bad sub
  // doesn't kill three siblings).
  const chunkSize = 2;
  const chunks = [];
  for (let i = 0; i < subs.length; i += chunkSize) {
    chunks.push(subs.slice(i, i + chunkSize));
  }

  // Cap concurrent Apify runs to stay polite + under free-plan memory.
  const parallel = 3;
  for (let i = 0; i < chunks.length; i += parallel) {
    const wave = chunks.slice(i, i + parallel);
    const results = await Promise.allSettled(wave.map(async (chunk) => {
      const startUrls = chunk.map(s => ({ url: `https://www.reddit.com/r/${s.name}/new/` }));
      const items = await runActor(startUrls, perSub * chunk.length, perSub, token);
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
