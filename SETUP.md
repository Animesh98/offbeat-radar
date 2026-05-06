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

### Option A — Reddit Data API (free)

Reddit gates new API access through a manual ticket review (days–weeks).
If you already have access:

1. <https://www.reddit.com/prefs/apps> → **create app** → **script** type.
2. Redirect URI: `http://localhost:8080` (unused but required).
3. Add to `.env`:
   ```
   REDDIT_CLIENT_ID=
   REDDIT_CLIENT_SECRET=
   REDDIT_USERNAME=
   REDDIT_PASSWORD=
   ```

### Option B — Apify Reddit Scraper (paid, ~$5/mo)

No Reddit account interaction. Free tier gives $5/mo credit which is
roughly the volume this tool generates.

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
Description=Offbeat Radar — every 30 min

[Timer]
OnBootSec=3min
OnUnitActiveSec=30min
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
