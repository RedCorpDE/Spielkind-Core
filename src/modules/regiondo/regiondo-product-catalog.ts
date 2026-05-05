type CatalogRecord = Record<string, unknown>;

export interface RegiondoCatalogOptionValueSummary {
  id: string;
  label: string;
}

export interface RegiondoCatalogOptionSummary {
  id: string;
  label: string;
  values: RegiondoCatalogOptionValueSummary[];
}

export interface RegiondoCatalogVariationSummary {
  id: string;
  label: string;
  options: RegiondoCatalogOptionSummary[];
  price: number | null;
  values: string[];
}

export interface RegiondoProductCatalogSummary {
  options: RegiondoCatalogOptionSummary[];
  variations: RegiondoCatalogVariationSummary[];
}

export interface RegiondoCatalogVariationRowSummaryInput {
  price: number | null;
  rawJson: unknown;
  regiondoVariantId: string;
  title: string | null;
}

export interface RegiondoCatalogOptionRowSummaryInput {
  rawJson: unknown;
  regiondoOptionId: string;
  regiondoVariantId: string | null;
  title: string | null;
  valuesJson: unknown;
}

interface ParsedOptionSummary extends RegiondoCatalogOptionSummary {
  labelPriority: number;
}

interface ParsedVariationSummary extends RegiondoCatalogVariationSummary {
  parsedOptions: ParsedOptionSummary[];
}

const EMPTY_REGIONDO_PRODUCT_CATALOG_SUMMARY: RegiondoProductCatalogSummary = {
  options: [],
  variations: []
};

const asRecord = (value: unknown): CatalogRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as CatalogRecord) : null;

const toCatalogRecord = (value: unknown): CatalogRecord => ({ ...(asRecord(value) ?? {}) });

const readTrimmedString = (record: CatalogRecord | null, keys: string[]) => {
  for (const key of keys) {
    const value = record?.[key];

    if (typeof value !== 'string') {
      continue;
    }

    const normalizedValue = value.trim();

    if (normalizedValue) {
      return normalizedValue;
    }
  }

  return '';
};

const readNumber = (record: CatalogRecord | null, keys: string[]) => {
  for (const key of keys) {
    const value = record?.[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const normalizedValue = Number(value.trim());

      if (Number.isFinite(normalizedValue)) {
        return normalizedValue;
      }
    }
  }

  return null;
};

const toIdentifier = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }

  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
};

const stringifyPrimitive = (value: unknown) => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }

  if (typeof value === 'boolean') {
    return `${value}`;
  }

  return '';
};

const dedupeStringValues = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalizedValue = value.trim();
    const lookupKey = normalizedValue.toLowerCase();

    if (!normalizedValue || seen.has(lookupKey)) {
      return;
    }

    seen.add(lookupKey);
    result.push(normalizedValue);
  });

  return result;
};

const joinDistinctLabels = (values: string[]) => dedupeStringValues(values).join(', ');

const dedupeOptionValues = (values: RegiondoCatalogOptionValueSummary[]) => {
  const seen = new Set<string>();
  const result: RegiondoCatalogOptionValueSummary[] = [];

  values.forEach((value) => {
    const lookupKey = `${value.id.toLowerCase()}::${value.label.toLowerCase()}`;

    if (seen.has(lookupKey)) {
      return;
    }

    seen.add(lookupKey);
    result.push(value);
  });

  return result;
};

const parseOptionValue = (value: unknown): RegiondoCatalogOptionValueSummary | null => {
  const primitiveValue = stringifyPrimitive(value);

  if (primitiveValue) {
    return {
      id: primitiveValue,
      label: primitiveValue
    };
  }

  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const label =
    readTrimmedString(record, ['title', 'label', 'name']) ||
    stringifyPrimitive(record.value) ||
    toIdentifier(record.option_value_id) ||
    toIdentifier(record.id);

  if (!label) {
    return null;
  }

  const id =
    toIdentifier(record.id) ||
    toIdentifier(record.value) ||
    toIdentifier(record.option_value_id) ||
    label;

  return {
    id,
    label
  };
};

const parseOptionValues = (values: unknown): RegiondoCatalogOptionValueSummary[] => {
  if (!Array.isArray(values)) {
    return [];
  }

  return dedupeOptionValues(
    values.flatMap((value) => {
      const parsedValue = parseOptionValue(value);
      return parsedValue ? [parsedValue] : [];
    })
  );
};

const buildOptionLabel = (
  record: CatalogRecord | null,
  values: RegiondoCatalogOptionValueSummary[],
  optionId: string
): { label: string; labelPriority: number } => {
  const explicitLabel = readTrimmedString(record, ['title', 'label', 'name']);

  if (explicitLabel) {
    return { label: explicitLabel, labelPriority: 2 };
  }

  const derivedLabel = joinDistinctLabels(values.map((value) => value.label));

  if (derivedLabel) {
    return { label: derivedLabel, labelPriority: 1 };
  }

  return { label: `Option ${optionId}`, labelPriority: 0 };
};

const parseOption = (value: unknown): ParsedOptionSummary | null => {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const optionId =
    toIdentifier(record.option_id) ||
    toIdentifier(record.id) ||
    toIdentifier(record.optionId);

  if (!optionId) {
    return null;
  }

  const values = parseOptionValues(record.values);
  const { label, labelPriority } = buildOptionLabel(record, values, optionId);

  return {
    id: optionId,
    label,
    labelPriority,
    values
  };
};

const buildOptionSourceFromRow = (row: RegiondoCatalogOptionRowSummaryInput): CatalogRecord => {
  const source = toCatalogRecord(row.rawJson);
  source.option_id = row.regiondoOptionId;

  if (row.title) {
    source.title = row.title;
  }

  if (row.valuesJson !== undefined) {
    source.values = row.valuesJson;
  }

  return source;
};

const toPublicOption = (option: ParsedOptionSummary): RegiondoCatalogOptionSummary => ({
  id: option.id,
  label: option.label,
  values: option.values
});

const mergeOptionSummary = (
  current: ParsedOptionSummary | undefined,
  incoming: ParsedOptionSummary
): ParsedOptionSummary => {
  if (!current) {
    return incoming;
  }

  const preferredLabelSource =
    current.labelPriority > incoming.labelPriority
      ? current
      : incoming.labelPriority > current.labelPriority
        ? incoming
        : current.values.length >= incoming.values.length
          ? current
          : incoming;

  return {
    id: current.id || incoming.id,
    label: preferredLabelSource.label,
    labelPriority: preferredLabelSource.labelPriority,
    values: dedupeOptionValues([...current.values, ...incoming.values])
  };
};

const buildVariationLabel = (
  record: CatalogRecord | null,
  variationValues: RegiondoCatalogOptionValueSummary[],
  linkedOptionValues: RegiondoCatalogOptionValueSummary[],
  variationId: string
) =>
  readTrimmedString(record, ['title', 'label', 'name']) ||
  joinDistinctLabels(variationValues.map((value) => value.label)) ||
  joinDistinctLabels(linkedOptionValues.map((value) => value.label)) ||
  `Variation ${variationId}`;

const toPublicVariation = (variation: ParsedVariationSummary): RegiondoCatalogVariationSummary => ({
  id: variation.id,
  label: variation.label,
  options: variation.options,
  price: variation.price,
  values: variation.values
});

const parseVariation = (value: unknown): ParsedVariationSummary | null => {
  const record = asRecord(value);

  if (!record) {
    return null;
  }

  const variationId =
    toIdentifier(record.variation_id) ||
    toIdentifier(record.id) ||
    toIdentifier(record.variationId);

  if (!variationId) {
    return null;
  }

  const parsedOptions = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        const parsedOption = parseOption(option);
        return parsedOption ? [parsedOption] : [];
      })
    : [];
  const variationValues = parseOptionValues(record.values);
  const linkedOptionValues = parsedOptions.flatMap((option) => option.values);

  return {
    id: variationId,
    label: buildVariationLabel(record, variationValues, linkedOptionValues, variationId),
    options: parsedOptions.map(toPublicOption),
    parsedOptions,
    price: readNumber(record, ['price', 'base_price', 'original_price']),
    values: dedupeStringValues(variationValues.map((optionValue) => optionValue.label))
  };
};

const parseVariationFromRow = (
  row: RegiondoCatalogVariationRowSummaryInput,
  optionRows: RegiondoCatalogOptionRowSummaryInput[]
): ParsedVariationSummary | null => {
  const source = toCatalogRecord(row.rawJson);
  source.variation_id = row.regiondoVariantId;
  source.options = optionRows.map(buildOptionSourceFromRow);

  if (row.title) {
    source.title = row.title;
  }

  if (row.price !== null) {
    source.price = row.price;
  }

  return parseVariation(source);
};

export const summarizeRegiondoProductCatalog = (rawJson: unknown): RegiondoProductCatalogSummary => {
  const productRecord = asRecord(rawJson);

  if (!productRecord) {
    return EMPTY_REGIONDO_PRODUCT_CATALOG_SUMMARY;
  }

  const variationsSource = Array.isArray(productRecord.variations)
    ? productRecord.variations
    : Array.isArray(productRecord.variants)
      ? productRecord.variants
      : [];
  const parsedVariations = variationsSource.flatMap((variation) => {
    const parsedVariation = parseVariation(variation);
    return parsedVariation ? [parsedVariation] : [];
  });
  const optionById = new Map<string, ParsedOptionSummary>();

  if (Array.isArray(productRecord.options)) {
    productRecord.options.forEach((option) => {
      const parsedOption = parseOption(option);

      if (!parsedOption) {
        return;
      }

      optionById.set(parsedOption.id, mergeOptionSummary(optionById.get(parsedOption.id), parsedOption));
    });
  }

  parsedVariations.forEach((variation) => {
    variation.parsedOptions.forEach((option) => {
      optionById.set(option.id, mergeOptionSummary(optionById.get(option.id), option));
    });
  });

  return {
    variations: parsedVariations.map(toPublicVariation),
    options: [...optionById.values()].map(toPublicOption),
  };
};

export const summarizeRegiondoProductCatalogFromRows = (input: {
  options: RegiondoCatalogOptionRowSummaryInput[];
  variations: RegiondoCatalogVariationRowSummaryInput[];
}): RegiondoProductCatalogSummary => {
  const optionRowsByVariationId = new Map<string, RegiondoCatalogOptionRowSummaryInput[]>();
  const productLevelOptionById = new Map<string, ParsedOptionSummary>();

  input.options.forEach((row) => {
    const parsedOption = parseOption(buildOptionSourceFromRow(row));

    if (parsedOption) {
      productLevelOptionById.set(
        parsedOption.id,
        mergeOptionSummary(productLevelOptionById.get(parsedOption.id), parsedOption)
      );
    }

    if (!row.regiondoVariantId) {
      return;
    }

    const optionRows = optionRowsByVariationId.get(row.regiondoVariantId) ?? [];
    optionRows.push(row);
    optionRowsByVariationId.set(row.regiondoVariantId, optionRows);
  });

  const parsedVariations = input.variations.flatMap((variation) => {
    const parsedVariation = parseVariationFromRow(
      variation,
      optionRowsByVariationId.get(variation.regiondoVariantId) ?? []
    );

    return parsedVariation ? [parsedVariation] : [];
  });

  parsedVariations.forEach((variation) => {
    variation.parsedOptions.forEach((option) => {
      productLevelOptionById.set(
        option.id,
        mergeOptionSummary(productLevelOptionById.get(option.id), option)
      );
    });
  });

  return {
    options: [...productLevelOptionById.values()].map(toPublicOption),
    variations: parsedVariations.map(toPublicVariation)
  };
};
