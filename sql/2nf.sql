-- 2NF step: move repeated trip and operator facts out of ticket rows.
-- Run with: mysql -u root -p busnation < sql/2nf.sql
USE busnation;

-- Trip facts now exist once per trip instead of once per ticket.
CREATE OR REPLACE VIEW trips_2nf AS
SELECT DISTINCT trip_no, operator_name, origin_city, dest_city
FROM unnormalized_bookings;

-- Booking rows keep only facts about the booking itself.
CREATE OR REPLACE VIEW bookings_2nf AS
SELECT booking_no, passenger_name, passenger_email, trip_no, seat_no, fare, payment_status
FROM unnormalized_bookings;

-- Compare:
--   SELECT * FROM trips_2nf ORDER BY trip_no;
--   SELECT * FROM bookings_2nf ORDER BY booking_no;
