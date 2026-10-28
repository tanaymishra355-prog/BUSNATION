-- BUSNATION schema: an intercity bus ticketing system and RDBMS demo.
-- WARNING: this script drops and recreates the busnation database.
-- Run with the MySQL CLI because trigger bodies use DELIMITER.

DROP DATABASE IF EXISTS busnation;
CREATE DATABASE busnation CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE busnation;

CREATE TABLE terminals (
  terminal_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code          CHAR(4)      NOT NULL UNIQUE,
  terminal_name VARCHAR(120) NOT NULL,
  city          VARCHAR(100) NOT NULL
) ENGINE = InnoDB;

CREATE TABLE buses (
  bus_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bus_code VARCHAR(12)  NOT NULL UNIQUE,
  operator_name VARCHAR(120) NOT NULL,
  bus_name VARCHAR(120) NOT NULL,
  bus_type VARCHAR(40)  NOT NULL
) ENGINE = InnoDB;

CREATE TABLE trips (
  trip_id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  trip_no    VARCHAR(12)  NOT NULL UNIQUE,
  bus_id     INT UNSIGNED NOT NULL,
  origin_id  INT UNSIGNED NOT NULL,
  dest_id    INT UNSIGNED NOT NULL,
  departs_at DATETIME     NOT NULL,
  arrives_at DATETIME     NOT NULL,
  CONSTRAINT fk_trip_bus    FOREIGN KEY (bus_id)    REFERENCES buses (bus_id)         ON DELETE RESTRICT,
  CONSTRAINT fk_trip_origin FOREIGN KEY (origin_id) REFERENCES terminals (terminal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_trip_dest   FOREIGN KEY (dest_id)   REFERENCES terminals (terminal_id) ON DELETE RESTRICT,
  CONSTRAINT chk_trip_route CHECK (origin_id <> dest_id),
  CONSTRAINT chk_trip_times CHECK (arrives_at > departs_at),
  KEY idx_trip_departure (departs_at)
) ENGINE = InnoDB;

CREATE TABLE seats (
  seat_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  trip_id INT UNSIGNED NOT NULL,
  seat_no VARCHAR(4)   NOT NULL,
  class   ENUM('STANDARD','FRONT_ROW') NOT NULL DEFAULT 'STANDARD',
  fare    DECIMAL(10,2) NOT NULL,
  CONSTRAINT uq_trip_seat UNIQUE (trip_id, seat_no),
  CONSTRAINT uq_seat_trip_pair UNIQUE (trip_id, seat_id),
  CONSTRAINT fk_seat_trip FOREIGN KEY (trip_id) REFERENCES trips (trip_id) ON DELETE RESTRICT,
  CONSTRAINT chk_seat_fare CHECK (fare >= 0)
) ENGINE = InnoDB;

CREATE TABLE passengers (
  passenger_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(120) NOT NULL,
  email        VARCHAR(200) NOT NULL UNIQUE,
  phone        VARCHAR(20)  NULL
) ENGINE = InnoDB;

-- active_seat_id is NULL for cancelled history; its UNIQUE key makes a live
-- seat exclusive even for writes that bypass the Node transaction lock.
CREATE TABLE bookings (
  booking_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  trip_id      INT UNSIGNED NOT NULL,
  seat_id      INT UNSIGNED NOT NULL,
  passenger_id INT UNSIGNED NOT NULL,
  status       ENUM('CONFIRMED','CANCELLED') NOT NULL DEFAULT 'CONFIRMED',
  active_seat_id INT UNSIGNED GENERATED ALWAYS AS
    (CASE WHEN status = 'CONFIRMED' THEN seat_id ELSE NULL END) STORED,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_active_booking_seat UNIQUE (active_seat_id),
  KEY idx_booking_seat_status (seat_id, status),
  CONSTRAINT fk_booking_trip_seat FOREIGN KEY (trip_id, seat_id)
    REFERENCES seats (trip_id, seat_id) ON DELETE RESTRICT,
  CONSTRAINT fk_booking_passenger FOREIGN KEY (passenger_id)
    REFERENCES passengers (passenger_id) ON DELETE RESTRICT
) ENGINE = InnoDB;

CREATE TABLE payments (
  payment_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id INT UNSIGNED NOT NULL UNIQUE,
  amount     DECIMAL(10,2) NOT NULL,
  status     ENUM('PAID','FAILED') NOT NULL DEFAULT 'PAID',
  paid_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_payment_booking FOREIGN KEY (booking_id) REFERENCES bookings (booking_id) ON DELETE RESTRICT,
  CONSTRAINT chk_amount_nonneg CHECK (amount >= 0)
) ENGINE = InnoDB;

CREATE TABLE luggage (
  luggage_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id INT UNSIGNED NOT NULL,
  kg         INT NOT NULL,
  fee        DECIMAL(10,2) NOT NULL,
  CONSTRAINT fk_luggage_booking FOREIGN KEY (booking_id) REFERENCES bookings (booking_id) ON DELETE RESTRICT,
  CONSTRAINT chk_luggage_kg CHECK (kg BETWEEN 1 AND 40),
  CONSTRAINT chk_luggage_fee CHECK (fee >= 0)
) ENGINE = InnoDB;

CREATE TABLE audit_log (
  log_id     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  table_name VARCHAR(64) NOT NULL,
  action     ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  row_id     BIGINT UNSIGNED NOT NULL,
  old_data   JSON NULL,
  new_data   JSON NULL,
  logged_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE = InnoDB;

-- Teaching table: deliberately repeats passenger, route and ticket facts.
CREATE TABLE unnormalized_bookings (
  unnorm_id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_no      VARCHAR(12)  NOT NULL,
  passenger_name  VARCHAR(120) NOT NULL,
  passenger_email VARCHAR(200) NOT NULL,
  trip_no         VARCHAR(12)  NOT NULL,
  operator_name   VARCHAR(120) NOT NULL,
  origin_city     VARCHAR(100) NOT NULL,
  dest_city       VARCHAR(100) NOT NULL,
  seat_no         VARCHAR(4)   NOT NULL,
  fare            DECIMAL(10,2) NOT NULL,
  payment_status  VARCHAR(20)  NOT NULL,
  luggage         VARCHAR(100) NOT NULL DEFAULT ''
) ENGINE = InnoDB;

CREATE TABLE demo_numbers (
  n INT UNSIGNED PRIMARY KEY
) ENGINE = InnoDB;

-- Prevent two live tickets from occupying the same seat.
DELIMITER ;;
CREATE TRIGGER trg_bookings_no_double_seat BEFORE INSERT ON bookings
FOR EACH ROW
BEGIN
  IF NEW.status = 'CONFIRMED' AND EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.seat_id = NEW.seat_id AND b.status = 'CONFIRMED'
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Seat already has a CONFIRMED booking';
  END IF;
END;;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_bookings_no_reconfirm BEFORE UPDATE ON bookings
FOR EACH ROW
BEGIN
  IF NEW.status = 'CONFIRMED' AND EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.seat_id = NEW.seat_id AND b.status = 'CONFIRMED' AND b.booking_id <> NEW.booking_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Seat already has a CONFIRMED booking';
  END IF;
END;;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_bookings_after_insert AFTER INSERT ON bookings
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('bookings', 'INSERT', NEW.booking_id, NULL,
          JSON_OBJECT('trip_id', NEW.trip_id, 'seat_id', NEW.seat_id,
                      'passenger_id', NEW.passenger_id, 'status', NEW.status));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_bookings_after_update AFTER UPDATE ON bookings
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('bookings', 'UPDATE', NEW.booking_id,
          JSON_OBJECT('trip_id', OLD.trip_id, 'seat_id', OLD.seat_id,
                      'passenger_id', OLD.passenger_id, 'status', OLD.status),
          JSON_OBJECT('trip_id', NEW.trip_id, 'seat_id', NEW.seat_id,
                      'passenger_id', NEW.passenger_id, 'status', NEW.status));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_bookings_after_delete AFTER DELETE ON bookings
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('bookings', 'DELETE', OLD.booking_id,
          JSON_OBJECT('trip_id', OLD.trip_id, 'seat_id', OLD.seat_id,
                      'passenger_id', OLD.passenger_id, 'status', OLD.status), NULL);;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_payments_after_insert AFTER INSERT ON payments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('payments', 'INSERT', NEW.payment_id, NULL,
          JSON_OBJECT('booking_id', NEW.booking_id, 'amount', NEW.amount, 'status', NEW.status));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_payments_after_update AFTER UPDATE ON payments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('payments', 'UPDATE', NEW.payment_id,
          JSON_OBJECT('booking_id', OLD.booking_id, 'amount', OLD.amount, 'status', OLD.status),
          JSON_OBJECT('booking_id', NEW.booking_id, 'amount', NEW.amount, 'status', NEW.status));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_payments_after_delete AFTER DELETE ON payments
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('payments', 'DELETE', OLD.payment_id,
          JSON_OBJECT('booking_id', OLD.booking_id, 'amount', OLD.amount, 'status', OLD.status), NULL);;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_luggage_after_insert AFTER INSERT ON luggage
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('luggage', 'INSERT', NEW.luggage_id, NULL,
          JSON_OBJECT('booking_id', NEW.booking_id, 'kg', NEW.kg, 'fee', NEW.fee));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_luggage_after_update AFTER UPDATE ON luggage
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('luggage', 'UPDATE', NEW.luggage_id,
          JSON_OBJECT('booking_id', OLD.booking_id, 'kg', OLD.kg, 'fee', OLD.fee),
          JSON_OBJECT('booking_id', NEW.booking_id, 'kg', NEW.kg, 'fee', NEW.fee));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_luggage_after_delete AFTER DELETE ON luggage
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('luggage', 'DELETE', OLD.luggage_id,
          JSON_OBJECT('booking_id', OLD.booking_id, 'kg', OLD.kg, 'fee', OLD.fee), NULL);;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_seats_after_insert AFTER INSERT ON seats
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('seats', 'INSERT', NEW.seat_id, NULL,
          JSON_OBJECT('trip_id', NEW.trip_id, 'seat_no', NEW.seat_no,
                      'class', NEW.class, 'fare', NEW.fare));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_seats_after_update AFTER UPDATE ON seats
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('seats', 'UPDATE', NEW.seat_id,
          JSON_OBJECT('trip_id', OLD.trip_id, 'seat_no', OLD.seat_no,
                      'class', OLD.class, 'fare', OLD.fare),
          JSON_OBJECT('trip_id', NEW.trip_id, 'seat_no', NEW.seat_no,
                      'class', NEW.class, 'fare', NEW.fare));;
DELIMITER ;

DELIMITER ;;
CREATE TRIGGER trg_seats_after_delete AFTER DELETE ON seats
FOR EACH ROW
  INSERT INTO audit_log (table_name, action, row_id, old_data, new_data)
  VALUES ('seats', 'DELETE', OLD.seat_id,
          JSON_OBJECT('trip_id', OLD.trip_id, 'seat_no', OLD.seat_no,
                      'class', OLD.class, 'fare', OLD.fare), NULL);;
DELIMITER ;
