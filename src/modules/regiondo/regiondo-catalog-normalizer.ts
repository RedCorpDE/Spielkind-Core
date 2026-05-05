type CatalogRecord = Record<string, unknown>;

export interface RegiondoAvailabilitySlot {
  date: string;
  time: string;
}

export interface RegiondoCatalogOptionSyncContext {
  product_id: string;
  source: string | null;
  source_date: string | null;
  source_time: string | null;
  variation_id: string;
}

export interface RegiondoCatalogVariationRecord {
  appointmentType: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  price: number;
  raw: CatalogRecord;
  regiondoProductId: string;
  regiondoVariantId: string;
  title: string | null;
}

export interface RegiondoCatalogOptionRecord {
  raw: CatalogRecord;
  regiondoOptionId: string;
  regiondoProductId: string;
  regiondoVariantId: string;
  title: string | null;
  valuesJson: unknown;
}

export interface RegiondoCatalogProductRecord {
  baseAmount: number;
  description: string | null;
  imageUrl: string | null;
  options: RegiondoCatalogOptionRecord[];
  raw: CatalogRecord;
  regiondoProductId: string;
  title: string;
  variations: RegiondoCatalogVariationRecord[];
}

const asRecord = (value: unknown): CatalogRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as CatalogRecord) : null;

const cloneRecord = (value: unknown): CatalogRecord => {
  const record = asRecord(value);
  return record ? { ...record } : {};
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const toIdentifier = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${Math.trunc(value)}`;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  return null;
};

const readString = (record: CatalogRecord | null, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record?.[key];

    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();

    if (trimmed) {
      return trimmed;
    }
  }

  return null;
};

const readIdentifier = (record: CatalogRecord | null, keys: string[]): string | null => {
  for (const key of keys) {
    const identifier = toIdentifier(record?.[key]);

    if (identifier) {
      return identifier;
    }
  }

  return null;
};

const readNumber = (record: CatalogRecord | null, keys: string[]): number | null => {
  for (const key of keys) {
    const value = toFiniteNumber(record?.[key]);

    if (value !== null) {
      return value;
    }
  }

  return null;
};

const getTitle = (value: unknown): string | null => {
  const record = asRecord(value);

  return readString(record, [
    'title',
    'name',
    'product_name',
    'productName',
    'variation_name',
    'variationName',
    'option_name',
    'optionName',
    'label'
  ]);
};

const getProductId = (value: unknown): string | null =>
  readIdentifier(asRecord(value), ['product_id', 'productId', 'product', 'id']);

const getVariationId = (value: unknown): string | null =>
  readIdentifier(asRecord(value), ['variation_id', 'variationId', 'variant_id', 'variantId', 'id']);

const getOptionId = (value: unknown): string | null =>
  readIdentifier(asRecord(value), ['option_id', 'optionId', 'value_id', 'valueId', 'id']);

export function toDateOnly(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);

    if (match) {
      return match[1];
    }
  }

  const date = new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + Number(days || 0));
  return copy;
}

function deepFindArraysByKeys(root: unknown, wantedKeys: string[], maxDepth: number): unknown[][] {
  const found: unknown[][] = [];

  const visit = (value: unknown, depth: number) => {
    if (!value || depth > maxDepth) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }

    const record = asRecord(value);

    if (!record) {
      return;
    }

    Object.entries(record).forEach(([key, child]) => {
      if (wantedKeys.includes(key) && Array.isArray(child)) {
        found.push(child);
      }
    });

    Object.values(record).forEach((child) => visit(child, depth + 1));
  };

  visit(root, 0);

  return found;
}

export function extractRegiondoVariations(root: unknown): CatalogRecord[] {
  return deepFindArraysByKeys(
    root,
    ['variations', 'product_variations', 'productVariations', 'variants'],
    5
  ).flatMap((items) =>
    items.flatMap((item) => {
      const record = asRecord(item);
      return record ? [record] : [];
    })
  );
}

function looksLikeOption(value: unknown): value is CatalogRecord {
  const record = asRecord(value);

  if (!record) {
    return false;
  }

  const optionId = getOptionId(record);

  if (!optionId) {
    return false;
  }

  if (
    record.option_id !== undefined ||
    record.optionId !== undefined ||
    record.option_name !== undefined ||
    record.optionName !== undefined ||
    record.value_id !== undefined ||
    record.valueId !== undefined
  ) {
    return true;
  }

  return Boolean(getTitle(record));
}

export function extractRegiondoOptionsDeep(payload: unknown): CatalogRecord[] {
  const result: CatalogRecord[] = [];

  const visit = (value: unknown, depth: number) => {
    if (!value || depth > 7) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }

    const record = asRecord(value);

    if (!record) {
      return;
    }

    if (looksLikeOption(record)) {
      result.push(record);
    }

    Object.entries(record).forEach(([key, child]) => {
      if (
        key === 'options' ||
        key === 'available_options' ||
        key === 'availableOptions' ||
        key === 'option_values' ||
        key === 'optionValues' ||
        key === 'values' ||
        key === 'items' ||
        key === 'data' ||
        key === 'result'
      ) {
        visit(child, depth + 1);
      } else if (typeof child === 'object' && child !== null) {
        visit(child, depth + 1);
      }
    });
  };

  visit(payload, 0);

  return result;
}

const pushAvailabilitySlot = (slots: RegiondoAvailabilitySlot[], date: unknown, time: unknown) => {
  const cleanDate = toDateOnly(date);

  if (!cleanDate || typeof time !== 'string') {
    return;
  }

  const cleanTime = time.slice(0, 5);

  if (!/^\d{2}:\d{2}$/.test(cleanTime)) {
    return;
  }

  slots.push({ date: cleanDate, time: cleanTime });
};

const parseAvailabilityEntry = (value: unknown, slots: RegiondoAvailabilitySlot[]) => {
  if (!value || typeof value === 'string') {
    return;
  }

  const record = asRecord(value);

  if (!record) {
    return;
  }

  const date =
    record.date ??
    record.day ??
    record.dt ??
    record.start_date ??
    record.startDate ??
    record.available_date ??
    record.availableDate;
  const time =
    record.time ??
    record.start_time ??
    record.startTime ??
    record.available_time ??
    record.availableTime ??
    record.from;

  if (date && time) {
    pushAvailabilitySlot(slots, date, time);
  }

  const times =
    record.times ??
    record.available_times ??
    record.availableTimes ??
    record.slots ??
    record.time_slots ??
    record.timeSlots ??
    record.children;

  if (!Array.isArray(times)) {
    return;
  }

  times.forEach((entry) => {
    if (typeof entry === 'string') {
      pushAvailabilitySlot(slots, date, entry);
      return;
    }

    const childRecord = asRecord(entry);

    if (!childRecord) {
      return;
    }

    pushAvailabilitySlot(
      slots,
      childRecord.date ?? childRecord.day ?? childRecord.dt ?? date,
      childRecord.time ??
        childRecord.start_time ??
        childRecord.startTime ??
        childRecord.value ??
        childRecord.label ??
        childRecord.from
    );
  });
};

export function extractRegiondoAvailabilitySlots(
  payload: unknown,
  maxSlots: number
): RegiondoAvailabilitySlot[] {
  const slots: RegiondoAvailabilitySlot[] = [];

  const visit = (value: unknown, depth: number) => {
    if (!value || depth > 6) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        parseAvailabilityEntry(item, slots);
        visit(item, depth + 1);
      });
      return;
    }

    const record = asRecord(value);

    if (!record) {
      return;
    }

    parseAvailabilityEntry(record, slots);
    Object.values(record).forEach((child) => {
      if (Array.isArray(child) || (typeof child === 'object' && child !== null)) {
        visit(child, depth + 1);
      }
    });
  };

  visit(payload, 0);

  const unique = new Map<string, RegiondoAvailabilitySlot>();

  slots.forEach((slot) => {
    unique.set(`${slot.date}_${slot.time}`, slot);
  });

  return [...unique.values()].slice(0, maxSlots);
}

export function mergeRegiondoSummaryAndDetail(summary: unknown, detail: unknown): CatalogRecord {
  return {
    ...cloneRecord(summary),
    ...cloneRecord(detail)
  };
}

export function normalizeRegiondoCatalogProduct(value: unknown): Omit<RegiondoCatalogProductRecord, 'options' | 'variations'> | null {
  const record = asRecord(value);
  const regiondoProductId = getProductId(record);

  if (!record || !regiondoProductId) {
    return null;
  }

  return {
    baseAmount: readNumber(record, ['base_price', 'original_price', 'price']) ?? 0,
    description: readString(record, ['short_description', 'description']) ?? null,
    imageUrl: readString(record, ['image', 'thumbnail']) ?? null,
    raw: cloneRecord(record),
    regiondoProductId,
    title: getTitle(record) ?? 'Untitled Product'
  };
}

export function normalizeRegiondoCatalogVariation(
  value: unknown,
  regiondoProductId: string,
  productDetail: unknown
): RegiondoCatalogVariationRecord | null {
  const record = asRecord(value);
  const detailRecord = asRecord(productDetail);
  const regiondoVariantId = getVariationId(record);

  if (!record || !regiondoVariantId) {
    return null;
  }

  return {
    appointmentType:
      readString(record, ['appointment_type', 'appointmentType']) ??
      readString(detailRecord, ['appointment_type', 'appointmentType']) ??
      null,
    dateFrom: toDateOnly(record.date_from ?? record.dateFrom ?? record.from ?? record.dt_from ?? record.dtFrom),
    dateTo: toDateOnly(record.date_to ?? record.dateTo ?? record.to ?? record.dt_to ?? record.dtTo),
    price: readNumber(record, ['price', 'base_price', 'original_price']) ?? 0,
    raw: cloneRecord(record),
    regiondoProductId,
    regiondoVariantId,
    title: getTitle(record)
  };
}

export function normalizeRegiondoCatalogOption(
  value: unknown,
  regiondoProductId: string,
  regiondoVariantId: string,
  source?: {
    date?: string;
    source?: string;
    time?: string;
  }
): RegiondoCatalogOptionRecord | null {
  const record = asRecord(value);
  const regiondoOptionId = getOptionId(record);

  if (!record || !regiondoOptionId) {
    return null;
  }

  const raw = cloneRecord(record);
  raw._sync_context = {
    product_id: regiondoProductId,
    source: source?.source ?? null,
    source_date: source?.date ?? null,
    source_time: source?.time ?? null,
    variation_id: regiondoVariantId
  } satisfies RegiondoCatalogOptionSyncContext;

  return {
    raw,
    regiondoOptionId,
    regiondoProductId,
    regiondoVariantId,
    title: getTitle(record),
    valuesJson: record.values ?? null
  };
}

export function createRegiondoOptionCompositeKey(input: {
  regiondoOptionId: string;
  regiondoProductId: string;
  regiondoVariantId: string;
}): string {
  return `${input.regiondoProductId}_${input.regiondoVariantId}_${input.regiondoOptionId}`;
}
