// Hacker News fetcher — Algolia search API (free, no auth).
//
// Strategy:
//   1. Find the active "Ask HN: Who is hiring?" thread for the current month.
//      We resolve it once per month and cache the story id.
//   2. Pull top-level comments via Algolia's search_by_date filtered by parent
//      story, narrowed to last 24h via numericFilters=created_at_i>{ts}.
//   3. Same for "Freelancer? Seeking freelancer?" (separate cadence — quarterly,
//      so we resolve it dynamically each run).
//
// API: https://hn.algolia.com/api
//   GET /api/v1/search?query=Ask%20HN%3A%20Who%20is%20hiring&tags=story
//   GET /api/v1/search_by_date?tags=comment,story_{id}&numericFilters=created_at_i>{ts}

const API = 'https://hn.algolia.com/api/v1';

async function findThread(query) {
  // Sorted by date (search_by_date) and scoped to the whoishiring user.
  // We then match by title prefix so we hit the right thread even if older
  // months show up first in the response.
  const url = `${API}/search_by_date?tags=author_whoishiring,story&hitsPerPage=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN search failed: ${res.status}`);
  const data = await res.json();
  const titlePrefix = query.toLowerCase();
  const matches = (data.hits || []).filter(h =>
    (h.title || '').toLowerCase().startsWith(titlePrefix)
  );
  matches.sort((a, b) => (b.created_at_i || 0) - (a.created_at_i || 0));
  return matches[0]; // most recent matching thread
}

async function fetchCommentsSince(storyId, sinceUnix) {
  // HN's Algolia API caps hitsPerPage at 1000.
  const url = `${API}/search_by_date?tags=comment,story_${storyId}` +
              `&numericFilters=created_at_i>${sinceUnix}` +
              `&hitsPerPage=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN comments fetch failed: ${res.status}`);
  const data = await res.json();
  return data.hits || [];
}

function normalizeComment(c, kind, parentTitle) {
  const url = `https://news.ycombinator.com/item?id=${c.objectID}`;
  return {
    source: `hn:${kind}`,
    post_id: String(c.objectID),
    url,
    author: c.author,
    title: parentTitle,        // we use parent thread title since comments lack one
    body: stripHtml(c.comment_text || ''),
    flair: null,
    created_at: c.created_at_i * 1000,
    score: c.points || 0,
    num_comments: 0,
    raw: c,
  };
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&#x2F;/g, '/').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
}

export async function fetchAllHN(cfg) {
  if (!cfg.enabled) return { posts: [], errors: [] };
  const cutoff = Math.floor((Date.now() - (cfg.fresh_window_hours || 24) * 3600_000) / 1000);
  const out = [];
  const errors = [];

  for (const t of cfg.threads || []) {
    try {
      const thread = await findThread(t.title_pattern);
      if (!thread) {
        errors.push(`HN thread not found: ${t.title_pattern}`);
        continue;
      }
      const comments = await fetchCommentsSince(thread.objectID, cutoff);
      for (const c of comments) {
        out.push(normalizeComment(c, t.type, thread.title));
      }
    } catch (e) {
      errors.push(`HN ${t.type}: ${e.message}`);
    }
  }
  return { posts: out, errors };
}
