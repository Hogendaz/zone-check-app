"use strict";

/**
 * lib/db.js
 *
 * Owns the SQLite connection, schema setup, and the monthly rollover check.
 * Everything else imports { db } from here — no other file opens its own
 * database connection.
 *
 * MIGRATIONS
 * ----------
 * SQLite doesn't support transactional DDL or a schema version table out of
 * the box, so we track applied migrations in a `migrations` table. Each
 * migration is a plain SQL string keyed by a sortable name. On startup the
 * db.serialize() block runs pending migrations in order, safely skipping
 * anything already recorded in the migrations table.
 *
 * To add a column or table in the future: add a new entry to MIGRATIONS below
 * and deploy. No ALTER TABLE + "duplicate column" error-parsing needed.
 */

const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const { getMonthKey } = require("./time");

const DEFAULT_DB_PATH = process.env.NODE_ENV === "production"
  ? "/data/checks.db"
  : "./checks.db";
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

if (process.env.NODE_ENV === "production" && !process.env.DB_PATH) {
  console.warn(
    "⚠️  DB_PATH is not set in production. Defaulting to /data/checks.db."
  );
}

if (DB_PATH !== DEFAULT_DB_PATH) {
  console.log(`ℹ️  Using custom DB_PATH: ${DB_PATH}`);
}

const dbExists = fs.existsSync(DB_PATH);
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Failed to open database:", err.message);
    process.exit(1);
  }
  console.log(`📂 Database: ${DB_PATH}`);
  if (!dbExists) {
    console.warn(
      "⚠️  Database file did not exist; a new SQLite database was created."
    );
  }
});

/* -----------------------------------------------------------------------
   MIGRATIONS
   Each entry: { name: string (unique, sortable), sql: string }
   - name must be unique and should sort chronologically (YYYYMMDD_description)
   - sql is run exactly once, ever, for each database file
   - Never edit an existing entry — add a new one instead
----------------------------------------------------------------------- */
const MIGRATIONS = [
  {
    name: "20240101_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS checks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        badge_number     TEXT    NOT NULL,
        zone             TEXT    NOT NULL,
        entry_time       TEXT    NOT NULL,
        exit_time        TEXT,
        duration_minutes INTEGER,
        shift            TEXT,
        archived         INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `,
  },
  {
    name: "20240201_add_blm_location",
    sql: `ALTER TABLE checks ADD COLUMN blm_location TEXT;`,
  },
  {
    name: "20240301_add_edited_flag",
    sql: `ALTER TABLE checks ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    name: "20240302_add_check_edits_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS check_edits (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id             INTEGER NOT NULL,
        edited_by            TEXT    NOT NULL,
        edited_at            TEXT    NOT NULL,
        old_entry_time       TEXT,
        new_entry_time       TEXT,
        old_exit_time        TEXT,
        new_exit_time        TEXT,
        old_duration_minutes INTEGER,
        new_duration_minutes INTEGER,
        reason               TEXT    NOT NULL
      );
    `,
  },
];

/**
 * Runs all pending migrations in order, then seeds initial metadata if needed.
 * Called once at server startup; safe to call multiple times (idempotent).
 * @returns {Promise<void>}
 */
function initDb() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // The migrations table tracks which migrations have already been applied.
      db.run(
        `CREATE TABLE IF NOT EXISTS migrations (
           name       TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`,
        (err) => {
          if (err) return reject(err);
        }
      );

      db.all("SELECT name FROM migrations", (err, applied) => {
        if (err) return reject(err);

        const appliedNames = new Set((applied || []).map((r) => r.name));
        const pending = MIGRATIONS.filter((m) => !appliedNames.has(m.name));

        if (pending.length === 0) {
          console.log("✅ Database schema is up to date.");
        }

        // Process migrations sequentially to avoid race conditions
        let migrationIndex = 0;
        const runNextMigration = () => {
          if (migrationIndex >= pending.length) {
            // All migrations complete — seed metadata
            const now = new Date();
            db.run(
              `INSERT OR IGNORE INTO meta (key, value) VALUES ('report_month', ?)`,
              [getMonthKey(now)]
            );
            db.run(
              `INSERT OR IGNORE INTO meta (key, value) VALUES ('report_start', ?)`,
              [now.toISOString()],
              (err) => {
                if (err) return reject(err);
                resolve();
              }
            );
            return;
          }

          const migration = pending[migrationIndex++];
          // Use db.exec for multi-statement migrations (no callback available)
          // Split by semicolon and run each statement with db.run
          const statements = migration.sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

          let stmtIndex = 0;
          const runNextStatement = () => {
            if (stmtIndex >= statements.length) {
              // All statements for this migration complete
              db.run(
                `INSERT INTO migrations (name, applied_at) VALUES (?, ?)`,
                [migration.name, new Date().toISOString()],
                (insertErr) => {
                  if (insertErr) return reject(insertErr);
                  console.log(`  ✓ Applied migration: ${migration.name}`);
                  runNextMigration();
                }
              );
              return;
            }

            const stmt = statements[stmtIndex++];
            db.run(stmt, (stmtErr) => {
              if (stmtErr) {
                console.error(`Migration failed [${migration.name}]:`, stmtErr.message);
                return reject(stmtErr);
              }
              runNextStatement();
            });
          };

          runNextStatement();
        };

        runNextMigration();
      });
    });
  });
}

/**
 * Archives all current-period checks when the calendar month has rolled over
 * since the last recorded report_month. Called at startup and before
 * serving the admin checks report.
 */
function checkMonthlyRollover() {
  const now = new Date();
  const thisMonth = getMonthKey(now);

  db.get(`SELECT value FROM meta WHERE key = 'report_month'`, (err, row) => {
    if (err) {
      console.error("Rollover check failed:", err.message);
      return;
    }
    if (!row) return;

    if (row.value !== thisMonth) {
      console.log("📅 New month detected — archiving previous period");
      db.serialize(() => {
        db.run(`UPDATE checks SET archived = 1 WHERE archived = 0`);
        db.run(`UPDATE meta SET value = ? WHERE key = 'report_month'`, [thisMonth]);
        db.run(`UPDATE meta SET value = ? WHERE key = 'report_start'`, [
          now.toISOString(),
        ]);
      });
    }
  });
}

module.exports = { db, initDb, checkMonthlyRollover };
