/**
 * Drives the hosted preview page with an in-memory stand-in for the artifact
 * store, so the preview transport and the TEST RECORDS panel are exercised
 * before publishing rather than after.
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'file://' + path.join(import.meta.dirname, '..', 'preview-wrapped.html');
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const results = [];
let failures = 0;
async function step(name, fn) {
  try { await fn(); results.push('  ✓ ' + name); }
  catch (e) { failures++; results.push('  ✗ ' + name + '\n      ' + String(e.message || e).split('\n')[0]); }
}

/** Minimal stand-in for the artifact store: same surface the transport uses. */
const FAKE_DB = `
window.__docs = {};
window.claude = {
  use: function (name) {
    if (name !== 'db') return Promise.resolve(null);
    function snapOf(pathname) {
      var d = window.__docs[pathname];
      return { exists: !!d, id: pathname.split('/').pop(), data: function () { return d; } };
    }
    var api = {
      doc: function (p) {
        return {
          set: function (v) { window.__docs[p] = v; return Promise.resolve(); },
          get: function () { return Promise.resolve(snapOf(p)); },
        };
      },
      collection: function (c) {
        function build(filters, order, lim) {
          return {
            where: function (f, op, v) { return build(filters.concat([[f, op, v]]), order, lim); },
            orderBy: function (f, dir) { return build(filters, [f, dir], lim); },
            limit: function (n) { return build(filters, order, n); },
            get: function () {
              var rows = Object.keys(window.__docs)
                .filter(function (k) { return k.indexOf(c + '/') === 0; })
                .map(function (k) { return { id: k.split('/').pop(), _p: k, data: function () { return window.__docs[k]; } }; });
              filters.forEach(function (f) {
                rows = rows.filter(function (r) { return r.data()[f[0]] === f[2]; });
              });
              if (order) rows.sort(function (a, b) {
                var x = a.data()[order[0]], y = b.data()[order[0]];
                return (order[1] === 'desc' ? -1 : 1) * (x < y ? -1 : x > y ? 1 : 0);
              });
              if (lim) rows = rows.slice(0, lim);
              return Promise.resolve({ docs: rows });
            },
            add: function (v) {
              var id = 'd' + (Object.keys(window.__docs).length + 1) + Math.random().toString(36).slice(2, 6);
              window.__docs[c + '/' + id] = v;
              return Promise.resolve({ id: id });
            },
          };
        }
        return build([], null, 0);
      },
    };
    return Promise.resolve(api);
  },
};
`;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--disable-background-networking', '--no-proxy-server', '--no-first-run', '--disable-sync'],
});

async function open(viewport = { width: 390, height: 800 }, withDb = true) {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (withDb) await page.addInitScript(FAKE_DB);
  await page.goto(FILE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#moCard:not([hidden])', { timeout: 8000 });
  return { page, ctx, errors };
}

async function addPhoto(page, i) {
  await page.locator(`[data-shot="${i}"]`).click();
  await page.setInputFiles('input[type=file]', { name: 'IMG_0042.JPG', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_B64, 'base64') });
  await page.waitForFunction((k) => document.querySelectorAll('.mo-slot')[k]?.classList.contains('done'), i, { timeout: 15000 });
}

await step('page is self-contained — no external requests', async () => {
  const html = fs.readFileSync(FILE.replace('file://', ''), 'utf8');
  assert.equal(/<link[^>]+href=/.test(html), false, 'no external stylesheet');
  assert.equal(/<script[^>]+src=/.test(html), false, 'no external script');
  assert.match(html, /PREVIEW — TEST ONLY/);
});

await step('SCHEDULE flow stores a test record', async () => {
  const { page, ctx, errors } = await open();
  await page.locator('[data-go="n1"]').click();
  await page.locator('#f-name').fill('Preview Tester');
  await page.locator('#f-phone').fill('2185550123');
  await page.locator('[data-next="n2"]').click();
  await page.locator('[data-eom]').click();
  await page.locator('[data-next="n3"]').click();
  await page.locator('[data-submit="scheduled"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 12000 });
  assert.match(await page.locator('.mo-done-h').innerText(), /notice received/i);
  const docs = await page.evaluate(() => window.__docs);
  const subs = Object.entries(docs).filter(([k]) => k.startsWith('submissions/'));
  assert.equal(subs.length, 1);
  assert.equal(subs[0][1].type, 'SCHEDULED_MOVE_OUT');
  assert.equal(subs[0][1].environment, 'PREVIEW');
  assert.equal(subs[0][1].customerName, 'Preview Tester');
  assert.equal(errors.length, 0, errors.join('; '));
  await ctx.close();
});

await step('COMPLETED flow stores a record with three photos', async () => {
  const { page, ctx, errors } = await open();
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('a14');
  await page.locator('#f-phone2').fill('2185550123');
  await page.locator('[data-next="o2"]').click();
  await addPhoto(page, 0); await addPhoto(page, 1); await addPhoto(page, 2);
  assert.match(await page.locator('.mo-prog .t').innerText(), /3 of 3 required/);
  await page.locator('[data-next="o3"]').click();
  for (const i of [0, 1, 2]) await page.locator(`[data-conf="${i}"]`).click();
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 15000 });
  assert.match(await page.locator('.mo-stamp').innerText(), /Unit A14/);

  const docs = await page.evaluate(() => window.__docs);
  const photos = Object.entries(docs).filter(([k]) => k.startsWith('photos/'));
  assert.equal(photos.length, 3, 'three photos stored');
  assert.deepEqual(photos.map(([, v]) => v.slot).sort(), ['DOOR', 'FLOOR', 'INSIDE']);
  for (const [, v] of photos) {
    assert.match(v.dataUrl, /^data:image\/jpeg;base64,/);
    // must fit the store's 256 KiB document cap with room to spare
    assert.ok(v.dataUrl.length < 200000, `stored photo too large: ${v.dataUrl.length}`);
  }
  const sub = Object.entries(docs).find(([k]) => k.startsWith('submissions/'))[1];
  assert.equal(sub.photoIds.length, 3);
  assert.deepEqual(sub.confirmations, { empty: true, swept: true, lockRemoved: true });
  assert.equal(errors.length, 0, errors.join('; '));
  await ctx.close();
});

await step('test records panel lists submissions with their photos', async () => {
  const { page, ctx } = await open();
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('C7');
  await page.locator('#f-phone2').fill('2185550188');
  await page.locator('[data-next="o2"]').click();
  await addPhoto(page, 0); await addPhoto(page, 1); await addPhoto(page, 2);
  await page.locator('[data-next="o3"]').click();
  for (const i of [0, 1, 2]) await page.locator(`[data-conf="${i}"]`).click();
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 15000 });

  await page.locator('#recLoad').click();
  await page.waitForSelector('.rec', { timeout: 8000 });
  const text = await page.locator('.rec').first().innerText();
  assert.match(text, /Unit C7/);
  assert.match(text, /TEST/);
  assert.match(text, /all three/);
  assert.equal(await page.locator('.rec-shots img').count(), 3, 'three photo thumbnails');
  await ctx.close();
});

await step('degrades honestly when the store is unavailable', async () => {
  const { page, ctx } = await open({ width: 390, height: 800 }, false);
  await page.waitForTimeout(1200);
  assert.match(await page.locator('#moRecords').innerText(), /not available/i);
  // the wizard itself still renders — it does not white-screen
  assert.match(await page.locator('.mo-h').innerText(), /Moving Out\?/);
  await ctx.close();
});

await step('layout holds at 320px with nothing clipped', async () => {
  const { page, ctx } = await open({ width: 320, height: 568 });
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('B12');
  await page.locator('#f-phone2').fill('2185550123');
  const report = await page.evaluate(() => {
    const body = document.getElementById('moBody');
    const foot = document.getElementById('moFoot');
    const kids = [...body.children];
    const last = kids[kids.length - 1];
    return {
      clipped: Math.round((last ? last.getBoundingClientRect().bottom : 0) - body.getBoundingClientRect().bottom),
      footVisible: foot.getBoundingClientRect().bottom <= window.innerHeight + 1,
      sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  assert.ok(report.clipped <= 2, `content clipped by ${report.clipped}px`);
  assert.equal(report.sideways, false, 'page scrolls sideways at 320px');
  assert.equal(report.footVisible, true, 'action button off screen');
  await ctx.close();
});

await browser.close();
console.log('\nHosted preview page (store-backed)');
console.log(results.join('\n'));
console.log(`\n  ${results.length - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
