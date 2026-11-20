/**
 * Pleasant Lake Storage — homepage unit selector.
 *
 * The homepage IS the first step of the rental: the customer picks a size here
 * and lands in storEDGE with that exact unit group already in the cart, instead
 * of choosing a unit twice.
 *
 * storEDGE is the only source of truth. Price, availability and the unit-group
 * id all come from the same live call; nothing about inventory is hard-coded.
 * The markup shipped in index.html is a static fallback rendered from the same
 * API, so a visitor without JavaScript — or one whose fetch fails — still sees
 * correct sizes, prices, availability and working links.
 *
 * Fails open, never closed: if the API is unreachable the static cards stay put.
 */
(function () {
  'use strict';

  var COMPANY_ID  = 'ef2375f3-b212-4670-bbc0-be544f6614b6';
  var FACILITY_ID = '159d76bf-6636-4e86-87fe-82fc497dc971';
  var BASE  = 'https://rental-center.storedge.com/';
  var API   = BASE + 'v1/facilities/' + FACILITY_ID + '/unit-groups';

  /* Attribution convention is shared with longlaketoysheds.com. The UTMs sit in
     the query string, BEFORE the '#': storEDGE routes on the hash, and a hash
     is never sent to the server, so anything after it is invisible upstream. */
  function rentUrl(groupId, sizeLabel) {
    var utm = 'utm_source=website&utm_medium=referral' +
              '&utm_campaign=pleasantlakestorage' +
              '&utm_content=' + encodeURIComponent(sizeLabel || 'unit');
    var q = '?companyId=' + COMPANY_ID + '&facilityId=' + FACILITY_ID + '&' + utm;
    return BASE + q + '#/move-in/' + FACILITY_ID + (groupId ? '/' + groupId : '');
  }

  /* What each size holds. Copy lifted verbatim from the Units & Prices table so
     the two pages never disagree; sizes absent here simply show no fit line. */
  var FITS = {
    '12x40': 'Boats, pontoons, RVs, campers, trailers',
    '8x11':  'Boxes, seasonal gear, small furniture',
    '10x11': '1-bedroom home, ATV, snowmobile',
    '11x16': 'Small boat, side-by-side, 2-bedroom home',
    '11x18': 'Fishing boat & trailer, household',
    '10x20': 'Boat & trailer, car, 3-bedroom home',
    '10x22': 'Longer boats, vehicles, ice house',
    '11x20': 'Boat & trailer, vehicles, ice house',
    '10x24': 'Pontoons, larger boats, full household',
    '11x24': 'Pontoons, campers, large loads',
    '11x26': 'Large pontoons, campers',
    '11x28': 'Largest boats, campers & RVs'
  };
  var SQFT = {
    '12x40': 480, '8x11': 88, '10x11': 110, '11x16': 176, '11x18': 198, '10x20': 200,
    '10x22': 220, '11x20': 220, '10x24': 240, '11x24': 264, '11x26': 286, '11x28': 308
  };
  var SITE_KEYS = ['12x40','8x11','10x11','11x16','11x18','10x20','10x22','11x20','10x24','11x24','11x26','11x28'];
  var OUTDOOR = { '12x40': true };

  function normaliseKey(size) {
    var n = String(size || '').match(/\d+/g);
    if (!n || n.length < 2) return null;
    n = n.map(Number).sort(function (a, b) { return b - a; }).slice(0, 2).sort(function (a, b) { return a - b; });
    var k = n.join('x');
    return SITE_KEYS.indexOf(k) > -1 ? k : null;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pretty(key) { return key.replace('x', ' × '); }

  // ── analytics ─────────────────────────────────────────────────────────────
  // GTM is already on the page; push to the existing dataLayer rather than
  // installing a second analytics path.
  window.dataLayer = window.dataLayer || [];
  function track(event, payload) {
    try { window.dataLayer.push(Object.assign({ event: event }, payload || {})); } catch (e) {}
  }

  // ── render ────────────────────────────────────────────────────────────────
  function card(u) {
    var kind = OUTDOOR[u.key] ? 'Outdoor Boat &amp; RV Parking' : 'Indoor Storage';
    var cta  = OUTDOOR[u.key] ? 'Reserve This Space' : 'Rent This Unit';
    return '' +
      '<article class="ucard" data-key="' + u.key + '" data-group="' + esc(u.groupId || '') + '">' +
        '<div class="ucard-top">' +
          '<div>' +
            '<p class="ucard-kind">' + kind + '</p>' +
            '<h3 class="ucard-size">' + pretty(u.key) + '</h3>' +
            (SQFT[u.key] ? '<p class="ucard-sqft">' + SQFT[u.key] + ' sq ft</p>' : '') +
          '</div>' +
          '<span class="ucard-pill"><i></i>Available Now</span>' +
        '</div>' +
        '<p class="ucard-price"><b>$' + u.price + '</b><span>/month</span></p>' +
        (FITS[u.key] ? '<p class="ucard-fits">' + esc(FITS[u.key]) + '</p>' : '') +
        '<a class="ucard-cta" href="' + esc(rentUrl(u.groupId, u.key)) + '">' + cta + '</a>' +
        '<p class="ucard-note" hidden></p>' +
      '</article>';
  }

  function waitRow(u) {
    return '' +
      '<li class="wrow" data-key="' + u.key + '">' +
        '<span class="wrow-size">' + pretty(u.key) + '</span>' +
        '<span class="wrow-price">$' + u.price + '/mo</span>' +
        '<span class="wrow-tag">Waitlist</span>' +
        '<a class="wrow-cta" href="contact-us.html?size=' + encodeURIComponent(u.key) + '">Get Notified</a>' +
      '</li>';
  }

  function render(list) {
    var grid = document.getElementById('availGrid');
    var wait = document.getElementById('waitList');
    var waitWrap = document.getElementById('waitWrap');
    var emptyMsg = document.getElementById('availEmpty');
    if (!grid || !wait) return;

    var avail = list.filter(function (u) { return u.available; }).sort(function (a, b) { return a.price - b.price; });
    var full  = list.filter(function (u) { return !u.available; }).sort(function (a, b) { return a.price - b.price; });

    grid.innerHTML = avail.map(card).join('');
    wait.innerHTML = full.map(waitRow).join('');
    if (waitWrap) waitWrap.hidden = full.length === 0;
    if (emptyMsg) emptyMsg.hidden = avail.length > 0;

    var count = document.getElementById('availCount');
    if (count) {
      count.textContent = avail.length === 1
        ? '1 size available right now'
        : avail.length + ' sizes available right now';
    }
  }


  // ── live load ─────────────────────────────────────────────────────────────
  var known = {};   // key -> { groupId, price } from the last good response

  function load() {
    return fetch(API, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return null;
        var list = [];
        Object.keys(data).forEach(function (id) {
          var g = data[id];
          if (!g || !g.size) return;
          var key = normaliseKey(g.size);
          if (!key) return;
          var price = Math.round(Number(g.price));
          if (!isFinite(price) || price <= 0) return;
          var u = { key: key, price: price, available: Number(g.available_units_count) > 0, groupId: g.id };
          known[key] = { groupId: g.id, price: price };
          list.push(u);
        });
        if (list.length) render(list);
        return list;
      })
      .catch(function () { return null; });   // static fallback stays on screen
  }

  // ── re-check on click ─────────────────────────────────────────────────────
  // A size can sell out between page load and click. Confirm before sending the
  // customer into checkout — but never block a legitimate renter: if the check
  // itself fails we proceed on the last known-good deep link.
  function wireClicks() {
    document.addEventListener('click', function (e) {
      var cta = e.target.closest && e.target.closest('.ucard-cta');
      if (cta) return onRentClick(e, cta);
      var w = e.target.closest && e.target.closest('.wrow-cta');
      if (w) {
        track('waitlist_click', { unit_size: w.closest('.wrow').getAttribute('data-key') });
        return;
      }
      var tel = e.target.closest && e.target.closest('a[href^="tel:"]');
      if (tel) track('phone_click', { location: tel.getAttribute('data-where') || 'page' });
    });
  }

  function onRentClick(e, cta) {
    var art = cta.closest('.ucard');
    var key = art.getAttribute('data-key');
    var groupId = art.getAttribute('data-group') || (known[key] && known[key].groupId) || '';
    var price = known[key] ? known[key].price : null;

    track('rent_unit_click', {
      unit_size: key,
      unit_price: price,
      unit_group_id: groupId || null,
      unit_type: OUTDOOR[key] ? 'outdoor' : 'indoor'
    });

    if (!groupId) { track('storedge_outbound', { unit_size: key, link_type: 'generic' }); return; }

    // Navigate IMMEDIATELY. A storage customer who taps "Rent This Unit"
    // must leave for the checkout on that tap -- no spinner, no gate. The
    // earlier build re-checked availability before navigating, which left a
    // dead-looking "Checking..." button on screen for ~2s (longer on rural
    // LTE) and read as broken.
    //
    // Availability stays honest through watchFreshness() below, which
    // re-reads the live list in the background, so a sold-out card has
    // normally already moved to the waitlist before anyone can click it.
    track('storedge_outbound', { unit_size: key, unit_group_id: groupId, link_type: 'deep', check: 'background' });
    // Let the browser follow the href itself -- no preventDefault, so a
    // middle-click or cmd-click still opens a new tab as the visitor expects.
  }

  // ── background refresh ──────────────────────────────────────────
  // Availability is kept current here instead of at click time, so the card
  // a visitor sees is already right and the tap itself is instant.
  function watchFreshness() {
    var REFRESH_MS = 60000;
    var last = Date.now();
    function maybe(force) {
      if (document.hidden) return;
      if (!force && Date.now() - last < REFRESH_MS) return;
      last = Date.now();
      load();
    }
    setInterval(function () { maybe(false); }, REFRESH_MS);
    // Coming back to the tab after a while is exactly when the page is stalest.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - last > 15000) maybe(true);
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) maybe(true); });
  }

  // ── section-view event ────────────────────────────────────────────────────
  function watchSection() {
    // Watch the card grid, not the whole section: the section is taller than a
    // phone screen, so a fractional threshold on it can never be satisfied.
    var target = document.getElementById('availGrid') || document.getElementById('available');
    if (!target || !('IntersectionObserver' in window)) return;
    var fired = false;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && !fired) {
          fired = true;
          track('view_available_units', {});
          io.disconnect();          // once per page view, never repeated
        }
      });
    }, { threshold: 0 });
    io.observe(target);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }

  function start() {
    // Seed from the static markup so a click works before the API answers.
    document.querySelectorAll('.ucard').forEach(function (a) {
      var k = a.getAttribute('data-key'), g = a.getAttribute('data-group');
      if (k && g) known[k] = { groupId: g, price: Number(String((a.querySelector('.ucard-price b') || {}).textContent || '').replace(/\D/g, '')) || null };
    });
    wireClicks();
    watchSection();
    load();
    watchFreshness();
  }
})();
