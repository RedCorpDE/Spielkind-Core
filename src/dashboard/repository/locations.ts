import { pool } from '../../db/client.js';
import type { CreateDashboardLocationInput, DashboardLocation, UpdateDashboardLocationInput } from '../types.js';
import {
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
} from '../../sync/mappers.js';
import { DashboardNotFoundError, DashboardValidationError, requireIsoString } from './core.js';
import { getProductLocation, type RegiondoProductLocationType } from '../../modules/regiondo/regiondo.types.js';

interface LocationRow {
  location_id: string;
  title: string;
  description: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  image_url: string | null;
  image_urls: string[] | null;
  directions: string | null;
  parking: string | null;
  public_transport: string | null;
  facilities: string[] | null;
  house_rules: string[] | null;
  contact_email: string | null;
  contact_phone: string | null;
  support_note: string | null;
  regiondo_location_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface RegiondoLocationCandidate {
  addresses: string[];
  id: string;
  locationType: RegiondoProductLocationType;
  locationNames: string[];
  title: string;
}

const SYSTEM_LOCATION_PROVIDER_IDS = new Set([
  SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID,
  SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID
]);

const LOCATION_COLUMNS = `location_id, title, description, address, city, postal_code, country_code,
  latitude, longitude, image_url, image_urls, directions, parking, public_transport,
  facilities, house_rules, contact_email, contact_phone, support_note,
  regiondo_location_id, created_at, updated_at`;

function mapLocationRow(row: LocationRow): DashboardLocation {
  const isNoLocationPlaceholder = row.regiondo_location_id === SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID;
  const isUnknownRegiondoPlaceholder = row.regiondo_location_id === SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID;
  const isSystemPlaceholder = isNoLocationPlaceholder || isUnknownRegiondoPlaceholder;

  return {
    id: row.location_id,
    title: isNoLocationPlaceholder ? 'No location' : isUnknownRegiondoPlaceholder ? 'Unknown Regiondo location' : row.title,
    description: row.description ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    countryCode: row.country_code ?? 'DE',
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    imageUrl: row.image_urls?.[0] ?? row.image_url,
    imageUrls: row.image_urls?.length ? row.image_urls : row.image_url ? [row.image_url] : [],
    directions: row.directions ?? null,
    parking: row.parking ?? null,
    publicTransport: row.public_transport ?? null,
    facilities: row.facilities ?? [],
    houseRules: row.house_rules ?? [],
    contactEmail: row.contact_email ?? null,
    contactPhone: row.contact_phone ?? null,
    supportNote: row.support_note ?? null,
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
      `SELECT ${LOCATION_COLUMNS}
       FROM locations WHERE location_id = $1 FOR UPDATE`,
      [targetLocationId]
    );
    if (!targetResult.rowCount) throw new DashboardNotFoundError('Location not found.');
    const target = targetResult.rows[0];
    assertNotSystemProviderId(target.regiondo_location_id);

    const sourceResult = await client.query<LocationRow & { regiondo_raw: unknown }>(
      `SELECT ${LOCATION_COLUMNS}, regiondo_raw
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
       RETURNING ${LOCATION_COLUMNS}`,
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

function normalizeStringArray(values: string[] | null | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
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
    `SELECT ${LOCATION_COLUMNS}
     FROM locations
     WHERE regiondo_location_id IS NULL
       OR regiondo_location_id <> ALL($1::text[])
     ORDER BY title ASC, created_at ASC`,
    [[SHARED_NO_LOCATION_PLACEHOLDER_LOCATION_ID, SHARED_REGIONDO_PLACEHOLDER_LOCATION_ID]]
  );

  return result.rows.map(mapLocationRow);
}

export async function listRegiondoLocationCandidates(): Promise<RegiondoLocationCandidate[]> {
  const [productsResult, mappedResult] = await Promise.all([
    pool.query<{ regiondo_raw: unknown }>(
      `SELECT regiondo_raw
       FROM products
       WHERE regiondo_product_id IS NOT NULL
         AND regiondo_raw IS NOT NULL
         AND (regiondo_raw ? 'city_id' OR regiondo_raw ? 'region_id')`
    ),
    pool.query<{ regiondo_location_id: string }>(
      `SELECT regiondo_location_id
       FROM locations
       WHERE regiondo_location_id IS NOT NULL`
    )
  ]);
  const mappedIds = new Set(mappedResult.rows.map((row) => row.regiondo_location_id));
  const candidates = new Map<string, RegiondoLocationCandidate>();

  for (const row of productsResult.rows) {
    if (typeof row.regiondo_raw !== 'object' || row.regiondo_raw === null || Array.isArray(row.regiondo_raw)) continue;
    const raw = row.regiondo_raw as Record<string, unknown>;

    for (const locationType of ['city', 'region'] as const) {
      let reference: ReturnType<typeof getProductLocation>;
      try {
        reference = getProductLocation(raw, locationType);
      } catch {
        continue;
      }

      const id = `${reference.locationId}`;
      if (mappedIds.has(id)) continue;
      const key = `${reference.locationType}:${id}`;
      const existing = candidates.get(key);
      const locationName = typeof raw.location_name === 'string' && raw.location_name.trim()
        ? raw.location_name.trim()
        : null;
      const cityName = typeof raw.city === 'string' && raw.city.trim() ? raw.city.trim() : null;
      const address = typeof raw.location_address === 'string' && raw.location_address.trim()
        ? raw.location_address.trim()
        : null;
      const fallbackTitle = reference.locationType === 'city' ? cityName : null;

      if (existing) {
        if (locationName && !existing.locationNames.includes(locationName)) existing.locationNames.push(locationName);
        if (address && !existing.addresses.includes(address)) existing.addresses.push(address);
        continue;
      }

      candidates.set(key, {
        addresses: address ? [address] : [],
        id,
        locationNames: locationName ? [locationName] : [],
        locationType: reference.locationType,
        title: fallbackTitle ?? locationName ?? `Regiondo ${reference.locationType} ${id}`
      });
    }
  }

  return [...candidates.values()].sort((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
  );
}

export async function getLocation(locationId: string): Promise<DashboardLocation> {
  const result = await pool.query<LocationRow>(
    `SELECT ${LOCATION_COLUMNS}
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
  const imageUrls = normalizeStringArray(input.imageUrls ?? (input.imageUrl ? [input.imageUrl] : []));
  assertNotSystemProviderId(regiondoLocationId);

  try {
    const result = await pool.query<LocationRow>(
      `INSERT INTO locations (
         title,
         description,
         address,
         city,
         postal_code,
         country_code,
         latitude,
         longitude,
         image_url,
         image_urls,
         directions,
         parking,
         public_transport,
         facilities,
         house_rules,
         contact_email,
         contact_phone,
         support_note,
         regiondo_location_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING ${LOCATION_COLUMNS}`,
      [
        input.title.trim(),
        normalizeOptionalText(input.description),
        normalizeOptionalText(input.address),
        normalizeOptionalText(input.city),
        normalizeOptionalText(input.postalCode),
        normalizeOptionalText(input.countryCode)?.toUpperCase() ?? 'DE',
        input.latitude ?? null,
        input.longitude ?? null,
        imageUrls[0] ?? null,
        imageUrls,
        normalizeOptionalText(input.directions),
        normalizeOptionalText(input.parking),
        normalizeOptionalText(input.publicTransport),
        normalizeStringArray(input.facilities),
        normalizeStringArray(input.houseRules),
        normalizeOptionalText(input.contactEmail),
        normalizeOptionalText(input.contactPhone),
        normalizeOptionalText(input.supportNote),
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
  const nextAddress = input.address === undefined ? existing.address : normalizeOptionalText(input.address);
  const nextCity = input.city === undefined ? existing.city : normalizeOptionalText(input.city);
  const nextPostalCode = input.postalCode === undefined ? existing.postalCode : normalizeOptionalText(input.postalCode);
  const nextCountryCode = input.countryCode === undefined
    ? existing.countryCode
    : normalizeOptionalText(input.countryCode)?.toUpperCase() ?? 'DE';
  const nextLatitude = input.latitude === undefined ? existing.latitude : input.latitude;
  const nextLongitude = input.longitude === undefined ? existing.longitude : input.longitude;
  const nextImageUrls = input.imageUrls !== undefined
    ? normalizeStringArray(input.imageUrls)
    : existing.imageUrls.length
      ? existing.imageUrls
      : input.imageUrl !== undefined
        ? normalizeStringArray(input.imageUrl ? [input.imageUrl] : [])
        : [];
  const nextDirections = input.directions === undefined ? existing.directions : normalizeOptionalText(input.directions);
  const nextParking = input.parking === undefined ? existing.parking : normalizeOptionalText(input.parking);
  const nextPublicTransport = input.publicTransport === undefined ? existing.publicTransport : normalizeOptionalText(input.publicTransport);
  const nextFacilities = input.facilities === undefined ? existing.facilities : normalizeStringArray(input.facilities);
  const nextHouseRules = input.houseRules === undefined ? existing.houseRules : normalizeStringArray(input.houseRules);
  const nextContactEmail = input.contactEmail === undefined ? existing.contactEmail : normalizeOptionalText(input.contactEmail);
  const nextContactPhone = input.contactPhone === undefined ? existing.contactPhone : normalizeOptionalText(input.contactPhone);
  const nextSupportNote = input.supportNote === undefined ? existing.supportNote : normalizeOptionalText(input.supportNote);
  const nextRegiondoLocationId =
    input.regiondoLocationId === undefined ? existing.regiondoLocationId : normalizeOptionalText(input.regiondoLocationId);
  assertNotSystemProviderId(nextRegiondoLocationId);

  try {
    const result = await pool.query<LocationRow>(
      `UPDATE locations
       SET
         title = $1,
         description = $2,
         address = $3,
         city = $4,
         postal_code = $5,
         country_code = $6,
         latitude = $7,
         longitude = $8,
         image_url = $9,
         image_urls = $10,
         directions = $11,
         parking = $12,
         public_transport = $13,
         facilities = $14,
         house_rules = $15,
         contact_email = $16,
         contact_phone = $17,
         support_note = $18,
         regiondo_location_id = $19,
         updated_at = now()
       WHERE location_id = $20
       RETURNING ${LOCATION_COLUMNS}`,
      [
        nextTitle, nextDescription, nextAddress, nextCity, nextPostalCode, nextCountryCode,
        nextLatitude, nextLongitude, nextImageUrls[0] ?? null, nextImageUrls, nextDirections,
        nextParking, nextPublicTransport, nextFacilities, nextHouseRules, nextContactEmail,
        nextContactPhone, nextSupportNote, nextRegiondoLocationId, locationId
      ]
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
