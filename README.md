# BUSNATION

BUSNATION is a local intercity bus ticketing app and RDBMS teaching demo. Passengers can browse scheduled trips, choose a seat, add luggage, confirm a ticket, and cancel it later. A separate operations view exposes the database tables, transactions, constraints, audit log, and SQL examples.

## Project structure

```text
BUSNATION/
├── public/
│   ├── index.html          # Passenger booking page and operations console
│   ├── site.js             # Trips, seats, passengers, checkout and tickets
│   ├── app.js              # RDBMS console, table explorer and logs
│   └── style.css           # BUSNATION visual system and responsive layout
├── sql/
│   ├── 1nf.sql              # Split the flat luggage list into atomic rows
│   ├── 2nf.sql              # Separate repeated trip facts
│   └── 3nf.sql              # Separate passenger and trip facts
├── db.js                    # MySQL pool, table whitelist and shared helpers
├── server.js                # Express API and transactional booking logic
├── schema.sql               # Database, tables, constraints and triggers
├── seed.sql                 # Repeatable sample terminals, trips and tickets
├── PROJECT_EXPLAINED.txt    # Walkthrough for presenting the project
├── package-lock.json
├── package.json
├── .env.example
└── .gitignore
```

## Run locally

Requirements: Node.js 18+ and MySQL 8.0.16+ (the project uses enforced `CHECK` constraints).

1. Install dependencies: `npm ci`
2. Copy `.env.example` to `.env` and set your local MySQL user and password.
3. Run `mysql -u root -p < schema.sql`.
4. Run `mysql -u root -p < seed.sql`.
5. Start the app with `npm start` and open [http://localhost:3000](http://localhost:3000).

**Important:** `schema.sql` drops and recreates the `busnation` database. Do not run it against a database containing data you need.

The `.env` file is ignored by Git. Never put a password or access token in source files.

## Booking flow

- Browse the sample Mumbai–Pune, Delhi–Jaipur, and Bengaluru–Chennai trips.
- See live seat availability and fares; front-row seats have a separate fare.
- Select a passenger or add a passenger record, then optionally add luggage (₹50/kg, 1–40 kg).
- Confirm a ticket. The ticket, payment record, and optional luggage record are created in one transaction.
- Review or cancel a ticket under **My tickets**. Cancellation keeps the history and releases the seat.

Sample trips and fares are stored in MySQL, not hard-coded into the page. `seed.sql` restores the same demo dataset and resets generated IDs.

## RDBMS lab

Choose **RDBMS lab** in the top navigation to explore:

- Normalized tables for terminals, buses, trips, seats, passengers, bookings, payments, and luggage.
- Primary/foreign keys, unique and check constraints, and a database-level active-seat uniqueness rule.
- Booking transactions, forced rollbacks, row locks, and a two-connection isolation demo.
- Trigger-written audit rows and, optionally, MySQL's general query log.
- A single-statement SQL box and the flat-table normalization examples.

To create the optional normalization views, run:

```sh
mysql -u root -p busnation < sql/1nf.sql
mysql -u root -p busnation < sql/2nf.sql
mysql -u root -p busnation < sql/3nf.sql
```

The general query log is off by default. To enable it in MySQL, use an administrative account:

```sql
SET GLOBAL log_output = 'TABLE';
SET GLOBAL general_log = 'ON';
```

Turn it off after the demo with `SET GLOBAL general_log = 'OFF';`.

## Local-demo limitations

This project simulates a successful payment record; it does **not** contact a payment provider. It has no user authentication, and its SQL console permits writes for teaching purposes. Keep it on localhost—do not expose it as a public booking service without adding authentication, payment integration, rate limits, and stricter database/API permissions.
