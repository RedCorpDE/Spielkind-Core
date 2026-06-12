import { createHash } from 'node:crypto';
import { pool } from '../../db/client.js';
import type {
  CreateDashboardTaskInput,
  DashboardTask,
  DashboardTaskMutationActor,
  DashboardTaskRawJson
} from '../../dashboard/types.js';
import { createTaskRecord, getTask } from '../../dashboard/repository/tasks.js';

const DEFAULT_SOURCE = 'client_email_service';
const EXTERNAL_ITEM_ID = 'External client email service';
const ACTOR: DashboardTaskMutationActor = {
  name: EXTERNAL_ITEM_ID,
  role: 'Operations',
  source: 'external'
};

export class ExternalTaskIntakeConflictError extends Error {}

export interface ExternalTaskIntakeOptionInput {
  optionId?: string | null;
  productId: string;
  variationId?: string | null;
}

export interface ExternalClientEmailTaskInput {
  attendees?: number | string | null;
  beveragePackage?: string | null;
  cateringSize?: string | null;
  choiceBlock?: string | string[] | null;
  columnId?: string | null;
  description: string;
  email?: string | null;
  eventDateTime: string;
  externalMessageId: string;
  firstName?: string | null;
  fixedPrice?: string | null;
  lastName?: string | null;
  options?: ExternalTaskIntakeOptionInput[];
  ownerId?: string | null;
  originalClientEmail: string;
  paymentMethod?: string | null;
  phoneNumber?: string | null;
  price?: number | string | null;
  priceCalculation?: string | null;
  reminderDate?: string | null;
  reservedCapacityDate?: string | null;
  secondaryEventTime?: string | null;
  site: string;
  source?: string | null;
  taxation?: string | null;
  title: string;
}

interface ExternalTaskIntakeEventRow {
  request_hash: string;
  task_id: string;
}

function trimOptional(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = trimOptional(value);
  return trimmed || undefined;
}

function normalizeOptionalNullableText(value: string | null | undefined): string | null | undefined {
  if (value === null) {
    return null;
  }

  return trimToUndefined(value);
}

function normalizeChoiceBlock(value: string | string[] | null | undefined): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();

  return entries.flatMap((entry) => {
    const normalized = trimOptional(entry);
    if (!normalized || normalized === 'none' || seen.has(normalized)) {
      return [];
    }

    seen.add(normalized);
    return [normalized];
  });
}

function normalizeOptions(options: ExternalTaskIntakeOptionInput[] | undefined) {
  return (options ?? []).flatMap((option) => {
    const productId = trimOptional(option.productId);
    if (!productId) {
      return [];
    }

    return [
      {
        option_id: trimOptional(option.optionId),
        product_id: productId,
        variation_id: trimOptional(option.variationId)
      }
    ];
  });
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function normalizeExternalClientEmailTaskInput(
  input: ExternalClientEmailTaskInput
): ExternalClientEmailTaskInput & { source: string } {
  return {
    ...input,
    beveragePackage: trimOptional(input.beveragePackage),
    cateringSize: trimOptional(input.cateringSize),
    columnId: normalizeOptionalNullableText(input.columnId),
    description: input.description.trim(),
    email: trimOptional(input.email),
    eventDateTime: input.eventDateTime.trim(),
    externalMessageId: input.externalMessageId.trim(),
    firstName: trimOptional(input.firstName),
    fixedPrice: trimOptional(input.fixedPrice),
    lastName: trimOptional(input.lastName),
    options: input.options ?? [],
    originalClientEmail: input.originalClientEmail.trim(),
    ownerId: normalizeOptionalNullableText(input.ownerId),
    paymentMethod: trimOptional(input.paymentMethod),
    phoneNumber: trimOptional(input.phoneNumber),
    priceCalculation: trimOptional(input.priceCalculation),
    reminderDate: normalizeOptionalNullableText(input.reminderDate),
    reservedCapacityDate: normalizeOptionalNullableText(input.reservedCapacityDate),
    secondaryEventTime: trimOptional(input.secondaryEventTime),
    site: input.site.trim(),
    source: trimOptional(input.source) || DEFAULT_SOURCE,
    taxation: trimOptional(input.taxation),
    title: input.title.trim()
  };
}

export function hashExternalClientEmailTaskInput(input: ExternalClientEmailTaskInput): string {
  const normalized = normalizeExternalClientEmailTaskInput(input);
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

export function buildCreateTaskInputFromExternalClientEmail(
  input: ExternalClientEmailTaskInput,
  requestHash?: string
): CreateDashboardTaskInput {
  const normalized = normalizeExternalClientEmailTaskInput(input);
  const contactEmail = trimOptional(normalized.email);
  const phoneNumber = trimOptional(normalized.phoneNumber);
  const rawJson: DashboardTaskRawJson = {
    booking_data: {
      attendees: normalized.attendees ?? '',
      beverage_package: trimOptional(normalized.beveragePackage),
      catering_size: trimOptional(normalized.cateringSize),
      choice_block: normalizeChoiceBlock(normalized.choiceBlock),
      contact_data: {
        email: contactEmail,
        first_name: trimOptional(normalized.firstName),
        last_name: trimOptional(normalized.lastName),
        phone_number: phoneNumber
      },
      email: contactEmail,
      external_item_id: EXTERNAL_ITEM_ID,
      fixed_price: trimOptional(normalized.fixedPrice),
      og_client_email: normalized.originalClientEmail,
      options: normalizeOptions(normalized.options),
      payment_method: trimOptional(normalized.paymentMethod),
      phone_number: phoneNumber,
      price: normalized.price ?? null,
      price_calculation: trimOptional(normalized.priceCalculation),
      qty: 1,
      secondary_event_time: trimOptional(normalized.secondaryEventTime),
      site: normalized.site,
      taxation: trimOptional(normalized.taxation)
    },
    external_intake: {
      externalMessageId: normalized.externalMessageId,
      requestHash: requestHash ?? hashExternalClientEmailTaskInput(normalized),
      source: normalized.source
    }
  };

  return {
    columnId: normalized.columnId,
    description: normalized.description,
    eventDateTime: normalized.eventDateTime,
    ownerId: normalized.ownerId,
    rawJson,
    reminderDate: normalized.reminderDate,
    reservedCapacityDate: normalized.reservedCapacityDate,
    site: normalized.site,
    title: normalized.title
  };
}

export async function createExternalClientEmailTask(
  input: ExternalClientEmailTaskInput
): Promise<{ created: boolean; duplicate?: boolean; item: DashboardTask }> {
  const normalized = normalizeExternalClientEmailTaskInput(input);
  const requestHash = hashExternalClientEmailTaskInput(normalized);
  const client = await pool.connect();
  let taskId: string | null = null;
  let created = true;

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `external_task_intake:${normalized.source}:${normalized.externalMessageId}`
    ]);

    const existing = await client.query<ExternalTaskIntakeEventRow>(
      `SELECT task_id, request_hash
       FROM external_task_intake_events
       WHERE source = $1 AND external_message_id = $2
       LIMIT 1`,
      [normalized.source, normalized.externalMessageId]
    );

    if (existing.rowCount) {
      const existingEvent = existing.rows[0];
      if (existingEvent.request_hash !== requestHash) {
        throw new ExternalTaskIntakeConflictError(
          'externalMessageId was already processed with a different payload.'
        );
      }

      taskId = existingEvent.task_id;
      created = false;
    } else {
      taskId = await createTaskRecord(
        client,
        buildCreateTaskInputFromExternalClientEmail(normalized, requestHash),
        ACTOR
      );

      await client.query(
        `INSERT INTO external_task_intake_events (source, external_message_id, task_id, request_hash)
         VALUES ($1, $2, $3, $4)`,
        [normalized.source, normalized.externalMessageId, taskId, requestHash]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (!taskId) {
    throw new Error('External task intake completed without a task id.');
  }

  return {
    created,
    ...(created ? {} : { duplicate: true }),
    item: await getTask(taskId)
  };
}
