// BUSNATION Express API: trips, live seat inventory and transactional tickets.
const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { pool, TABLE_SQL, dbError, ts, sleep } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// A ticket, payment and optional luggage entry commit together or roll back
// together. SELECT FOR UPDATE serializes two attempts for the same seat.
async function bookSeat(conn, options, trace, actor = 'APP') {
  const step = (text, status = 'OK') => trace.push({ ts: ts(), actor, step: text, status });
  await conn.beginTransaction();
  step('BEGIN');

  const [seats] = await conn.query(
    'SELECT seat_id, trip_id, seat_no, fare FROM seats WHERE seat_id = ? FOR UPDATE',
    [options.seatId],
  );
  if (!seats.length) {
    const error = new Error('Seat not found');
    error.code = 'SEAT_NOT_FOUND';
    throw error;
  }
  const seat = seats[0];
  if (seat.trip_id !== options.tripId) {
    const error = new Error('Seat is not on this trip');
    error.code = 'SEAT_TRIP_MISMATCH';
    throw error;
  }
  step(`SELECT seat ${seat.seat_no} FOR UPDATE -> row lock held`);

  const [booking] = await conn.query(
    "INSERT INTO bookings (trip_id, seat_id, passenger_id, status) VALUES (?, ?, ?, 'CONFIRMED')",
    [options.tripId, options.seatId, options.passengerId],
  );
  step(`INSERT bookings -> booking_id ${booking.insertId}`);
  if (options.failAt === 'booking') {
    const error = new Error('Forced failure after ticket insert');
    error.code = 'FORCED_FAILURE';
    throw error;
  }

  const [payment] = await conn.query(
    "INSERT INTO payments (booking_id, amount, status) VALUES (?, ?, 'PAID')",
    [booking.insertId, seat.fare],
  );
  step(`INSERT payments -> payment_id ${payment.insertId}, amount ${seat.fare}`);
  if (options.failAt === 'payment') {
    const error = new Error('Forced failure after payment insert');
    error.code = 'FORCED_FAILURE';
    throw error;
  }

  if (options.luggageKg > 0) {
    const fee = options.luggageKg * 50;
    const [luggage] = await conn.query(
      'INSERT INTO luggage (booking_id, kg, fee) VALUES (?, ?, ?)',
      [booking.insertId, options.luggageKg, fee],
    );
    step(`INSERT luggage -> luggage_id ${luggage.insertId}, ${options.luggageKg} kg, fee ${fee}`);
  }
  if (options.failAt === 'luggage') {
    const error = new Error('Forced failure after luggage insert');
    error.code = 'FORCED_FAILURE';
    throw error;
  }

  await conn.commit();
  step('COMMIT');
  return { bookingId: booking.insertId };
}

app.get('/api/health', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT DATABASE() AS database_name');
  const databaseName = rows[0].database_name;
  if (databaseName !== 'busnation') {
    return res.status(503).json({
      ok: false,
      code: 'WRONG_DATABASE',
      message: 'Set DB_NAME=busnation and run schema.sql plus seed.sql.',
    });
  }
  await pool.query('SELECT 1 FROM trips LIMIT 1');
  res.json({ ok: true, db: 'connected', database: databaseName });
}));

app.get('/api/trips', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.trip_id, t.trip_no, t.departs_at, t.arrives_at,
            TIMESTAMPDIFF(MINUTE, t.departs_at, t.arrives_at) AS duration_minutes,
            origin.code AS origin_code, origin.city AS origin_city,
            origin.terminal_name AS origin_terminal,
            dest.code AS dest_code, dest.city AS dest_city,
            dest.terminal_name AS dest_terminal,
            bus.operator_name AS operator, bus.bus_name, bus.bus_type,
            (SELECT MIN(s.fare) FROM seats s WHERE s.trip_id = t.trip_id) AS min_fare,
            (SELECT COUNT(*) FROM seats s
             LEFT JOIN bookings b ON b.seat_id = s.seat_id AND b.status = 'CONFIRMED'
             WHERE s.trip_id = t.trip_id AND b.booking_id IS NULL) AS free_seats
     FROM trips t
     JOIN terminals origin ON origin.terminal_id = t.origin_id
     JOIN terminals dest ON dest.terminal_id = t.dest_id
     JOIN buses bus ON bus.bus_id = t.bus_id
     ORDER BY t.departs_at`,
  );
  res.json({ ok: true, rows });
}));

app.post('/api/passengers', wrap(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  if (!name || !email) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'name and email are required' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO passengers (name, email, phone) VALUES (?, ?, ?)',
      [name, email, phone || null],
    );
    const [rows] = await pool.query(
      'SELECT passenger_id, name, email, phone FROM passengers WHERE passenger_id = ?',
      [result.insertId],
    );
    res.json({ ok: true, row: rows[0] });
  } catch (error) {
    if (error.errno === 1062) {
      return res.status(409).json({
        ok: false,
        code: 1062,
        message: 'email already registered — choose that passenger instead',
      });
    }
    throw error;
  }
}));

app.get('/api/bookings', wrap(async (req, res) => {
  const passengerId = Number(req.query.passenger_id);
  if (!Number.isInteger(passengerId) || passengerId <= 0) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'passenger_id must be a positive integer' });
  }
  const [rows] = await pool.query(
    `SELECT bk.booking_id, bk.trip_id, bk.status, bk.created_at,
            t.trip_no, t.departs_at, t.arrives_at,
            origin.city AS origin_city, dest.city AS dest_city,
            s.seat_no, IFNULL(pay.amount, 0) AS amount,
            IFNULL(pay.status, '-') AS payment_status,
            (SELECT IFNULL(SUM(l.fee), 0) FROM luggage l WHERE l.booking_id = bk.booking_id) AS luggage_fee
     FROM bookings bk
     JOIN trips t ON t.trip_id = bk.trip_id
     JOIN terminals origin ON origin.terminal_id = t.origin_id
     JOIN terminals dest ON dest.terminal_id = t.dest_id
     JOIN seats s ON s.seat_id = bk.seat_id
     LEFT JOIN payments pay ON pay.booking_id = bk.booking_id
     WHERE bk.passenger_id = ?
     ORDER BY bk.booking_id DESC`,
    [passengerId],
  );
  res.json({ ok: true, rows });
}));

app.get('/api/trips/:id/seats', wrap(async (req, res) => {
  const tripId = Number(req.params.id);
  if (!Number.isInteger(tripId) || tripId <= 0) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'trip id must be a positive integer' });
  }
  const [rows] = await pool.query(
    `SELECT s.seat_id, s.trip_id, s.seat_no, s.class, s.fare,
            b.booking_id, p.name AS passenger_name
     FROM seats s
     LEFT JOIN bookings b ON b.seat_id = s.seat_id AND b.status = 'CONFIRMED'
     LEFT JOIN passengers p ON p.passenger_id = b.passenger_id
     WHERE s.trip_id = ?
     ORDER BY s.seat_no`,
    [tripId],
  );
  res.json({ ok: true, rows });
}));

app.get('/api/table/:name', wrap(async (req, res) => {
  const sql = TABLE_SQL[req.params.name];
  if (!sql) {
    return res.status(404).json({ ok: false, code: 'UNKNOWN_TABLE', message: `table not whitelisted: ${req.params.name}` });
  }
  const [rows, fields] = await pool.query(sql);
  res.json({ ok: true, columns: fields.map((field) => field.name), rows });
}));

app.post('/api/book', async (req, res) => {
  const body = req.body || {};
  const tripId = Number(body.trip_id);
  const seatId = Number(body.seat_id);
  const passengerId = Number(body.passenger_id);
  const luggageKg = body.luggage_kg == null ? 0 : Number(body.luggage_kg);
  const failAt = body.fail_at || null;

  if (![tripId, seatId, passengerId].every((value) => Number.isInteger(value) && value > 0)) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'trip_id, seat_id and passenger_id must be positive integers' });
  }
  if (!Number.isInteger(luggageKg) || luggageKg < 0 || luggageKg > 40) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'luggage_kg must be a whole number from 0 to 40' });
  }
  if (failAt && !['booking', 'payment', 'luggage'].includes(failAt)) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'fail_at must be booking, payment, luggage or null' });
  }

  const conn = await pool.getConnection();
  const trace = [];
  try {
    const result = await bookSeat(conn, { tripId, seatId, passengerId, luggageKg, failAt }, trace);
    res.json({ ok: true, committed: true, booking_id: result.bookingId, trace });
  } catch (error) {
    try {
      await conn.rollback();
      trace.push({ ts: ts(), actor: 'APP', step: 'ROLLBACK', status: 'ERROR' });
    } catch (_) { /* the connection may already be gone */ }
    const detail = dbError(error);
    res.status(409).json({
      ok: false,
      committed: false,
      code: detail.code,
      sqlState: detail.sqlState,
      message: detail.message,
      trace,
    });
  } finally {
    conn.release();
  }
});

app.post('/api/cancel/:bookingId', async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'booking id must be a positive integer' });
  }
  const conn = await pool.getConnection();
  const trace = [];
  try {
    await conn.beginTransaction();
    trace.push({ ts: ts(), actor: 'APP', step: 'BEGIN', status: 'OK' });
    const [bookings] = await conn.query(
      'SELECT booking_id, status FROM bookings WHERE booking_id = ? FOR UPDATE',
      [bookingId],
    );
    if (!bookings.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, committed: false, code: 'NOT_FOUND', message: `ticket ${bookingId} does not exist`, trace });
    }
    if (bookings[0].status === 'CANCELLED') {
      await conn.rollback();
      return res.status(409).json({ ok: false, committed: false, code: 'ALREADY_CANCELLED', message: `ticket ${bookingId} is already cancelled`, trace });
    }
    await conn.query("UPDATE bookings SET status = 'CANCELLED' WHERE booking_id = ?", [bookingId]);
    trace.push({ ts: ts(), actor: 'APP', step: `UPDATE bookings -> ticket ${bookingId} cancelled`, status: 'OK' });
    await conn.query("UPDATE payments SET status = 'FAILED' WHERE booking_id = ?", [bookingId]);
    trace.push({ ts: ts(), actor: 'APP', step: `UPDATE payments -> voided for ticket ${bookingId}`, status: 'OK' });
    await conn.commit();
    trace.push({ ts: ts(), actor: 'APP', step: 'COMMIT', status: 'OK' });
    res.json({ ok: true, committed: true, trace });
  } catch (error) {
    try {
      await conn.rollback();
      trace.push({ ts: ts(), actor: 'APP', step: 'ROLLBACK', status: 'ERROR' });
    } catch (_) { /* the connection may already be gone */ }
    const detail = dbError(error);
    res.status(409).json({ ok: false, committed: false, code: detail.code, sqlState: detail.sqlState, message: detail.message, trace });
  } finally {
    conn.release();
  }
});

app.post('/api/constraint-demo', wrap(async (req, res) => {
  const type = (req.body || {}).type;
  let sql;
  let params = [];
  if (type === 'fk') {
    sql = "INSERT INTO trips (trip_no, bus_id, origin_id, dest_id, departs_at, arrives_at) VALUES ('BN999', 999, 1, 2, '2026-12-01 09:00:00', '2026-12-01 12:00:00')";
  } else if (type === 'unique') {
    sql = "INSERT INTO passengers (name, email, phone) VALUES ('Demo Duplicate', 'asha@mail.com', NULL)";
  } else if (type === 'check') {
    const [bookings] = await pool.query('SELECT booking_id FROM bookings ORDER BY booking_id LIMIT 1');
    if (!bookings.length) return res.json({ ok: true, demo: type, code: 'NO_BOOKINGS', message: 'no ticket exists for the luggage check demo' });
    sql = 'INSERT INTO luggage (booking_id, kg, fee) VALUES (?, 50, 2500.00)';
    params = [bookings[0].booking_id];
  } else if (type === 'trigger') {
    const [bookings] = await pool.query("SELECT trip_id, seat_id, passenger_id FROM bookings WHERE status = 'CONFIRMED' ORDER BY booking_id LIMIT 1");
    if (!bookings.length) return res.json({ ok: true, demo: type, code: 'NO_BOOKINGS', message: 'no confirmed ticket exists to collide with' });
    sql = "INSERT INTO bookings (trip_id, seat_id, passenger_id, status) VALUES (?, ?, ?, 'CONFIRMED')";
    params = [bookings[0].trip_id, bookings[0].seat_id, bookings[0].passenger_id];
  } else {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'type must be fk, unique, check or trigger' });
  }

  try {
    await pool.query(sql, params);
    res.json({ ok: true, demo: type, code: 'NO_ERROR', message: 'statement unexpectedly succeeded' });
  } catch (error) {
    const detail = dbError(error);
    res.json({ ok: true, demo: type, sql, code: detail.code, sqlState: detail.sqlState, message: detail.message });
  }
}));

app.post('/api/isolation-demo', async (req, res) => {
  const body = req.body || {};
  const tripId = Number(body.trip_id);
  const seatId = Number(body.seat_id);
  const passengerId = Number(body.passenger_id || 1);
  const trace = [];
  if (![tripId, seatId, passengerId].every((value) => Number.isInteger(value) && value > 0)) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', message: 'trip_id, seat_id and passenger_id must be positive integers' });
  }
  const [occupied] = await pool.query(
    "SELECT booking_id FROM bookings WHERE seat_id = ? AND status = 'CONFIRMED'",
    [seatId],
  );
  if (occupied.length) {
    return res.status(409).json({ ok: false, code: 'SEAT_BUSY', message: 'isolation demo needs a free seat — choose one in the seat map' });
  }

  const connA = await pool.getConnection();
  let connB;
  try {
    connB = await pool.getConnection();
    await connA.query('SET SESSION innodb_lock_wait_timeout = 5');
    await connB.query('SET SESSION innodb_lock_wait_timeout = 5');

    await connA.beginTransaction();
    trace.push({ ts: ts(), actor: 'A', step: 'BEGIN', status: 'OK' });
    const [seats] = await connA.query('SELECT seat_no, fare FROM seats WHERE seat_id = ? AND trip_id = ? FOR UPDATE', [seatId, tripId]);
    if (!seats.length) {
      const error = new Error('Seat is not on this trip');
      error.code = 'SEAT_TRIP_MISMATCH';
      throw error;
    }
    trace.push({ ts: ts(), actor: 'A', step: `SELECT seat ${seats[0].seat_no} FOR UPDATE -> lock held`, status: 'OK' });
    const [bookingA] = await connA.query(
      "INSERT INTO bookings (trip_id, seat_id, passenger_id, status) VALUES (?, ?, ?, 'CONFIRMED')",
      [tripId, seatId, passengerId],
    );
    trace.push({ ts: ts(), actor: 'A', step: `INSERT bookings -> booking_id ${bookingA.insertId} (uncommitted)`, status: 'OK' });
    await connA.query("INSERT INTO payments (booking_id, amount, status) VALUES (?, ?, 'PAID')", [bookingA.insertId, seats[0].fare]);
    trace.push({ ts: ts(), actor: 'A', step: `INSERT payments -> amount ${seats[0].fare} (uncommitted)`, status: 'OK' });

    const attemptB = bookSeat(connB, { tripId, seatId, passengerId, luggageKg: 0, failAt: null }, trace, 'B');
    await sleep(1200);
    const [transactions] = await pool.query(
      'SELECT trx_state FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = ?',
      [connB.connection.threadId],
    );
    trace.push({
      ts: ts(), actor: 'B',
      step: transactions.length ? `status while A holds the lock: trx_state = ${transactions[0].trx_state}` : 'attempting booking',
      status: 'WAIT',
    });

    await connA.commit();
    trace.push({ ts: ts(), actor: 'A', step: 'COMMIT -> ticket is now visible', status: 'OK' });
    let bFailed = null;
    try {
      await attemptB;
    } catch (error) {
      bFailed = dbError(error);
      try {
        await connB.rollback();
        trace.push({ ts: ts(), actor: 'B', step: 'ROLLBACK', status: 'ERROR' });
      } catch (_) { /* the connection may already be gone */ }
      trace.push({ ts: ts(), actor: 'B', step: `failed: [${bFailed.code}] ${bFailed.message}`, status: 'ERROR' });
    }
    res.json({ ok: true, committed: true, trace, b_failed: bFailed });
  } catch (error) {
    try { await connA.rollback(); } catch (_) { /* A may not have begun */ }
    const detail = dbError(error);
    res.status(500).json({ ok: false, committed: false, code: detail.code, sqlState: detail.sqlState, message: detail.message, trace });
  } finally {
    connA.release();
    if (connB) connB.release();
  }
});

app.post('/api/query', wrap(async (req, res) => {
  const sql = String((req.body || {}).sql || '').trim();
  const body = sql.replace(/;+\s*$/, '');
  const first = (body.match(/^[a-zA-Z]+/) || [''])[0].toUpperCase();
  if (!body) return res.status(400).json({ ok: false, code: 'EMPTY', message: 'type a SQL statement' });
  if (body.includes(';')) return res.status(400).json({ ok: false, code: 'MULTI', message: 'only a single statement is allowed' });
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(first)) {
    return res.status(400).json({ ok: false, code: 'FORBIDDEN', message: `only SELECT, INSERT, UPDATE, DELETE are allowed (got ${first || 'nothing'})` });
  }
  try {
    const [rows, fields] = await pool.query(body);
    if (Array.isArray(rows)) {
      res.json({ ok: true, columns: fields.map((field) => field.name), rows: rows.slice(0, 200) });
    } else {
      res.json({ ok: true, columns: [], rows: [], affectedRows: rows.affectedRows, insertId: rows.insertId });
    }
  } catch (error) {
    const detail = dbError(error);
    res.status(400).json({ ok: false, code: detail.code, sqlState: detail.sqlState, message: detail.message });
  }
}));

app.get('/api/logs/audit', wrap(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const [rows] = await pool.query(
    `SELECT log_id, table_name, action, row_id, old_data, new_data, logged_at
     FROM audit_log WHERE log_id > ? ORDER BY log_id DESC LIMIT 100`,
    [since],
  );
  res.json({ ok: true, rows });
}));

app.get('/api/logs/general', wrap(async (req, res) => {
  const [generalLog] = await pool.query('SELECT @@general_log AS enabled');
  if (!generalLog[0].enabled) return res.json({ ok: true, enabled: false, rows: [] });
  const [rows] = await pool.query(
    `SELECT event_time, user_host, command_type,
            CAST(argument AS CHAR CHARACTER SET utf8mb4) AS argument
     FROM mysql.general_log
     WHERE user_host LIKE ? AND argument NOT LIKE '%general_log%'
     ORDER BY event_time DESC, thread_id DESC LIMIT 30`,
    [`${process.env.DB_USER}%`],
  );
  res.json({ ok: true, enabled: true, rows });
}));

app.post('/api/reset', wrap(async (req, res) => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    dateStrings: true,
  });
  try {
    const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    await conn.query(seed);
    await conn.query('TRUNCATE TABLE mysql.general_log');
    res.json({ ok: true, message: 'BUSNATION sample data reset' });
  } finally {
    await conn.end();
  }
}));

function wrap(handler) {
  return (req, res) => handler(req, res).catch((error) => {
    console.error(error);
    const detail = dbError(error);
    res.status(500).json({ ok: false, code: detail.code, sqlState: detail.sqlState, message: detail.message });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BUSNATION listening on http://localhost:${PORT}`));
