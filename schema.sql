-- Job Book — D1 schema.
-- Records are stored as JSON blobs keyed by id, with a millisecond
-- updated_at used for last-write-wins merging between the two phones.

CREATE TABLE IF NOT EXISTS clients (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS clients_updated ON clients (updated_at);
CREATE INDEX IF NOT EXISTS visits_updated  ON visits  (updated_at);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS notes_updated ON notes (updated_at);

-- Photos attached to notes. Not part of the sync loop above — a photo is
-- written once via POST /api/photo and never merged or re-synced, so it
-- doesn't need an updated_at or last-write-wins handling like the other
-- tables. Deleted only when the note carrying its id is tombstoned.
CREATE TABLE IF NOT EXISTS photos (
  id           TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);
