# Migration History

## Gap at 007

Migration `007_consumptions.sql` is intentionally absent from the current working tree.

**History:**

- The file was present in the initial commit (`Phase 1: DB-Schema, Control Node, Regiondo-Sync`,
  `ce971ef3`) and defined a `consumptions` table — a resource-booking junction that tracked
  capacity reservations/blocks against a `resources` row.

- It was **deleted** in commit `35fa8d28` (`Test1`, author: Niko-Becker-B12, 2026-03-23).

**Content of the deleted migration (for reference):**

```sql
CREATE TABLE IF NOT EXISTS consumptions (
  consumption_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  booking_id       uuid NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE,
  resource_id      uuid NOT NULL REFERENCES resources(resource_id) ON DELETE RESTRICT,

  type             text NOT NULL DEFAULT 'reserved'
    CHECK (type IN ('reserved','consumed','blocked','maintenance')),

  dt_from          timestamptz NOT NULL,
  dt_to            timestamptz NOT NULL,
  CHECK (dt_to > dt_from),

  capacity_used    integer NOT NULL DEFAULT 1 CHECK (capacity_used > 0),

  created_at       timestamptz NOT NULL DEFAULT now()
);
```

**Assessment:** The gap is **intentional, not accidental.** No subsequent migration (008–016)
references `consumptions`, and no source file queries it. The table is likely planned for a
future phase (resource capacity tracking). The gap in numbering must be preserved — do **not**
renumber 008+ or re-introduce 007 without a separate ADR/planning decision.
