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

Three options. The dispatcher in `fetchers/reddit.mjs` picks automatically:
OAuth (if creds present) > Direct (default, free, no creds) > Apify (only if
you set `REDDIT_BACKEND=apify` in env). All paths return the same shape.

### Option A — Direct unauth (default, free, no creds)

The default backend if nothing else is configured. Hits
`https://old.reddit.com/r/{sub}/new.json` with a polite User-Agent. On
403/429/503 it retries once, then falls through a redlib mirror list.
At hourly cadence × 10 active subs that's ~240 reqs/day — well under
Reddit's documented unauth ~10/min limit.

Nothing to set up — it's the default. Customise `reddit.user_agent` and
`reddit.mirror_list` in `config/offbeat.yml` if needed.

Trade-off: 403s do happen — usually transient and absorbed by the mirror
fallback, but extended outages are possible. Use OAuth (Option B) for
guaranteed reliability once your approval lands.

### Option B — Reddit Data API / OAuth (free, but gated)

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

Free tier is 100 QPM — way more than this tool uses. The dispatcher
auto-prefers OAuth when these are set; the Direct backend stays as a
fallback if you ever revoke the creds.

### Option C — Apify Reddit Scraper Lite (paid, opt-in only)

Only used if you explicitly set `REDDIT_BACKEND=apify` in env AND have
`APIFY_TOKEN` set. Never auto-selected — it costs money.

The `trudax/reddit-scraper-lite` actor bills $3.40 per 1,000 dataset
items, with a $5/mo free credit ≈ 1,470 items/mo. The local seen-set
**does not** reduce Apify cost — Apify is called before the seen-set
runs, so the actor bills us for every item it returns each call,
repeats included. Cost scales with `subs × posts_per_sub × runs/day`.

| Subs × posts_per_sub × runs/day | Items/mo | OOP after $5 credit |
|---|---|---|
| 4 × 8 × 4 (every 6h) | ~3,840 | ~$8/mo |
| 10 × 25 × 24 (hourly) | ~180k | ~$607/mo ⚠️ |

If you reach for Apify, cap `posts_per_sub` low and use a wide-spaced
timer. Most users should stick with Direct (Option A) until OAuth lands.

To opt in:

1. Sign up at <https://apify.com>.
2. Settings → Integrations → API tokens → create one.
3. Add to `.env`:
   ```
   APIFY_TOKEN=apify_api_...
   REDDIT_BACKEND=apify
   ```

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
Description=Offbeat Radar — hourly fetch

[Timer]
OnBootSec=3min
OnUnitActiveSec=1h          # Direct or OAuth: hourly. Drop to 6h if you opt into Apify.
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
