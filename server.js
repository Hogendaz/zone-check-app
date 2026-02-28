const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const session = require("express-session");

const ADMIN_USER = "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme123";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.use(session({
  secret: "zone-check-secret-key",
  resave: false,
  saveUninitialized: false
}));

const db = new sqlite3.Database("/data/checks.db");

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
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Initialize reporting metadata
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;

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
  const thisMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;

  db.get(
    `SELECT value FROM meta WHERE key = 'report_month'`,
    (err, row) => {
      if (err || !row) return;

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
function getShift(entryTimeISO) {
  const hour = new Date(entryTimeISO).getHours();
  return (hour >= 6 && hour < 18) ? "Day" : "Night";
}

/* =====================
   AUTH
===================== */
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
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
  const currentMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;

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
      res.json({ start: row?.value });
    }
  );
});

/* =====================
   SYNC
===================== */
app.post("/sync", (req, res) => {
  const {
    badge_number,
    zone,
    entry_time,
    exit_time,
    duration_minutes,
    blm_location
  } = req.body;

  // Check if an active check already exists
  db.get(
    `SELECT id FROM checks
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
        // INSERT (enter)
        const shift = getShift(entry_time);

        db.run(
          `INSERT INTO checks
           (badge_number, zone, entry_time, exit_time, duration_minutes, shift, archived, blm_location)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [
                badge_number,
                zone,
                entry_time,
                exit_time || null,
                duration_minutes || null,
                shift,
                blm_location || null
          ],
          () => res.json({ success: true })
        );
      } else if (exit_time) {
        // UPDATE (exit)
        db.run(
          `UPDATE checks
           SET exit_time = ?, duration_minutes = ?
           WHERE id = ?`,
          [exit_time, duration_minutes, row.id],
          () => res.json({ success: true })
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

      let duration = Math.round(
        (now - new Date(row.entry_time)) / 60000
      );
        // BLM Only - round UP to next 15-minute block
      if (row.zone === "BLM") {
        duration = Math.ceil(duration / 15) * 15;
      }

      db.run(
        `UPDATE checks
         SET exit_time = ?, duration_minutes = ?
         WHERE id = ?`,
        [now.toISOString(), duration, row.id],
        () => res.json({ success: true, duration })
      );
    }
  );
});

app.get("/my-checks/:badge", (req, res) => {
  const badge = req.params.badge;

  db.all(
    `SELECT zone, entry_time, exit_time, duration_minutes, blm_location
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



app.listen(3000, () =>
  console.log("✅ Server running at http://localhost:3000")
);
