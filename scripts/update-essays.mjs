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

const res = await fetch(API, { headers: { accept: 'application/json' } });
if (!res.ok) {
  console.error('Feed fetch failed:', res.status, res.statusText);
  process.exit(1);
}

const data = await res.json();
if (data.status !== 'ok' || !Array.isArray(data.items)) {
  console.error('rss2json returned an error:', data.status, data.message || '');
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
