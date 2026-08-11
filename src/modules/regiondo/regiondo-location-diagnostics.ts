type DiagnosticSource = 'booking' | 'product';

export interface RegiondoLocationDiagnosticField {
  path: string;
  source: DiagnosticSource;
  value: string;
}

const DIRECT_LOCATION_KEYS = new Set([
  'city',
  'city_id',
  'cityId',
  'location_id',
  'locationId',
  'location_name',
  'locationName',
  'location_title',
  'locationTitle',
  'location_address',
  'meeting_point_id',
  'meetingPointId',
  'poi_ids',
  'poiIds',
  'region_id',
  'regionId',
  'venue_id',
  'venueId'
]);

const LOCATION_CONTAINER_KEYS = new Set(['location', 'venue', 'meeting_point', 'meetingPoint']);
const SAFE_CONTAINER_VALUE_KEYS = new Set(['id', 'label', 'name', 'title']);
const MAX_VALUE_LENGTH = 160;
const MAX_DEPTH = 10;

function toSafePrimitive(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_VALUE_LENGTH);
}

function isLocationContainerPath(path: string[]): boolean {
  return path.slice(0, -1).some((segment) => LOCATION_CONTAINER_KEYS.has(segment));
}

export function discoverRegiondoLocationFields(
  sources: Array<{ raw: unknown; source: DiagnosticSource }>
): RegiondoLocationDiagnosticField[] {
  const fields = new Map<string, RegiondoLocationDiagnosticField>();

  const visit = (value: unknown, source: DiagnosticSource, path: string[], depth: number) => {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, source, [...path, `[${index}]`], depth + 1));
      return;
    }

    if (typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = [...path, key];
      const primitive = toSafePrimitive(child);
      const isAllowed = DIRECT_LOCATION_KEYS.has(key) ||
        (isLocationContainerPath(childPath) && SAFE_CONTAINER_VALUE_KEYS.has(key));

      if (isAllowed && primitive) {
        const field = { path: childPath.join('.'), source, value: primitive } satisfies RegiondoLocationDiagnosticField;
        fields.set(`${field.source}:${field.path}:${field.value}`, field);
      }

      if (typeof child === 'object' && child !== null) visit(child, source, childPath, depth + 1);
    }
  };

  sources.forEach(({ raw, source }) => visit(raw, source, [], 0));
  return [...fields.values()].sort((left, right) =>
    left.source.localeCompare(right.source) || left.path.localeCompare(right.path) || left.value.localeCompare(right.value)
  );
}
