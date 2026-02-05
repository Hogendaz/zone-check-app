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

const db = new sqlite3.Database("./checks.db");

// DB Table
db.serialize(() => {

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(
  now.getMonth() + 1
    ).padStart(2, "0")}`;

db.run(
  `INSERT OR IGNORE INTO meta (key, value)
   VALUES ('report_month', ?)`,
  [currentMonth]
);

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
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(
    `INSERT OR IGNORE INTO meta (key, value)
     VALUES ('report_start', ?)`,
    [new Date().toISOString()]
  );
});

function checkMonthlyRollover() {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;
  db.get(
    `SELECT value FROM meta WHERE key = 'report_month'`,
    (err, row) => {
      if (err || !row) return;

      const storedMonth = row.value;

      if (storedMonth !== thisMonth) {
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

checkMonthlyRollover();



function getShift(entryTimeISO) {
  const hour = new Date(entryTimeISO).getHours();
  return (hour >= 6 && hour < 18) ? "Day" : "Night";
}

// ✅ ADMIN LOGIN
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ success: true });
  }

  res.status(401).json({ success: false });
});

// ✅ PROTECTED ADMIN CHECKS (ONLY ONE)
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


//RESET REPORTING PERIOD (ARCHIVE)
app.post("/admin/reset", (req, res) => {
  if (!req.session.admin) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const now = new Date().toISOString();

  db.serialize(() => {
    db.run(`UPDATE checks SET archived = 1`);
    db.run(
      `UPDATE meta SET value = ? WHERE key = 'report_start'`,
      [now]
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


//SYNC WITH SHIFT + ARCHIVED
app.post("/sync", (req, res) => {
  const {
    badge_number,
    zone,
    entry_time,
    exit_time,
    duration_minutes
  } = req.body;

  const shift = getShift(entry_time);

  db.run(
    `INSERT INTO checks
     (badge_number, zone, entry_time, exit_time, duration_minutes, shift, archived)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [badge_number, zone, entry_time, exit_time, duration_minutes, shift],
    err => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Insert failed" });
      }
      res.json({ success: true });
    }
  );
});

app.listen(3000, () =>
  console.log("✅ Server running at http://localhost:3000")
);