require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const sessionCookieName = "medhani_user";
const sessionSecret = process.env.SESSION_SECRET || "change-this-secret-before-hosting";

const inputters = {
  "Inputter 1": process.env.INPUTTER_1_PASSWORD || "black",
  "Inputter 2": process.env.INPUTTER_2_PASSWORD || "mouse"
};
const treatmentDays = new Set([0, 3, 4, 6]);

const mysqlSsl = process.env.DB_SSL === "true"
  ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true" }
  : undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "defaultdb",
  ssl: mysqlSsl,
  waitForConnections: true,
  connectionLimit: 10
});

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
  const { user, password } = req.body || {};
  if (!inputters[user] || inputters[user] !== password) {
    return res.status(401).json({ error: "Wrong password." });
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
      patient_name AS name,
      phone,
      note,
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
      (appointment_date, appointment_time, duration_minutes, patient_name, phone, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [item.date, item.time, item.duration, item.name, item.phone, item.note, currentUser]
  );
  const [rows] = await pool.query(
    `SELECT
      id,
      DATE_FORMAT(appointment_date, '%Y-%m-%d') AS date,
      TIME_FORMAT(appointment_time, '%H:%i') AS time,
      duration_minutes AS duration,
      patient_name AS name,
      phone,
      note,
      created_by AS createdBy,
      created_at AS createdAt
    FROM appointments
    WHERE id = ?`,
    [result.insertId]
  );
  res.status(201).json({ appointment: rows[0] });
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
          (appointment_date, appointment_time, duration_minutes, patient_name, phone, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [item.date, item.time, item.duration, item.name, item.phone, item.note, raw.createdBy || getSessionUser(req)]
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
      console.log(`Medhani appointment server running at http://localhost:${port}`);
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
      patient_name VARCHAR(160) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      note TEXT NULL,
      created_by VARCHAR(40) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_appointment_day_time (appointment_date, appointment_time),
      INDEX idx_phone (phone)
    )
  `);
}

function requireLogin(req, res, next) {
  if (!getSessionUser(req)) {
    return res.status(401).json({ error: "Please log in first." });
  }
  next();
}

function ensureDatabase() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = initializeDatabase().catch((error) => {
      databaseReadyPromise = null;
      throw error;
    });
  }
  return databaseReadyPromise;
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const value = cookies[sessionCookieName];
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const user = Buffer.from(parts[0], "base64url").toString("utf8");
  const expected = signValue(parts[0]);
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
