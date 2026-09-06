/**
 * Assembles the hosted Pleasant Lake preview from the real repo files, so the
 * preview is the same page and the same wizard, not a retyped copy.
 *
 *   site CSS + wizard CSS + Pleasant Lake markup + wizard JS + a store-backed
 *   transport + a TEST RECORDS panel
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const siteCss = read('css/styles.css');
const pageHtml = read('move-out.html');
const wizardJs = read('js/move-out.js');
const logo = fs.readFileSync(path.join(ROOT, 'images/logo-mark.svg')).toString('base64');

// the wizard's own <style> block, lifted from the real page
const wizardCss = pageHtml.match(/<style>([\s\S]*?)<\/style>/)[1];

// the wizard's card markup, lifted from the real page
const cardHtml = pageHtml.match(/<div class="mo-card" id="moCard" hidden>[\s\S]*?<\/div>\n      <\/div>/)[0];

const transport = `
/* ── Preview transport ───────────────────────────────────────────────────
   The wizard core below is byte-for-byte the file that ships on the site.
   Only its transport is swapped: instead of the Cloudflare Worker, this
   preview reads and writes the artifact's own store, so the flow can be
   exercised on a real phone before any backend is deployed.

   Differences from the real backend, stated plainly rather than hidden:
     · the move-out timestamp here is this device's clock (the Worker uses
       the server's, which is what production relies on)
     · photos are re-compressed smaller to fit the store's document limit
     · no SMS is recorded; the Worker writes a notification outbox row
   ------------------------------------------------------------------- */
(function () {
  var STORE = null;
  var storePromise = (window.claude && claude.use) ? claude.use('db').catch(function () { return null; }) : Promise.resolve(null);
  storePromise.then(function (db) { STORE = db; renderRecordsButton(); });

  function unavailable() {
    return Promise.resolve({ status: 503, body: { ok: false, errors: [{ field: 'form',
      message: 'The preview store is not available in this view. Reopen the page, or call (218) 675-5625.' }] } });
  }

  /** Shrink again for the store: documents are capped, and a thumbnail-grade
      copy is still enough to see whether a unit is empty and swept. */
  function toStoredDataUrl(blob) {
    return createImageBitmap(blob).then(function (bmp) {
      var scale = Math.min(1, 1100 / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      var q = 0.72, url = c.toDataURL('image/jpeg', q);
      while (url.length > 170000 && q > 0.35) { q -= 0.08; url = c.toDataURL('image/jpeg', q); }
      return url;
    });
  }

  window.MOVEOUT_TRANSPORT = {
    uploadPhoto: function (prepared, slot, onProgress, uploadToken) {
      if (!STORE) return Promise.reject(new Error('The preview store is not available. Reopen the page and try again.'));
      if (onProgress) onProgress(0.15);
      return toStoredDataUrl(prepared.blob).then(function (dataUrl) {
        if (onProgress) onProgress(0.6);
        var id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        return STORE.doc('photos/' + id).set({
          slot: slot, uploadToken: uploadToken, dataUrl: dataUrl,
          bytes: prepared.blob.size, width: prepared.width, height: prepared.height,
          createdAt: new Date().toISOString(), environment: 'PREVIEW'
        }).then(function () {
          if (onProgress) onProgress(1);
          return { ok: true, photoId: id, slot: slot };
        });
      }).catch(function (err) {
        var code = err && err.code;
        if (code === 'quota_exceeded') throw new Error('The preview store is full. Clear the test records below and try again.');
        throw new Error("That photo didn't finish saving. Please try it again.");
      });
    },

    submit: function (pathname, payload) {
      if (!STORE) return unavailable();
      var completed = pathname.indexOf('completed') !== -1;
      var now = new Date();
      var key = payload.idempotencyKey;

      return STORE.collection('submissions').where('idempotencyKey', '==', key).limit(1).get()
        .then(function (existing) {
          if (existing.docs && existing.docs.length) {
            var d = existing.docs[0].data();
            return { status: 200, body: Object.assign({ ok: true, duplicate: true }, d.result) };
          }
          var result = completed
            ? { id: '', type: 'COMPLETED_MOVE_OUT', unitNumber: String(payload.unitNumber || '').toUpperCase(),
                completedAt: now.toISOString(),
                completedAtLabel: now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                photoCount: (payload.photoIds || []).length }
            : { id: '', type: 'SCHEDULED_MOVE_OUT', plannedMoveOutDate: payload.plannedMoveOutDate };

          return STORE.collection('submissions').add({
            environment: 'PREVIEW',
            type: result.type,
            status: 'NEW',
            facility: 'Pleasant Lake Storage — Hackensack, MN (PREVIEW)',
            idempotencyKey: key,
            submittedAt: now.toISOString(),
            createdAt: now.toISOString(),
            customerName: payload.name || null,
            phone: payload.phone || null,
            plannedMoveOutDate: payload.plannedMoveOutDate || null,
            unitNumber: completed ? String(payload.unitNumber || '').toUpperCase() : null,
            completedAt: completed ? now.toISOString() : null,
            confirmations: payload.confirmations || null,
            photoIds: payload.photoIds || [],
            result: result
          }).then(function (ref) {
            result.id = ref.id || key;
            return { status: 201, body: Object.assign({ ok: true }, result) };
          });
        })
        .catch(function () {
          return { status: 500, body: { ok: false, errors: [{ field: 'form',
            message: 'We could not save that just then. Please try again, or call (218) 675-5625.' }] } };
        });
    }
  };

  /* ── TEST RECORDS panel ── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function renderRecordsButton() {
    var host = document.getElementById('moRecords');
    if (!host) return;
    if (!STORE) { host.innerHTML = '<p class="rec-none">The preview store is not available in this view, so test records cannot be listed.</p>'; return; }
    host.innerHTML = '<button type="button" class="rec-btn" id="recLoad">Show test records</button>';
    document.getElementById('recLoad').addEventListener('click', loadRecords);
  }

  function loadRecords() {
    var host = document.getElementById('moRecords');
    host.innerHTML = '<p class="rec-none">Loading…</p>';
    STORE.collection('submissions').orderBy('createdAt', 'desc').limit(25).get().then(function (snap) {
      var docs = snap.docs || [];
      if (!docs.length) { host.innerHTML = '<p class="rec-none">No test submissions yet. Complete the flow above and they will appear here.</p>' + reloadBtn(); return; }
      var photoIds = [];
      docs.forEach(function (d) { (d.data().photoIds || []).forEach(function (p) { photoIds.push(p); }); });
      Promise.all(photoIds.slice(0, 40).map(function (id) {
        return STORE.doc('photos/' + id).get().then(function (s) { return [id, s.exists ? s.data() : null]; }).catch(function () { return [id, null]; });
      })).then(function (pairs) {
        var byId = {}; pairs.forEach(function (p) { byId[p[0]] = p[1]; });
        host.innerHTML = docs.map(function (d) { return card(d, byId); }).join('') + reloadBtn();
      });
    }).catch(function () {
      host.innerHTML = '<p class="rec-none">Could not read the test records.</p>' + reloadBtn();
    });
  }

  function reloadBtn() { return '<button type="button" class="rec-btn" onclick="location.reload()">Refresh</button>'; }

  function card(d, byId) {
    var r = d.data();
    var when = new Date(r.submittedAt || r.createdAt);
    var stamp = when.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    var shots = (r.photoIds || []).map(function (id) {
      var p = byId[id];
      return p && p.dataUrl
        ? '<figure><img src="' + p.dataUrl + '" alt="' + esc(p.slot) + '"><figcaption>' + esc(p.slot) + '</figcaption></figure>'
        : '';
    }).join('');
    var head = r.type === 'COMPLETED_MOVE_OUT'
      ? 'Unit ' + esc(r.unitNumber) + ' — moved out'
      : esc(r.customerName) + ' — notice for ' + esc(r.plannedMoveOutDate);
    var c = r.confirmations || {};
    return '<article class="rec">' +
      '<div class="rec-head"><b>' + head + '</b><span class="rec-tag">TEST</span></div>' +
      '<dl class="rec-kv">' +
        '<div><dt>Phone</dt><dd>' + esc(r.phone) + '</dd></div>' +
        '<div><dt>Submitted</dt><dd>' + esc(stamp) + '</dd></div>' +
        '<div><dt>Status</dt><dd>' + esc(r.status) + '</dd></div>' +
        (r.type === 'COMPLETED_MOVE_OUT'
          ? '<div><dt>Confirmations</dt><dd>' + (c.empty && c.swept && c.lockRemoved ? '✅ all three' : '⚠️ incomplete') + '</dd></div>'
          : '') +
      '</dl>' +
      (shots ? '<div class="rec-shots">' + shots + '</div>' : '') +
      '</article>';
  }
})();
`;

const extraCss = `
  .mo-records{max-width:760px;margin:0 auto;padding:0 20px 8px}
  .mo-records h2{font-size:1.15rem;margin:0 0 6px;color:var(--ink)}
  .mo-records .lede{font-size:.9rem;color:var(--gray);margin:0 0 14px;line-height:1.5}
  .rec-btn{font:inherit;font-size:.92rem;font-weight:700;color:var(--blue);background:#fff;
    border:2px solid var(--blue);border-radius:8px;padding:11px 18px;cursor:pointer;min-height:44px}
  .rec-none{font-size:.9rem;color:var(--gray);margin:0 0 12px}
  .rec{background:#fff;border:1px solid var(--line);border-left:4px solid #d98518;
    border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .rec-head{display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:10px}
  .rec-head b{font-size:1rem;color:var(--ink)}
  .rec-tag{font-size:.62rem;font-weight:700;letter-spacing:.09em;background:#d98518;color:#fff;
    border-radius:4px;padding:3px 7px}
  .rec-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 10px}
  .rec-kv dt{font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:var(--gray);margin-bottom:2px}
  .rec-kv dd{margin:0;font-size:.9rem;font-weight:600;color:var(--ink)}
  .rec-shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
  .rec-shots figure{margin:0}
  .rec-shots img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:7px;border:1px solid var(--line);display:block}
  .rec-shots figcaption{font-size:.65rem;color:var(--gray);margin-top:4px;text-align:center}
`;

const out = `<title>Pleasant Lake Move-Out Preview</title>
<style>
${siteCss}
${wizardCss}
${extraCss}
</style>

<div class="topbar">
  <div class="container">
    <span>📍 2475 County 45 NW, Hackensack, MN 56452</span>
    <span>📞 <a href="tel:+12186755625">(218) 675-5625</a></span>
  </div>
</div>

<header class="site-header">
  <div class="container nav-wrap">
    <a class="brand" href="#top">
      <img src="data:image/svg+xml;base64,${logo}" alt="Pleasant Lake Storage logo" class="logo-img">
      <span class="brand-text">
        <strong>Pleasant Lake Storage</strong>
        <span>Hackensack, Minnesota</span>
      </span>
    </a>
    <nav class="main-nav" aria-label="Main navigation">
      <a href="#top">Move Out</a>
    </nav>
  </div>
</header>

<div class="page-hero" style="padding:34px 0;" id="top">
  <div class="container">
    <h1 style="margin:0 0 6px;">Move Out</h1>
    <p style="margin:0;">Takes about two minutes on your phone.</p>
  </div>
</div>

<section style="padding:22px 0 12px;">
  <div class="mo-shell">
    <div class="mo-banner">
      <strong>PREVIEW — TEST ONLY.</strong> Nothing here reaches a real account. Every submission is
      stored as a test record in this preview page's own store and is listed at the bottom.
      To really move out, call <a href="tel:+12186755625">(218) 675-5625</a>.
    </div>

    ${cardHtml}
  </div>
</section>

<section style="padding:8px 0 40px;">
  <div class="mo-records">
    <h2>Test records</h2>
    <p class="lede">Everything submitted from this preview, newest first — the same fields and photos
      the staff admin queue will show. Test data only.</p>
    <div id="moRecords"><p class="rec-none">Starting the preview store…</p></div>
  </div>
</section>

<footer class="site-footer">
  <div class="container">
    <div class="legal">Pleasant Lake Storage · 2475 County 45 NW, Hackensack, MN 56452 · Preview build, not the live site.</div>
  </div>
</footer>

<script>
${transport}
</script>
<script>
${wizardJs}
</script>
`;

fs.writeFileSync(path.join(ROOT, 'preview-artifact.html'), out);
console.log('built preview-artifact.html:', out.length, 'bytes');
