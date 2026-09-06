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
  var MAX_PHOTOS = 6;
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
  function endOfThisMonth() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth() + 1, 0); }

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
    noticeDate: (restored && restored.noticeDate) || '',
    noticeMode: (restored && restored.noticeMode) || '',
    unit: (restored && restored.unit) || '',
    photos: (restored && restored.photos) || [null, null, null],
    extras: (restored && restored.extras) || [],
    confs: [false, false, false],
    idempotencyKey: '',
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

  function loadBitmap(file) {
    // createImageBitmap with imageOrientation applies EXIF for us where supported.
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .then(function (bmp) { return { source: bmp, orientation: 1 }; })
        .catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file) {
    return file.arrayBuffer().then(function (buf) {
      var orientation = exifOrientation(buf);
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve({ source: img, orientation: orientation }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
        img.src = url;
      });
    });
  }

  /** Resize + compress to a JPEG small enough to email/store, right way up. */
  function prepareImage(file) {
    return loadBitmap(file).then(function (loaded) {
      var src = loaded.source;
      var sw = src.width, sh = src.height;
      var swap = loaded.orientation >= 5 && loaded.orientation <= 8;
      var dw = swap ? sh : sw, dh = swap ? sw : sh;

      var scale = Math.min(1, MAX_EDGE / Math.max(dw, dh));
      var outW = Math.max(1, Math.round(dw * scale));
      var outH = Math.max(1, Math.round(dh * scale));

      var canvas = document.createElement('canvas');
      canvas.width = outW; canvas.height = outH;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.save();
      applyOrientation(ctx, loaded.orientation, outW, outH);
      var drawW = swap ? outH : outW;
      var drawH = swap ? outW : outH;
      ctx.drawImage(src, 0, 0, drawW, drawH);
      ctx.restore();
      if (src.close) src.close();

      var thumb = '';
      try {
        var tc = document.createElement('canvas');
        var tScale = Math.min(1, 160 / Math.max(outW, outH));
        tc.width = Math.max(1, Math.round(outW * tScale));
        tc.height = Math.max(1, Math.round(outH * tScale));
        tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);
        thumb = tc.toDataURL('image/jpeg', 0.6);
      } catch (e) { thumb = ''; }

      return new Promise(function (resolve, reject) {
        function attempt(quality) {
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error('encode')); return; }
            if (blob.size / 1024 <= TARGET_KB || quality <= 0.42) {
              resolve({ blob: blob, width: outW, height: outH, thumb: thumb });
            } else {
              attempt(Math.round((quality - 0.08) * 100) / 100);
            }
          }, 'image/jpeg', quality);
        }
        attempt(0.82);
      });
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
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, body: body };
      });
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
          '<div class="mo-stack" style="gap:12px">' +
            '<button type="button" class="mo-tile" data-go="n1"><span class="ic">📅</span><span>' +
              '<b>Schedule My Move-Out</b><small>I’m leaving soon — here’s my date</small></span></button>' +
            '<button type="button" class="mo-tile" data-go="o1"><span class="ic">📸</span><span>' +
              '<b>I’ve Already Moved Out</b><small>It’s empty — send photos and close it</small></span></button>' +
          '</div>',
        foot: '<p class="why">Questions? Call or text <a href="' + FACILITY_TEL + '" style="color:var(--green-main);font-weight:700;">' + FACILITY_PHONE + '</a></p>'
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
              'placeholder="Scott Swenson" autocomplete="name" autocapitalize="words" enterkeyhint="next"></div>' +
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
      var custom = !!S.noticeDate && !isEom;
      var d = S.noticeDate ? parseIso(S.noticeDate) : null;
      var eomIsToday = iso(eom) === iso(new Date());
      return {
        label: 'Notice · 2 of 3', step: 2, of: 3,
        body:
          '<h2 class="mo-h">When are you planning to move out?</h2>' +
          '<p class="mo-sub">Pick any date that works for you.</p>' +
          '<button type="button" class="mo-tile' + (isEom ? ' on' : '') + '" data-eom="1">' +
            '<span class="ic">🗓️</span><span><b>End of this month</b><small>' +
            esc(fmtLong(eom)) + ' · ' + (eomIsToday ? 'Today' : esc(fmtDay(eom))) + '</small></span>' +
            '<span class="chk">' + (isEom ? '✓' : '') + '</span></button>' +
          '<div class="mo-or"><span>or</span></div>' +
          '<div class="mo-date' + (custom ? ' set' : '') + '">' +
            '<div class="face"><span class="cal">📅</span><span class="txt">' +
              (custom ? esc(fmtLong(d)) + '<small>' + esc(fmtDay(d)) + '</small>' : 'Select a different date') +
            '</span><span class="caret">' + (custom ? 'Change' : '▾') + '</span></div>' +
            '<input type="date" data-bind="noticeDate" value="' + (custom ? esc(S.noticeDate) : '') + '" ' +
              'min="' + iso(new Date()) + '" aria-label="Planned move-out date"></div>',
        foot: '<button type="button" class="mo-btn" data-next="n3"' + (S.noticeDate ? '' : ' disabled') + '>Continue →</button>'
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
            row('Planned move-out', fmtLong(parseIso(S.noticeDate))) +
          '</div>' +
          '<div class="mo-remind">When you are completely moved out, <strong>return here</strong> to send us your final move-out photos.</div>',
        foot: '<button type="button" class="mo-btn" data-submit="scheduled"' + (S.submitting ? ' disabled' : '') + '>' +
          (S.submitting ? 'Sending…' : 'Submit My Move-Out Notice') + '</button>'
      };
    },

    n4: function () {
      var r = S.result || {};
      var d = r.plannedMoveOutDate ? parseIso(r.plannedMoveOutDate) : parseIso(S.noticeDate);
      return {
        step: 3, of: 3, center: true, noBack: true,
        body:
          '<div class="mo-mark">✓</div>' +
          '<h2 class="mo-done-h">Move-out notice received</h2>' +
          '<div class="mo-stamp">Planned move-out<br>' + esc(fmtLong(d)) + '</div>' +
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
          (total < MAX_PHOTOS ? '<p class="mo-optional">You can add up to ' + (MAX_PHOTOS - total) + ' more if you’d like.</p>' : '');
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
            esc(fmtLong(new Date())) + '</b></p>',
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
          '<p class="mo-done-p">Your move-out date is <b>' + esc(r.completedAtLabel || fmtLong(new Date())) + '</b>. ' +
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
    body.className = 'mo-body' + (sc.center ? ' center' : '');
    body.innerHTML = (alertText ? '<div class="mo-alert" role="alert">' + alertText + '</div>' : '') + sc.body;
    foot.innerHTML = sc.foot || '';
    if (previous !== null) window.scrollTo(0, previous);
    stepLabel.textContent = sc.label || '';
    bar.style.width = sc.of ? (sc.step / sc.of * 100) + '%' : '0%';
    backBtn.hidden = here === 'home' || !!sc.noBack;
  }

  function go(id) {
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
      if (S.noticeMode === 'eom') { S.noticeMode = ''; S.noticeDate = ''; }
      else { S.noticeMode = 'eom'; S.noticeDate = iso(endOfThisMonth()); }
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
    if (key === 'noticeDate') { S.noticeMode = input.value ? 'custom' : ''; saveSession(); render(); return; }
    saveSession();
    var button = foot.querySelector('[data-next]');
    if (button && (here === 'n1' || here === 'o1')) {
      button.disabled = here === 'n1'
        ? !(S.name.trim().length > 1 && validPhone(S.phone))
        : !(S.unit.trim().length > 0 && validPhone(S.phone));
    }
  });

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

    if (index >= 0) {
      S.photos[index] = { slot: slotKey, state: 'uploading', progress: 0, photoId: null, thumb: '' };
      render(true);
    }

    prepareImage(file)
      .then(function (prepared) {
        if (index >= 0) {
          S.photos[index].thumb = prepared.thumb;
          render(true);
        }
        return uploadPhoto(prepared, slotKey, function (fraction) {
          if (index >= 0 && S.photos[index]) {
            S.photos[index].progress = fraction;
            var fill = body.querySelectorAll('.mo-slot')[index];
            var inner = fill && fill.querySelector('.mo-mini-bar i');
            if (inner) inner.style.width = Math.round(fraction * 100) + '%';
          }
        }).then(function (result) { return { result: result, prepared: prepared }; });
      })
      .then(function (out) {
        var entry = { slot: slotKey, state: 'done', photoId: out.result.photoId, thumb: out.prepared.thumb, progress: 1 };
        if (index >= 0) S.photos[index] = entry;
        else S.extras.push(entry);
        saveSession();
        render(true);
      })
      .catch(function (err) {
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
  function ensureKey() {
    if (!S.idempotencyKey) S.idempotencyKey = randomToken();
    return S.idempotencyKey;
  }

  function submitScheduled(button) {
    if (S.submitting) return;
    if (!S.name.trim() || !validPhone(S.phone) || !S.noticeDate) {
      showAlert('Please check your name, phone number and date.');
      return;
    }
    S.submitting = true;
    button.disabled = true;
    button.textContent = 'Sending…';

    postJson('/api/move-outs/scheduled', {
      name: S.name.trim(),
      phone: maskTel(S.phone),
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
      phone: maskTel(S.phone),
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
