# Setup

## 1. Install

```bash
git clone https://github.com/Animesh98/offbeat-radar.git
cd offbeat-radar
npm install
```

Dependencies: `better-sqlite3`, `nodemailer`, `dotenv`, `js-yaml`.

## 2. Configure your profile

```bash
cp config/offbeat.example.yml config/offbeat.yml
$EDITOR config/offbeat.yml
```

Edit the `profile.summary` block — this is the single biggest knob. The LLM
uses it verbatim to score posts, so be specific. Stack, level, comp floor,
location, hard-skips. The more concrete, the better the score signal.

Then edit `reddit.subreddits` — drop any with `weight: 0`, add ones relevant
to your search.

## 3. Pick a Reddit backend

Two options:

### Option A — Reddit Data API (free, but gated)

As of 2026 Reddit gates **all** new API access — including personal
`script` apps — behind a manual review at
<https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164>
(select "I'm a Developer" → "I want to register to use the Reddit API").
You'll get a Zendesk auto-ack; approval can take days to weeks. Until
it lands, the "create app" button on `reddit.com/prefs/apps` is disabled.

Once approved:

1. <https://www.reddit.com/prefs/apps> → **create app** → **script** type.
2. Redirect URI: `http://localhost:8080` (unused but required).
3. Add to `.env`:
   ```
   REDDIT_CLIENT_ID=
   REDDIT_CLIENT_SECRET=
   REDDIT_USERNAME=
   REDDIT_PASSWORD=
   ```

Free tier is 100 QPM — way more than this tool uses. With OAuth you can
re-enable all the standby subreddits in `config/offbeat.yml` and bump
`posts_per_sub` back up.

### Option B — Apify Reddit Scraper Lite (paid)

Use this while you wait for Reddit OAuth approval. The
`trudax/reddit-scraper-lite` actor is billed at **$3.40 per 1,000
dataset items** (Pay-Per-Result). The free Apify plan gives $5/mo
credit ≈ 1,470 free items/mo.

**Important:** the local seen-set in `data/offbeat.db` deduplicates
posts before they reach Haiku, but it does **not** reduce Apify cost —
the actor still extracts every item it returns each run, including
repeats from prior runs. Cost scales with `subs × posts_per_sub ×
runs/day`, not with the number of *unique* posts.

Rough cost math:

| Subs × posts_per_sub × runs/day | Items/mo | Gross | OOP after $5 credit |
|---|---|---|---|
| 4 × 8 × 4 (every 6h) — default config | ~3,840 | ~$13/mo | **~$8/mo** |
| 10 × 25 × 48 (default 30-min, full subs) | ~360k | ~$1,224/mo | **~$1,219/mo** ⚠️ |

The shipped `config/offbeat.yml` is set to the first row to keep
Apify-only users inside ~$10/mo. Don't crank cadence or sub count on
the Apify path — switch to OAuth instead.

1. Sign up at <https://apify.com>.
2. Settings → Integrations → API tokens → create one.
3. Add to `.env`:
   ```
   APIFY_TOKEN=apify_api_...
   ```

The dispatcher in `fetchers/reddit.mjs` picks Option A if both are set.

## 4. LLM + email

```
ANTHROPIC_API_KEY=sk-ant-...

GMAIL_APP_PASSWORD=              # https://myaccount.google.com/apppasswords
GMAIL_FROM=you@gmail.com
OFFBEAT_DIGEST_TO=               # default: same as GMAIL_FROM
```

Gmail SMTP needs an "App Password" (not your regular password). Enable
2FA first if you haven't, then generate one.

## 5. Smoke test

```bash
node offbeat-fetch.mjs --verbose --limit=5    # fetch 5 posts, classify, store
node offbeat-digest.mjs --dry                  # render HTML to data/digests/
```

The `--dry` digest writes the rendered HTML to `data/digests/` for
inspection without sending the email.

## 6. Schedule it

Two systemd user timers:

```bash
# ~/.config/systemd/user/offbeat-radar-fetch.timer
[Unit]
Description=Offbeat Radar — every 6 hours (Apify-only) or 1 hour (Reddit OAuth)

[Timer]
OnBootSec=3min
OnUnitActiveSec=6h          # Apify-only: every 6h. With Reddit OAuth, drop to 1h.
Persistent=true
Unit=offbeat-radar-fetch.service

[Install]
WantedBy=timers.target
```

```bash
# ~/.config/systemd/user/offbeat-radar-fetch.service
[Unit]
Description=Offbeat Radar — fetch + classify
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/projects/offbeat-radar
EnvironmentFile=%h/projects/offbeat-radar/.env
ExecStart=/usr/bin/node offbeat-fetch.mjs
StandardOutput=append:%h/.cache/offbeat-radar.log
StandardError=append:%h/.cache/offbeat-radar.log
```

Mirror these for `offbeat-radar-digest.timer` (firing 4x/day at your
chosen IST/local hours via `OnCalendar=`) and `offbeat-radar-digest.service`
(running `offbeat-digest.mjs`).

Enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now offbeat-radar-fetch.timer
systemctl --user enable --now offbeat-radar-digest.timer
systemctl --user list-timers | grep offbeat
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Reddit OAuth failed: 401` | Wrong creds in `.env` |
| `Apify {403,429}: ...` | Free-tier credit exhausted; check apify.com → Billing |
| `ANTHROPIC_API_KEY missing` | `.env` not loaded — must run from repo root |
| `0 candidates after confidence filter` | Most posts are getting classified as DISCUSSION/SEEKING. Tighten `subreddits`, raise `min_confidence` |
| Digest never arrives | Check `data/offbeat.db` runs table for digest errors. Gmail SMTP needs an App Password, not your normal password. |

## Tuning

- **Add/remove subs:** edit `config/offbeat.yml#reddit.subreddits`.
- **Raise/lower bar:** `scoring.digest_threshold` (floor for inclusion in email, default 5.0).
- **Refine the prompt:** edit `fetchers/normalize.mjs` `buildSystemPrompt`.
- **Reset the seen-set:** `sqlite3 data/offbeat.db 'DELETE FROM seen_posts;'`.
