const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const session = require("express-session");
const crypto = require("crypto");

const isProd = process.env.NODE_ENV === "production";

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || "/data/checks.db";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
let ADMIN_PASS = process.env.ADMIN_PASS;
let SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  if (isProd) {
    console.error("FATAL: SESSION_SECRET environment variable must be set in production.");
    process.exit(1);
  }
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("⚠️  SESSION_SECRET not set — generated a random one for this run (dev only). Sessions won't survive a restart.");
}

if (!ADMIN_PASS) {
  if (isProd) {
    console.error("FATAL: ADMIN_PASS environment variable must be set in production.");
    process.exit(1);
  }
  ADMIN_PASS = "changeme123";
  console.warn("⚠️  ADMIN_PASS not set — using default 'changeme123' for local dev only. Do not deploy without setting this.");
}

/* Only allow cross-origin requests if ALLOWED_ORIGIN is explicitly configured.
   The app's own frontend is served same-origin and doesn't need CORS at all. */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

const app = express();
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN, credentials: true } : { origin: false }));
app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,        // requires HTTPS in production
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8 // 8 hour session
  }
}));

const db = new sqlite3.Database(DB_PATH);

/* =====================
   SCHEMA SETUP
===================== */
db.serialize(() => {
  // Core tables
  db.run(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      badge_number TEXT,
      zone TEXT,
      entry_time TEXT,
      exit_time TEXT,
      duration_minutes INTEGER,
      shift TEXT,
      archived INTEGER DEFAULT 0
    )
  `);

  db.run(`
  ALTER TABLE checks
  ADD COLUMN blm_location TEXT
`, err => {
  if (err && !err.message.includes("duplicate column")) {
    console.error("Error adding blm_location column:", err.message);
  }
});

  db.run(`
  ALTER TABLE checks
  ADD COLUMN edited INTEGER DEFAULT 0
`, err => {
  if (err && !err.message.includes("duplicate column")) {
    console.error("Error adding edited column:", err.message);
  }
});

  // Audit trail: one row per time correction a deputy makes to a check.
  // Never updated or deleted — append-only history.
  db.run(`
    CREATE TABLE IF NOT EXISTS check_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_id INTEGER NOT NULL,
      edited_by TEXT NOT NULL,
      edited_at TEXT NOT NULL,
      old_entry_time TEXT,
      new_entry_time TEXT,
      old_exit_time TEXT,
      new_exit_time TEXT,
      old_duration_minutes INTEGER,
      new_duration_minutes INTEGER,
      reason TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Initialize reporting metadata
  const now = new Date();
  const currentMonth = getMonthKey(now);

  db.run(
    `INSERT OR IGNORE INTO meta (key, value)
     VALUES ('report_month', ?)`,
    [currentMonth]
  );

  db.run(
    `INSERT OR IGNORE INTO meta (key, value)
     VALUES ('report_start', ?)`,
    [now.toISOString()]
  );
});

/* =====================
   MONTHLY ROLLOVER
===================== */
function checkMonthlyRollover() {
  const now = new Date();
  const thisMonth = getMonthKey(now);

  db.get(
    `SELECT value FROM meta WHERE key = 'report_month'`,
    (err, row) => {
      if (err) {
        console.error("Rollover check failed:", err.message);
        return;
      }
      if (!row) return;

      if (row.value !== thisMonth) {
        console.log("📅 New month detected — archiving previous month");

        db.serialize(() => {
          db.run(`UPDATE checks SET archived = 1 WHERE archived = 0`);
          db.run(
            `UPDATE meta SET value = ? WHERE key = 'report_month'`,
            [thisMonth]
          );
          db.run(
            `UPDATE meta SET value = ? WHERE key = 'report_start'`,
            [now.toISOString()]
          );
        });
      }
    }
  );
}

/* Run once at startup */
checkMonthlyRollover();

/* =====================
   HELPERS
===================== */
const ZONES = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "BLM"];

function getShift(entryTimeISO) {
  const hour = new Date(entryTimeISO).getHours();
  return (hour >= 6 && hour < 18) ? "Day" : "Night";
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/* BLM zone policy: round duration UP to the next 15-minute block.
   This is the single source of truth — the server always recomputes
   duration from entry/exit timestamps rather than trusting client input. */
function computeDurationMinutes(zone, entryTimeISO, exitTimeISO) {
  const minutes = Math.round(
    (new Date(exitTimeISO) - new Date(entryTimeISO)) / 60000
  );
  return zone === "BLM" ? Math.ceil(minutes / 15) * 15 : minutes;
}

/* =====================
   AUTH
===================== */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const validUser = typeof username === "string" && safeCompare(username, ADMIN_USER);
  const validPass = typeof password === "string" && safeCompare(password, ADMIN_PASS);

  if (validUser && validPass) {
    req.session.admin = true;
    return res.json({ success: true });
  }

  res.status(401).json({ success: false });
});

/* =====================
   ADMIN REPORTS
===================== */
app.get("/checks", (req, res) => {
  checkMonthlyRollover();

  if (!req.session.admin) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const showArchived = req.query.archived === "1";

  const query = showArchived
    ? `SELECT * FROM checks ORDER BY entry_time DESC`
    : `SELECT * FROM checks WHERE archived = 0 ORDER BY entry_time DESC`;

  db.all(query, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "DB error" });
    }
    res.json(rows);
  });
});

/* =====================
   ACTIVE CHECK (CROSS DEVICE)
===================== */
app.get("/active-check/:badge", (req, res) => {
  const badge = req.params.badge;

  db.get(
    `SELECT * FROM checks
     WHERE badge_number = ?
       AND exit_time IS NULL
       AND archived = 0`,
    [badge],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }

      if (row) {
        return res.json({
          active: true,
          zone: row.zone,
          entry_time: row.entry_time
        });
      }

      res.json({ active: false });
    }
  );
});

/* =====================
   ADMIN RESET
===================== */
app.post("/admin/reset", (req, res) => {
  if (!req.session.admin) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const now = new Date();
  const currentMonth = getMonthKey(now);

  db.serialize(() => {
    db.run(`UPDATE checks SET archived = 1`);
    db.run(
      `UPDATE meta SET value = ? WHERE key = 'report_start'`,
      [now.toISOString()]
    );
    db.run(
      `UPDATE meta SET value = ? WHERE key = 'report_month'`,
      [currentMonth]
    );
  });

  res.json({ success: true });
});

app.get("/admin/report-start", (req, res) => {
  if (!req.session.admin) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  db.get(
    `SELECT value FROM meta WHERE key = 'report_start'`,
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json({ start: row?.value });
    }
  );
});

/* =====================
   SYNC
===================== */
app.post("/sync", (req, res) => {
  const { badge_number, zone, entry_time, exit_time, blm_location } = req.body || {};

  if (!badge_number || !zone || !entry_time) {
    return res.status(400).json({ error: "badge_number, zone, and entry_time are required" });
  }

  if (!ZONES.includes(zone)) {
    return res.status(400).json({ error: "Invalid zone" });
  }

  // Check if an active check already exists (need entry_time + zone to compute duration below)
  db.get(
    `SELECT id, entry_time, zone FROM checks
     WHERE badge_number = ?
       AND exit_time IS NULL
       AND archived = 0`,
    [badge_number],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }

      if (!row) {
        // INSERT (enter) — exit_time may already be set if this is an offline
        // device syncing a completed visit in one shot.
        const shift = getShift(entry_time);
        const duration = exit_time
          ? computeDurationMinutes(zone, entry_time, exit_time)
          : null;

        db.run(
          `INSERT INTO checks
           (badge_number, zone, entry_time, exit_time, duration_minutes, shift, archived, blm_location)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [
            badge_number,
            zone,
            entry_time,
            exit_time || null,
            duration,
            shift,
            blm_location || null
          ],
          (insertErr) => {
            if (insertErr) {
              console.error(insertErr);
              return res.status(500).json({ error: "DB error" });
            }
            res.json({ success: true });
          }
        );
      } else if (exit_time) {
        // UPDATE (exit) — duration is computed from the stored entry_time
        // and the existing zone, not trusted from the client.
        const duration = computeDurationMinutes(row.zone, row.entry_time, exit_time);

        db.run(
          `UPDATE checks
           SET exit_time = ?, duration_minutes = ?
           WHERE id = ?`,
          [exit_time, duration, row.id],
          (updateErr) => {
            if (updateErr) {
              console.error(updateErr);
              return res.status(500).json({ error: "DB error" });
            }
            res.json({ success: true });
          }
        );
      } else {
        res.json({ success: true });
      }
    }
  );
});

app.post("/force-exit/:badge", (req, res) => {
  const badge = req.params.badge;

  const now = new Date();

  db.get(
    `SELECT id, entry_time, zone FROM checks
     WHERE badge_number = ?
       AND exit_time IS NULL
       AND archived = 0`,
    [badge],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }

      if (!row) {
        return res.json({ success: false, message: "No active zone found" });
      }

      const exitISO = now.toISOString();
      const duration = computeDurationMinutes(row.zone, row.entry_time, exitISO);

      db.run(
        `UPDATE checks
         SET exit_time = ?, duration_minutes = ?
         WHERE id = ?`,
        [exitISO, duration, row.id],
        (updateErr) => {
          if (updateErr) {
            console.error(updateErr);
            return res.status(500).json({ error: "DB error" });
          }
          res.json({ success: true, duration });
        }
      );
    }
  );
});

app.get("/my-checks/:badge", (req, res) => {
  const badge = req.params.badge;

  db.all(
    `SELECT id, zone, entry_time, exit_time, duration_minutes, blm_location, edited
     FROM checks
     WHERE badge_number = ?
       AND archived = 0
     ORDER BY entry_time DESC`,
    [badge],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json(rows);
    }
  );
});

/* =====================
   DEPUTY TIME CORRECTIONS
   Lets a deputy fix a check's entry/exit time (e.g. forgot to clock out).
   Every change is written to check_edits as an immutable audit record
   before the checks row itself is updated.
===================== */
app.post("/checks/:id/edit", (req, res) => {
  const checkId = Number(req.params.id);
  const { badge_number, entry_time, exit_time, reason } = req.body || {};

  if (!Number.isInteger(checkId)) {
    return res.status(400).json({ error: "Invalid check id" });
  }

  if (!badge_number || !entry_time || typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({
      error: "badge_number, entry_time, and a reason for the change are required"
    });
  }

  const newEntryDate = new Date(entry_time);
  if (isNaN(newEntryDate.getTime())) {
    return res.status(400).json({ error: "Invalid entry_time" });
  }

  db.get(
    `SELECT id, badge_number, zone, entry_time, exit_time, duration_minutes, archived
     FROM checks WHERE id = ?`,
    [checkId],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!row) {
        return res.status(404).json({ error: "Check not found" });
      }
      if (row.archived) {
        return res.status(400).json({ error: "Cannot edit a check from an archived period" });
      }
      // A deputy may only correct their own checks — never someone else's.
      if (row.badge_number !== badge_number) {
        return res.status(403).json({ error: "You can only edit your own checks" });
      }

      // exit_time is optional in the request: omitting it (or sending "")
      // leaves the existing exit_time untouched rather than clearing it.
      const finalExitTime = exit_time ? exit_time : row.exit_time;

      if (finalExitTime) {
        const exitDate = new Date(finalExitTime);
        if (isNaN(exitDate.getTime())) {
          return res.status(400).json({ error: "Invalid exit_time" });
        }
        if (exitDate <= newEntryDate) {
          return res.status(400).json({ error: "exit_time must be after entry_time" });
        }
      }

      const newDuration = finalExitTime
        ? computeDurationMinutes(row.zone, entry_time, finalExitTime)
        : null;
      const newShift = getShift(entry_time);
      const editedAt = new Date().toISOString();

      db.serialize(() => {
        db.run(
          `INSERT INTO check_edits
           (check_id, edited_by, edited_at, old_entry_time, new_entry_time,
            old_exit_time, new_exit_time, old_duration_minutes, new_duration_minutes, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            checkId, badge_number, editedAt,
            row.entry_time, entry_time,
            row.exit_time, finalExitTime || null,
            row.duration_minutes, newDuration,
            reason.trim()
          ],
          (editErr) => {
            if (editErr) console.error("Failed to log check edit:", editErr.message);
          }
        );

        db.run(
          `UPDATE checks
           SET entry_time = ?, exit_time = ?, duration_minutes = ?, shift = ?, edited = 1
           WHERE id = ?`,
          [entry_time, finalExitTime || null, newDuration, newShift, checkId],
          (updateErr) => {
            if (updateErr) {
              console.error(updateErr);
              return res.status(500).json({ error: "DB error" });
            }
            res.json({ success: true, duration_minutes: newDuration });
          }
        );
      });
    }
  );
});



/* =====================
   ADMIN: VIEW EDIT AUDIT TRAIL
===================== */
app.get("/admin/edits", (req, res) => {
  if (!req.session.admin) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const checkId = req.query.check_id ? Number(req.query.check_id) : null;

  const query = checkId
    ? `SELECT * FROM check_edits WHERE check_id = ? ORDER BY edited_at DESC`
    : `SELECT * FROM check_edits ORDER BY edited_at DESC`;
  const params = checkId ? [checkId] : [];

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "DB error" });
    }
    res.json(rows);
  });
});

app.listen(PORT, () =>
  console.log(`✅ Server running at http://localhost:${PORT}`)
);
