// Haiku normalizer — single LLM call per post does:
//   1. classify { HIRING | SEEKING | DISCUSSION | GIG | SPAM } + confidence
//   2. extract { company, role, location, remote, comp_range, contact, apply_url }
// AND
//   3. score 0–10 fit against Animesh's profile + verdict (APPLY|LEAN|HOLD|SKIP)
//
// Conflates classification + scoring into one call to save tokens. Uses raw
// fetch + Anthropic tool_use (matching career-ops's existing pattern in
// smart-filter.mjs — no new SDK dep).

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_TIMEOUT_MS = 30_000;

const TOOL = {
  name: 'classify_and_score',
  description: 'Classify the post and, if HIRING, extract job fields and score role fit.',
  input_schema: {
    type: 'object',
    properties: {
      classification: {
        type: 'string',
        enum: ['HIRING', 'SEEKING', 'DISCUSSION', 'GIG', 'SPAM'],
      },
      confidence: { type: 'number' },
      job: {
        type: ['object', 'null'],
        properties: {
          company:        { type: ['string', 'null'] },
          role:           { type: 'string' },
          location:       { type: ['string', 'null'] },
          remote:         { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'unknown'] },
          comp_range:     { type: ['string', 'null'] },
          contact_method: { type: 'string', enum: ['DM', 'email', 'form', 'comment', 'unknown'] },
          contact_value:  { type: ['string', 'null'] },
          apply_url:      { type: ['string', 'null'] },
        },
      },
      score:     { type: ['number', 'null'] },
      verdict:   { type: ['string', 'null'], enum: ['APPLY', 'LEAN-APPLY', 'HOLD', 'SKIP', null] },
      reasoning: { type: 'string' },
    },
    required: ['classification', 'confidence', 'reasoning'],
  },
};

// The user's profile is loaded from config/offbeat.yml at runtime
// (profile.summary). The system prompt is built once per run.
function buildSystemPrompt(profileSummary) {
  return `You evaluate Reddit/HN posts as job leads for the following candidate.

CANDIDATE PROFILE:
${profileSummary || '(no profile configured — score conservatively, default to HOLD)'}

TASKS:
1. Classify the post:
   - HIRING: a company/founder/recruiter offering a role.
   - SEEKING: candidate offering services (skip).
   - DISCUSSION: not a job (skip).
   - GIG: 1–5 day microtask under $500 (skip).
   - SPAM: agency boilerplate, NSFW, unrelated.

2. If HIRING: extract structured job fields. apply_url is the explicit link, if any.

3. If HIRING: score 0–10 role fit against the candidate profile, then map verdict:
   - APPLY: score ≥ 8
   - LEAN-APPLY: 6 ≤ score < 8
   - HOLD: 4 ≤ score < 6
   - SKIP: score < 4 OR matches the candidate's HARD SKIPs

   Scoring guide:
   - 9–10: ideal fit on stack + level + location/remote + comp.
   - 7–8: clearly relevant; minor friction.
   - 5–6: adjacent (different stack but partial overlap, or anonymous "DM me").
   - 3–4: weak fit (wrong level or stack).
   - 0–2: hard skip signals.

4. reasoning: 1–2 sentences.

Be skeptical. Anonymous "DM me" caps at 6. No-comp + no-location caps at 5.
Hard skips override stack fit.`;
}

function buildUserMessage(post) {
  const created = new Date(post.created_at).toISOString();
  return `[Source: ${post.source}] [Posted: ${created}] [Author: u/${post.author}]
Title: ${post.title}
Flair: ${post.flair || '(none)'}

${(post.body || '').slice(0, 4000)}`;
}

async function classifyOne(post, model, apiKey, systemPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'classify_and_score' },
        messages: [{ role: 'user', content: buildUserMessage(post) }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const block = (data.content || []).find(b => b.type === 'tool_use');
    if (!block) throw new Error('No tool_use in response');
    return block.input;
  } finally {
    clearTimeout(timer);
  }
}

export async function normalizeBatch(posts, cfg, profileSummary = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  const model = cfg.model || 'claude-haiku-4-5-20251001';
  const concurrency = cfg.concurrency || 4;
  const systemPrompt = buildSystemPrompt(profileSummary);
  const out = [];
  const errors = [];

  for (let i = 0; i < posts.length; i += concurrency) {
    const batch = posts.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(p => classifyOne(p, model, apiKey, systemPrompt).then(r => ({ post: p, result: r })))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        out.push(r.value);
      } else {
        errors.push(String(r.reason?.message || r.reason));
      }
    }
  }
  return { results: out, errors };
}
