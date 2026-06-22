"use strict";

/**
 * server.js — entry point
 *
 * Responsibilities:
 *   1. Validate required environment variables (fail fast on bad config)
 *   2. Set up Express middleware (CORS, JSON parsing, sessions, static files)
 *   3. Mount route modules
 *   4. Initialise the database and start listening
 *
 * Business logic lives in:
 *   lib/time.js       — zone policy, shift calc, duration rounding
 *   lib/db.js         — database connection, migrations, rollover
 *   routes/checks.js  — deputy-facing routes
 *   routes/admin.js   — admin-only routes
 */

const express = require("express");
const cors    = require("cors");
const session = require("express-session");
const crypto  = require("crypto");

const { initDb } = require("./lib/db");
const checksRouter = require("./routes/checks");
const adminRouter  = require("./routes/admin");

/* -----------------------------------------------------------------------
   ENVIRONMENT / CONFIG
   - Dev: missing secrets get safe defaults + console warnings
   - Prod (NODE_ENV=production): missing secrets are fatal — fail fast
     rather than run with known-insecure values
----------------------------------------------------------------------- */
const isProd = process.env.NODE_ENV === "production";
const PORT   = parseInt(process.env.PORT || "3000", 10);

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (isProd) {
    console.error("FATAL: SESSION_SECRET must be set in production.");
    process.exit(1);
  }
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn(
    "⚠️  SESSION_SECRET not set — generated a random one for this run.\n" +
    "   Sessions won't survive a server restart. Set SESSION_SECRET in .env for dev."
  );
}

if (!process.env.ADMIN_PASS) {
  if (isProd) {
    console.error("FATAL: ADMIN_PASS must be set in production.");
    process.exit(1);
  }
  process.env.ADMIN_PASS = "changeme123";
  console.warn(
    "⚠️  ADMIN_PASS not set — using 'changeme123' for local dev only.\n" +
    "   Set ADMIN_PASS in .env before running locally with real data."
  );
}

/* -----------------------------------------------------------------------
   EXPRESS SETUP
----------------------------------------------------------------------- */
const app = express();

// CORS: disabled unless ALLOWED_ORIGIN is explicitly set.
// The app's own frontend is served same-origin and doesn't need CORS.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
app.use(
  cors(
    ALLOWED_ORIGIN
      ? { origin: ALLOWED_ORIGIN, credentials: true }
      : { origin: false }
  )
);

app.use(express.json());
app.use(express.static("public"));

if (isProd) {
  app.set("trust proxy", 1);
}

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,           // JS can't read the cookie
      secure: isProd,           // HTTPS only in production
      sameSite: "lax",          // blocks most CSRF vectors
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

/* -----------------------------------------------------------------------
   ROUTES
----------------------------------------------------------------------- */
app.use("/", checksRouter);
app.use("/", adminRouter);

/* -----------------------------------------------------------------------
   START
   initDb() runs all pending migrations, then resolves. We wait for it
   before accepting traffic so the schema is always current when the
   first request arrives.
----------------------------------------------------------------------- */
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialise database:", err.message);
    process.exit(1);
  });
