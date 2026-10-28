// Passenger-facing BUSNATION booking experience.
'use strict';

const site = {
  view: 'site',
  trips: [],
  tripId: null,
  trip: null,
  seat: null,
  passengers: [],
  paxId: null,
  tripsPaxId: null,
};

const $s = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

async function jfetch(path, options) {
  const response = await fetch(path, options);
  let body;
  try { body = await response.json(); } catch (_) { body = {}; }
  if (!response.ok || !body.ok) {
    throw Object.assign(new Error(body.message || `request failed (${response.status})`), {
      code: body.code,
      trace: body.trace,
      committed: body.committed,
    });
  }
  return body;
}

const jpost = (path, data) => jfetch(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

function setView(view) {
  site.view = view;
  const isSite = view === 'site';
  $s('site-view').hidden = !isSite;
  $s('layout').hidden = isSite;
  for (const button of $s('view-switch').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
}

function formatTime(value) {
  return value ? value.slice(11, 16) : '—';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}

function formatDuration(minutes) {
  const hours = Math.floor(Number(minutes) / 60);
  const remaining = Number(minutes) % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function updateRouteStamp() {
  $s('stamp-origin').textContent = site.trip ? site.trip.origin_code : 'FROM';
  $s('stamp-destination').textContent = site.trip ? site.trip.dest_code : 'TO';
}

function appendText(parent, tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

// Departures and live availability.
async function loadSiteTrips() {
  const list = $s('trip-list');
  const count = $s('trip-count');
  $s('trip-error').textContent = '';
  try {
    const body = await jfetch('/api/trips');
    site.trips = body.rows;
    list.textContent = '';
    count.textContent = `${site.trips.length} ${site.trips.length === 1 ? 'departure' : 'departures'}`;

    if (!site.trips.some((trip) => trip.trip_id === site.tripId)) {
      site.tripId = site.trips[0] ? site.trips[0].trip_id : null;
      site.seat = null;
    }
    site.trip = site.trips.find((trip) => trip.trip_id === site.tripId) || null;
    updateRouteStamp();

    if (!site.trips.length) {
      appendText(list, 'li', 'empty-state', 'No departures are available right now. Check back soon.');
      updateSummary();
      return;
    }

    for (const trip of site.trips) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `trip-row${trip.trip_id === site.tripId ? ' sel' : ''}`;
      button.dataset.tripId = String(trip.trip_id);
      button.setAttribute('aria-pressed', String(trip.trip_id === site.tripId));
      button.setAttribute('aria-label', `${trip.origin_city} to ${trip.dest_city}, ${trip.operator} ${trip.bus_type}, departs ${formatTime(trip.departs_at)}, from ${money.format(Number(trip.min_fare))}, ${trip.free_seats} seats available`);

      const operator = appendText(button, 'span', 'trip-operator-wrap', '');
      appendText(operator, 'span', 'trip-operator', trip.operator);
      appendText(operator, 'small', 'trip-service', `${trip.bus_type} · ${trip.trip_no}`);

      const route = appendText(button, 'span', 'trip-route', '');
      const origin = appendText(route, 'span', 'trip-city', '');
      appendText(origin, 'strong', '', trip.origin_city);
      appendText(origin, 'small', '', trip.origin_terminal);
      appendText(route, 'span', 'trip-arrow', '');
      const destination = appendText(route, 'span', 'trip-city', '');
      appendText(destination, 'strong', '', trip.dest_city);
      appendText(destination, 'small', '', trip.dest_terminal);

      const timing = appendText(button, 'span', 'trip-time', '');
      appendText(timing, 'strong', '', `${formatTime(trip.departs_at)} – ${formatTime(trip.arrives_at)}`);
      appendText(timing, 'small', '', `${formatDate(trip.departs_at)} · ${formatDuration(trip.duration_minutes)}`);

      const price = appendText(button, 'span', 'trip-price', '');
      appendText(price, 'strong', '', `from ${money.format(Number(trip.min_fare))}`);
      appendText(price, 'small', '', `${trip.free_seats} seats left`);

      button.addEventListener('click', () => {
        selectTrip(trip.trip_id).catch((error) => { $s('trip-error').textContent = error.message; });
      });
      item.appendChild(button);
      list.appendChild(item);
    }

    if (site.tripId != null) await loadCoach();
    updateSummary();
  } catch (error) {
    count.textContent = 'Trips unavailable';
    list.textContent = '';
    appendText(list, 'li', 'empty-state', 'We couldn’t load departures. Check that the app and database are running.');
    $s('trip-error').textContent = error.message;
  }
}

async function selectTrip(tripId) {
  site.tripId = tripId;
  site.trip = site.trips.find((trip) => trip.trip_id === tripId) || null;
  site.seat = null;
  updateRouteStamp();
  $s('pax-error').textContent = '';
  for (const button of $s('trip-list').querySelectorAll('.trip-row')) {
    button.classList.toggle('sel', Number(button.dataset.tripId) === tripId);
    button.setAttribute('aria-pressed', String(button.classList.contains('sel')));
  }
  await loadCoach();
  updateSummary();
}

// 2 + aisle + 2 seat map, built from the live trip inventory.
async function loadCoach() {
  if (site.tripId == null) {
    $s('coach-map').textContent = '';
    return;
  }
  const body = await jfetch(`/api/trips/${site.tripId}/seats`);
  if (site.seat) {
    const currentSeat = body.rows.find((item) => item.seat_id === site.seat.seat_id);
    if (!currentSeat || currentSeat.booking_id != null) {
      site.seat = null;
      $s('pax-error').textContent = currentSeat
        ? `Seat ${currentSeat.seat_no} was just booked. Choose another seat.`
        : 'That seat is no longer available. Choose another seat.';
    } else {
      site.seat = currentSeat;
    }
  }
  const rows = {};
  for (const seat of body.rows) {
    const match = seat.seat_no.match(/^(\d+)([A-Z])$/);
    if (!match) continue;
    (rows[match[1]] = rows[match[1]] || []).push(seat);
  }
  const fares = {};
  for (const seat of body.rows) fares[seat.class] = seat.fare;
  const frontFare = fares.FRONT_ROW == null ? '—' : money.format(Number(fares.FRONT_ROW));
  const standardFare = fares.STANDARD == null ? '—' : money.format(Number(fares.STANDARD));
  $s('coach-legend').textContent = `Front row ${frontFare} · Standard ${standardFare}`;

  const map = $s('coach-map');
  map.textContent = '';
  for (const rowNo of Object.keys(rows).sort((a, b) => Number(a) - Number(b))) {
    const row = appendText(map, 'div', 'coach-row', '');
    appendText(row, 'span', 'rowno', rowNo);
    for (const letter of ['A', 'B', 'C', 'D']) {
      if (letter === 'C') {
        const aisle = appendText(row, 'span', 'aisle', '');
        aisle.setAttribute('aria-hidden', 'true');
      }
      const seat = rows[rowNo].find((item) => item.seat_no === rowNo + letter);
      if (!seat) continue;
      const booked = seat.booking_id != null;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `seat ${booked ? 'booked' : 'free'}${seat.class === 'FRONT_ROW' ? ' front' : ''}`;
      button.setAttribute('aria-pressed', String(Boolean(site.seat && site.seat.seat_id === seat.seat_id)));
      button.setAttribute('aria-label', booked
        ? `Seat ${seat.seat_no}, booked by ${seat.passenger_name}`
        : `Seat ${seat.seat_no}, ${seat.class === 'FRONT_ROW' ? 'front row' : 'standard'}, ${money.format(Number(seat.fare))}`);
      if (booked) button.title = `Booked by ${seat.passenger_name}`;
      if (site.seat && seat.seat_id === site.seat.seat_id) button.classList.add('selected');
      appendText(button, 'span', 'seatx', booked ? '×' : '');
      appendText(button, 'span', 'slabel', seat.seat_no);
      button.addEventListener('click', () => selectCoachSeat(seat));
      row.appendChild(button);
    }
  }
}

function selectCoachSeat(seat) {
  if (seat.booking_id != null) {
    $s('pax-error').textContent = `Seat ${seat.seat_no} is already booked by ${seat.passenger_name}.`;
    return;
  }
  $s('pax-error').textContent = '';
  site.seat = seat;
  loadCoach().catch((error) => { $s('site-error').textContent = error.message; });
  updateSummary();
}

// Passenger records are shared with the database console.
async function loadSitePassengers() {
  const body = await jfetch('/api/table/passengers');
  site.passengers = body.rows;
  for (const selectId of ['site-passenger', 'site-trips-pax']) {
    const select = $s(selectId);
    const previous = select.value;
    select.textContent = '';
    for (const passenger of site.passengers) {
      const option = document.createElement('option');
      option.value = passenger.passenger_id;
      option.textContent = `${passenger.name} · ${passenger.email}`;
      select.appendChild(option);
    }
    if (site.passengers.some((passenger) => String(passenger.passenger_id) === previous)) select.value = previous;
  }
  if (!site.passengers.some((passenger) => passenger.passenger_id === site.paxId)) {
    site.paxId = site.passengers[0] ? site.passengers[0].passenger_id : null;
  }
  if (!site.passengers.some((passenger) => passenger.passenger_id === site.tripsPaxId)) {
    site.tripsPaxId = site.passengers[0] ? site.passengers[0].passenger_id : null;
  }
  if (site.paxId != null) $s('site-passenger').value = String(site.paxId);
  if (site.tripsPaxId != null) $s('site-trips-pax').value = String(site.tripsPaxId);
  updateSummary();
}

async function addPassenger() {
  $s('np-error').textContent = '';
  try {
    const body = await jpost('/api/passengers', {
      name: $s('np-name').value,
      email: $s('np-email').value,
      phone: $s('np-phone').value,
    });
    await loadSitePassengers();
    site.paxId = body.row.passenger_id;
    $s('site-passenger').value = String(site.paxId);
    $s('np-name').value = '';
    $s('np-email').value = '';
    $s('np-phone').value = '';
    $s('new-pax').open = false;
    window.dispatchEvent(new Event('busnation:passengers-changed'));
    updateSummary();
  } catch (error) {
    $s('np-error').textContent = error.code ? `[${error.code}] ${error.message}` : error.message;
  }
}

function updateSummary() {
  const trip = site.trip;
  const seat = site.seat;
  const luggageKg = Number($s('site-luggage').value) || 0;
  $s('sum-trip').textContent = trip ? `${trip.origin_city} → ${trip.dest_city} · ${trip.trip_no}` : 'Choose a trip to begin';
  $s('sum-departure').textContent = trip ? `${formatDate(trip.departs_at)} · ${formatTime(trip.departs_at)}` : '—';
  $s('sum-seat').textContent = seat ? `${seat.seat_no} · ${seat.class === 'FRONT_ROW' ? 'Front row' : 'Standard'}` : '—';
  $s('sum-fare').textContent = seat ? money.format(Number(seat.fare)) : '—';
  $s('sum-luggage').textContent = luggageKg > 0 ? `${luggageKg} kg · ${money.format(luggageKg * 50)}` : 'None';
  $s('sum-total').textContent = seat ? money.format(Number(seat.fare) + luggageKg * 50) : '—';
  $s('site-book').disabled = !(trip && seat && site.paxId && luggageKg >= 0 && luggageKg <= 40);
}

async function siteBook() {
  $s('site-error').textContent = '';
  $s('site-ticket').hidden = true;
  if (!site.trip || !site.seat || !site.paxId) {
    $s('site-error').textContent = 'Choose a trip, an available seat and a passenger before confirming.';
    return;
  }
  const luggageKg = Number($s('site-luggage').value) || 0;
  if (!Number.isInteger(luggageKg) || luggageKg < 0 || luggageKg > 40) {
    $s('site-error').textContent = 'Luggage must be a whole number from 0 to 40 kg.';
    return;
  }

  $s('site-book').disabled = true;
  let bookingId = null;
  try {
    const body = await jpost('/api/book', {
      trip_id: site.tripId,
      seat_id: site.seat.seat_id,
      passenger_id: site.paxId,
      luggage_kg: luggageKg,
    });
    bookingId = body.booking_id;
    renderSiteTrace(body.trace);
    site.seat = null;
    await showTicket(bookingId);
  } catch (error) {
    if (error.trace) renderSiteTrace(error.trace);
    $s('site-error').textContent = error.code ? `[${error.code}] ${error.message}` : error.message;
  }

  await Promise.all([loadSiteTrips(), loadMyTickets()]);
  updateSummary();
  $s('site-book').disabled = !(site.trip && site.seat && site.paxId);
}

async function showTicket(bookingId) {
  const body = await jfetch(`/api/bookings?passenger_id=${site.paxId}`);
  const ticket = body.rows.find((row) => Number(row.booking_id) === Number(bookingId));
  if (!ticket) return;
  const passenger = site.passengers.find((item) => item.passenger_id === site.paxId);
  $s('tkt-id').textContent = `BN-${String(ticket.booking_id).padStart(6, '0')}`;
  $s('tkt-route').textContent = `${ticket.origin_city} → ${ticket.dest_city} · ${ticket.trip_no}`;
  $s('tkt-pax').textContent = passenger ? passenger.name : `Passenger ${site.paxId}`;
  $s('tkt-seat').textContent = ticket.seat_no;
  $s('tkt-total').textContent = money.format(Number(ticket.amount) + Number(ticket.luggage_fee));
  $s('site-ticket').hidden = false;
}

// Tickets remain visible after cancellation so the booking history is intact.
async function loadMyTickets() {
  const list = $s('site-trips');
  const passengerId = site.tripsPaxId;
  list.textContent = '';
  if (passengerId == null) {
    appendText(list, 'li', 'empty-state', 'Add a passenger to see ticket history.');
    return;
  }
  $s('trips-error').textContent = '';
  try {
    const body = await jfetch(`/api/bookings?passenger_id=${passengerId}`);
    if (!body.rows.length) {
      appendText(list, 'li', 'empty-state', 'No tickets yet. Your next trip can start here.');
      return;
    }
    for (const ticket of body.rows) {
      const item = document.createElement('li');
      item.className = 'my-trip-item';
      const info = appendText(item, 'span', 'my-trip-info', '');
      appendText(info, 'strong', '', `${ticket.origin_city} → ${ticket.dest_city}`);
      appendText(info, 'small', '', `${ticket.trip_no} · seat ${ticket.seat_no} · ${formatDate(ticket.departs_at)}`);

      const badge = appendText(item, 'span', `badge ${ticket.status === 'CONFIRMED' ? 'b-ok' : 'b-err'}`, ticket.status);
      badge.setAttribute('aria-label', `Ticket ${ticket.status.toLowerCase()}`);
      appendText(item, 'span', 'my-trip-amount', money.format(Number(ticket.amount) + Number(ticket.luggage_fee)));
      if (ticket.status === 'CONFIRMED') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'button-danger cancel-ticket';
        cancel.textContent = 'Cancel';
        cancel.setAttribute('aria-label', `Cancel ticket BN-${String(ticket.booking_id).padStart(6, '0')}`);
        cancel.addEventListener('click', () => cancelTicket(ticket.booking_id));
        item.appendChild(cancel);
      }
      list.appendChild(item);
    }
  } catch (error) {
    $s('trips-error').textContent = error.message;
  }
}

async function cancelTicket(bookingId) {
  $s('trips-error').textContent = '';
  try {
    const body = await jpost(`/api/cancel/${bookingId}`, {});
    renderSiteTrace(body.trace);
  } catch (error) {
    if (error.trace) renderSiteTrace(error.trace);
    $s('trips-error').textContent = error.code ? `[${error.code}] ${error.message}` : error.message;
  }
  await Promise.all([loadMyTickets(), loadSiteTrips()]);
  updateSummary();
}

function renderSiteTrace(trace) {
  const list = $s('site-trace-list');
  list.textContent = '';
  for (const step of trace.slice().reverse()) {
    const item = document.createElement('li');
    const time = appendText(item, 'span', 't', step.ts);
    time.setAttribute('aria-label', `At ${step.ts}`);
    const status = String(step.status || 'OK').toLowerCase();
    appendText(item, 'span', `status-${status}`, step.status || 'OK');
    item.appendChild(document.createTextNode(` ${step.actor ? `${step.actor} ` : ''}${step.step}`));
    list.appendChild(item);
  }
}

function initSite() {
  for (const button of $s('view-switch').querySelectorAll('button')) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }
  $s('site-passenger').addEventListener('change', (event) => {
    site.paxId = Number(event.target.value) || null;
    updateSummary();
  });
  $s('site-trips-pax').addEventListener('change', (event) => {
    site.tripsPaxId = Number(event.target.value) || null;
    loadMyTickets();
  });
  $s('site-luggage').addEventListener('input', updateSummary);
  $s('btn-add-pax').addEventListener('click', addPassenger);
  $s('site-book').addEventListener('click', siteBook);
  setView('site');

  loadSiteTrips();
  loadSitePassengers().then(loadMyTickets).catch((error) => {
    $s('pax-error').textContent = `Passenger list unavailable: ${error.message}`;
  });
}

initSite();
