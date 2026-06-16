CREATE TABLE IF NOT EXISTS task_comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name    text NOT NULL,
  author_role    text NOT NULL,
  body           text NOT NULL CHECK (btrim(body) <> ''),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task_created
  ON task_comments (task_id, created_at DESC, id DESC);
