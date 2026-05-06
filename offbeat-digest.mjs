#!/usr/bin/env node
/**
 * offbeat-digest.mjs — Delta digest emailer for the offbeat scraper.
 *
 * Runs at 09:30 / 13:30 / 17:30 / 21:30 IST via systemd timer.
 * Reads scored rows where digested_at IS NULL AND skipped=0 AND score >=
 * digest_threshold. Builds an HTML email and sends via Gmail SMTP. Skips
 * the send if zero new rows.
 *
 * Reuses GMAIL_APP_PASSWORD/GMAIL_FROM from ~/brain/resume-tutor/.env.
 *
 * Usage:
 *   node offbeat-digest.mjs            # send now
 *   node offbeat-digest.mjs --dry      # render to stdout, don't send
 *   node offbeat-digest.mjs --force    # send even if empty
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import yaml from 'js-yaml';
import nodemailer from 'nodemailer';

import { startRun, finishRun, pendingDigestRows, markDigested } from './fetchers/seen.mjs';

loadEnv({ path: '.env', quiet: true });
for (const p of (process.env.OFFBEAT_EXTRA_ENV_FILES || '').split(':').filter(Boolean)) {
  loadEnv({ path: p, quiet: true });
}

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const CONFIG_PATH = 'config/offbeat.yml';
const DASHBOARD_URL = process.env.OFFBEAT_DASHBOARD_URL || '';

const ESCAPE = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

function fmtAge(ms) {
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function badgeColor(score) {
  if (score >= 8) return '#16a34a'; // green
  if (score >= 6) return '#0ea5e9'; // sky
  if (score >= 4) return '#eab308'; // amber
  return '#94a3b8';                 // slate
}

function verdictPill(v) {
  const colors = {
    'APPLY':       { bg: '#dcfce7', fg: '#15803d', label: 'APPLY' },
    'LEAN-APPLY':  { bg: '#e0f2fe', fg: '#0369a1', label: 'LEAN' },
    'HOLD':        { bg: '#fef3c7', fg: '#a16207', label: 'HOLD' },
    'SKIP':        { bg: '#fee2e2', fg: '#b91c1c', label: 'SKIP' },
  };
  const c = colors[v] || { bg: '#e2e8f0', fg: '#475569', label: v || '—' };
  return `<span style="background:${c.bg};color:${c.fg};padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;">${c.label}</span>`;
}

function buildContactAction(row) {
  const apply = row.apply_url;
  if (apply && apply.startsWith('http')) {
    return `<a href="${ESCAPE(apply)}" style="...">Apply →</a>`;
  }
  if (row.contact_method === 'email' && row.contact_value) {
    const subject = encodeURIComponent(`Re: ${row.role} (saw your post)`);
    return `mailto:${ESCAPE(row.contact_value)}?subject=${subject}`;
  }
  if (row.contact_method === 'DM' && row.author && row.source.startsWith('reddit:')) {
    const subject = encodeURIComponent(`Re: ${row.role}`);
    return `https://www.reddit.com/message/compose?to=u%2F${encodeURIComponent(row.author)}&subject=${subject}`;
  }
  return row.url;
}

function renderCard(row) {
  const score = Number(row.score || 0);
  const remote = (row.remote && row.remote !== 'unknown') ? `🏠 ${row.remote}` : '';
  const loc = row.location ? `📍 ${ESCAPE(row.location)}` : '';
  const comp = row.comp_range ? `💰 ${ESCAPE(row.comp_range)}` : '';
  const sub = row.source.replace(/^reddit:/, 'r/').replace(/^hn:/, 'HN ');
  const action = buildContactAction(row);
  const tailored = row.tailored_path && !row.tailored_path.startsWith('pending:')
    ? `<a href="${ESCAPE(`${DASHBOARD_URL}/api/extension/jd/${row.tailored_path}`)}" style="color:#15803d;text-decoration:none;font-weight:600;">📄 Tailored .tex</a> · `
    : '';
  const skipUrl = `${DASHBOARD_URL}/api/offbeat/skip/${row.id}`;

  return `
<div style="border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:12px 0;background:#fff;">
  <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;">
    <div style="flex:1;">
      <div style="font-size:11px;color:#64748b;letter-spacing:0.04em;text-transform:uppercase;">${ESCAPE(sub)} · ${ESCAPE(fmtAge(row.created_at))} · u/${ESCAPE(row.author || 'unknown')}</div>
      <div style="font-size:17px;font-weight:600;color:#0f172a;margin-top:4px;line-height:1.3;">${ESCAPE(row.role || 'Untitled')}</div>
      ${row.company ? `<div style="font-size:14px;color:#475569;margin-top:2px;">${ESCAPE(row.company)}</div>` : ''}
    </div>
    <div style="text-align:right;flex-shrink:0;">
      <div style="background:${badgeColor(score)};color:#fff;padding:6px 12px;border-radius:8px;font-size:14px;font-weight:700;">${score.toFixed(1)}</div>
      <div style="margin-top:4px;">${verdictPill(row.verdict)}</div>
    </div>
  </div>
  <div style="margin-top:10px;font-size:13px;color:#475569;display:flex;gap:14px;flex-wrap:wrap;">
    ${[loc, remote, comp].filter(Boolean).join(' · ')}
  </div>
  ${row.reasoning ? `<div style="margin-top:10px;font-size:13px;color:#334155;font-style:italic;border-left:3px solid #e2e8f0;padding-left:10px;">${ESCAPE(row.reasoning)}</div>` : ''}
  <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
    <a href="${ESCAPE(row.url)}" style="background:#0f172a;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;">Open post</a>
    <a href="${ESCAPE(action)}" style="background:#0ea5e9;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;">${row.contact_method === 'DM' ? 'DM author' : row.contact_method === 'email' ? 'Email' : 'Apply'}</a>
    <span style="font-size:13px;color:#64748b;align-self:center;">${tailored}<a href="${ESCAPE(skipUrl)}" style="color:#94a3b8;text-decoration:none;">Skip</a></span>
  </div>
</div>`;
}

function buildEmail(rows, cfg) {
  const istNow = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const subject = `${cfg.digest.subject_prefix}: ${rows.length} new lead${rows.length === 1 ? '' : 's'} (${istNow} IST)`;

  const cards = rows.map(renderCard).join('\n');
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:24px 16px;">
  <div style="text-align:center;margin-bottom:20px;">
    <div style="font-size:13px;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">Offbeat Job Radar</div>
    <div style="font-size:22px;font-weight:700;color:#0f172a;margin-top:4px;">${rows.length} new lead${rows.length === 1 ? '' : 's'}</div>
    <div style="font-size:13px;color:#64748b;margin-top:2px;">${istNow} IST · Reddit + Hacker News</div>
  </div>
  ${cards}
  <div style="text-align:center;font-size:11px;color:#94a3b8;margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;">
    <a href="${ESCAPE(DASHBOARD_URL)}/api/offbeat/status" style="color:#94a3b8;">scraper status</a> ·
    delta-only digest from <code>offbeat-fetch.mjs</code>
  </div>
</div>
</body></html>`;

  const text = rows.map(r => {
    const score = Number(r.score || 0).toFixed(1);
    return `[${score}] ${r.role}${r.company ? ' @ ' + r.company : ''}
  ${r.source} · ${fmtAge(r.created_at)}
  ${r.location || 'Unknown'} · ${r.remote || 'unknown'} · ${r.comp_range || 'comp not stated'}
  ${r.reasoning || ''}
  Post: ${r.url}
`;
  }).join('\n---\n');

  return { subject, html, text };
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`config not found: ${CONFIG_PATH}`);
  return yaml.load(readFileSync(CONFIG_PATH, 'utf-8'));
}

async function main() {
  const cfg = loadConfig();
  const runId = startRun('digest');
  let emailsSent = 0;

  try {
    const rows = pendingDigestRows({
      minScore: cfg.scoring?.digest_threshold ?? 5.0,
      max: cfg.digest?.max_items_per_email ?? 12,
    });

    if (!rows.length && !FORCE) {
      console.log('no pending rows; skipping email');
      finishRun(runId, { ok: true, postsKept: 0, emailsSent: 0 });
      return;
    }

    const { subject, html, text } = buildEmail(rows, cfg);

    if (DRY) {
      console.log('--- SUBJECT ---');
      console.log(subject);
      console.log('--- TEXT ---');
      console.log(text);
      console.log('--- HTML LENGTH ---', html.length);
      // Save HTML preview for inspection.
      mkdirSync('data/digests', { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(`data/digests/offbeat-${ts}.html`, html);
      console.log(`HTML saved to data/digests/offbeat-${ts}.html`);
      finishRun(runId, { ok: true, postsKept: rows.length, emailsSent: 0 });
      return;
    }

    const pw = process.env.GMAIL_APP_PASSWORD;
    const from = process.env.OFFBEAT_DIGEST_FROM || process.env.GMAIL_FROM;
    const to = process.env.OFFBEAT_DIGEST_TO || from;
    if (!pw || !from) throw new Error('GMAIL_APP_PASSWORD / GMAIL_FROM missing');

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: from, pass: pw },
    });

    await transporter.sendMail({
      from: `"Offbeat Radar" <${from}>`,
      to,
      subject,
      text,
      html,
    });
    emailsSent = 1;
    console.log(`✓ sent digest with ${rows.length} rows to ${to}`);

    markDigested(rows.map(r => r.id));
    finishRun(runId, { ok: true, postsKept: rows.length, emailsSent });
  } catch (e) {
    console.error('digest failed:', e);
    finishRun(runId, { ok: false, emailsSent, error: String(e.message || e) });
    process.exit(1);
  }
}

main();
