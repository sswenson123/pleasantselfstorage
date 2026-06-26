/**
 * Pleasant Lake Storage — StorEdge Pricing & Availability Scraper (gentle mode)
 * ─────────────────────────────────────────────────────────────────────────────
 * Run from the pleasant-lake-website folder:
 *   node scraper.js
 *
 * Reads each unit's size, price, and availability from the StorEdge rental
 * center (JSON API) and writes data/availability.json. index.html reads that
 * file (via js/availability.js) and updates the Units & Prices table —
 * monthly rate, Available/Waitlist tag, and the Rent Now / Get Notified button.
 *
 * First-time setup (run once):
 *   npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
 *
 * Runs gently: real visible Chrome + stealth. Scrape once or twice a day max.
 * Schedule (on YOUR Mac — StorEdge blocks cloud IPs):
 *   crontab -e   then (twice a day, 7am & 7pm; HEADLESS=1 keeps it hidden):
 *   0 7,19 * * * cd "/Users/sswenson/Claude/Self Storage/pleasant-lake-website" && HEADLESS=1 /usr/local/bin/node scraper.js >> scraper.log 2>&1 && git add data/availability.json && git commit -m "Auto: update prices" && git push
 */

let puppeteer;
try {
  puppeteer = require('puppeteer-extra');
  puppeteer.use(require('puppeteer-extra-plugin-stealth')());
  console.log('🥷 Stealth mode on.');
} catch (_) {
  puppeteer = require('puppeteer');
  console.log('ℹ️  Stealth plugin not installed — using plain puppeteer.');
}
const fs   = require('fs');
const path = require('path');

const wait   = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * 1500);

// ── Pleasant Lake Storage facility (Hackensack, MN) ──────────────────────────
const COMPANY_ID  = 'ef2375f3-b212-4670-bbc0-be544f6614b6';
const FACILITY_ID = '159d76bf-6636-4e86-87fe-82fc497dc971';

const RENT_URL =
  `https://rental-center.storedge.com/?companyId=${COMPANY_ID}` +
  `&facilityId=${FACILITY_ID}#/move-in`;

const OUT_FILE = path.join(__dirname, 'data', 'availability.json');

// Pleasant Lake has many footprints (often labelled W x L x Height). Build a
// canonical "WxL" key from the two LARGEST numbers (drops the 8' height), sorted
// ascending so order never matters. e.g. "8 x 11 x 8" → "8x11", "11 x 28 x 8" → "11x28".
const SITE_KEYS = ['12x40','8x11','10x11','11x16','11x18','10x20','10x22','11x20','10x24','11x24','11x26','11x28'];
function normaliseKey(sizeStr) {
  if (!sizeStr) return null;
  let nums = (sizeStr.match(/\d+/g) || []).map(Number);
  if (nums.length < 2) return null;
  nums = nums.sort((a, b) => b - a).slice(0, 2).sort((a, b) => a - b);
  const key = nums.join('x');
  return SITE_KEYS.includes(key) ? key : null;
}

(async () => {
  console.log('🔍 Launching browser...');
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === '1' ? 'new' : false,
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 900 });
  await wait(jitter(1200));

  const apiPayloads = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) apiPayloads.push({ url: res.url(), body: await res.json() });
    } catch (_) {}
  });

  console.log('🌐 Loading StorEdge rental center...');
  let ok = false;
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    await page.goto(RENT_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 5000));
    const body = await page.evaluate(() => document.body.innerText || '');
    if (/service unavailable|temporarily unavailable/i.test(body)) {
      console.log(`⚠️  StorEdge said "Service Unavailable" (try ${attempt}/4). Waiting 30s...`);
      if (attempt < 4) await new Promise((r) => setTimeout(r, 30000));
    } else {
      ok = true;
    }
  }
  if (!ok) {
    await browser.close();
    console.log('\n❌ StorEdge is temporarily down (503). Existing prices left untouched. Try later.');
    process.exit(3);
  }

  const cardTexts = await page.evaluate(() => {
    const selectors = [
      '.unit-type-card', '.unit-card', '[class*="unit-type"]',
      '.available-unit', '.panel', '[class*="UnitType"]',
    ];
    let cards = [];
    for (const sel of selectors) {
      cards = [...document.querySelectorAll(sel)];
      if (cards.length) break;
    }
    return cards.map((c) => (c.innerText || '').trim().slice(0, 200));
  });

  await browser.close();

  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'storedge-raw.json'),
    JSON.stringify({ cardTexts, apiPayloads }, null, 2));

  function deepFindUnits(payloads) {
    const out = [];
    const seen = new Set();
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node && typeof node === 'object') {
        // StorEdge unit-groups shape: { size:"10x11x8", price:75, available_units_count:0, area:110 }
        if (typeof node.size === 'string' && node.price != null &&
            (typeof node.price === 'number' || /\d/.test(String(node.price)))) {
          const priceNum = parseFloat(String(node.price).replace(/[^0-9.]/g, ''));
          let available = true;
          if (typeof node.available_units_count === 'number') available = node.available_units_count > 0;
          else if (typeof node.available === 'boolean') available = node.available;
          const sig = node.size + '|' + priceNum + '|' + available;
          if (!seen.has(sig)) { seen.add(sig); out.push({ sizeStr: node.size, price: priceNum, available }); }
        }
        Object.keys(node).forEach((k) => visit(node[k]));
      }
    }
    payloads.forEach((p) => visit(p.body));
    return out;
  }

  let existing = { units: {} };
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch {}
  const units = { ...existing.units };

  const apiUnits = deepFindUnits(apiPayloads);
  let found = 0;
  console.log(`\n📦 ${cardTexts.length} card(s) rendered · ${apiUnits.length} priced record(s) in API\n`);

  for (const u of apiUnits) {
    const key = normaliseKey(u.sizeStr);
    if (!key) continue;
    const prev = units[key]?.perMonth;
    const num = !isNaN(u.price) ? Math.round(u.price) : null;
    const useNum = num != null && (prev == null || num < prev) ? num : (prev ?? num);
    units[key] = {
      ...units[key],
      price:     useNum != null ? `$${useNum}` : (units[key]?.price || null),
      perMonth:  useNum != null ? useNum : (units[key]?.perMonth ?? null),
      available: u.available,
      lastSeen:  new Date().toISOString(),
    };
    found++;
  }

  for (const key of SITE_KEYS) {
    const u = units[key];
    if (!u) continue;
    console.log(`  ${key.padEnd(6)} ${(u.price || '—').padEnd(6)} ${u.available ? '🟢 available' : '🔴 waitlist'}`);
  }

  if (!found) {
    console.log('\n⚠️  Nothing matched from the API. Card text captured was:\n');
    cardTexts.forEach((t, i) => console.log(`   [${i}] ${t.replace(/\n/g, ' | ')}`));
    console.log('\n   Existing data/availability.json left untouched.');
    console.log('   Full raw data saved to data/storedge-raw.json — send me that file.');
    process.exit(2);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    facilityId:  FACILITY_ID,
    units,
  }, null, 2));

  console.log(`\n✅ Saved data/availability.json  (${new Date().toLocaleString()})`);
})().catch((err) => {
  console.error('❌ Scraper error:', err.message);
  process.exit(1);
});
