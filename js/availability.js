/**
 * Pleasant Lake Storage — Live Pricing & Availability
 * Calls the StorEdge API directly (CORS-open) — no cached JSON file needed.
 * Updates each row of the Units & Prices table:
 *   • monthly rate (.price cell)
 *   • Available / Waitlist tag
 *   • the action button (Rent Now → StorEdge, or Get Notified → contact-us)
 *
 * Rows are matched by a data-pl="KEY" attribute on each <tr>.
 * Fails quietly: if the API is unreachable, hand-entered fallback values stay.
 */
(function () {
  var API_URL  = 'https://rental-center.storedge.com/v1/facilities/159d76bf-6636-4e86-87fe-82fc497dc971/unit-groups';
  var FACILITY_ID = '159d76bf-6636-4e86-87fe-82fc497dc971';
  var RENT_URL = 'https://rental-center.storedge.com/?companyId=ef2375f3-b212-4670-bbc0-be544f6614b6&facilityId=159d76bf-6636-4e86-87fe-82fc497dc971#/move-in';

  // "10x11x8" or "12x40" → canonical "WxL" key matching data-pl attributes
  function normaliseKey(sizeStr) {
    var parts = String(sizeStr).toLowerCase().split('x').map(Number).filter(function(n){ return !isNaN(n) && n > 0; });
    if (parts.length < 2) return null;
    parts.sort(function(a, b) { return b - a; }); // descending
    var top2 = parts.slice(0, 2).sort(function(a, b) { return a - b; }); // ascending
    return top2.join('x');
  }

  fetch(API_URL)
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { if (data) apply(data); })
    .catch(function() { /* leave hand-entered fallback values in place */ });

  /* Step 3 of the rental flow with this size already in the cart. Without the
     group id we can only open the generic unit picker, which is where this
     link used to land for every size. */
  function rentUrlFor(groupId) {
    return groupId ? RENT_URL + '/' + FACILITY_ID + '/' + groupId : RENT_URL;
  }

  function apply(data) {
    // Build a map: "10x11" → { price, available }
    var units = {};
    Object.values(data).forEach(function(group) {
      var key = normaliseKey(group.size);
      if (!key) return;
      units[key] = {
        price:     '$' + group.price,
        available: group.available_units_count > 0,
        groupId:   group.id
      };
    });

    document.querySelectorAll('tr[data-pl]').forEach(function(row) {
      var u = units[row.getAttribute('data-pl')];
      if (!u) return;

      // Monthly rate
      var priceCell = row.querySelector('.price');
      if (priceCell) priceCell.textContent = u.price;

      // Status tag
      var statusCell = row.querySelector('td[data-label="Status"]');
      if (statusCell) {
        statusCell.innerHTML = u.available
          ? '<span class="tag tag-avail">Available</span>'
          : '<span class="tag tag-wait">Waitlist</span>';
      }

      // Action button
      var actionCell = row.querySelector('td[data-label="Action"]');
      if (actionCell) {
        actionCell.innerHTML = u.available
          ? '<a class="btn btn-rent" href="' + rentUrlFor(u.groupId) + '">Rent Now</a>'
          : '<a class="btn btn-wait" href="contact-us.html">Get Notified</a>';
      }

      // The unit-size label is a link too. It used to point at the generic
      // picker on some rows, which meant a hidden second route that skipped
      // the unit the customer had just chosen. Keep it in step with the button.
      var labelLink = row.querySelector('td[data-label="Unit Size"] a');
      if (labelLink) {
        labelLink.setAttribute('href', u.available ? rentUrlFor(u.groupId) : 'contact-us.html');
      }

      // Row class for styling
      row.className = u.available ? 'row-avail' : 'row-wait';
    });
  }
})();
