#!/usr/bin/env node
/**
 * Foosto menu scraper.
 *
 * Reads https://menu.foosto.com/ and writes menu.js, which assigns
 * window.FOOSTO_MENU. Runs on plain Node 20+ with no dependencies.
 *
 * ---------------------------------------------------------------------------
 * !! EVERYTHING IN THIS FILE DEPENDS ON FOOSTO'S PAGE STRUCTURE !!
 * This is the part most likely to break. See PARSING STRATEGY below.
 * ---------------------------------------------------------------------------
 *
 * PARSING STRATEGY
 *
 * We deliberately do NOT use CSS selectors, tag names, or class names. Foosto
 * runs an off-the-shelf theme; classes and tags are the first thing to change
 * in a redesign, and a selector-based scraper would break silently.
 *
 * Instead we flatten the document to an ordered list of text chunks and anchor
 * on the visible LABELS, which are user-facing copy and far more stable:
 *
 *     Chef: Soneka Begum          <- starts a new chef; applies to items below
 *     <dish name>                 <- the chunk immediately before "Price :"
 *     Price : 192.0
 *     Menu Code: 62231
 *     Available: 9
 *     Place Order
 *
 * Note the chef is a GROUP HEADING, not a per-item field. We carry the current
 * chef forward as we walk the document. If Foosto ever moves the chef inside
 * each item block this still works, because we only care about ordering.
 *
 * IF THIS BREAKS, it will almost certainly be because one of the five label
 * regexes below stopped matching. Check LABELS first. The script hard-fails
 * rather than committing an empty or partial menu, so a break shows up as a
 * red workflow run, not as an empty page for your users.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SOURCE_URL = 'https://menu.foosto.com/';
const OUT_FILE = path.resolve(process.argv[2] ?? 'menu.js');
const FETCH_TIMEOUT_MS = 30_000;

/* --- Foosto-dependent: the visible labels we anchor on ------------------- */
const LABELS = {
  chef: /^Chef:\s*(.+?)\s*$/i,
  price: /^Price\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/i,
  code: /^Menu\s*Code\s*:\s*([A-Za-z0-9_-]+)\s*$/i,
  available: /^Available\s*:\s*([0-9]+)\s*$/i,
  // Chunks that are never a dish name.
  noise: /^(Place Order|Order Now|Home|Contact Us|Terms Of use|Privacy Policy)$/i,
};
/* ------------------------------------------------------------------------ */

const IMG_TOKEN = '\u0000IMG:';

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7',
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in named ? named[n.toLowerCase()] : m));
}

/**
 * Flatten HTML into an ordered array of visible text chunks. <img> elements
 * survive as IMG_TOKEN entries so we can attach photos to the right dish.
 */
function toChunks(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');

  // Preserve image URLs before tags are destroyed.
  s = s.replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    (_, src) => `\n${IMG_TOKEN}${src}\n`);

  s = s.replace(/<[^>]+>/g, '\n');
  s = decodeEntities(s);

  return s
    .split('\n')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseMenu(html) {
  const chunks = toChunks(html);
  const items = [];

  let chef = null;
  let lastText = null;   // most recent chunk that could be a dish name
  let current = null;    // item being assembled

  const finish = () => {
    if (current && current.code && current.available !== null) items.push(current);
    current = null;
  };

  for (const chunk of chunks) {
    if (chunk.startsWith(IMG_TOKEN)) {
      if (current) current.images.push(chunk.slice(IMG_TOKEN.length));
      continue;
    }

    let m;
    if ((m = chunk.match(LABELS.chef))) {
      finish();
      chef = m[1];
      lastText = null;
      continue;
    }
    if ((m = chunk.match(LABELS.price))) {
      finish();
      current = {
        code: null,
        name: lastText ?? '',
        chef: chef ?? 'Unknown',
        price: Number(m[1]),
        available: null,
        images: [],
      };
      lastText = null;
      continue;
    }
    if (current && (m = chunk.match(LABELS.code))) { current.code = m[1]; continue; }
    if (current && (m = chunk.match(LABELS.available))) { current.available = Number(m[1]); continue; }

    if (!LABELS.noise.test(chunk)) lastText = chunk;
  }
  finish();

  return items;
}

function validate(items) {
  const problems = [];
  if (items.length === 0) {
    problems.push('Parsed 0 items. Either the page changed, or it now renders the menu with JavaScript.');
  }
  const seen = new Set();
  for (const [i, it] of items.entries()) {
    const where = `item ${i} (code ${it.code ?? '?'})`;
    if (!it.code) problems.push(`${where}: missing menu code`);
    if (!it.name) problems.push(`${where}: missing dish name`);
    if (!it.chef || it.chef === 'Unknown') problems.push(`${where}: no chef heading seen before it`);
    if (!Number.isFinite(it.price)) problems.push(`${where}: bad price`);
    if (!Number.isInteger(it.available)) problems.push(`${where}: bad availability`);
    if (it.code && seen.has(it.code)) problems.push(`${where}: duplicate menu code`);
    seen.add(it.code);
  }
  return problems;
}

async function previousItems() {
  if (!existsSync(OUT_FILE)) return null;
  try {
    const txt = await readFile(OUT_FILE, 'utf8');
    const json = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    return JSON.parse(json).items ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const res = await fetch(SOURCE_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      // Some hosts serve a stripped page to unknown clients.
      'user-agent': 'Mozilla/5.0 (compatible; foosto-menu-mirror/1.0)',
      'accept-language': 'en,bn;q=0.9',
      'cache-control': 'no-cache',
    },
  });
  if (!res.ok) throw new Error(`Foosto returned HTTP ${res.status}`);

  const html = await res.text();
  const items = parseMenu(html);
  const problems = validate(items);

  if (problems.length) {
    console.error('Scrape failed. menu.js was NOT written.\n');
    for (const p of problems.slice(0, 25)) console.error('  - ' + p);
    if (problems.length > 25) console.error(`  ... and ${problems.length - 25} more`);
    console.error('\nCheck the LABELS regexes in scripts/scrape-menu.mjs against the live page.');
    process.exit(1);
  }

  const prev = await previousItems();
  const unchanged = prev && JSON.stringify(prev) === JSON.stringify(items);

  const now = new Date().toISOString();
  const payload = {
    source: SOURCE_URL,
    changedAt: unchanged ? JSON.parse((await readFile(OUT_FILE, 'utf8')).match(/\{[\s\S]*\}/)[0]).changedAt : now,
    checkedAt: now,
    count: items.length,
    items,
  };

  const banner = '// Generated by scripts/scrape-menu.mjs. Do not edit by hand.\n';
  await writeFile(OUT_FILE, banner + 'window.FOOSTO_MENU = ' + JSON.stringify(payload, null, 2) + ';\n');

  const prices = items.map((i) => i.price);
  console.log(`Parsed ${items.length} items from ${new Set(items.map((i) => i.chef)).size} chefs.`);
  console.log(`Price range ${Math.min(...prices)}-${Math.max(...prices)}. Content ${unchanged ? 'unchanged' : 'CHANGED'}.`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `changed=${unchanged ? 'false' : 'true'}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
