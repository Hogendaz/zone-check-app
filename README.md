🛰 Zone Activity Tracking System

A full-stack web application for tracking time spent within defined zones, featuring cross-device session enforcement, persistent storage, administrative reporting, and policy-based time rounding.

This project demonstrates backend architecture, database design, real-time UI state management, and multi-device session validation using Node.js and SQLite.

🚀 Features
✅ Multi-Zone Time Tracking

Users can:

Enter and exit predefined zones

View active session status

Track duration automatically

Supported zones:

Zone 1

Zone 2

Zone 3

Zone 4

BLM (includes sub-location tracking)

🔄 Cross-Device Session Enforcement

Prevents multiple active sessions for the same user

Server validates active check before allowing new entry

Force-exit functionality for cross-device resolution

Ensures session integrity across devices

💾 Persistent Storage

SQLite database

Deployed using a persistent disk path

Data survives redeployments and server restarts

Database path used in production:

/data/checks.db
📆 Monthly Reporting Rollover

Automatically archives previous reporting period

Tracks current reporting month in metadata table

Admin reset option available

🧮 Policy-Based Time Rounding (BLM Zone)

The BLM zone includes:

Required sub-location input

Time rounded up to the next 15-minute increment

Example behavior:

Actual Time	Stored Time
1 min	15
16 min	30
29 min	30
52 min	60

Rounding applies only to the BLM zone.

📊 Admin Dashboard

Administrative features include:

Badge filtering

Zone filtering

Shift filtering (Day/Night)

Date range filtering

Archived data toggle

Dynamic zone totals

Total time calculations

Printable report formatting

Archive watermark during print

📱 Mobile-Optimized UI

Large touch-friendly buttons

Clear active zone indicator

Real-time elapsed timer

Designed for field-style workflows

🏗 Tech Stack
Frontend

HTML5

CSS3

Vanilla JavaScript

IndexedDB (offline-friendly local storage)

Backend

Node.js

Express

SQLite3

express-session

Deployment

Render

Persistent Disk Storage

🗄 Database Schema
checks table
CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  badge_number TEXT,
  zone TEXT,
  entry_time TEXT,
  exit_time TEXT,
  duration_minutes INTEGER,
  shift TEXT,
  archived INTEGER DEFAULT 0,
  blm_location TEXT
);
meta table

Stores:

report_month

report_start

🔐 Authentication

Admin routes protected with session-based authentication

Active-check validation performed server-side

Frontend validates against duplicate active sessions

🧠 Engineering Highlights

Server-side validation prevents client-side bypass

Cross-device session integrity enforcement

Schema migration using ALTER TABLE with duplicate protection

Dynamic zone aggregation for scalable reporting

Separate archival and current reporting periods

Consistent policy logic applied on both client and server

🛠 Local Setup

Clone the repository

Install dependencies:

npm install

Run locally:

node server.js

Open in browser:

http://localhost:3000
📈 Future Improvements

CSV export

Role-based authentication

REST API abstraction

Docker containerization

Real-time active session dashboard

Audit logging system

🧑‍💻 Author

Developed as a full-stack project demonstrating:

Workflow modeling

Cross-device validation logic

Persistent database design

Policy-based time calculations

Administrative reporting architecture