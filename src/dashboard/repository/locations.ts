import { pool } from '../../db/client.js';
import type { CreateDashboardLocationInput, DashboardLocation, UpdateDashboardLocationInput } from '../types.js';
import { SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID } from '../../sync/mappers.js';
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

function mapLocationRow(row: LocationRow): DashboardLocation {
  const isSystemPlaceholder = row.regiondo_location_id === SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID;

  return {
    id: row.location_id,
    title: isSystemPlaceholder ? 'Unknown Regiondo location' : row.title,
    description: row.description ?? '',
    imageUrl: row.image_url,
    regiondoLocationId: isSystemPlaceholder ? null : row.regiondo_location_id,
    isSystemPlaceholder,
    providerDataStatus: isSystemPlaceholder ? 'unknown' : 'known',
    createdAt: requireIsoString(row.created_at, 'locations.created_at'),
    updatedAt: requireIsoString(row.updated_at, 'locations.updated_at')
  };
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
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
     ORDER BY title ASC, created_at ASC`
  );

  return result.rows.map(mapLocationRow);
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
        normalizeOptionalText(input.regiondoLocationId)
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
  const nextTitle = typeof input.title === 'string' ? input.title.trim() : existing.title;
  const nextDescription = input.description === undefined ? existing.description : normalizeOptionalText(input.description);
  const nextImageUrl = input.imageUrl === undefined ? existing.imageUrl : normalizeOptionalText(input.imageUrl);
  const nextRegiondoLocationId =
    input.regiondoLocationId === undefined ? existing.regiondoLocationId : normalizeOptionalText(input.regiondoLocationId);

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
