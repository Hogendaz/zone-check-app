"use strict";

/**
 * lib/time.js
 *
 * All time-related helpers and zone policy logic live here.
 * Server routes import from this module; nothing else should reimplement
 * these rules inline. The client-side timer in index.html is purely cosmetic
 * (live elapsed display) and is NOT authoritative — the server always
 * recomputes durations from stored timestamps.
 */

/** Valid zone names. Any code that needs this list should import it from here
 *  rather than repeating the array — add a zone in one place. */
const ZONES = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "BLM"];

/**
 * Returns "Day" or "Night" based on entry hour (local server time).
 * Day shift: 06:00 – 17:59. Night shift: 18:00 – 05:59.
 * @param {string} entryTimeISO
 * @returns {"Day"|"Night"}
 */
function getShift(entryTimeISO) {
  const hour = new Date(entryTimeISO).getHours();
  return hour >= 6 && hour < 18 ? "Day" : "Night";
}

/**
 * Returns a "YYYY-MM" string for the given Date (used as the report-period key).
 * @param {Date} date
 * @returns {string}
 */
function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Computes the billable duration in whole minutes between two ISO timestamps,
 * applying zone-specific rounding policy.
 *
 * BLM zone policy: round UP to the next 15-minute block.
 *   1 min → 15,  16 min → 30,  29 min → 30,  52 min → 60
 *
 * All other zones: round to nearest whole minute (standard Math.round).
 *
 * This is the ONLY place this calculation should exist. Both the /sync
 * and /checks/:id/edit routes call this — never the client.
 *
 * @param {string} zone
 * @param {string} entryTimeISO
 * @param {string} exitTimeISO
 * @returns {number} duration in minutes
 */
function computeDurationMinutes(zone, entryTimeISO, exitTimeISO) {
  const rawMinutes = Math.round(
    (new Date(exitTimeISO) - new Date(entryTimeISO)) / 60_000
  );
  return zone === "BLM" ? Math.ceil(rawMinutes / 15) * 15 : rawMinutes;
}

module.exports = { ZONES, getShift, getMonthKey, computeDurationMinutes };
