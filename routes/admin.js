"use strict";

/**
 * routes/admin.js
 *
 * Admin-only routes — every handler here checks req.session.admin before
 * doing anything else. The requireAdmin middleware centralises that check
 * so it can't accidentally be omitted from a new route.
 *
 *   POST /admin/login             — authenticate and start a session
 *   GET  /checks                  — fetch all checks (with optional archive toggle)
 *   POST /admin/reset             — start a new reporting period
 *   GET  /admin/report-start      — return the current period's start timestamp
 *   GET  /admin/edits             — view the full edit audit trail
 */

const { Router } = require("express");
const crypto = require("crypto");
const { db, checkMonthlyRollover } = require("../lib/db");
const { getMonthKey } = require("../lib/time");

const router = Router();

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS; // validated as non-empty in server.js

/* -----------------------------------------------------------------------
   HELPERS
----------------------------------------------------------------------- */

/**
 * Timing-safe string comparison.
 * Prevents timing attacks where an attacker measures how long the comparison
 * takes to guess the password one character at a time. crypto.timingSafeEqual
 * always takes the same amount of time regardless of where strings differ.
 */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware that rejects unauthenticated requests with 403.
 * Apply to any route that requires admin access.
 */
function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

/* -----------------------------------------------------------------------
   POST /admin/login
----------------------------------------------------------------------- */
router.post("/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  const validUser = typeof username === "string" && safeCompare(username, ADMIN_USER);
  const validPass = typeof password === "string" && safeCompare(password, ADMIN_PASS);

  if (validUser && validPass) {
    req.session.admin = true;
    return res.json({ success: true });
  }

  res.status(401).json({ success: false });
});

/* -----------------------------------------------------------------------
   GET /checks
   Returns all checks, optionally including archived ones.
   Also triggers the monthly rollover check so the report is always current.
----------------------------------------------------------------------- */
router.get("/checks", requireAdmin, (req, res) => {
  checkMonthlyRollover();

  const showArchived = req.query.archived === "1";
  const query = showArchived
    ? `SELECT * FROM checks WHERE archived = 1 ORDER BY entry_time DESC`
    : `SELECT * FROM checks WHERE archived = 0 ORDER BY entry_time DESC`;

  db.all(query, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "DB error" });
    }
    res.json(rows);
  });
});

/* -----------------------------------------------------------------------
   POST /admin/reset
   Archives all current-period checks and starts a fresh reporting period.
----------------------------------------------------------------------- */
router.post("/admin/reset", requireAdmin, (req, res) => {
  const now = new Date();

  db.serialize(() => {
    db.run(`UPDATE checks SET archived = 1`);
    db.run(`UPDATE meta SET value = ? WHERE key = 'report_start'`, [now.toISOString()]);
    db.run(
      `UPDATE meta SET value = ? WHERE key = 'report_month'`,
      [getMonthKey(now)],
      (err) => {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: "DB error" });
        }
        res.json({ success: true });
      }
    );
  });
});

/* -----------------------------------------------------------------------
   GET /admin/report-start
   Returns the ISO timestamp when the current reporting period started.
----------------------------------------------------------------------- */
router.get("/admin/report-start", requireAdmin, (req, res) => {
  db.get(`SELECT value FROM meta WHERE key = 'report_start'`, (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "DB error" });
    }
    res.json({ start: row?.value ?? null });
  });
});

/* -----------------------------------------------------------------------
   GET /admin/edits
   Returns the full edit audit trail from check_edits.
   Optional query param: ?check_id=N  — narrows to edits for one check.
----------------------------------------------------------------------- */
router.get("/admin/edits", requireAdmin, (req, res) => {
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

module.exports = router;
