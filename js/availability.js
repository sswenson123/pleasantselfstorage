/**
 * Pleasant Lake Storage — Live Pricing & Availability
 * Reads data/availability.json and updates each row of the Units & Prices table:
 *   • monthly rate (.price cell)
 *   • Available / Waitlist tag
 *   • the action button (Rent Now → StorEdge, or Get Notified → contact-us)
 *
 * Rows are matched by a data-pl="KEY" attribute on each <tr>.
 * Fails quietly: if the JSON or a unit is missing, the hand-entered row stays.
 */
(function () {
  var JSON_PATH = 'data/availability.json';
  var RENT_URL = 'https://rental-center.storedge.com/?companyId=ef2375f3-b212-4670-bbc0-be544f6614b6&facilityId=159d76bf-6636-4e86-87fe-82fc497dc971#/move-in';

  fetch(JSON_PATH, { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) { if (data) apply(data); })
    .catch(function () { /* leave hand-entered values in place */ });

  function apply(data) {
    var units = data.units || {};

    document.querySelectorAll('tr[data-pl]').forEach(function (row) {
      var u = units[row.getAttribute('data-pl')];
      if (!u) return;

      // Monthly rate
      var priceCell = row.querySelector('.price');
      if (priceCell && u.price) priceCell.textContent = u.price;

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
          ? '<a class="btn btn-rent" href="' + RENT_URL + '">Rent Now</a>'
          : '<a class="btn btn-wait" href="contact-us.html">Get Notified</a>';
      }

      // Keep the row class in sync (used for styling)
      row.className = u.available ? 'row-avail' : 'row-wait';
    });

    // Optional "updated" stamp if the page has #price-updated
    var ts = document.getElementById('price-updated');
    if (ts && data.lastUpdated) {
      var d = new Date(data.lastUpdated);
      if (!isNaN(d)) {
        ts.textContent = 'Prices updated ' +
          d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
  }
})();
