// CampusFit "Find a Trainer" map.
// Trainers come from a published Google Sheet (CSV). Gyms come from OpenStreetMap (Overpass API).
(function () {
  'use strict';

  // ---- Settings --------------------------------------------------------------------------
  // Paste the "Publish to web" CSV link of the approved-trainers sheet tab here.
  var TRAINERS_CSV_URL = '';
  // Where the "Get listed" button sends trainers (the sign-up Google Form, once it exists).
  var SIGNUP_URL = 'mailto:infocampusfit@gmail.com?subject=Trainer%20listing%20on%20CampusFit';
  var CANADA = { center: [56.1, -96.3], zoom: 4 };
  var GYM_MIN_ZOOM = 11;      // gyms load only when this zoomed in (keeps Overpass queries small)
  var GYM_LIMIT = 150;
  // Public Overpass servers. The first is asked straight away; if it hasn't answered after a few
  // seconds the next one is asked too, and whichever answers first wins.
  var OVERPASS_URLS = [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  var OVERPASS_HEDGE_MS = 7000;    // wait this long before also asking the next server
  var OVERPASS_MAX_MS = 40000;     // give up on any single server after this long
  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

  // ---- Helpers ---------------------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return 'https://' + u;
    return '';
  }
  function km(a, b) {
    var R = 6371, toR = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtKm(d) { return d < 1 ? Math.round(d * 1000) + ' m' : (d < 10 ? d.toFixed(1) : Math.round(d)) + ' km'; }
  function setStatus(msg) { $('finder-status').textContent = msg; }

  // Minimal RFC 4180 CSV parser (handles quotes, commas and newlines inside quotes).
  function parseCSV(text) {
    var rows = [], row = [], field = '', i = 0, q = false;
    text = text.replace(/^\uFEFF/, '');
    for (; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
  }

  // Map spreadsheet headers (Google Form question titles) to fields by keyword.
  // Order matters: the first matching rule claims a column (e.g. "Email address" is email, not address).
  var FIELDS = [
    ['approved', /approv/], ['lat', /^lat/], ['lng', /^(lon|lng)/], ['email', /e-?mail/], ['phone', /phone/],
    ['instagram', /instagram/], ['photo', /photo|image/], ['website', /website|url/], ['address', /address|location/],
    ['services', /service/], ['rates', /rate|price/], ['online', /online|virtual/], ['bio', /bio|about/],
    ['business', /business|gym|studio/], ['name', /name/]
  ];
  function rowsToTrainers(rows) {
    if (!rows.length) return [];
    var map = {};
    rows[0].forEach(function (h, idx) {
      var key = h.toLowerCase().trim();
      for (var f = 0; f < FIELDS.length; f++) {
        if (FIELDS[f][1].test(key) && map[FIELDS[f][0]] === undefined) { map[FIELDS[f][0]] = idx; break; }
      }
    });
    return rows.slice(1).map(function (r) {
      var t = {};
      Object.keys(map).forEach(function (k) { t[k] = (r[map[k]] || '').trim(); });
      return t;
    }).filter(function (t) {
      if (!t.name) return false;
      if (map.approved !== undefined && !/^(y|yes|true|x|approved|1)$/i.test(t.approved || '')) return false;
      t.lat = parseFloat(t.lat); t.lng = parseFloat(t.lng);
      return true;
    });
  }

  // Geocode a trainer address only if the sheet has no coordinates (cached per browser).
  var geoQueue = Promise.resolve();
  function geocode(q) {
    var key = 'cf-geo:' + q.toLowerCase();
    try { var hit = localStorage.getItem(key); if (hit) return Promise.resolve(JSON.parse(hit)); } catch (e) {}
    geoQueue = geoQueue.then(function () { return new Promise(function (r) { setTimeout(r, 1100); }); }).then(function () {
      return fetch(NOMINATIM_URL + '?format=jsonv2&limit=1&countrycodes=ca&q=' + encodeURIComponent(q))
        .then(function (res) { return res.json(); })
        .then(function (j) {
          var p = j && j[0] ? [parseFloat(j[0].lat), parseFloat(j[0].lon)] : null;
          try { if (p) localStorage.setItem(key, JSON.stringify(p)); } catch (e) {}
          return p;
        }).catch(function () { return null; });
    });
    return geoQueue;
  }

  // ---- Map -------------------------------------------------------------------------------
  var map = L.map('finder-map', { scrollWheelZoom: true, zoomControl: true }).setView(CANADA.center, window.innerWidth < 600 ? 3 : CANADA.zoom);
  // Street-map style (OpenFreeMap "Liberty" vector tiles). Falls back to standard OSM tiles if WebGL isn't available.
  var baseLayer = null;
  try {
    if (L.maplibreGL && window.maplibregl && maplibregl.supported !== false) {
      baseLayer = L.maplibreGL({
        style: 'https://tiles.openfreemap.org/styles/liberty',
        attributionControl: { customAttribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }
      }).addTo(map);
    }
  } catch (e) { baseLayer = null; }
  if (!baseLayer) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  }

  var icon = function (cls) {
    return L.divIcon({ className: 'finder-pin ' + cls, html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -10] });
  };
  var trainerLayer = L.layerGroup().addTo(map);
  var gymLayer = L.layerGroup().addTo(map);
  var youMarker = null;
  var origin = null;           // [lat, lng] the list is sorted by
  var trainers = [];
  var gyms = [];
  var lastGymBounds = null;
  var areaName = '';           // city/town of the last searched place, used for Google search links

  // ---- Popups ----------------------------------------------------------------------------
  function contactLinks(t) {
    var out = [];
    if (t.phone) out.push('<a href="tel:' + esc(t.phone.replace(/[^\d+]/g, '')) + '">' + esc(t.phone) + '</a>');
    if (t.email) out.push('<a href="mailto:' + esc(t.email) + '">' + esc(t.email) + '</a>');
    var w = safeUrl(t.website);
    if (w) out.push('<a href="' + esc(w) + '" target="_blank" rel="noopener">Website</a>');
    if (t.instagram) {
      var ig = /^https?:/i.test(t.instagram) ? t.instagram : 'https://www.instagram.com/' + t.instagram.replace(/^@/, '') + '/';
      out.push('<a href="' + esc(safeUrl(ig)) + '" target="_blank" rel="noopener">Instagram</a>');
    }
    return out.join(' · ');
  }
  function services(t) {
    return (t.services || '').split(/[,;\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function trainerPopup(t) {
    var photo = safeUrl(t.photo);
    var chips = services(t).map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join('');
    var contact = contactLinks(t);
    return '<div class="pop">' +
      (photo ? '<img class="pop-photo" src="' + esc(photo) + '" alt="' + esc(t.name) + '">' : '') +
      '<p class="pop-kind pop-kind--trainer">CampusFit trainer</p>' +
      '<h3>' + esc(t.name) + '</h3>' +
      (t.business ? '<p class="pop-sub">' + esc(t.business) + '</p>' : '') +
      (t.address ? '<p>' + esc(t.address) + '</p>' : '') +
      (/^(y|yes|true)/i.test(t.online || '') ? '<p class="pop-note">Also trains online</p>' : '') +
      (chips ? '<div class="chips">' + chips + '</div>' : '') +
      (t.rates ? '<p><strong>Rates:</strong> ' + esc(t.rates) + '</p>' : '') +
      (t.bio ? '<p class="pop-bio">' + esc(t.bio) + '</p>' : '') +
      (contact ? '<p class="pop-contact">' + contact + '</p>' : '') +
      '</div>';
  }
  function googleSearch(g) {
    var where = g.address || areaName || (g.lat.toFixed(4) + ',' + g.lng.toFixed(4));
    var q = g.name + ' ' + where;
    return 'https://www.google.com/search?q=' + encodeURIComponent(q);
  }
  function gymPopup(g) {
    var w = safeUrl(g.website);
    return '<div class="pop">' +
      '<p class="pop-kind">Gym / fitness studio</p>' +
      '<h3>' + esc(g.name) + '</h3>' +
      (g.address ? '<p>' + esc(g.address) + '</p>' : '') +
      (g.hours ? '<p><strong>Hours:</strong> ' + esc(g.hours) + '</p>' : '') +
      '<p class="pop-contact">' + [
        g.phone ? '<a href="tel:' + esc(g.phone.replace(/[^\d+]/g, '')) + '">' + esc(g.phone) + '</a>' : '',
        w ? '<a href="' + esc(w) + '" target="_blank" rel="noopener">Website</a>' : '',
        '<a href="' + esc(googleSearch(g)) + '" target="_blank" rel="noopener">Search on Google</a>'
      ].filter(Boolean).join(' · ') + '</p>' +
      '<p class="pop-note">Listing from OpenStreetMap. Rates and trainer availability: contact the gym.</p>' +
      '</div>';
  }

  // ---- Rendering -------------------------------------------------------------------------
  function activeService() { return $('finder-service').value; }
  function visibleTrainers() {
    if (!$('show-trainers').checked) return [];
    var s = activeService();
    return trainers.filter(function (t) {
      return !isNaN(t.lat) && !isNaN(t.lng) && (!s || services(t).some(function (x) { return x.toLowerCase() === s; }));
    });
  }
  function render() {
    trainerLayer.clearLayers(); gymLayer.clearLayers();
    var items = [];
    visibleTrainers().forEach(function (t) {
      var m = L.marker([t.lat, t.lng], { icon: icon('finder-pin--trainer'), title: t.name, zIndexOffset: 1000 })
        .bindPopup(trainerPopup(t), { maxWidth: 300 }).addTo(trainerLayer);
      items.push({ kind: 'trainer', data: t, marker: m, pos: [t.lat, t.lng] });
    });
    if ($('show-gyms').checked) {
      gyms.forEach(function (g) {
        var m = L.marker([g.lat, g.lng], { icon: icon('finder-pin--gym'), title: g.name })
          .bindPopup(gymPopup(g), { maxWidth: 300 }).addTo(gymLayer);
        items.push({ kind: 'gym', data: g, marker: m, pos: [g.lat, g.lng] });
      });
    }
    var ref = origin || [map.getCenter().lat, map.getCenter().lng];
    items.forEach(function (it) { it.dist = km(ref, it.pos); });
    items.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'trainer' ? -1 : 1;
      return a.dist - b.dist;
    });
    var list = $('finder-list');
    list.innerHTML = '';
    if ($('show-trainers').checked && !trainers.length) {
      list.innerHTML = '<p class="finder-empty">No CampusFit trainers are listed yet. Gyms and studios appear when you search a location or zoom in on a city.</p>';
    }
    if (!items.length) {
      if (!list.innerHTML) list.innerHTML = '<p class="finder-empty">Nothing to show here yet. Search a location or zoom in on a city to see gyms and studios.</p>';
      return;
    }
    items.slice(0, 200).forEach(function (it, idx) {
      var d = it.data;
      var li = document.createElement('button');
      li.type = 'button';
      li.className = 'finder-item finder-item--' + it.kind;
      li.style.setProperty('--i', Math.min(idx, 12));   // staggered entrance, capped so long lists stay snappy
      var sub = it.kind === 'trainer'
        ? [d.business, services(d).slice(0, 3).join(', ')].filter(Boolean).join(' · ')
        : (d.address || 'Gym / fitness studio');
      li.innerHTML = '<span class="finder-item-top"><span class="finder-item-name">' + esc(d.name) + '</span>' +
        (origin ? '<span class="finder-item-dist">' + fmtKm(it.dist) + '</span>' : '') + '</span>' +
        '<span class="finder-item-kind">' + (it.kind === 'trainer' ? 'CampusFit trainer' : 'Gym / studio') + '</span>' +
        (sub ? '<span class="finder-item-sub">' + esc(sub) + '</span>' : '') +
        (it.kind === 'trainer' && d.rates ? '<span class="finder-item-rate">' + esc(d.rates) + '</span>' : '');
      li.addEventListener('click', function () {
        map.flyTo(it.pos, Math.max(map.getZoom(), 15), { duration: 0.6 });
        setTimeout(function () { it.marker.openPopup(); }, 650);
        if (window.innerWidth < 900) $('finder-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      list.appendChild(li);
    });
  }

  // ---- Data loading ----------------------------------------------------------------------
  function loadTrainers() {
    if (!TRAINERS_CSV_URL) { render(); return; }
    fetch(TRAINERS_CSV_URL, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (text) {
        trainers = rowsToTrainers(parseCSV(text));
        var all = {};
        trainers.forEach(function (t) { services(t).forEach(function (s) { all[s.toLowerCase()] = s; }); });
        var sel = $('finder-service');
        Object.keys(all).sort().forEach(function (k) {
          var o = document.createElement('option'); o.value = k; o.textContent = all[k]; sel.appendChild(o);
        });
        render();
        trainers.filter(function (t) { return (isNaN(t.lat) || isNaN(t.lng)) && t.address; }).forEach(function (t) {
          geocode(t.address).then(function (p) { if (p) { t.lat = p[0]; t.lng = p[1]; render(); } });
        });
      })
      .catch(function () { setStatus('Could not load the trainer list right now. Gyms still show when you search.'); });
  }

  var gymRequest = null;
  // Ask the Overpass servers with staggered starts; resolve with the first good answer.
  function overpass(q, ctrl) {
    return new Promise(function (resolve, reject) {
      var attempts = [], failed = 0, done = false, next = 0, hedge = null;
      function finish() { done = true; clearTimeout(hedge); attempts.forEach(function (a) { if (a) a.abort(); }); }
      function launch() {
        if (done || next >= OVERPASS_URLS.length) return;
        var i = next++;
        var a = window.AbortController ? new AbortController() : null;
        attempts.push(a);
        var timer = a ? setTimeout(function () { a.abort(); }, OVERPASS_MAX_MS) : null;
        fetch(OVERPASS_URLS[i], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: a && a.signal })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function (j) { clearTimeout(timer); if (done) return; finish(); resolve(j); })
          .catch(function (err) {
            clearTimeout(timer);
            if (done) return;
            failed++;
            if (next < OVERPASS_URLS.length) { clearTimeout(hedge); launch(); }      // try the next one now
            else if (failed >= OVERPASS_URLS.length) { finish(); reject(err); }
          });
        clearTimeout(hedge);
        hedge = setTimeout(launch, OVERPASS_HEDGE_MS);
      }
      if (ctrl) ctrl.signal.addEventListener('abort', function () { if (!done) { finish(); reject(new Error('aborted')); } });
      launch();
    });
  }
  function loadGyms() {
    if (map.getZoom() < GYM_MIN_ZOOM) {
      setStatus('Zoom in on a city to see gyms and fitness studios.');
      return;
    }
    var b = map.getBounds().pad(0.3);   // load a margin around the view so small pans don't refetch
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(function (n) { return n.toFixed(5); }).join(',');
    var q = '[out:json][timeout:25];(' +
      'nwr["leisure"="fitness_centre"](' + bbox + ');' +
      'nwr["leisure"="sports_centre"]["sport"~"fitness"](' + bbox + ');' +
      ');out center tags ' + GYM_LIMIT + ';';
    setStatus('Loading gyms in this area…');
    lastGymBounds = b;
    $('finder-area').hidden = true;
    if (gymRequest) gymRequest.abort();
    var ctrl = window.AbortController ? new AbortController() : null;
    gymRequest = ctrl;
    overpass(q, ctrl)
      .then(function (j) {
        gyms = (j.elements || []).map(function (e) {
          var t = e.tags || {};
          var lat = e.lat != null ? e.lat : (e.center && e.center.lat);
          var lng = e.lon != null ? e.lon : (e.center && e.center.lon);
          var street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
          return {
            name: t.name || t.brand || 'Unnamed gym', lat: lat, lng: lng,
            address: [street, t['addr:city']].filter(Boolean).join(', '),
            phone: t.phone || t['contact:phone'] || '', website: t.website || t['contact:website'] || '',
            hours: t.opening_hours || '', osmType: e.type, osmId: e.id
          };
        }).filter(function (g) { return g.lat != null && g.lng != null; });
        render();
        var n = gyms.length, tn = visibleTrainers().filter(function (t) { return b.contains([t.lat, t.lng]); }).length;
        setStatus(tn + ' CampusFit trainer' + (tn === 1 ? '' : 's') + ' and ' + n + (n >= GYM_LIMIT ? '+' : '') + ' gym' + (n === 1 ? '' : 's') + ' in this area.');
      })
      .catch(function () {
        if (ctrl && ctrl.signal.aborted) return;   // a newer search replaced this one
        lastGymBounds = null;
        $('finder-area').hidden = false;
        setStatus('Gym listings are busy right now. Tap "Search this area" to try again.');
      });
  }

  function goTo(lat, lng, label) {
    origin = [lat, lng];
    if (youMarker) youMarker.remove();
    youMarker = L.marker(origin, { icon: icon('finder-pin--you'), title: label, keyboard: false, zIndexOffset: 2000 })
      .bindPopup('<div class="pop"><p class="pop-kind">Your search</p><h3>' + esc(label) + '</h3></div>').addTo(map);
    map.flyTo(origin, 13, { duration: 0.8 });
  }

  // ---- Controls --------------------------------------------------------------------------
  $('finder-search').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('finder-q').value.trim();
    if (!q) return;
    setStatus('Searching for “' + q + '”…');
    fetch(NOMINATIM_URL + '?format=jsonv2&limit=1&countrycodes=ca&addressdetails=1&q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var a = j && j[0] && j[0].address || {};
        areaName = [a.city || a.town || a.village || a.municipality || '', a.state || ''].filter(Boolean).join(', ');
        if (!j || !j[0]) { setStatus('No match for “' + q + '” in Canada. Try a city, street address or postal code.'); return; }
        goTo(parseFloat(j[0].lat), parseFloat(j[0].lon), j[0].display_name.split(',').slice(0, 3).join(','));
      })
      .catch(function () { setStatus('Location search is unavailable right now. Try “Use my location” or drag the map.'); });
  });
  $('finder-locate').addEventListener('click', function () {
    if (!navigator.geolocation) { setStatus('Your browser can’t share its location. Type a city or postal code instead.'); return; }
    setStatus('Finding your location…');
    navigator.geolocation.getCurrentPosition(function (p) {
      areaName = '';
      goTo(p.coords.latitude, p.coords.longitude, 'Your location');
    }, function () { setStatus('Location access was blocked. Type a city or postal code instead.'); }, { timeout: 10000 });
  });
  $('finder-area').addEventListener('click', function () {
    var c = map.getCenter(); origin = [c.lat, c.lng]; loadGyms();
  });
  var moveTimer = null;
  map.on('moveend', function () {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(function () {
      if (map.getZoom() < GYM_MIN_ZOOM) {
        if (!gyms.length) setStatus('Zoom in on a city, or search a location, to see gyms and fitness studios.');
        return;
      }
      if (!lastGymBounds || !lastGymBounds.contains(map.getBounds())) loadGyms();
    }, 500);
  });
  ['show-trainers', 'show-gyms', 'finder-service'].forEach(function (id) { $(id).addEventListener('change', render); });
  $('finder-signup').href = SIGNUP_URL;

  loadTrainers();
})();
