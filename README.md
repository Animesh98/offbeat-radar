# Offbeat Radar

A personal job-search digest tool. Polls a small list of public job-related
subreddits, Hacker News' monthly "Who is hiring?" thread, and HN's `/jobs`
feed (paid YC-startup posts), classifies posts with an LLM against the
user's own profile, and emails ~4 short delta-digests per day. Single-user.
All data stays local.

This is a private utility, not a service. There is no public-facing surface,
no republishing of Reddit content, and no second user.

## What it does

```
Reddit (~10 subs)  ──┐
HN "Who is hiring?"  ├──▶ heuristic prefilter ──▶ LLM classify+score ──▶ SQLite ──▶ HTML email
HN /jobs (YC paid) ──┘                                                    │
                                                                          └──▶ skip / dedup
```

1. **Fetch** — on a systemd timer (default hourly with the free direct
   backend), pulls the newest posts from a configured set of subreddits
   (direct unauth, OAuth, or Apify), the current month's `Ask HN: Who is
   hiring?` thread (HN Algolia), and HN's `/jobs` feed (YC-startup paid
   postings via the official Firebase API; URLs followed for full JD body).
2. **Filter** — drops `[FOR HIRE]`-style posts, candidates seeking work,
   discussions, NSFW, and deleted content using flair + title heuristics.
3. **Classify** — sends survivors to Claude Haiku 4.5 with the user's
   profile (`config/offbeat.yml#profile.summary`) and gets back
   `{classification, job_fields, score 0–10, verdict}`.
4. **Dedup** — records posts in SQLite (`data/offbeat.db`) so a post is
   never re-classified, and skips repeats of the same `company::role` seen
   in the last 7 days.
5. **Digest** — at 4 fixed times/day, builds an HTML email with
   ~5–12 cards (sorted by score) and sends via Gmail SMTP. Empty digests
   are suppressed.

## Volume + rate limits

- **Default config (Apify path):** 4 subs × 8 posts/sub × 4 runs/day ≈ 128 items/day fetched. With the local seen-set + heuristic + dedup steps, net traffic to the LLM is ~30–60 posts/day.
- **API calls to Reddit:** ~16/day on Apify (4 subs × 4 runs); ~240/day if you switch to Reddit OAuth and bump cadence to hourly. Both far under the 100 QPM Reddit free-tier limit.
- **Apify cost:** ~$8/mo OOP at default config (after the $5 free credit). See `SETUP.md` for the cost matrix and why bigger configs belong on OAuth.
- **No data resold, republished, or shared.** The tool runs on the user's own server. All output goes only to the user's private inbox.
- **Retention:** the SQLite seen-set is pruned to 30 days. Post bodies and
  author names are stored only as long as needed to render the digest and
  prevent re-processing.

## Why this exists

Job alerts in major portals (LinkedIn, Indeed, Naukri) miss roles that get
posted as *Reddit threads* or *HN comments* by founders, small teams, and
agencies. Checking those manually is high-friction. This tool is a private
"radar" that surfaces them in the same digest format the user already
processes daily for other sources.

It is **not** a scraping product, not a multi-user service, and has no
plans to grow into either. The codebase is open-source mostly to be
transparent about how the user's Reddit data API access is being used.

## Tech

- **Node.js** (ESM). No build step.
- **SQLite** (`better-sqlite3`) for the seen-set + scored cache.
- **Anthropic Claude Haiku 4.5** for classify+extract+score in one tool-use call.
- **Reddit Data API** (preferred, free) **or** **Apify Reddit Scraper** (paid fallback).
- **Hacker News Algolia API** (free, no auth).
- **Gmail SMTP** for digest delivery.
- **systemd** user timers for scheduling.

## Setup

See [SETUP.md](./SETUP.md). Highlights:

1. `npm install`
2. Copy `config/offbeat.example.yml` → `config/offbeat.yml`, edit `profile.summary` and `subreddits`.
3. Copy `.env.example` → `.env`, fill `ANTHROPIC_API_KEY`, Gmail SMTP, and **either** Reddit API creds **or** an Apify token.
4. `node offbeat-fetch.mjs --verbose --limit=5` to smoke-test.
5. Wire systemd timers (templates included; see SETUP.md).

## Files

```
fetchers/
  reddit.mjs          # dispatcher: picks OAuth or Apify backend
  reddit-apify.mjs    # Apify Reddit Scraper backend
  hn.mjs              # HN Algolia API
  normalize.mjs       # Haiku 4.5 classify + extract + score
  seen.mjs            # SQLite (seen-set, scored, runs)
config/
  offbeat.example.yml # Subreddit list, thresholds, profile summary
offbeat-fetch.mjs     # Orchestrator (timer entrypoint)
offbeat-digest.mjs    # Delta digest renderer + SMTP send
```

## License

MIT. See [LICENSE](./LICENSE).

## Author

Animesh Sinha — [github.com/Animesh98](https://github.com/Animesh98)
