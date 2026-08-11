import { pool } from '../../db/client.js';
import type { CreateDashboardLocationInput, DashboardLocation, UpdateDashboardLocationInput } from '../types.js';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
} from '../../sync/mappers.js';
import { DashboardNotFoundError, DashboardValidationError, requireIsoString } from './core.js';

interface LocationRow {
  location_id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  regiondo_location_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface RegiondoLocationCandidate {
  addresses: string[];
  id: string;
  locationNames: string[];
  title: string;
}

const SYSTEM_LOCATION_PROVIDER_IDS = new Set([
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
]);

function mapLocationRow(row: LocationRow): DashboardLocation {
  const isNoLocationPlaceholder = row.regiondo_location_id === SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID;
  const isUnknownRegiondoPlaceholder = row.regiondo_location_id === SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID;
  const isSystemPlaceholder = isNoLocationPlaceholder || isUnknownRegiondoPlaceholder;

  return {
    id: row.location_id,
    title: isNoLocationPlaceholder ? 'No location' : isUnknownRegiondoPlaceholder ? 'Unknown Regiondo location' : row.title,
    description: row.description ?? '',
    imageUrl: row.image_url,
    regiondoLocationId: isSystemPlaceholder ? null : row.regiondo_location_id,
    isSystemPlaceholder,
    providerDataStatus: isUnknownRegiondoPlaceholder ? 'unknown' : row.regiondo_location_id && !isNoLocationPlaceholder ? 'known' : 'none',
    createdAt: requireIsoString(row.created_at, 'locations.created_at'),
    updatedAt: requireIsoString(row.updated_at, 'locations.updated_at')
  };
}

export async function mapLocationToRegiondo(
  targetLocationId: string,
  input: { sourceLocationId: string; title?: string }
): Promise<DashboardLocation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await client.query<LocationRow>(
      `SELECT location_id, title, description, image_url, regiondo_location_id, created_at, updated_at
       FROM locations WHERE location_id = $1 FOR UPDATE`,
      [targetLocationId]
    );
    if (!targetResult.rowCount) throw new DashboardNotFoundError('Location not found.');
    const target = targetResult.rows[0];
    assertNotSystemProviderId(target.regiondo_location_id);

    const sourceResult = await client.query<LocationRow & { regiondo_raw: unknown }>(
      `SELECT location_id, title, description, image_url, regiondo_location_id, regiondo_raw, created_at, updated_at
       FROM locations WHERE location_id = $1 FOR UPDATE`,
      [input.sourceLocationId]
    );
    if (!sourceResult.rowCount) throw new DashboardNotFoundError('Regiondo location not found.');
    const source = sourceResult.rows[0];
    assertNotSystemProviderId(source.regiondo_location_id);
    if (!source.regiondo_location_id) {
      throw new DashboardValidationError('Select a location that is connected to Regiondo.');
    }

    if (target.location_id === source.location_id) {
      await client.query('COMMIT');
      return mapLocationRow(target);
    }
    if (target.regiondo_location_id) {
      throw new DashboardValidationError('This location is already connected to Regiondo.');
    }

    const nextTitle = input.title?.trim() || target.title;
    const affectedBookings = await client.query<{ booking_id: string }>(
      `SELECT booking_id FROM bookings WHERE location_id = ANY($1::uuid[])`,
      [[target.location_id, source.location_id]]
    );
    const bookingIds = affectedBookings.rows.map((row) => row.booking_id);

    if (bookingIds.length) {
      await client.query(
        `UPDATE tasks
         SET raw_json = jsonb_set(
               jsonb_set(COALESCE(raw_json, '{}'::jsonb), '{site}', to_jsonb($2::text), true),
               '{booking_data}',
               COALESCE(raw_json -> 'booking_data', '{}'::jsonb) || jsonb_build_object('location_id', $1::text, 'site', $2::text),
               true
             ),
             updated_at = now()
         WHERE connected_booking_key = ANY($3::uuid[])
            OR id IN (SELECT task_id FROM task_bookings WHERE booking_id = ANY($3::uuid[]))`,
        [target.location_id, nextTitle, bookingIds]
      );
    }

    await client.query(`UPDATE bookings SET location_id = $1, updated_at = now() WHERE location_id = $2`, [target.location_id, source.location_id]);
    await client.query(`UPDATE resources SET location_id = $1, updated_at = now() WHERE location_id = $2`, [target.location_id, source.location_id]);
    await client.query(
      `INSERT INTO location_products (location_id, product_id)
       SELECT $1, product_id FROM location_products WHERE location_id = $2
       ON CONFLICT (location_id, product_id) DO NOTHING`,
      [target.location_id, source.location_id]
    );
    await client.query(`DELETE FROM location_products WHERE location_id = $1`, [source.location_id]);
    await client.query(`UPDATE reminder_rules SET location_id = $1, updated_at = now() WHERE location_id = $2`, [target.location_id, source.location_id]);
    await client.query(`UPDATE locations SET regiondo_location_id = NULL, updated_at = now() WHERE location_id = $1`, [source.location_id]);
    const mappedResult = await client.query<LocationRow>(
      `UPDATE locations
       SET title = $2, regiondo_location_id = $3, regiondo_raw = $4::jsonb, updated_at = now()
       WHERE location_id = $1
       RETURNING location_id, title, description, image_url, regiondo_location_id, created_at, updated_at`,
      [target.location_id, nextTitle, source.regiondo_location_id, JSON.stringify(source.regiondo_raw ?? {})]
    );
    await client.query(`DELETE FROM locations WHERE location_id = $1`, [source.location_id]);
    await client.query('COMMIT');
    return mapLocationRow(mappedResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throwLocationMutationError(error);
  } finally {
    client.release();
  }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

function assertNotSystemProviderId(regiondoLocationId: string | null | undefined): void {
  if (regiondoLocationId && SYSTEM_LOCATION_PROVIDER_IDS.has(regiondoLocationId)) {
    throw new DashboardValidationError('System location placeholders cannot be edited through location settings.');
  }
}

function isDatabaseError(error: unknown): error is { code?: string; constraint?: string } {
  return typeof error === 'object' && error !== null;
}

function throwLocationMutationError(error: unknown): never {
  if (isDatabaseError(error)) {
    if (error.code === '23505') {
      throw new DashboardValidationError('A location with this Regiondo location id already exists.');
    }

    if (error.code === '23503') {
      throw new DashboardValidationError('Cannot delete a location that is still referenced by other records.');
    }
  }

  throw error;
}

export async function listLocations(): Promise<DashboardLocation[]> {
  const result = await pool.query<LocationRow>(
    `SELECT
       location_id,
       title,
       description,
       image_url,
       regiondo_location_id,
       created_at,
       updated_at
     FROM locations
     WHERE regiondo_location_id IS NULL
       OR regiondo_location_id <> ALL($1::text[])
     ORDER BY title ASC, created_at ASC`,
    [[SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID, SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID]]
  );

  return result.rows.map(mapLocationRow);
}

export async function listRegiondoLocationCandidates(): Promise<RegiondoLocationCandidate[]> {
  const result = await pool.query<{
    addresses: string[] | null;
    location_id: string;
    location_title: string | null;
    location_names: string[] | null;
  }>(
    `SELECT
       p.regiondo_raw ->> 'location_id' AS location_id,
       MAX(COALESCE(
         NULLIF(BTRIM(p.regiondo_raw ->> 'location_name'), ''),
         NULLIF(BTRIM(p.regiondo_raw ->> 'city'), '')
       )) AS location_title,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(BTRIM(p.regiondo_raw ->> 'location_name'), '')), NULL) AS location_names,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(BTRIM(p.regiondo_raw ->> 'location_address'), '')), NULL) AS addresses
     FROM products p
     WHERE p.regiondo_product_id IS NOT NULL
       AND NULLIF(BTRIM(p.regiondo_raw ->> 'location_id'), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM locations l
         WHERE l.regiondo_location_id = p.regiondo_raw ->> 'location_id'
       )
     GROUP BY p.regiondo_raw ->> 'location_id'
     ORDER BY MAX(NULLIF(BTRIM(p.regiondo_raw ->> 'location_name'), '')) ASC NULLS LAST,
              p.regiondo_raw ->> 'location_id' ASC`
  );

  return result.rows.map((row) => ({
    addresses: row.addresses ?? [],
    id: row.location_id,
    locationNames: row.location_names ?? [],
    title: row.location_title ?? row.location_names?.[0] ?? `Regiondo location ${row.location_id}`
  }));
}

export async function getLocation(locationId: string): Promise<DashboardLocation> {
  const result = await pool.query<LocationRow>(
    `SELECT
       location_id,
       title,
       description,
       image_url,
       regiondo_location_id,
       created_at,
       updated_at
     FROM locations
     WHERE location_id = $1
     LIMIT 1`,
    [locationId]
  );

  if (!result.rowCount) {
    throw new DashboardNotFoundError('Location not found.');
  }

  return mapLocationRow(result.rows[0]);
}

export async function createLocation(input: CreateDashboardLocationInput): Promise<DashboardLocation> {
  const regiondoLocationId = normalizeOptionalText(input.regiondoLocationId);
  assertNotSystemProviderId(regiondoLocationId);

  try {
    const result = await pool.query<LocationRow>(
      `INSERT INTO locations (
         title,
         description,
         image_url,
         regiondo_location_id
       )
       VALUES ($1, $2, $3, $4)
       RETURNING
         location_id,
         title,
         description,
         image_url,
         regiondo_location_id,
         created_at,
         updated_at`,
      [
        input.title.trim(),
        normalizeOptionalText(input.description),
        normalizeOptionalText(input.imageUrl),
        regiondoLocationId
      ]
    );

    return mapLocationRow(result.rows[0]);
  } catch (error) {
    throwLocationMutationError(error);
  }
}

export async function updateLocation(
  locationId: string,
  input: UpdateDashboardLocationInput
): Promise<DashboardLocation> {
  const existing = await getLocation(locationId);
  if (existing.isSystemPlaceholder) {
    throw new DashboardValidationError('System location placeholders cannot be edited through location settings.');
  }

  const nextTitle = typeof input.title === 'string' ? input.title.trim() : existing.title;
  const nextDescription = input.description === undefined ? existing.description : normalizeOptionalText(input.description);
  const nextImageUrl = input.imageUrl === undefined ? existing.imageUrl : normalizeOptionalText(input.imageUrl);
  const nextRegiondoLocationId =
    input.regiondoLocationId === undefined ? existing.regiondoLocationId : normalizeOptionalText(input.regiondoLocationId);
  assertNotSystemProviderId(nextRegiondoLocationId);

  try {
    const result = await pool.query<LocationRow>(
      `UPDATE locations
       SET
         title = $1,
         description = $2,
         image_url = $3,
         regiondo_location_id = $4
       WHERE location_id = $5
       RETURNING
         location_id,
         title,
         description,
         image_url,
         regiondo_location_id,
         created_at,
         updated_at`,
      [nextTitle, nextDescription, nextImageUrl, nextRegiondoLocationId, locationId]
    );

    if (!result.rowCount) {
      throw new DashboardNotFoundError('Location not found.');
    }

    return mapLocationRow(result.rows[0]);
  } catch (error) {
    throwLocationMutationError(error);
  }
}

export async function deleteLocation(locationId: string): Promise<void> {
  const existing = await getLocation(locationId);
  if (existing.isSystemPlaceholder) {
    throw new DashboardValidationError('System location placeholders cannot be deleted.');
  }

  try {
    const result = await pool.query(
      `DELETE FROM locations
       WHERE location_id = $1`,
      [locationId]
    );

    if (!result.rowCount) {
      throw new DashboardNotFoundError('Location not found.');
    }
  } catch (error) {
    throwLocationMutationError(error);
  }
}
