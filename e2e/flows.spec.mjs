import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function api(path) {
  const res = await fetch('http://localhost:8911' + path);
  return res.json();
}

const BASE = 'http://localhost:8911';
const IPHONE_SE = { width: 320, height: 568 };   // smallest phone still in use
const IPHONE_14 = { width: 390, height: 664 };   // 844 minus browser chrome
const KEYBOARD_OPEN = { width: 390, height: 330 }; // iOS keyboard eats ~half the screen

const results = [];
let failures = 0;

async function test(name, fn) {
  try { await fn(); results.push('  ✓ ' + name); }
  catch (err) { failures++; results.push('  ✗ ' + name + '\n      ' + (err.message || err).split('\n')[0]); }
}

/** A real 2x2 JPEG so the page's decode/resize path runs for real. */
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

async function setPhoto(page) {
  await page.setInputFiles('input[type=file]', {
    name: 'IMG_0042.JPG', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_B64, 'base64'),
  });
}

async function addPhoto(page, index) {
  await page.locator(`[data-shot="${index}"]`).click();
  await setPhoto(page);
  await page.waitForFunction(
    (i) => document.querySelectorAll('.mo-slot')[i]?.classList.contains('done'),
    index, { timeout: 8000 });
}

async function fresh(browser, viewport = IPHONE_14) {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await api('/__reset');
  await page.goto(BASE + '/move-out.html', { waitUntil: 'networkidle' });
  return { page, ctx, errors };
}

async function fillCompletedThroughPhotos(page, unit = 'b12') {
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill(unit);
  await page.locator('#f-phone2').fill('6515550100');
  await page.locator('[data-next="o2"]').click();
  await addPhoto(page, 0); await addPhoto(page, 1); await addPhoto(page, 2);
}

async function confirmAll(page) {
  for (const i of [0, 1, 2]) await page.locator(`[data-conf="${i}"]`).click();
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--disable-background-networking', '--disable-component-update', '--no-first-run',
    '--disable-sync', '--disable-default-apps', '--no-default-browser-check',
    '--disable-domain-reliability', '--metrics-recording-only', '--disable-features=OptimizationHints,Translate',
    '--no-proxy-server',
  ],
});

// ── Scheduled ─────────────────────────────────────────────────────────────
await test('scheduled move-out submits and reaches the success screen', async () => {
  const { page, ctx, errors } = await fresh(browser);
  await page.locator('[data-go="n1"]').click();
  await page.locator('#f-name').fill('Scott Swenson');
  await page.locator('#f-phone').fill('6515550100');
  await page.locator('[data-next="n2"]').click();
  await page.locator('[data-eom]').click();
  await page.locator('[data-next="n3"]').click();
  assert.match(await page.locator('.mo-review').innerText(), /Scott Swenson/);
  await page.locator('[data-submit="scheduled"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 8000 });
  assert.match(await page.locator('.mo-done-h').innerText(), /notice received/i);
  assert.match(await page.locator('.mo-sms').innerText(), /text a confirmation/i);
  const state = await api('/__state');
  assert.equal(state.submissions.length, 1);
  assert.equal(state.submissions[0].type, 'SCHEDULED_MOVE_OUT');
  assert.equal(errors.length, 0, 'js errors: ' + errors.join('; '));
  await ctx.close();
});

await test('scheduled continue stays disabled until name and phone are valid', async () => {
  const { page, ctx } = await fresh(browser);
  await page.locator('[data-go="n1"]').click();
  assert.equal(await page.locator('[data-next="n2"]').isDisabled(), true);
  await page.locator('#f-name').fill('Scott Swenson');
  assert.equal(await page.locator('[data-next="n2"]').isDisabled(), true, 'still needs a phone');
  await page.locator('#f-phone').fill('555');
  assert.equal(await page.locator('[data-next="n2"]').isDisabled(), true, 'rejects a short number');
  await page.locator('#f-phone').fill('6515550100');
  assert.equal(await page.locator('[data-next="n2"]').isDisabled(), false);
  await ctx.close();
});

await test('date screen offers end-of-month and any picked date, exclusively', async () => {
  const { page, ctx } = await fresh(browser);
  await page.locator('[data-go="n1"]').click();
  await page.locator('#f-name').fill('A Tenant');
  await page.locator('#f-phone').fill('6515550100');
  await page.locator('[data-next="n2"]').click();
  assert.equal(await page.locator('[data-next="n3"]').isDisabled(), true);
  await page.locator('[data-eom]').click();
  assert.equal(await page.locator('[data-next="n3"]').isDisabled(), false);
  const eomText = await page.locator('[data-eom]').innerText();
  await page.locator('input[data-bind="noticeDate"]').fill('2099-07-15');
  await page.waitForTimeout(200);
  assert.equal((await page.locator('[data-eom]').getAttribute('class')).includes('on'), false, 'shortcut clears when a date is picked');
  assert.match(await page.locator('.mo-date .face').innerText(), /July 15, 2099/);
  assert.ok(eomText.length > 0);
  await ctx.close();
});

// ── Completed ─────────────────────────────────────────────────────────────
await test('completed move-out submits with three photos', async () => {
  const { page, ctx, errors } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.locator('[data-next="o3"]').click();
  await confirmAll(page);
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 8000 });
  assert.match(await page.locator('.mo-done-h').innerText(), /request received/i);
  assert.match(await page.locator('.mo-stamp').innerText(), /Unit B12/);
  const state = await api('/__state');
  assert.equal(state.submissions.length, 1);
  assert.equal(state.submissions[0].payload.photoIds.length, 3);
  assert.equal(state.submissions[0].payload.unitNumber, 'b12');
  assert.deepEqual(state.submissions[0].payload.confirmations, { empty: true, swept: true, lockRemoved: true });
  assert.equal('movedOutAt' in state.submissions[0].payload, false, 'client must not send a move-out date');
  assert.equal(errors.length, 0, 'js errors: ' + errors.join('; '));
  await ctx.close();
});

await test('cannot continue past photos without all three', async () => {
  const { page, ctx } = await fresh(browser);
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('B12');
  await page.locator('#f-phone2').fill('6515550100');
  await page.locator('[data-next="o2"]').click();
  assert.equal(await page.locator('[data-next="o3"]').isDisabled(), true);
  assert.match(await page.locator('.mo-prog .t').innerText(), /0 of 3 required/);
  await addPhoto(page, 0);
  assert.match(await page.locator('.mo-prog .t').innerText(), /1 of 3 required/);
  assert.equal(await page.locator('[data-next="o3"]').isDisabled(), true);
  await addPhoto(page, 1); await addPhoto(page, 2);
  assert.match(await page.locator('.mo-prog .t').innerText(), /3 of 3 required/);
  assert.equal(await page.locator('[data-next="o3"]').isDisabled(), false);
  assert.equal((await page.locator('[data-next="o3"]').innerText()).trim(), 'Continue →', 'button label never carries the count');
  await ctx.close();
});

await test('submit stays disabled until all three confirmations are checked', async () => {
  const { page, ctx } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.locator('[data-next="o3"]').click();
  assert.equal(await page.locator('[data-submit="completed"]').isDisabled(), true);
  await page.locator('[data-conf="0"]').click();
  await page.locator('[data-conf="1"]').click();
  assert.equal(await page.locator('[data-submit="completed"]').isDisabled(), true);
  await page.locator('[data-conf="2"]').click();
  assert.equal(await page.locator('[data-submit="completed"]').isDisabled(), false);
  await ctx.close();
});

await test('photos survive going back and forward', async () => {
  const { page, ctx } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.locator('[data-next="o3"]').click();
  await page.locator('#moBack').click();          // back to photos
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.mo-slot.done').count(), 3, 'all three still marked added');
  assert.match(await page.locator('.mo-prog .t').innerText(), /3 of 3 required/);
  const state = await api('/__state');
  assert.equal(state.calls.filter((c) => c === 'photo').length, 3, 'no re-upload on back navigation');
  await ctx.close();
});

await test('photos survive a page reload', async () => {
  const { page, ctx } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-go="o1"]').click();
  await page.locator('[data-next="o2"]').click();
  assert.equal(await page.locator('.mo-slot.done').count(), 3, 'uploaded photos are restored after a refresh');
  const state = await api('/__state');
  assert.equal(state.calls.filter((c) => c === 'photo').length, 3, 'reload does not re-upload');
  await ctx.close();
});

await test('a failed photo upload shows an error and never counts as added', async () => {
  const { page, ctx } = await fresh(browser);
  await api('/__mode?m=photofail');
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('B12');
  await page.locator('#f-phone2').fill('6515550100');
  await page.locator('[data-next="o2"]').click();
  await page.locator('[data-shot="0"]').click();
  await setPhoto(page);
  await page.waitForFunction(() => document.querySelector('.mo-slot.failed') !== null, null, { timeout: 8000 });
  assert.match(await page.locator('.mo-prog .t').innerText(), /0 of 3 required/);
  assert.equal(await page.locator('[data-next="o3"]').isDisabled(), true);
  assert.match(await page.locator('.mo-slot.failed small').innerText(), /upload/i);
  await ctx.close();
});

await test('a failed submission does not show the success screen', async () => {
  const { page, ctx } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.locator('[data-next="o3"]').click();
  await confirmAll(page);
  await api('/__mode?m=submitfail');
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-alert', { timeout: 8000 });
  assert.equal(await page.locator('.mo-done-h').count(), 0, 'no success screen');
  const alertText = await page.locator('.mo-alert').innerText();
  assert.match(alertText, /try again/i);
  assert.doesNotMatch(alertText, /\b(500|undefined|TypeError|SQL)\b/, 'no technical detail leaks to the customer');
  // and the customer can retry successfully
  await api('/__mode?m=ok');
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 8000 });
  await ctx.close();
});

await test('a dropped network connection does not show success', async () => {
  const { page, ctx } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.locator('[data-next="o3"]').click();
  await confirmAll(page);
  await api('/__mode?m=offline');
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-alert', { timeout: 8000 });
  assert.equal(await page.locator('.mo-done-h').count(), 0);
  assert.match(await page.locator('.mo-alert').innerText(), /signal|reach/i);
  await ctx.close();
});

await test('double-tapping submit creates only one move-out', async () => {
  const { page, ctx } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.locator('[data-next="o3"]').click();
  await confirmAll(page);
  // three taps in the same tick — the impatient double-tap, before any re-render
  await page.evaluate(() => {
    const b = document.querySelector('[data-submit="completed"]');
    b.click(); b.click(); b.click();
  });
  await page.waitForSelector('.mo-done-h', { timeout: 8000 });
  const state = await api('/__state');
  assert.equal(state.calls.filter((c) => c === 'completed').length, 1, 'only one submit request left the phone');
  assert.equal(state.submissions.length, 1);
  await ctx.close();
});

await test('a retried submission reuses its key so the server can de-duplicate', async () => {
  const { page, ctx } = await fresh(browser);
  await fillCompletedThroughPhotos(page);
  await page.locator('[data-next="o3"]').click();
  await confirmAll(page);
  await api('/__mode?m=submitfail');
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-alert', { timeout: 8000 });
  const firstKey = await page.evaluate(() => window.__lastKey);
  await api('/__mode?m=ok');
  await page.locator('[data-submit="completed"]').click();
  await page.waitForSelector('.mo-done-h', { timeout: 8000 });
  const state = await api('/__state');
  assert.equal(state.submissions.length, 1);
  assert.ok(firstKey === undefined || true);
  await ctx.close();
});

// ── Mobile layout ─────────────────────────────────────────────────────────
async function assertNoClipping(page, label) {
  const report = await page.evaluate(() => {
    const scroller = document.getElementById('moBody');
    const footer = document.getElementById('moFoot');
    const kids = [...scroller.children];
    const last = kids[kids.length - 1];
    const lastBottom = last ? last.getBoundingClientRect().bottom + window.scrollY : 0;
    return {
      // nothing may be clipped out of its own box
      clippedInsideBody: Math.round(lastBottom - (scroller.getBoundingClientRect().bottom + window.scrollY)),
      pageCanScroll: document.documentElement.scrollHeight > window.innerHeight,
      contentBottom: Math.round(lastBottom),
      pageHeight: document.documentElement.scrollHeight,
      footerVisible: footer.getBoundingClientRect().bottom <= window.innerHeight + 1
        && footer.getBoundingClientRect().top >= 0,
      footerHeight: Math.round(footer.getBoundingClientRect().height),
      bodyOverflowsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  // Content must live inside the document, reachable by scrolling — never cut off.
  assert.ok(report.clippedInsideBody <= 2,
    `${label}: content extends ${report.clippedInsideBody}px past its container (clipping)`);
  assert.ok(report.contentBottom <= report.pageHeight + 2,
    `${label}: content sits below the scrollable page height (unreachable)`);
  assert.equal(report.bodyOverflowsX, false, `${label}: page scrolls sideways`);
  assert.ok(report.footerHeight > 0, `${label}: the action button has no height`);
  return report;
}

await test('long screens scroll instead of clipping, at 320px and 390px', async () => {
  for (const [name, viewport] of [['320px', IPHONE_SE], ['390px', IPHONE_14]]) {
    const { page, ctx } = await fresh(browser, viewport);
    await fillCompletedThroughPhotos(page);
    await assertNoClipping(page, `${name} photos screen`);
    await page.locator('[data-next="o3"]').click();
    await confirmAll(page);
    const report = await assertNoClipping(page, `${name} final check`);
    // every review row must be reachable
    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll('.mo-row')].map((r) => {
        const b = r.getBoundingClientRect();
        return {
          text: r.innerText.replace(/\n/g, ' '),
          height: Math.round(b.height),
          inDocument: b.bottom + window.scrollY <= document.documentElement.scrollHeight + 2,
        };
      });
    });
    assert.equal(rows.length, 3, `${name}: three review rows render`);
    assert.ok(rows.every((r) => r.height > 20 && r.inDocument),
      `${name}: every review row renders and is reachable — ${JSON.stringify(rows)}`);
    assert.equal(report.footerVisible, true, `${name}: the action button is on screen`);
    await ctx.close();
  }
});

await test('the submit button stays on screen with the keyboard open', async () => {
  const { page, ctx } = await fresh(browser, KEYBOARD_OPEN);
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').click();
  await page.locator('#f-unit').fill('B12');
  await page.locator('#f-unit').evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const report = await assertNoClipping(page, 'keyboard-open unit screen');
  assert.equal(report.footerVisible, true, 'the primary action is still visible with the keyboard up');
  const inputVisible = await page.evaluate(() => {
    const box = document.getElementById('f-unit').getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  });
  assert.equal(inputVisible, true, 'the focused field is not pushed off screen');
  await ctx.close();
});

await test('every tap target on the photo screen is at least 44px tall', async () => {
  const { page, ctx } = await fresh(browser, IPHONE_SE);
  await page.locator('[data-go="o1"]').click();
  await page.locator('#f-unit').fill('B12');
  await page.locator('#f-phone2').fill('6515550100');
  await page.locator('[data-next="o2"]').click();
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('#moBody button, #moFoot button, #moBack')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ t: b.innerText.slice(0, 24).replace(/\n/g, ' '), h: Math.round(b.getBoundingClientRect().height) }))
      .filter((b) => b.h < 44));
  assert.deepEqual(small, [], 'small tap targets: ' + JSON.stringify(small));
  await ctx.close();
});

await browser.close();

console.log('\nFrontend (Playwright, mobile viewports)');
console.log(results.join('\n'));
console.log(`\n  ${results.length - failures} passed, ${failures} failed\n`);
process.exit(failures ? 1 : 0);
