-- 3NF step: passenger identity and trip/route facts live in their own tables.
-- Run with: mysql -u root -p busnation < sql/3nf.sql
USE busnation;

-- One row per passenger: email lives with the person, not with every booking.
CREATE OR REPLACE VIEW passengers_3nf AS
SELECT DISTINCT passenger_name, passenger_email
FROM unnormalized_bookings;

-- One row per trip: the route facts live with the scheduled trip.
CREATE OR REPLACE VIEW trips_3nf AS
SELECT DISTINCT trip_no, operator_name, origin_city, dest_city
FROM unnormalized_bookings;

-- Bookings refer to passengers by their unique email in this flat-table lesson;
-- the real schema uses the stronger passenger_id key and foreign key.
CREATE OR REPLACE VIEW bookings_3nf AS
SELECT booking_no, trip_no, seat_no, payment_status, passenger_email
FROM unnormalized_bookings;

-- Compare:
--   SELECT * FROM passengers_3nf ORDER BY passenger_name;
--   SELECT * FROM trips_3nf ORDER BY trip_no;
--   SELECT * FROM bookings_3nf ORDER BY booking_no;
