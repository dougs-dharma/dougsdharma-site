// Fetches the latest essays from a Substack RSS feed and rewrites the block
// between <!-- ESSAYS:START --> and <!-- ESSAYS:END --> in index.html.
//
// Runs on a GitHub Actions runner (Node 20+, global fetch). No dependencies.
// To change the feed or how many essays show, edit FEED / COUNT below.

import { readFile, writeFile } from 'node:fs/promises';

const FEED   = 'https://dougsmith773158.substack.com/feed';
const COUNT  = 3;
const FILE   = 'index.html';
const INDENT = '          '; // 10 spaces — matches the indentation in index.html

function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d) {
  const t = Date.parse(d);
  if (isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

const res = await fetch(FEED, {
  headers: {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
  },
});
if (!res.ok) {
  console.error('Feed fetch failed:', res.status, res.statusText);
  process.exit(1);
}
const xml = await res.text();

const items = (xml.match(/<item>[\s\S]*?<\/item>/gi) || [])
  .slice(0, COUNT)
  .map((block) => ({
    title: pick(block, 'title'),
    link:  pick(block, 'link'),
    date:  fmtDate(pick(block, 'pubDate')),
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
