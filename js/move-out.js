/*
 * WI 64 Self Storage — move-out wizard.
 *
 * Two approved flows, locked:
 *   Schedule  : name + phone -> planned date -> review -> success
 *   Completed : unit + phone -> photos -> one last check -> success
 *
 * The completed move-out date is NOT collected. It is the server's timestamp at
 * the moment the submission is accepted, echoed back for display.
 */
(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────────────
  // Set after `wrangler deploy`, or overridden with <body data-moveout-api="…">.
  // An empty data-moveout-api means "same origin" — that is how the preview
  // Worker serves the site and the API together. Absent means use the default.
  var API_ATTR = document.body.getAttribute('data-moveout-api');
  var API_BASE = API_ATTR === null ? 'https://wi64-moveout-preview.wi64selfstorage.workers.dev' : API_ATTR;

  var FACILITY_PHONE = document.body.getAttribute('data-facility-phone') || '(218) 675-5625';
  var FACILITY_TEL = 'tel:+1' + FACILITY_PHONE.replace(/\D/g, '');

  var MAX_EDGE = 1600;      // px, long edge after resize
  var TARGET_KB = 380;      // per photo
  var POST_TIMEOUT_MS = 30000;   // matches the 90s upload ceiling in spirit
  var MAX_PHOTOS = 6;    // 3 required + 3 optional; must match the server's cap
  var PHONE_HELP = 'call ' + FACILITY_PHONE;

  var SLOTS = [
    { key: 'INSIDE', title: 'Inside the unit', hint: 'Wide shot from the doorway' },
    { key: 'FLOOR',  title: 'Floor / empty unit', hint: "Shows it's swept and clear" },
    { key: 'DOOR',   title: 'Door + unit number, lock removed', hint: 'Latch with no lock on it' }
  ];

  // ── tiny helpers ──────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function randomToken() {
    var bytes = new Uint8Array(18);
    (self.crypto || window.crypto).getRandomValues(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function maskTel(v) {
    var d = digits(v).slice(0, 10);
    if (d.length < 4) return d;
    if (d.length < 7) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }
  function validPhone(v) { return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits(v)); }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseIso(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtLong(d) { return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
  function fmtDay(d) { return d.toLocaleDateString('en-US', { weekday: 'long' }); }
  function endOfThisMonth() { var t = todayMidnight(); return new Date(t.getFullYear(), t.getMonth() + 1, 0); }

  /* The facility's calendar day, not the phone's. A customer scheduling from
     another time zone — or with a phone clock that has drifted — must see the
     same "today" the Worker enforces, which is America/Chicago. Falls back to
     the device's local day only if Intl has no time-zone data. */
  var FACILITY_TZ = 'America/Chicago';
  function facilityTodayIso() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: FACILITY_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) { return iso(new Date()); }
  }
  function todayMidnight() { return parseIso(facilityTodayIso()); }

  /**
   * Why the date is not acceptable, in the customer's words — or '' when it is
   * fine, or null when nothing has been chosen yet. A native date field happily
   * reports a year like 1909, so this, not the field, is the authority. The
   * Worker repeats every one of these checks; neither side trusts the other.
   */
  function dateProblem(v) {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Please pick a date from the calendar.';
    var p = v.split('-'), y = +p[0], m = +p[1], day = +p[2];
    var d = new Date(y, m - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) {
      return 'That is not a real date. Please pick one from the calendar.';
    }
    var today = todayMidnight();
    if (d < today) return 'That date has already passed. Please pick today or a later date.';
    var limit = new Date(today.getFullYear() + 2, today.getMonth(), today.getDate());
    if (d > limit) return 'That is more than two years away. Please check the year.';
    return '';
  }
  function validNoticeDate(v) { return dateProblem(v) === ''; }
  function maxNoticeDate() { var t = todayMidnight(); return iso(new Date(t.getFullYear() + 2, t.getMonth(), t.getDate())); }

  // ── three-part date selector ──────────────────────────────────────────────
  // The native calendar popup was unreliable on iPhone, so the date is chosen
  // with three ordinary <select>s instead. iOS gives each one its usual wheel,
  // nothing can be typed, and impossible choices are greyed out rather than
  // accepted and rejected afterwards.
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /** Days in a month, 1-indexed. Day 0 of the next month is the last of this
   *  one, so February follows the real leap-year rule with no special case. */
  function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }

  /** The only years worth offering: this one and the two after it. */
  function yearChoices() { var y = todayMidnight().getFullYear(); return [y, y + 1, y + 2]; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** The three parts currently chosen, '' for any not chosen yet. */
  function dateParts() {
    if (S.noticeDate && /^\d{4}-\d{2}-\d{2}$/.test(S.noticeDate)) {
      var p = S.noticeDate.split('-');
      return { y: String(+p[0]), m: String(+p[1]), d: String(+p[2]) };
    }
    return { y: S.dy || '', m: S.dm || '', d: S.dd || '' };
  }

  function option(value, label, selected, disabled) {
    return '<option value="' + value + '"' + (selected ? ' selected' : '') +
      (disabled ? ' disabled' : '') + '>' + label + '</option>';
  }

  function monthOptions(year, chosen) {
    var t = todayMidnight(), thisYear = +year === t.getFullYear();
    var out = option('', 'Month', !chosen, false);
    for (var m = 1; m <= 12; m++) {
      out += option(m, MONTH_NAMES[m - 1], String(chosen) === String(m), thisYear && m < t.getMonth() + 1);
    }
    return out;
  }

  function dayOptions(year, month, chosen) {
    var t = todayMidnight();
    var y = +year || t.getFullYear();
    var m = +month || (t.getMonth() + 1);
    var thisMonth = y === t.getFullYear() && m === t.getMonth() + 1;
    var out = option('', 'Day', !chosen, false);
    var n = daysInMonth(y, m);
    for (var d = 1; d <= n; d++) {
      out += option(d, d, String(chosen) === String(d), thisMonth && d < t.getDate());
    }
    return out;
  }

  function yearOptions(chosen) {
    var out = option('', 'Year', !chosen, false);
    yearChoices().forEach(function (y) { out += option(y, y, String(chosen) === String(y)); });
    return out;
  }

  function selectField(id, label, options) {
    return '<div class="mo-dpart' + (id === 'd-month' ? ' wide' : '') + '">' +
      '<label class="mo-label" for="' + id + '">' + label + '</label>' +
      '<div class="mo-sel"><select id="' + id + '" data-dpart="' + id.slice(2) + '" ' +
      'class="' + (/ selected/.test(options.split('</option>')[0]) ? 'empty' : 'set') + '">' + options +
      '</select><span class="cue" aria-hidden="true">\u25BE</span></div></div>';
  }

  // ── session state ─────────────────────────────────────────────────────────
  // uploadToken ties already-uploaded photos to this browser session, so going
  // Back (or reloading) never loses them.
  var SKEY = 'wi64.moveout.v1';

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SKEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.uploadToken) return parsed;
      }
    } catch (e) { /* private mode, quota — fall through to a fresh session */ }
    return null;
  }
  function saveSession() {
    try {
      sessionStorage.setItem(SKEY, JSON.stringify({
        uploadToken: S.uploadToken,
        // Without this a stalled submit + reload mints a new key and books the
        // move-out twice — the exact thing the key exists to prevent.
        idempotencyKey: S.idempotencyKey,
        unit: S.unit, phone: S.phone, name: S.name,
        noticeDate: S.noticeDate, noticeMode: S.noticeMode,
        photos: S.photos.map(function (p) {
          return p && p.photoId ? { slot: p.slot, photoId: p.photoId, thumb: p.thumb } : null;
        }),
        extras: S.extras.map(function (p) { return { slot: p.slot, photoId: p.photoId, thumb: p.thumb }; })
      }));
    } catch (e) { /* not fatal — photos are already on the server */ }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SKEY); } catch (e) { /* ignore */ }
  }

  var restored = loadSession();
  var S = {
    uploadToken: (restored && restored.uploadToken) || randomToken(),
    name: (restored && restored.name) || '',
    phone: (restored && restored.phone) || '',
    idempotencyKey: (restored && restored.idempotencyKey) || '',
    noticeDate: (restored && restored.noticeDate) || '',
    // the three parts, held separately while only some of them are chosen
    dy: '', dm: '', dd: '',
    noticeMode: (restored && restored.noticeMode) || '',
    unit: (restored && restored.unit) || '',
    photos: (restored && restored.photos) || [null, null, null],
    extras: (restored && restored.extras) || [],
    confs: [false, false, false],
    result: null,
    submitting: false
  };
  if (!Array.isArray(S.photos) || S.photos.length !== 3) S.photos = [null, null, null];

  var here = 'home';
  var trail = [];
  var alertText = '';

  // ── image handling ────────────────────────────────────────────────────────
  /**
   * Reads the EXIF orientation tag from a JPEG. Needed because canvas
   * drawImage ignores orientation metadata: without this, iPhone photos taken
   * in portrait arrive sideways.
   */
  function exifOrientation(buffer) {
    var view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return 1;
    var offset = 2;
    while (offset < view.byteLength - 1) {
      if (view.getUint8(offset) !== 0xFF) break;
      var marker = view.getUint8(offset + 1);
      if (marker === 0xE1) {
        var exifStart = offset + 4;
        if (view.getUint32(exifStart, false) !== 0x45786966) return 1;
        var tiff = exifStart + 6;
        var little = view.getUint16(tiff, false) === 0x4949;
        var dirOffset = tiff + view.getUint32(tiff + 4, little);
        var entries = view.getUint16(dirOffset, little);
        for (var i = 0; i < entries; i++) {
          var entry = dirOffset + 2 + i * 12;
          if (view.getUint16(entry, little) === 0x0112) {
            var value = view.getUint16(entry + 8, little);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
      if ((marker & 0xF0) !== 0xE0) break;
      offset += 2 + view.getUint16(offset + 2, false);
    }
    return 1;
  }

  function applyOrientation(ctx, orientation, w, h) {
    switch (orientation) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
      default: break;
    }
  }

  function loadBitmap(file, wantOrientation) {
    // createImageBitmap applies EXIF for us where supported.
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .then(function (bmp) { return { source: bmp, orientation: 1 }; })
        .catch(function () { return loadViaImg(file, wantOrientation); });
    }
    return loadViaImg(file, wantOrientation);
  }

  function loadViaImg(file, wantOrientation) {
    // Reading the whole file for EXIF costs memory, so only do it when we
    // actually need the orientation (i.e. createImageBitmap was unavailable).
    var orientationStep = wantOrientation === false
      ? Promise.resolve(1)
      : file.arrayBuffer().then(exifOrientation).catch(function () { return 1; });

    return orientationStep.then(function (orientation) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve({ source: img, orientation: orientation }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('IMAGE_DECODE')); };
        img.src = url;
      });
    });
  }

  /* iOS caps how much canvas backing store a page may hold, and it counts
     every canvas that still exists. Allocating a fresh one per photo is what
     made the third upload fail: reuse one and shrink it when finished. */
  var workCanvas = null;
  function getCanvas(w, h) {
    if (!workCanvas) workCanvas = document.createElement('canvas');
    workCanvas.width = w; workCanvas.height = h;
    return workCanvas;
  }
  function releaseCanvas(c) { try { c.width = 1; c.height = 1; } catch (e) { /* nothing to free */ } }

  function attemptPrepare(file, maxEdge) {
    return loadBitmap(file).then(function (loaded) {
      var src = loaded.source;
      var swap = loaded.orientation >= 5 && loaded.orientation <= 8;
      var dw = swap ? src.height : src.width;
      var dh = swap ? src.width : src.height;
      if (!dw || !dh) { if (src.close) src.close(); throw new Error('IMAGE_DECODE'); }

      var scale = Math.min(1, maxEdge / Math.max(dw, dh));
      var outW = Math.max(1, Math.round(dw * scale));
      var outH = Math.max(1, Math.round(dh * scale));

      var canvas = getCanvas(outW, outH);
      var ctx = canvas.getContext('2d');
      if (!ctx) { if (src.close) src.close(); throw new Error('IMAGE_DECODE'); }
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.save();
      applyOrientation(ctx, loaded.orientation, outW, outH);
      ctx.drawImage(src, 0, 0, swap ? outH : outW, swap ? outW : outH);
      ctx.restore();
      if (src.close) src.close();
      src = null;

      // Thumbnail off the same canvas, then let that scratch canvas go too.
      var thumb = '';
      try {
        var tc = document.createElement('canvas');
        var tScale = Math.min(1, 150 / Math.max(outW, outH));
        tc.width = Math.max(1, Math.round(outW * tScale));
        tc.height = Math.max(1, Math.round(outH * tScale));
        tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);
        thumb = tc.toDataURL('image/jpeg', 0.6);
        releaseCanvas(tc);
      } catch (e) { thumb = ''; }

      /* Aim at the target size instead of stepping down to it. Walking the
         quality down 0.08 at a time meant up to six full re-encodes of a
         1600px canvas per photo, which is what made uploads feel slow. One
         measurement, one correction, one last resort: at most three. */
      return new Promise(function (resolve, reject) {
        function encode(quality) {
          return new Promise(function (r, j) {
            canvas.toBlob(function (blob) { blob ? r(blob) : j(new Error('IMAGE_ENCODE')); }, 'image/jpeg', quality);
          });
        }
        var done = function (blob) {
          releaseCanvas(canvas);
          resolve({ blob: blob, width: outW, height: outH, thumb: thumb });
        };
        encode(0.8).then(function (first) {
          if (first.size / 1024 <= TARGET_KB) return done(first);
          // JPEG size moves roughly with quality, so scale by the overshoot.
          var next = Math.max(0.42, Math.min(0.78, 0.8 * Math.sqrt(TARGET_KB / (first.size / 1024))));
          return encode(next).then(function (second) {
            if (second.size / 1024 <= TARGET_KB || next <= 0.43) return done(second);
            return encode(0.42).then(done);
          });
        }).catch(function (err) { releaseCanvas(canvas); reject(err); });
      });
    });
  }

  /**
   * Resize + compress, right way up. If the first pass fails — which on a phone
   * usually means memory, not a broken file — retry once at a smaller size
   * before giving up, and always report it in words a customer can act on.
   */
  function prepareImage(file) {
    return attemptPrepare(file, MAX_EDGE)
      .catch(function () {
        releaseCanvas(getCanvas(1, 1));
        return new Promise(function (r) { setTimeout(r, 250); })
          .then(function () { return attemptPrepare(file, 1000); });
      })
      .catch(function () {
        throw new Error("We couldn't read that photo. Please take it again.");
      });
  }

  /**
   * Transport seam. The site talks to the Worker over HTTP; the hosted preview
   * swaps in a store-backed transport by defining window.MOVEOUT_TRANSPORT
   * before this file runs. Everything above and below is identical either way,
   * so the preview exercises the real wizard, not a copy of it.
   */
  var T = window.MOVEOUT_TRANSPORT || null;

  /** XHR rather than fetch, because only XHR reports upload progress. */
  function uploadPhotoHttp(prepared, slot, onProgress) {
    return new Promise(function (resolve, reject) {
      var form = new FormData();
      form.append('file', prepared.blob, 'unit-photo.jpg');
      form.append('slot', slot);
      form.append('uploadToken', S.uploadToken);
      form.append('width', String(prepared.width));
      form.append('height', String(prepared.height));

      var xhr = new XMLHttpRequest();
      xhr.open('POST', API_BASE + '/api/photos');
      xhr.timeout = 90000;
      if (xhr.upload) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = function () {
        var body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) resolve(body);
        else reject(new Error((body && body.errors && body.errors[0] && body.errors[0].message) ||
          "That photo didn't finish uploading. Please try it again."));
      };
      xhr.onerror = function () { reject(new Error("We couldn't reach us just then. Check your signal and try that photo again.")); };
      xhr.ontimeout = function () { reject(new Error('That photo took too long to send. Please try it again.')); };
      xhr.send(form);
    });
  }

  function uploadPhoto(prepared, slot, onProgress) {
    if (T && T.uploadPhoto) return T.uploadPhoto(prepared, slot, onProgress, S.uploadToken);
    return uploadPhotoHttp(prepared, slot, onProgress);
  }

  function postJsonHttp(path, payload) {
    /* fetch() waits forever by default. On a weak signal inside a metal
       building that leaves the button on "Sending…" with no way out but a
       reload — which is why the idempotency key is now persisted: the retry
       carries the same key and the server returns the original record. */
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, POST_TIMEOUT_MS) : null;
    var options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    };
    if (ctl) options.signal = ctl.signal;
    return fetch(API_BASE + path, options).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, body: body };
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error('That took too long to send. Check your signal and try again.');
      }
      throw err;
    });
  }

  function postJson(path, payload) {
    if (T && T.submit) return T.submit(path, payload);
    return postJsonHttp(path, payload);
  }

  function firstError(body, fallback) {
    if (body && body.errors && body.errors.length && body.errors[0].message) return body.errors[0].message;
    return fallback;
  }

  // A session restored mid-flow already knows its date; seed the three parts
  // from it so changing one of them does not wipe the other two.
  if (S.noticeDate && /^\d{4}-\d{2}-\d{2}$/.test(S.noticeDate)) {
    var _p = S.noticeDate.split('-');
    S.dy = String(+_p[0]); S.dm = String(+_p[1]); S.dd = String(+_p[2]);
  }

  // ── screens ───────────────────────────────────────────────────────────────
  function reviewHead(label, backTo) {
    return '<div class="mo-rhead"><span>' + label + '</span>' +
      '<button type="button" data-edit="' + backTo + '">Edit</button></div>';
  }
  function row(k, v, mono) {
    return '<div class="mo-row"><span>' + esc(k) + '</span><b' + (mono ? ' class="mono"' : '') + '>' + esc(v) + '</b></div>';
  }

  var SCREENS = {
    home: function () {
      return {
        step: 0,
        body:
          '<h2 class="mo-h">Moving Out?</h2>' +
          '<p class="mo-sub">Pick the one that fits.</p>' +
          '<div class="mo-stack mo-choices">' +
            '<button type="button" class="mo-tile" data-go="n1"><span class="ic">📅</span><span>' +
              '<b>Schedule My Move-Out</b><small>I’m leaving soon — here’s my date</small></span></button>' +
            '<button type="button" class="mo-tile" data-go="o1"><span class="ic">📸</span><span>' +
              '<b>I’ve Already Moved Out</b><small>It’s empty — send photos and close it</small></span></button>' +
          '</div>',
        foot: '<p class="why">Questions? Call <a href="' + FACILITY_TEL + '" style="color:var(--green-main);font-weight:800;">' + FACILITY_PHONE + '</a></p>'
      };
    },

    // ── Schedule ──
    n1: function () {
      var ready = S.name.trim().length > 1 && validPhone(S.phone);
      return {
        label: 'Notice · 1 of 3', step: 1, of: 3,
        body:
          '<h2 class="mo-h">Schedule Your Move-Out</h2>' +
          '<p class="mo-sub">Tell us who you are.</p>' +
          '<div class="mo-stack">' +
            '<div><label class="mo-label" for="f-name">Name</label>' +
              '<input class="mo-input" id="f-name" data-bind="name" value="' + esc(S.name) + '" ' +
              'placeholder="Full Name" autocomplete="name" autocapitalize="words" enterkeyhint="next"></div>' +
            '<div><label class="mo-label" for="f-phone">Phone number</label>' +
              '<input class="mo-input" id="f-phone" data-bind="phone" data-tel="1" value="' + esc(S.phone) + '" ' +
              'placeholder="(651) 555-0100" inputmode="tel" autocomplete="tel" enterkeyhint="done">' +
              '<p class="mo-hint">We’ll text your confirmation here.</p></div>' +
          '</div>',
        foot: '<button type="button" class="mo-btn" data-next="n2"' + (ready ? '' : ' disabled') + '>Continue →</button>'
      };
    },

    n2: function () {
      var eom = endOfThisMonth();
      var isEom = S.noticeMode === 'eom';
      var eomIsToday = iso(eom) === iso(new Date());
      var parts = dateParts();
      var chosen = S.noticeDate && !dateProblem(S.noticeDate) ? parseIso(S.noticeDate) : null;
      var problem = S.noticeDate ? dateProblem(S.noticeDate) : null;
      return {
        label: 'Notice \u00b7 2 of 3', step: 2, of: 3,
        body:
          '<h2 class="mo-h">When are you planning to move out?</h2>' +
          '<p class="mo-sub">Pick any date that works for you.</p>' +
          '<button type="button" class="mo-tile' + (isEom ? ' on' : '') + '" data-eom="1">' +
            '<span class="ic">🗓️</span><span><b>End of this month</b><small>' +
            esc(fmtLong(eom)) + ' \u00b7 ' + (eomIsToday ? 'Today' : esc(fmtDay(eom))) + '</small></span>' +
            '<span class="chk">' + (isEom ? '\u2713' : '') + '</span></button>' +
          '<div class="mo-or"><span>or</span></div>' +
          '<p class="mo-label" id="d-legend">Choose a different date</p>' +
          '<div class="mo-dparts" role="group" aria-labelledby="d-legend">' +
            selectField('d-month', 'Month', monthOptions(parts.y, parts.m)) +
            selectField('d-day', 'Day', dayOptions(parts.y, parts.m, parts.d)) +
            selectField('d-year', 'Year', yearOptions(parts.y)) +
          '</div>' +
          '<p class="mo-chosen" id="f-date-msg"' + (chosen ? '' : ' hidden') + '>' +
            (chosen ? 'Selected move-out date: <b>' + esc(fmtLong(chosen)) + '</b><span>' + esc(fmtDay(chosen)) + '</span>' : '') + '</p>' +
          '<p class="mo-dateerr" id="f-date-err"' + (problem ? '' : ' hidden') + '>' + esc(problem || '') + '</p>',
        foot: '<button type="button" class="mo-btn" data-next="n3"' + (validNoticeDate(S.noticeDate) ? '' : ' disabled') + '>Continue \u2192</button>'
      };
    },

    n3: function () {
      return {
        label: 'Notice · 3 of 3', step: 3, of: 3,
        body:
          '<h2 class="mo-h">Review Your Notice</h2>' +
          '<p class="mo-sub">Make sure this looks right.</p>' +
          '<div class="mo-review">' +
            reviewHead('Your notice', 'n1') +
            row('Name', S.name) +
            row('Phone', maskTel(S.phone), true) +
            row('Planned move-out', S.noticeDate ? fmtLong(parseIso(S.noticeDate)) : '\u2014') +
          '</div>' +
          '<div class="mo-remind">When you are completely moved out, <strong>return here</strong> to send us your final move-out photos.</div>',
        foot: '<button type="button" class="mo-btn" data-submit="scheduled"' + (S.submitting ? ' disabled' : '') + '>' +
          (S.submitting ? 'Sending…' : 'Submit My Move-Out Notice') + '</button>'
      };
    },

    n4: function () {
      var r = S.result || {};
      var d = r.plannedMoveOutDate ? parseIso(r.plannedMoveOutDate)
        : (S.noticeDate ? parseIso(S.noticeDate) : null);
      return {
        step: 3, of: 3, center: true, noBack: true,
        body:
          '<div class="mo-mark">✓</div>' +
          '<h2 class="mo-done-h">Move-out notice received</h2>' +
          (d ? '<div class="mo-stamp">Planned move-out<br>' + esc(fmtLong(d)) + '</div>' : '') +
          '<div class="mo-next">When the unit is empty, swept and your lock has been removed, ' +
            'return to the Move Out page and select <strong>I’ve Already Moved Out</strong>.</div>' +
          '<p class="mo-sms">💬 We’ll text a confirmation to ' + esc(maskTel(S.phone)) + '</p>',
        foot: '<button type="button" class="mo-btn ghost" data-go="home">Done</button>'
      };
    },

    // ── Already moved out ──
    o1: function () {
      var ready = S.unit.trim().length > 0 && validPhone(S.phone);
      return {
        label: 'Move-out · 1 of 3', step: 1, of: 3,
        body:
          '<h2 class="mo-h">Confirm Your Move-Out</h2>' +
          '<p class="mo-sub">Which unit did you move out of?</p>' +
          '<div class="mo-stack">' +
            '<div><label class="mo-label" for="f-unit">Unit number</label>' +
              '<input class="mo-input unit" id="f-unit" data-bind="unit" value="' + esc(S.unit) + '" ' +
              'placeholder="B12" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="next"></div>' +
            '<div><label class="mo-label" for="f-phone2">Phone number</label>' +
              '<input class="mo-input" id="f-phone2" data-bind="phone" data-tel="1" value="' + esc(S.phone) + '" ' +
              'placeholder="(651) 555-0100" inputmode="tel" autocomplete="tel" enterkeyhint="done">' +
              '<p class="mo-hint">We’ll text you here about your move-out.</p></div>' +
          '</div>',
        foot: '<button type="button" class="mo-btn" data-next="o2"' + (ready ? '' : ' disabled') + '>Continue →</button>'
      };
    },

    o2: function () {
      var done = S.photos.filter(function (p) { return p && p.photoId; }).length;
      var total = done + S.extras.length;

      var slots = SLOTS.map(function (slot, i) {
        var p = S.photos[i];
        var state = p ? p.state : 'empty';
        var cls = state === 'done' ? ' done' : state === 'uploading' ? ' busy' : state === 'failed' ? ' failed' : '';
        var left, right, sub;
        if (state === 'uploading') {
          left = '<span class="mo-ring" role="status" aria-label="Uploading"></span>';
          sub = 'Uploading…<span class="mo-mini-bar"><i style="width:' + Math.round((p.progress || 0) * 100) + '%"></i></span>';
          right = '';
        } else if (state === 'done') {
          left = p.thumb ? '<img src="' + p.thumb + '" alt="">' : '✓';
          sub = 'Added — tap to retake';
          right = '✓';
        } else if (state === 'failed') {
          left = '!';
          sub = esc(p.error || "Didn't upload. Tap to try again.");
          right = '↻';
        } else {
          left = String(i + 1);
          sub = slot.hint;
          right = '📷';
        }
        return '<button type="button" class="mo-slot' + cls + '" data-shot="' + i + '">' +
          '<span class="thumb">' + left + '</span>' +
          '<span><b>' + slot.title + '</b><small>' + sub + '</small></span>' +
          '<span class="act">' + right + '</span></button>';
      }).join('');

      var extras = '';
      if (done === 3) {
        extras = '<div class="mo-extras">' +
          S.extras.map(function (p, i) {
            return '<div class="mo-ex">' + (p.thumb ? '<img src="' + p.thumb + '" alt="">' : '') +
              '<button type="button" class="x" data-drop="' + i + '" aria-label="Remove extra photo">×</button></div>';
          }).join('') +
          (total < MAX_PHOTOS ? '<button type="button" class="mo-ex add" data-extra="1" aria-label="Add another photo">+</button>' : '') +
          '</div>' +
          '<p class="mo-optional' + (total >= MAX_PHOTOS ? ' at-max' : '') + '">' +
            total + ' of ' + MAX_PHOTOS + ' photos added' +
            (total < MAX_PHOTOS
              ? ' \u2014 you can add ' + (MAX_PHOTOS - total) + ' more if you\u2019d like.'
              : '. Remove one to swap it.') + '</p>';
      }

      return {
        label: 'Move-out · 2 of 3', step: 2, of: 3,
        body:
          '<h2 class="mo-h">Show Us the Empty Unit</h2>' +
          '<p class="mo-sub">Tap a slot to open your camera.</p>' +
          '<div class="mo-slots">' + slots + '</div>' +
          '<div class="mo-prog"><span class="t' + (done === 3 ? ' ok' : '') + '">Photos added: ' + done + ' of 3 required</span>' +
            '<span class="track"><i style="width:' + (done / 3 * 100) + '%"></i></span></div>' +
          extras,
        foot: '<button type="button" class="mo-btn" data-next="o3"' + (done < 3 ? ' disabled' : '') + '>Continue →</button>'
      };
    },

    o3: function () {
      var lines = [
        'My unit is completely empty',
        'The floor is swept and trash/debris is removed',
        'My padlock is removed and the unit is unlocked'
      ];
      var all = S.confs[0] && S.confs[1] && S.confs[2];
      var count = S.photos.filter(function (p) { return p && p.photoId; }).length + S.extras.length;
      return {
        label: 'Move-out · 3 of 3', step: 3, of: 3,
        body:
          '<h2 class="mo-h">One Last Check</h2>' +
          '<p class="mo-sub" style="margin-bottom:18px">Tap each to confirm, then check your details.</p>' +
          '<div class="mo-stack" style="gap:10px">' +
            lines.map(function (t, i) {
              return '<button type="button" class="mo-conf' + (S.confs[i] ? ' on' : '') + '" data-conf="' + i + '" ' +
                'role="checkbox" aria-checked="' + (S.confs[i] ? 'true' : 'false') + '">' +
                '<span class="box">' + (S.confs[i] ? '✓' : '') + '</span>' + t + '</button>';
            }).join('') +
          '</div>' +
          '<div class="mo-review" style="margin-top:15px">' +
            reviewHead('Submitting as', 'o1') +
            row('Unit', S.unit.toUpperCase(), true) +
            row('Phone', maskTel(S.phone), true) +
            row('Photos', count + ' attached') +
          '</div>' +
          '<p class="mo-optional" style="text-align:left;margin-top:9px">Move-out date: <b>today, ' +
            'today\u2019s date</b> \u2014 the moment you submit.</p>',
        foot: '<button type="button" class="mo-btn" data-submit="completed"' +
          (all && !S.submitting ? '' : ' disabled') + '>' +
          (S.submitting ? 'Submitting…' : 'Confirm &amp; Submit Move-Out') + '</button>'
      };
    },

    o4: function () {
      var r = S.result || {};
      return {
        step: 3, of: 3, center: true, noBack: true,
        body:
          '<div class="mo-mark">✓</div>' +
          '<h2 class="mo-done-h">Move-out request received</h2>' +
          '<div class="mo-stamp" style="font-size:18px;letter-spacing:.07em">Unit ' + esc(r.unitNumber || S.unit.toUpperCase()) + '</div>' +
          '<p class="mo-done-p">' + (r.completedAtLabel ? 'Your move-out date is <b>' + esc(r.completedAtLabel) + '</b>. ' : '') +
            'We’ll review your photos and be in touch if anything else is needed.</p>' +
          '<div class="mo-next"><strong>Leave the door unlocked</strong> with your padlock off — ' +
            'we can’t finish a move-out on a locked unit.</div>' +
          '<p class="mo-sms">💬 We’ll text a confirmation to ' + esc(maskTel(S.phone)) + '</p>',
        foot: '<button type="button" class="mo-btn ghost" data-go="home">Done</button>'
      };
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  var body = el('moBody'), foot = el('moFoot'), bar = el('moBar'),
      stepLabel = el('moStep'), backBtn = el('moBack'), card = el('moCard');

  function render(keepScroll) {
    var sc = SCREENS[here]();
    var previous = keepScroll ? window.scrollY : null;
    body.className = 'mo-body' + (sc.center ? ' center' : '') + (here === 'home' ? ' home' : '');
    body.innerHTML = (alertText ? '<div class="mo-alert" role="alert">' + alertText + '</div>' : '') + sc.body;
    foot.innerHTML = sc.foot || '';
    if (previous !== null) window.scrollTo(0, previous);
    stepLabel.textContent = sc.label || '';
    bar.style.width = sc.of ? (sc.step / sc.of * 100) + '%' : '0%';
    backBtn.hidden = here === 'home' || !!sc.noBack;
    card.classList.toggle('at-home', here === 'home');
  }

  function go(id) {
    // Review has nothing to show without a date; send them back to pick one.
    if (id === 'n3' && !validNoticeDate(S.noticeDate)) id = 'n2';
    // Entering either flow claims the key that will submit it.
    if (id === 'n1' || id === 'o1') ensureKey();
    if (here !== id) trail.push(here);
    alertText = '';
    here = id;
    render();
    // Each screen starts at its own top, the way a native step does.
    var top = card.getBoundingClientRect().top + window.scrollY - 12;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function showAlert(message) {
    alertText = esc(message);
    render();
    var node = body.querySelector('.mo-alert');
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function resetAll() {
    clearSession();
    S.uploadToken = randomToken();
    S.name = ''; S.phone = ''; S.noticeDate = ''; S.noticeMode = '';
    S.dy = ''; S.dm = ''; S.dd = '';
    S.idempotencyKey = '';
    S.unit = ''; S.photos = [null, null, null]; S.extras = [];
    S.confs = [false, false, false]; S.idempotencyKey = ''; S.result = null; S.submitting = false;
    trail = []; here = 'home'; alertText = '';
    render();
  }

  // ── events ────────────────────────────────────────────────────────────────
  body.addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-go]'))) {
      if (t.getAttribute('data-go') === 'home') resetAll(); else go(t.getAttribute('data-go'));
      return;
    }
    if ((t = e.target.closest('[data-edit]'))) { go(t.getAttribute('data-edit')); return; }
    if ((t = e.target.closest('[data-eom]'))) {
      if (S.noticeMode === 'eom') {
        S.noticeMode = ''; S.noticeDate = ''; S.dy = ''; S.dm = ''; S.dd = '';
      } else {
        S.noticeMode = 'eom'; S.noticeDate = iso(endOfThisMonth());
        var p = S.noticeDate.split('-');
        S.dy = String(+p[0]); S.dm = String(+p[1]); S.dd = String(+p[2]);
      }
      saveSession(); render(); return;
    }
    if ((t = e.target.closest('[data-conf]'))) {
      var ci = +t.getAttribute('data-conf');
      S.confs[ci] = !S.confs[ci];
      render(true); return;
    }
    if ((t = e.target.closest('[data-drop]'))) {
      S.extras.splice(+t.getAttribute('data-drop'), 1);
      saveSession(); render(true); return;
    }
    if ((t = e.target.closest('[data-shot]'))) { pickFile(+t.getAttribute('data-shot')); return; }
    if ((t = e.target.closest('[data-extra]'))) { pickFile(-1); return; }
  });

  foot.addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-go]'))) {
      if (t.getAttribute('data-go') === 'home') resetAll(); else go(t.getAttribute('data-go'));
      return;
    }
    if ((t = e.target.closest('[data-next]'))) { if (!t.disabled) go(t.getAttribute('data-next')); return; }
    if ((t = e.target.closest('[data-submit]'))) {
      if (t.disabled) return;
      if (t.getAttribute('data-submit') === 'scheduled') submitScheduled(t);
      else submitCompleted(t);
    }
  });

  body.addEventListener('input', function (e) {
    var input = e.target, key = input.getAttribute && input.getAttribute('data-bind');
    if (!key) return;
    if (input.getAttribute('data-tel')) input.value = maskTel(input.value);
    S[key] = input.value;
    saveSession();
    var button = foot.querySelector('[data-next]');
    if (button && (here === 'n1' || here === 'o1')) {
      button.disabled = here === 'n1'
        ? !(S.name.trim().length > 1 && validPhone(S.phone))
        : !(S.unit.trim().length > 0 && validPhone(S.phone));
    }
  });

  // Each part commits on 'change' — on iPhone that is when the wheel closes.
  // The day list is rebuilt in place rather than by re-rendering the screen, so
  // the select the customer just used is not swapped out from under them.
  body.addEventListener('change', function (e) {
    var part = e.target && e.target.getAttribute && e.target.getAttribute('data-dpart');
    if (!part) return;
    if (part === 'month') S.dm = e.target.value;
    if (part === 'day') S.dd = e.target.value;
    if (part === 'year') S.dy = e.target.value;
    S.noticeMode = 'custom';
    applyDateParts();
  });

  /**
   * Reconciles the three parts into a date. Rebuilds the month and day lists
   * for the chosen year and month — a day that no longer exists (February 30,
   * or the 29th of a non-leap year) is dropped rather than silently kept — then
   * updates the confirmation line, the error line and the Continue button.
   */
  function markSelect(el) {
    var chosen = !!el.value;
    el.classList.toggle('set', chosen);
    el.classList.toggle('empty', !chosen);
  }

  function applyDateParts() {
    var t = todayMidnight();
    var y = +S.dy || 0, m = +S.dm || 0, d = +S.dd || 0;

    // a day that does not exist in the newly chosen month cannot stay selected
    if (y && m && d && d > daysInMonth(y, m)) { d = 0; S.dd = ''; }

    S.noticeDate = (y && m && d) ? (y + '-' + pad2(m) + '-' + pad2(d)) : '';
    var problem = S.noticeDate ? dateProblem(S.noticeDate) : null;
    if (problem) S.noticeDate = '';
    saveSession();

    var monthSel = body.querySelector('#d-month');
    var daySel = body.querySelector('#d-day');
    var yearSel = body.querySelector('#d-year');
    if (monthSel) { monthSel.innerHTML = monthOptions(S.dy, S.dm); markSelect(monthSel); }
    if (daySel) { daySel.innerHTML = dayOptions(S.dy, S.dm, S.dd); markSelect(daySel); }
    if (yearSel) { yearSel.innerHTML = yearOptions(S.dy); markSelect(yearSel); }

    var eomTile = body.querySelector('[data-eom]');
    if (eomTile) {
      eomTile.classList.remove('on');
      var chk = eomTile.querySelector('.chk');
      if (chk) chk.textContent = '';
    }

    var msg = body.querySelector('#f-date-msg');
    var err = body.querySelector('#f-date-err');
    var cont = foot.querySelector('[data-next="n3"]');
    if (cont) cont.disabled = !validNoticeDate(S.noticeDate);
    if (err) { err.textContent = problem || ''; err.hidden = !problem; }
    if (msg) {
      if (S.noticeDate) {
        var picked = parseIso(S.noticeDate);
        msg.innerHTML = 'Selected move-out date: <b>' + esc(fmtLong(picked)) + '</b><span>' +
          esc(fmtDay(picked)) + '</span>';
        msg.hidden = false;
      } else { msg.hidden = true; }
    }
  }

  backBtn.addEventListener('click', function () {
    if (trail.length) { alertText = ''; here = trail.pop(); render(); }
  });

  // ── photo capture ─────────────────────────────────────────────────────────
  var picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.style.display = 'none';
  document.body.appendChild(picker);
  var targetSlot = 0;
  /* Retaking a slot while its first upload is still in flight used to let the
     older response land second and write a stale photoId — which the server
     then rejected as a missing required slot, with no clue why. Every attempt
     takes a ticket; only the newest ticket for a slot may write. */
  var slotSeq = { INSIDE: 0, FLOOR: 0, DOOR: 0, EXTRA: 0 };

  function pickFile(index) {
    if (index === -1 && S.photos.filter(function (p) { return p && p.photoId; }).length + S.extras.length >= MAX_PHOTOS) return;
    targetSlot = index;
    picker.value = '';
    picker.click();
  }

  picker.addEventListener('change', function () {
    var file = picker.files && picker.files[0];
    if (!file) return;
    var index = targetSlot;
    var slotKey = index >= 0 ? SLOTS[index].key : 'EXTRA';
    var ticket = ++slotSeq[slotKey];
    var current = function () { return slotSeq[slotKey] === ticket; };

    if (index >= 0) {
      S.photos[index] = { slot: slotKey, state: 'uploading', progress: 0, photoId: null, thumb: '' };
      render(true);
    }

    prepareImage(file)
      .then(function (prepared) {
        if (!current()) return null;
        if (index >= 0 && S.photos[index]) {
          S.photos[index].thumb = prepared.thumb;
          render(true);
        }
        return uploadPhoto(prepared, slotKey, function (fraction) {
          if (!current()) return;
          if (index >= 0 && S.photos[index]) {
            S.photos[index].progress = fraction;
            var fill = body.querySelectorAll('.mo-slot')[index];
            var inner = fill && fill.querySelector('.mo-mini-bar i');
            if (inner) inner.style.width = Math.round(fraction * 100) + '%';
          }
        }).then(function (result) { return { result: result, prepared: prepared }; });
      })
      .then(function (out) {
        // A superseded attempt stops here: its photoId is already stale.
        if (!out || !current()) return;
        var entry = { slot: slotKey, state: 'done', photoId: out.result.photoId, thumb: out.prepared.thumb, progress: 1 };
        if (index >= 0) S.photos[index] = entry;
        else S.extras.push(entry);
        saveSession();
        render(true);
      })
      .catch(function (err) {
        if (!current()) return;   // a newer attempt owns this slot now
        var message = (err && err.message) || 'That photo did not upload. Please try again.';
        if (index >= 0) {
          S.photos[index] = { slot: slotKey, state: 'failed', error: message, photoId: null, thumb: '' };
          render(true);
        } else {
          showAlert(message);
        }
      });
  });

  // ── submissions ───────────────────────────────────────────────────────────
  /* Minted when a flow starts and kept until it succeeds, so a retry — by the
     customer, or after a reload — reuses it and the server de-duplicates. */
  function ensureKey() {
    if (!S.idempotencyKey) { S.idempotencyKey = randomToken(); saveSession(); }
    return S.idempotencyKey;
  }

  function submitScheduled(button) {
    if (S.submitting) return;
    if (!S.name.trim() || !validPhone(S.phone) || !validNoticeDate(S.noticeDate)) {
      showAlert('Please check your name, phone number and date.');
      return;
    }
    S.submitting = true;
    button.disabled = true;
    button.textContent = 'Sending…';

    postJson('/api/move-outs/scheduled', {
      name: S.name.trim(),
      phone: digits(S.phone),
      plannedMoveOutDate: S.noticeDate,
      idempotencyKey: ensureKey()
    }).then(function (res) {
      S.submitting = false;
      if (res.status >= 200 && res.status < 300 && res.body && res.body.ok) {
        S.result = res.body;
        clearSession();
        go('n4');
        return;
      }
      showAlert(firstError(res.body, 'We could not save your notice just then. Please try again, or ' + PHONE_HELP + '.'));
      render();
    }).catch(function () {
      S.submitting = false;
      showAlert("We couldn't reach us just then. Check your signal and try again, or " + PHONE_HELP + '.');
    });
  }

  function submitCompleted(button) {
    if (S.submitting) return;
    var ids = [];
    for (var i = 0; i < S.photos.length; i++) {
      if (!S.photos[i] || !S.photos[i].photoId) {
        showAlert('Please add all three required photos before submitting.');
        return;
      }
      ids.push(S.photos[i].photoId);
    }
    S.extras.forEach(function (p) { if (p.photoId) ids.push(p.photoId); });

    if (!(S.confs[0] && S.confs[1] && S.confs[2])) {
      showAlert('Please confirm all three statements about your unit.');
      return;
    }
    if (!S.unit.trim()) { showAlert('Please enter your unit number.'); return; }
    if (!validPhone(S.phone)) { showAlert('Please enter a 10-digit phone number we can text.'); return; }

    S.submitting = true;
    button.disabled = true;
    button.textContent = 'Submitting…';

    postJson('/api/move-outs/completed', {
      unitNumber: S.unit.trim(),
      phone: digits(S.phone),
      confirmations: { empty: S.confs[0], swept: S.confs[1], lockRemoved: S.confs[2] },
      photoIds: ids,
      uploadToken: S.uploadToken,
      idempotencyKey: ensureKey()
    }).then(function (res) {
      S.submitting = false;
      // Only ever show success once the server says it saved the submission.
      if (res.status >= 200 && res.status < 300 && res.body && res.body.ok) {
        S.result = res.body;
        clearSession();
        go('o4');
        return;
      }
      showAlert(firstError(res.body, 'We could not save your move-out just then. Please try again, or ' + PHONE_HELP + '.'));
      render();
    }).catch(function () {
      S.submitting = false;
      showAlert("We couldn't reach us just then. Your photos are saved — check your signal and tap Confirm again, or " + PHONE_HELP + '.');
    });
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  // Photos uploaded before a reload are still on the server; restore their state.
  S.photos = S.photos.map(function (p) {
    return p && p.photoId ? { slot: p.slot, state: 'done', photoId: p.photoId, thumb: p.thumb || '', progress: 1 } : null;
  });
  S.extras = (S.extras || []).filter(function (p) { return p && p.photoId; })
    .map(function (p) { return { slot: p.slot, state: 'done', photoId: p.photoId, thumb: p.thumb || '' }; });

  card.hidden = false;
  render();
})();
