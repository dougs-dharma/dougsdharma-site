// Fetches the latest essays from Substack and rewrites the block between
// <!-- ESSAYS:START --> and <!-- ESSAYS:END --> in index.html.
//
// Tries several sources in order and uses the first that returns posts:
//   1. feed2json   — relay that reads the feed and returns JSON Feed
//   2. Substack's own JSON API, directly  (/api/v1/posts)
//   3. The RSS feed, directly             (/feed)
//   4. allorigins  — relay that passes the feed through unchanged
//   5. rss2json    — relay; the original source
// Why relays come first: Substack answers GitHub Actions runner IPs with
// HTTP 403 for both the API and the feed (confirmed Oct 2026), so a direct
// fetch only works from elsewhere. The direct sources stay in the chain in
// case that block is ever lifted. History: the script used rss2json alone
// until Oct 2026, when rss2json began serving a Cloudflare challenge page to
// every request and every run failed. allorigins is flaky (frequent 5xx), so
// it is a backup only. No single source has proved reliable, hence the chain.
//
// Runs on a GitHub Actions runner (Node 20+, global fetch). No dependencies.
// To change the Substack or how many essays show, edit SUBSTACK / COUNT below.

import { readFile, writeFile } from 'node:fs/promises';

const SUBSTACK = 'https://dougsmithphd.substack.com';
const COUNT    = 3;
const FILE     = 'index.html';
const INDENT   = '          '; // 10 spaces — matches the indentation in index.html

const UA = 'Mozilla/5.0 (compatible; dougsdharma-site-updater; +https://dougsdharma.com/)';

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Accepts ISO 8601 (Substack API), RFC 822 (RSS), or rss2json's
// "YYYY-MM-DD HH:MM:SS" (UTC, no zone). Formats in UTC so the displayed
// calendar date doesn't depend on the runner's timezone.
export function fmtDate(d) {
  let s = String(d || '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  if (isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---- Parsers: each returns [{ title, link, date }] (date already formatted) ----

export function parseSubstackApi(json) {
  if (!Array.isArray(json)) throw new Error('API response is not an array');
  return json.map((p) => ({
    title: (p.title || '').trim(),
    link:  (p.canonical_url || '').trim(),
    date:  fmtDate(p.post_date),
  }));
}

export function parseRss(xml) {
  if (!/<rss[\s>]/.test(xml)) throw new Error('response is not RSS (got: ' + xml.slice(0, 60).replace(/\s+/g, ' ') + ')');
  const field = (item, tag) => {
    const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    if (!m) return '';
    return decodeEntities(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim();
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: field(item, 'title'),
    link:  field(item, 'link'),
    date:  fmtDate(field(item, 'pubDate')),
  }));
}

// JSON Feed 1.x (https://jsonfeed.org), as returned by feed2json.
export function parseJsonFeed(json) {
  if (!json || !Array.isArray(json.items)) throw new Error('not a JSON Feed (no items array)');
  return json.items.map((it) => ({
    title: (it.title || '').trim(),
    link:  (it.url || it.external_url || '').trim(),
    date:  fmtDate(it.date_published),
  }));
}

export function parseRss2json(json) {
  if (json.status !== 'ok' || !Array.isArray(json.items)) {
    throw new Error(`rss2json status=${json.status} ${json.message || ''}`);
  }
  return json.items.map((it) => ({
    title: (it.title || '').trim(),
    link:  (it.link || '').trim(),
    date:  fmtDate(it.pubDate),
  }));
}

// ---- Fetching ----

const FEED = `${SUBSTACK}/feed`;
const SOURCES = [
  { name: 'feed2json',    url: 'https://feed2json.org/convert?url=' + encodeURIComponent(FEED),
    kind: 'json', parse: parseJsonFeed },
  { name: 'Substack API', url: `${SUBSTACK}/api/v1/posts?limit=${COUNT}`, kind: 'json', parse: parseSubstackApi },
  { name: 'RSS feed',     url: FEED,                                      kind: 'text', parse: parseRss },
  { name: 'allorigins',   url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(FEED),
    kind: 'text', parse: parseRss },
  { name: 'rss2json',     url: 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(FEED),
    kind: 'json', parse: parseRss2json },
];

// GitHub Actions annotation. Unlike the job log, annotations are readable
// without signing in (via the check-runs API), so a failure explains itself.
// Commas, colons and newlines must be escaped in the title/message.
function annotate(level, title, msg) {
  if (!process.env.GITHUB_ACTIONS) return;
  const e = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const t = e(title).replace(/:/g, '%3A').replace(/,/g, '%2C');
  console.log(`::${level} title=${t}::${e(msg)}`);
}

async function trySource(src, attempts = 2) {
  let lastErr = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(src.url, {
        headers: { 'user-agent': UA, accept: src.kind === 'json' ? 'application/json' : 'application/rss+xml, text/xml' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} ${res.statusText}`);
        // A 4xx is a refusal (blocked, not found) and won't change on retry.
        if (res.status >= 400 && res.status < 500) e.noRetry = true;
        throw e;
      }
      const body = await res.text();
      let data;
      if (src.kind === 'json') {
        try { data = JSON.parse(body); }
        catch { throw new Error('not JSON (got: ' + body.slice(0, 60).replace(/\s+/g, ' ') + ')'); }
      } else {
        data = body;
      }
      const items = src.parse(data).filter((p) => p.title && p.link);
      if (!items.length) throw new Error('no usable items');
      return items;
    } catch (err) {
      // Node's fetch hides the real network error in err.cause.
      lastErr = err.message + (err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '');
      console.error(`  ${src.name}, attempt ${i}/${attempts}: ${lastErr}`);
      if (err.noRetry) break;
      if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  annotate('warning', `Essay source failed: ${src.name}`, `${src.url} -> ${lastErr}`);
  return null;
}

async function main() {
  let items = null;
  for (const src of SOURCES) {
    console.log(`Trying ${src.name}…`);
    items = await trySource(src);
    if (items) {
      console.log(`  OK via ${src.name}.`);
      annotate('notice', 'Essays fetched', `via ${src.name}`);
      break;
    }
  }
  if (!items) {
    // Deliberately not a job failure (Doug's choice, 2026-10-21): a failed
    // run emails him every six hours, and an essay list that's a little stale
    // costs little because he posts rarely. The warning annotation still
    // records the outage. Exit codes 1 below (missing markers) remain
    // failures, since those mean the page itself is broken.
    annotate('warning', 'All essay sources failed', 'index.html left unchanged; see the per-source warnings.');
    console.error('All essay sources failed; leaving index.html unchanged.');
    return;
  }
  items = items.slice(0, COUNT);

  const rows = items.map((p) =>
    `${INDENT}<a class="essay reveal" href="${esc(p.link)}" target="_blank" rel="noopener">` +
    `<span class="e-title">${esc(p.title)}</span>` +
    `<span class="e-date">${esc(p.date)}</span></a>`
  ).join('\n');

  const html = await readFile(FILE, 'utf8');
  const re = /(<!-- ESSAYS:START[\s\S]*?-->)[\s\S]*?(<!-- ESSAYS:END -->)/;
  if (!re.test(html)) {
    console.error('Could not find <!-- ESSAYS:START --> ... <!-- ESSAYS:END --> markers in ' + FILE + '.');
    process.exit(1);
  }

  const updated = html.replace(re, `$1\n${rows}\n${INDENT}$2`);
  if (updated === html) {
    console.log('Essays already up to date — no change.');
    return;
  }
  await writeFile(FILE, updated);
  console.log('Updated ' + items.length + ' essays:');
  for (const p of items) console.log('  - ' + p.title + (p.date ? '  (' + p.date + ')' : ''));
}

await main();
