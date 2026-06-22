"use strict";

/**
 * routes/checks.js
 *
 * Deputy-facing routes:
 *   GET  /active-check/:badge     — cross-device session check
 *   POST /sync                    — enter or exit a zone (with offline support)
 *   POST /force-exit/:badge       — close a session open on another device
 *   GET  /my-checks/:badge        — list current-period checks for a deputy
 *   POST /checks/:id/edit         — deputy time correction (triggers audit log)
 */

const { Router } = require("express");
const { db } = require("../lib/db");
const { ZONES, getShift, computeDurationMinutes } = require("../lib/time");

const router = Router();

/* -----------------------------------------------------------------------
   GET /active-check/:badge
   Returns whether this badge has an open (un-exited) check in the current
   period. Used by the frontend to enforce cross-device session integrity.
----------------------------------------------------------------------- */
router.get("/active-check/:badge", (req, res) => {
  const badge = req.params.badge;

  db.get(
    `SELECT zone, entry_time FROM checks
     WHERE badge_number = ? AND exit_time IS NULL AND archived = 0`,
    [badge],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }
      if (row) {
        return res.json({ active: true, zone: row.zone, entry_time: row.entry_time });
      }
      res.json({ active: false });
    }
  );
});

/* -----------------------------------------------------------------------
   POST /sync
   Called by the frontend when a deputy enters or exits a zone.
   Also handles the offline case: a device that was offline during both
   enter and exit will send a single request with both entry_time and
   exit_time set.

   Duration and shift are ALWAYS computed server-side from the stored
   timestamps — the client's local duration value is never trusted.
----------------------------------------------------------------------- */
router.post("/sync", (req, res) => {
  const { badge_number, zone, entry_time, exit_time, blm_location } = req.body || {};

  if (!badge_number || !zone || !entry_time) {
    return res
      .status(400)
      .json({ error: "badge_number, zone, and entry_time are required" });
  }

  if (!ZONES.includes(zone)) {
    return res.status(400).json({ error: "Invalid zone" });
  }

  // Fetch the current open check so we can use its stored entry_time and zone
  // when computing duration on exit (rather than trusting client input).
  db.get(
    `SELECT id, entry_time, zone FROM checks
     WHERE badge_number = ? AND exit_time IS NULL AND archived = 0`,
    [badge_number],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }

      if (!row) {
        // No open check — this is an ENTER (or an offline device catching up
        // with a complete entry+exit in one shot).
        const shift = getShift(entry_time);
        const duration = exit_time
          ? computeDurationMinutes(zone, entry_time, exit_time)
          : null;

        db.run(
          `INSERT INTO checks
             (badge_number, zone, entry_time, exit_time,
              duration_minutes, shift, archived, blm_location)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [badge_number, zone, entry_time, exit_time || null, duration, shift, blm_location || null],
          (insertErr) => {
            if (insertErr) {
              console.error(insertErr);
              return res.status(500).json({ error: "DB error" });
            }
            res.json({ success: true });
          }
        );
      } else if (exit_time) {
        // Open check found — this is an EXIT.
        // Recompute duration from the *stored* entry_time, not what the client sent.
        const duration = computeDurationMinutes(row.zone, row.entry_time, exit_time);

        db.run(
          `UPDATE checks SET exit_time = ?, duration_minutes = ? WHERE id = ?`,
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
        // Already has an open check and no exit_time — idempotent no-op.
        res.json({ success: true });
      }
    }
  );
});

/* -----------------------------------------------------------------------
   POST /force-exit/:badge
   Closes the open check for a badge from the current device when the
   original session is on another device. Duration is computed server-side.
----------------------------------------------------------------------- */
router.post("/force-exit/:badge", (req, res) => {
  const badge = req.params.badge;
  const now = new Date();

  db.get(
    `SELECT id, entry_time, zone FROM checks
     WHERE badge_number = ? AND exit_time IS NULL AND archived = 0`,
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
        `UPDATE checks SET exit_time = ?, duration_minutes = ? WHERE id = ?`,
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

/* -----------------------------------------------------------------------
   GET /my-checks/:badge
   Returns the current-period checks for a deputy, including the row id
   (needed for editing) and whether the check has been edited.
----------------------------------------------------------------------- */
router.get("/my-checks/:badge", (req, res) => {
  const badge = req.params.badge;

  db.all(
    `SELECT id, zone, entry_time, exit_time, duration_minutes, blm_location, edited
     FROM checks
     WHERE badge_number = ? AND archived = 0
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

/* -----------------------------------------------------------------------
   POST /checks/:id/edit
   Deputy-initiated time correction. The deputy must supply:
     - badge_number  (ownership check — you can only edit your own checks)
     - entry_time    (required; the new entry timestamp)
     - exit_time     (optional; omit to keep the existing exit time)
     - reason        (required; recorded verbatim in the audit log)

   An immutable row is inserted into check_edits BEFORE the check is
   updated, capturing the before/after values. The checks row is then
   updated with server-recomputed duration and shift.
----------------------------------------------------------------------- */
router.post("/checks/:id/edit", (req, res) => {
  const checkId = Number(req.params.id);
  const { badge_number, entry_time, exit_time, reason } = req.body || {};

  if (!Number.isInteger(checkId)) {
    return res.status(400).json({ error: "Invalid check id" });
  }
  if (!badge_number || !entry_time) {
    return res.status(400).json({ error: "badge_number and entry_time are required" });
  }
  if (typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({ error: "A reason for the change is required" });
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
        return res
          .status(400)
          .json({ error: "Cannot edit a check from an archived period" });
      }
      if (row.badge_number !== badge_number) {
        return res.status(403).json({ error: "You can only edit your own checks" });
      }

      // If no new exit_time is provided, keep the existing one rather than
      // clearing it — a deputy fixing only the entry time shouldn't lose their exit.
      const finalExitTime = exit_time || row.exit_time;

      if (finalExitTime) {
        const exitDate = new Date(finalExitTime);
        if (isNaN(exitDate.getTime())) {
          return res.status(400).json({ error: "Invalid exit_time" });
        }
        if (exitDate <= newEntryDate) {
          return res
            .status(400)
            .json({ error: "exit_time must be after entry_time" });
        }
      }

      const newDuration = finalExitTime
        ? computeDurationMinutes(row.zone, entry_time, finalExitTime)
        : null;
      const newShift = getShift(entry_time);
      const editedAt = new Date().toISOString();

      // Write the audit record first, then update the check.
      // db.serialize() ensures these run in order even though sqlite3's
      // callback API is otherwise unordered.
      db.serialize(() => {
        db.run(
          `INSERT INTO check_edits
             (check_id, edited_by, edited_at,
              old_entry_time, new_entry_time,
              old_exit_time,  new_exit_time,
              old_duration_minutes, new_duration_minutes,
              reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            checkId, badge_number, editedAt,
            row.entry_time,       entry_time,
            row.exit_time,        finalExitTime || null,
            row.duration_minutes, newDuration,
            reason.trim(),
          ],
          (auditErr) => {
            if (auditErr) console.error("Failed to write audit record:", auditErr.message);
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

module.exports = router;
