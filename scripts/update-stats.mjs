// Fetches the video index counts and rewrites the block between
// <!-- INDEXSTATS:START --> and <!-- INDEXSTATS:END --> in index.html.
//
// The counts come from stats.json, which build.py regenerates in the
// dougs-dharma-index repo from the same source of truth as the index site.
// It is a tiny counts-only file (~80 bytes) precisely so this step is cheap —
// videos.json holds the same numbers but is ~400 KB.
//
// Runs on a GitHub Actions runner (Node 20+, global fetch). No dependencies.
// Set STATS_URL to point at a local server when testing.

import { readFile, writeFile } from 'node:fs/promises';

const URL    = process.env.STATS_URL || 'https://videos.dougsdharma.com/stats.json';
const FILE   = 'index.html';
const INDENT = '              '; // 14 spaces — matches the indentation in index.html

// The three stats shown on the card, in display order.
const FIELDS = [
  ['videos', 'Videos'],
  ['topics', 'Topics'],
  ['suttas', 'Suttas cited'],
];

// GitHub Pages occasionally returns a transient 5xx. Retry a few times with a
// short backoff so a momentary blip doesn't leave the numbers stale.
async function fetchStats(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(URL, { headers: { accept: 'application/json' } });
      if (res.ok) return await res.json();
      console.error(`Attempt ${i}/${attempts}: HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      console.error(`Attempt ${i}/${attempts}: ${err.message}`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, i * 3000)); // 3s, 6s
  }
  return null;
}

const data = await fetchStats();
if (!data) {
  console.error('Could not fetch stats.json; leaving index.html unchanged.');
  process.exit(1);
}

// Only accept sane, positive integers — never write a 0 or a NaN onto the page.
const values = {};
for (const [key] of FIELDS) {
  const n = data[key];
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`stats.json has no usable "${key}" (got ${JSON.stringify(n)}); leaving index.html unchanged.`);
    process.exit(1);
  }
  values[key] = n;
}

const rows = FIELDS.map(([key, label]) =>
  `${INDENT}<span><b>${values[key].toLocaleString('en-US')}</b><i>${label}</i></span>`
).join('\n');

let html = await readFile(FILE, 'utf8');
const re = /(<!-- INDEXSTATS:START -->)[\s\S]*?(<!-- INDEXSTATS:END -->)/;
if (!re.test(html)) {
  console.error('Could not find <!-- INDEXSTATS:START --> ... <!-- INDEXSTATS:END --> markers in ' + FILE + '.');
  process.exit(1);
}

const updated = html.replace(re, `$1\n${rows}\n${INDENT}$2`);
if (updated === html) {
  console.log('Index stats already up to date — no change.');
  process.exit(0);
}

await writeFile(FILE, updated);
console.log('Updated index stats: ' + FIELDS.map(([k, l]) => `${values[k]} ${l}`).join(', '));
