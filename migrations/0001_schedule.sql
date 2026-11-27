CREATE TABLE groups (id TEXT PRIMARY KEY);
INSERT INTO groups VALUES ('П-61БС');
CREATE TABLE imports (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES groups(id),
  base_version INTEGER NOT NULL, file_hash TEXT NOT NULL, payload TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX imports_owner ON imports(owner, created);
CREATE TABLE versions (
  group_id TEXT NOT NULL REFERENCES groups(id), number INTEGER NOT NULL,
  created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  description TEXT NOT NULL, file_hash TEXT, draft_id TEXT REFERENCES imports(id), source INTEGER,
  PRIMARY KEY (group_id, number), UNIQUE (group_id, file_hash)
);
CREATE TABLE published_days (
  group_id TEXT NOT NULL, version INTEGER NOT NULL, day TEXT NOT NULL,
  PRIMARY KEY (group_id, version, day),
  FOREIGN KEY (group_id, version) REFERENCES versions(group_id, number)
);
CREATE TABLE lessons (
  group_id TEXT NOT NULL, version INTEGER NOT NULL, day TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (group_id, version, day, position),
  FOREIGN KEY (group_id, version, day) REFERENCES published_days(group_id, version, day)
);
CREATE TRIGGER snapshot AFTER INSERT ON versions BEGIN
  INSERT INTO published_days
    SELECT NEW.group_id, NEW.number, day FROM published_days
      WHERE group_id = NEW.group_id AND version = COALESCE(NEW.source, NEW.number - 1)
      AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.id = NEW.draft_id
        AND day BETWEEN json_extract(i.payload,'$.from') AND json_extract(i.payload,'$.to'));
  INSERT INTO published_days
    WITH RECURSIVE days(day, last) AS (
      SELECT json_extract(payload,'$.from'), json_extract(payload,'$.to') FROM imports WHERE id = NEW.draft_id
      UNION ALL SELECT date(day,'+1 day'), last FROM days WHERE day < last
    ) SELECT NEW.group_id, NEW.number, day FROM days;
  INSERT INTO lessons
    SELECT NEW.group_id, NEW.number, day, position, data FROM lessons
      WHERE group_id = NEW.group_id AND version = COALESCE(NEW.source, NEW.number - 1)
      AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.id = NEW.draft_id
        AND day BETWEEN json_extract(i.payload,'$.from') AND json_extract(i.payload,'$.to'));
  INSERT INTO lessons
    SELECT NEW.group_id, NEW.number, json_extract(l.value, '$.date'), CAST(l.key AS INTEGER), l.value
      FROM imports i, json_each(i.payload, '$.lessons') l WHERE i.id = NEW.draft_id;
END;
CREATE TABLE holidays (
  group_id TEXT NOT NULL REFERENCES groups(id), day TEXT NOT NULL, PRIMARY KEY(group_id, day)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL DEFAULT 'П-61БС' REFERENCES groups(id),
  private_chat INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0, evening INTEGER NOT NULL DEFAULT 0,
  morning INTEGER NOT NULL DEFAULT 0, reminder INTEGER NOT NULL DEFAULT 0,
  seen_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX users_group ON users(group_id);
CREATE TABLE telegram_updates (id INTEGER PRIMARY KEY, processed_at INTEGER NOT NULL);
CREATE TABLE telegram_files (id TEXT PRIMARY KEY, owner TEXT NOT NULL, file_id TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE notification_jobs (
  user_id TEXT NOT NULL REFERENCES users(id), event TEXT NOT NULL, group_id TEXT NOT NULL, message TEXT NOT NULL,
  due INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(user_id,event)
);
CREATE INDEX notification_due ON notification_jobs(state,due);
CREATE TABLE rate_limits (actor TEXT NOT NULL, bucket INTEGER NOT NULL, hits INTEGER NOT NULL, PRIMARY KEY(actor,bucket));
