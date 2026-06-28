require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const sessionCookieName = "medhini_user";
const sessionSecret = process.env.SESSION_SECRET || "change-this-secret-before-hosting";

const inputters = {
  Kusal: true,
  Maneesha: true
};
const treatmentDays = new Set([0, 3, 4, 6]);

let pool = null;
let databaseReadyPromise = null;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/api/health", asyncHandler(async (req, res) => {
  await ensureDatabase();
  res.json({ ok: true });
}));

app.get("/api/me", (req, res) => {
  res.json({ user: getSessionUser(req) });
});

app.post("/api/login", (req, res) => {
  const { user } = req.body || {};
  if (!inputters[user]) {
    return res.status(401).json({ error: "Unknown inputter." });
  }
  setSessionUser(res, user);
  res.json({ user });
});

app.post("/api/logout", (req, res) => {
  clearSessionUser(res);
  res.json({ ok: true });
});

app.get("/api/appointments", requireLogin, asyncHandler(async (req, res) => {
  await ensureDatabase();
  const [rows] = await pool.query(
    `SELECT
      id,
      DATE_FORMAT(appointment_date, '%Y-%m-%d') AS date,
      TIME_FORMAT(appointment_time, '%H:%i') AS time,
      duration_minutes AS duration,
      treatment_type AS treatmentType,
      patient_name AS name,
      phone,
      note,
      payment_status AS paymentStatus,
      appointment_status AS appointmentStatus,
      created_by AS createdBy,
      created_at AS createdAt
    FROM appointments
    ORDER BY appointment_date ASC, appointment_time ASC, id ASC`
  );
  res.json({ appointments: rows });
}));

app.post("/api/appointments", requireLogin, asyncHandler(async (req, res) => {
  await ensureDatabase();
  const item = validateAppointment(req.body || {});
  const currentUser = getSessionUser(req);
  const [result] = await pool.query(
    `INSERT INTO appointments
      (appointment_date, appointment_time, duration_minutes, treatment_type, patient_name, phone, note, payment_status, appointment_status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [item.date, item.time, item.duration, item.treatmentType, item.name, item.phone, item.note, "not_paid", "active", currentUser]
  );
  const [rows] = await pool.query(
    `SELECT
      id,
      DATE_FORMAT(appointment_date, '%Y-%m-%d') AS date,
      TIME_FORMAT(appointment_time, '%H:%i') AS time,
      duration_minutes AS duration,
      treatment_type AS treatmentType,
      patient_name AS name,
      phone,
      note,
      payment_status AS paymentStatus,
      appointment_status AS appointmentStatus,
      created_by AS createdBy,
      created_at AS createdAt
    FROM appointments
    WHERE id = ?`,
    [result.insertId]
  );
  res.status(201).json({ appointment: rows[0] });
}));

app.patch("/api/appointments/:id", requireLogin, asyncHandler(async (req, res) => {
  await ensureDatabase();
  const patch = validateAppointmentPatch(req.body || {});
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "No changes provided." });
  }

  const updates = [];
  const values = [];
  if (patch.paymentStatus) {
    updates.push("payment_status = ?");
    values.push(patch.paymentStatus);
  }
  if (patch.appointmentStatus) {
    updates.push("appointment_status = ?");
    values.push(patch.appointmentStatus);
  }
  values.push(req.params.id);

  await pool.query(`UPDATE appointments SET ${updates.join(", ")} WHERE id = ?`, values);
  const [rows] = await pool.query(
    `SELECT
      id,
      DATE_FORMAT(appointment_date, '%Y-%m-%d') AS date,
      TIME_FORMAT(appointment_time, '%H:%i') AS time,
      duration_minutes AS duration,
      treatment_type AS treatmentType,
      patient_name AS name,
      phone,
      note,
      payment_status AS paymentStatus,
      appointment_status AS appointmentStatus,
      created_by AS createdBy,
      created_at AS createdAt
    FROM appointments
    WHERE id = ?`,
    [req.params.id]
  );
  res.json({ appointment: rows[0] });
}));

app.delete("/api/appointments/:id", requireLogin, asyncHandler(async (req, res) => {
  await ensureDatabase();
  await pool.query("DELETE FROM appointments WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
}));

app.post("/api/appointments/import", requireLogin, asyncHandler(async (req, res) => {
  await ensureDatabase();
  const appointments = Array.isArray(req.body && req.body.appointments) ? req.body.appointments : null;
  if (!appointments) {
    return res.status(400).json({ error: "Invalid import file." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("DELETE FROM appointments");
    for (const raw of appointments) {
      const item = validateAppointment(raw);
      await connection.query(
        `INSERT INTO appointments
          (appointment_date, appointment_time, duration_minutes, treatment_type, patient_name, phone, note, payment_status, appointment_status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.date,
          item.time,
          item.duration,
          item.treatmentType,
          item.name,
          item.phone,
          item.note,
          raw.paymentStatus || "not_paid",
          raw.appointmentStatus || "active",
          raw.createdBy || getSessionUser(req)
        ]
      );
    }
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.publicMessage || "Server error." });
});

if (require.main === module) {
  start();
}

module.exports = app;

async function start() {
  try {
    await ensureDatabase();
    app.listen(port, () => {
      console.log(`Medhini appointment server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Could not connect to MySQL. Check .env database settings and Aiven SSL access.");
    console.error(error.message);
    process.exit(1);
  }
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      appointment_date DATE NOT NULL,
      appointment_time TIME NOT NULL,
      duration_minutes INT UNSIGNED NOT NULL DEFAULT 60,
      treatment_type VARCHAR(20) NOT NULL DEFAULT 'wellness',
      patient_name VARCHAR(160) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      note TEXT NULL,
      payment_status VARCHAR(20) NOT NULL DEFAULT 'not_paid',
      appointment_status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_by VARCHAR(40) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_appointment_day_time (appointment_date, appointment_time),
      INDEX idx_phone (phone)
    )
  `);
  await addColumnIfMissing("appointments", "treatment_type", "VARCHAR(20) NOT NULL DEFAULT 'wellness'");
  await addColumnIfMissing("appointments", "payment_status", "VARCHAR(20) NOT NULL DEFAULT 'not_paid'");
  await addColumnIfMissing("appointments", "appointment_status", "VARCHAR(20) NOT NULL DEFAULT 'active'");
}

async function addColumnIfMissing(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (Number(rows[0].count) === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function requireLogin(req, res, next) {
  if (!getSessionUser(req)) {
    return res.status(401).json({ error: "Please log in first." });
  }
  next();
}

function ensureDatabase() {
  if (process.env.VERCEL && !process.env.DB_HOST) {
    throw badRequest("DB_HOST is missing in Vercel Environment Variables.");
  }
  if (!pool) {
    pool = createPool();
  }
  if (!databaseReadyPromise) {
    databaseReadyPromise = initializeDatabase().catch((error) => {
      databaseReadyPromise = null;
      throw error;
    });
  }
  return databaseReadyPromise;
}

function createPool() {
  const mysqlSsl = process.env.DB_SSL === "true"
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true" }
    : undefined;

  return mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "defaultdb",
    ssl: mysqlSsl,
    waitForConnections: true,
    connectionLimit: 10
  });
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const value = cookies[sessionCookieName];
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const user = Buffer.from(parts[0], "base64url").toString("utf8");
  const expected = signValue(parts[0]);
  if (parts[1].length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) {
    return null;
  }
  return inputters[user] ? user : null;
}

function setSessionUser(res, user) {
  const encodedUser = Buffer.from(user, "utf8").toString("base64url");
  const signedValue = encodedUser + "." + signValue(encodedUser);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookieName}=${signedValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
}

function clearSessionUser(res) {
  res.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function signValue(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(";").reduce((cookies, cookie) => {
    const index = cookie.indexOf("=");
    if (index === -1) return cookies;
    const key = cookie.slice(0, index).trim();
    const value = cookie.slice(index + 1).trim();
    cookies[key] = value;
    return cookies;
  }, {});
}

function asyncHandler(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function validateAppointment(raw) {
  const item = {
    date: String(raw.date || "").slice(0, 10),
    time: String(raw.time || "").slice(0, 5),
    duration: Number(raw.duration || raw.durationMinutes || 60),
    treatmentType: raw.treatmentType === "normal" ? "normal" : "wellness",
    name: String(raw.name || "").trim(),
    phone: String(raw.phone || "").trim(),
    note: String(raw.note || "").trim()
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
    throw badRequest("Appointment date is invalid.");
  }
  if (!isTreatmentDay(item.date)) {
    throw badRequest("This date is not a treatment day.");
  }
  if (!/^\d{2}:\d{2}$/.test(item.time)) {
    throw badRequest("Appointment time is invalid.");
  }
  if (!item.name || !item.phone) {
    throw badRequest("Name and phone number are required.");
  }
  if (!Number.isFinite(item.duration) || item.duration < 15 || item.duration > 480) {
    throw badRequest("Appointment length is invalid.");
  }

  return item;
}

function validateAppointmentPatch(raw) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(raw, "paymentStatus")) {
    if (!["not_paid", "paid"].includes(raw.paymentStatus)) {
      throw badRequest("Payment status is invalid.");
    }
    patch.paymentStatus = raw.paymentStatus;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "appointmentStatus")) {
    if (!["active", "cancel", "reschedule"].includes(raw.appointmentStatus)) {
      throw badRequest("Appointment status is invalid.");
    }
    patch.appointmentStatus = raw.appointmentStatus;
  }
  return patch;
}

function isTreatmentDay(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return treatmentDays.has(date.getDay());
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.publicMessage = message;
  return error;
}
