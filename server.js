const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const session = require("express-session");
const ADMIN_USER = "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme123" 

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

db.run(`
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_number TEXT,
    zone TEXT,
    entry_time TEXT,
    exit_time TEXT,
    duration_minutes INTEGER
  )
`);
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ success: true });
  }

  res.status(401).json({ success: false });
});

app.get("/checks", (req, res) => {
  if (!req.session.admin) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  db.all(`SELECT * FROM checks ORDER BY entry_time DESC`, (err, rows) => {
    res.json(rows);
  });
});


app.post("/sync", (req, res) => {
  const {
    badge_number,
    zone,
    entry_time,
    exit_time,
    duration_minutes
  } = req.body;

  db.run(
    `INSERT INTO checks
     (badge_number, zone, entry_time, exit_time, duration_minutes)
     VALUES (?, ?, ?, ?, ?)`,
    [badge_number, zone, entry_time, exit_time, duration_minutes],
    () => res.json({ success: true })
  );
});

app.get("/checks", (req, res) => {
  db.all(`SELECT * FROM checks ORDER BY entry_time DESC`, (err, rows) => {
    res.json(rows);
  });
});

app.listen(3000, () =>
  console.log("✅ Server running at http://localhost:3000")
);
