ALTER TABLE tasks
  ALTER COLUMN column_key DROP NOT NULL;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_column_key_fkey;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_column_key_fkey
  FOREIGN KEY (column_key)
  REFERENCES task_kanban_columns(id)
  ON DELETE SET NULL;
