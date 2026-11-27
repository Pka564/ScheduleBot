CREATE TABLE group_notification_disabled (
  group_id TEXT NOT NULL REFERENCES groups(id),
  kind TEXT NOT NULL CHECK(kind IN ('changes','evening','morning','reminder')),
  PRIMARY KEY(group_id,kind)
);
