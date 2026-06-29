// Fetches the latest essays from a Substack feed and rewrites the block
// between <!-- ESSAYS:START --> and <!-- ESSAYS:END --> in index.html.
//
// Substack/Cloudflare returns 403 to GitHub Actions runner IPs when the feed
// is fetched directly, so we go through the rss2json reader service, which
// fetches the feed from its own (non-blocked) servers and returns clean JSON.
//
// Runs on a GitHub Actions runner (Node 20+, global fetch). No dependencies.
// To change the feed or how many essays show, edit FEED / COUNT below.

import { readFile, writeFile } from 'node:fs/promises';

const FEED   = 'https://dougsmith773158.substack.com/feed';
const COUNT  = 3;
const FILE   = 'index.html';
const INDENT = '          '; // 10 spaces — matches the indentation in index.html

// Note: rss2json's `count` param needs a paid API key, so we fetch the
// default set (the feed's most recent items) and slice to COUNT below.
const API = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(FEED);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d) {
  // rss2json returns pubDate as "YYYY-MM-DD HH:MM:SS" (UTC). Normalize so the
  // displayed calendar date is stable regardless of the runner's timezone.
  const iso = String(d).trim().replace(' ', 'T').replace(/Z?$/, 'Z');
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// The rss2json service occasionally returns a transient 5xx. Retry a few
// times with a short backoff so a momentary blip doesn't fail the whole run.
async function fetchFeed(attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(API, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'ok' && Array.isArray(json.items)) return json;
        console.error(`Attempt ${i}/${attempts}: rss2json status=${json.status} ${json.message || ''}`);
      } else {
        console.error(`Attempt ${i}/${attempts}: HTTP ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error(`Attempt ${i}/${attempts}: ${err.message}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, i * 3000)); // 3s, 6s, 9s
  }
  return null;
}

const data = await fetchFeed();
if (!data) {
  console.error('Feed fetch failed after retries; leaving index.html unchanged.');
  process.exit(1);
}

const items = data.items
  .slice(0, COUNT)
  .map((it) => ({
    title: (it.title || '').trim(),
    link:  (it.link || '').trim(),
    date:  fmtDate(it.pubDate),
  }))
  .filter((p) => p.title && p.link);

if (!items.length) {
  console.error('No usable items parsed from feed; leaving index.html unchanged.');
  process.exit(1);
}

const rows = items.map((p) =>
  `${INDENT}<a class="essay reveal" href="${esc(p.link)}" target="_blank" rel="noopener">` +
  `<span class="e-title">${esc(p.title)}</span>` +
  `<span class="e-date">${esc(p.date)}</span></a>`
).join('\n');

let html = await readFile(FILE, 'utf8');
const re = /(<!-- ESSAYS:START[\s\S]*?-->)[\s\S]*?(<!-- ESSAYS:END -->)/;
if (!re.test(html)) {
  console.error('Could not find <!-- ESSAYS:START --> ... <!-- ESSAYS:END --> markers in ' + FILE + '.');
  process.exit(1);
}

const updated = html.replace(re, `$1\n${rows}\n${INDENT}$2`);
if (updated === html) {
  console.log('Essays already up to date — no change.');
  process.exit(0);
}

await writeFile(FILE, updated);
console.log('Updated ' + items.length + ' essays:');
for (const p of items) console.log('  - ' + p.title + (p.date ? '  (' + p.date + ')' : ''));
