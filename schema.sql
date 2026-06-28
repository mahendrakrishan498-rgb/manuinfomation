CREATE TABLE IF NOT EXISTS appointments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  duration_minutes INT UNSIGNED NOT NULL DEFAULT 60,
  patient_name VARCHAR(160) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  note TEXT NULL,
  created_by VARCHAR(40) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_appointment_day_time (appointment_date, appointment_time),
  INDEX idx_phone (phone)
);
