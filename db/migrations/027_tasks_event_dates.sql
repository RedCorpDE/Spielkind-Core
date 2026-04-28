-- Migration: Add event, reminder, and reserved capacity date fields to tasks

-- Add new date columns to tasks table
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS event_date_time timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_date timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_capacity_date timestamptz;

-- Add indexes for the new date columns
CREATE INDEX IF NOT EXISTS idx_tasks_event_date_time ON tasks(event_date_time) WHERE event_date_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_date ON tasks(reminder_date) WHERE reminder_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_reserved_capacity_date ON tasks(reserved_capacity_date) WHERE reserved_capacity_date IS NOT NULL;