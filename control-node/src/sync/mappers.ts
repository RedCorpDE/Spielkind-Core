/**
 * Maps Regiondo API responses to our database structures.
 *
 * Based on the real supplier/bookings response shape:
 * - Bookings are flat objects (no nested customer object)
 * - Primary key is `booking_key`
 * - Regiondo provides no customer ID — our system assigns a UUID at upsert time
 *   (find-or-create by email, so the UUID is stable across syncs)
 * - `dt_to` must be derived from `event_date_time` + `duration_value` / `duration_type`
 * - `total_amount` is a decimal string ("60.0000")
 * - `paid_amount` is inferred from the `payment_status` text
 * - Birthday lives inside the `buyer_data` array at field_id "7"
 * - `status` "sent" means confirmed
 */

// ─── DB upsert shapes ────────────────────────────────────────────────────────

export interface ClientUpsert {
  // regiondo_customer_id is intentionally absent here —
  // it is a UUID assigned by our system at upsert time (find-or-create by email).
  first_name: string;
  last_name: string;
  email: string | null;
  phone_number: string | null;
  birthday: string | null;
  regiondo_raw: unknown;
}

export interface ProductUpsert {
  regiondo_product_id: string;
  title: string;
  description: string | null;
  base_amount: number;
  regiondo_raw: unknown;
}

export interface BookingUpsert {
  regiondo_booking_id: string;
  regiondo_customer_id: string; // UUID resolved by upsertClient before this is written
  dt_from: string;
  dt_to: string;
  guest_count: number;
  total_amount: number;
  paid_amount: number;
  status: string;
  regiondo_raw: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(val: unknown): string | null {
  if (val == null || val === "") return null;
  return String(val).trim();
}

function num(val: unknown, fallback = 0): number {
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

/**
 * Extracts a field value from Regiondo's buyer_data array by field_id.
 * buyer_data: [{ field_id: "7", value: "1989-03-10" }, ...]
 */
function buyerField(buyerData: unknown, fieldId: string): string | null {
  if (!Array.isArray(buyerData)) return null;
  const found = buyerData.find(
      (f): f is Record<string, unknown> =>
          typeof f === "object" &&
          f !== null &&
          String((f as Record<string, unknown>).field_id) === fieldId
  );
  return str(found?.value ?? null);
}

/**
 * Calculates dt_to by adding duration to dt_from.
 *
 * duration_type: "minute" | "hour" | "day"
 * duration_value: string like "90.00"
 *
 * Regiondo datetimes are Europe/Berlin — stored as-is to match the rest of the system.
 * NOTE: uses +01:00 (CET); consider a tz library (e.g. luxon) to handle CEST correctly.
 */
function calcDtTo(
    dtFrom: string,
    durationType: string,
    durationValue: string
): string {
  const base = new Date(dtFrom.replace(" ", "T") + "+01:00");
  const amount = parseFloat(durationValue) || 0;

  switch (durationType) {
    case "minute":
      base.setMinutes(base.getMinutes() + amount);
      break;
    case "hour":
      base.setHours(base.getHours() + amount);
      break;
    case "day":
      base.setDate(base.getDate() + amount);
      break;
    default:
      break;
  }

  return base
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
}

/**
 * Infers paid_amount from the payment_status label.
 * "Unpaid (Cash payment)" → 0
 * "Paid (PayPal)" / "Paid (Credit Card)" / etc. → total_amount
 */
function inferPaidAmount(paymentStatus: string, totalAmount: number): number {
  const lower = paymentStatus.toLowerCase();
  if (lower.startsWith("paid")) return totalAmount;
  return 0;
}

/**
 * Maps Regiondo booking status codes to our internal status enum.
 * Regiondo uses "sent" for confirmed bookings.
 */
const STATUS_MAP: Record<string, string> = {
  sent: "confirmed",
  confirmed: "confirmed",
  pending: "pending",
  cancelled: "cancelled",
  canceled: "cancelled",
  completed: "completed",
  done: "completed",
};

function mapStatus(raw: string): string {
  return STATUS_MAP[raw.toLowerCase()] ?? "pending";
}

// ─── Public mappers ───────────────────────────────────────────────────────────

/**
 * Maps a flat Regiondo booking row to a ClientUpsert.
 * Does NOT include regiondo_customer_id — that UUID is assigned at upsert time.
 */
export function mapCustomer(raw: Record<string, unknown>): ClientUpsert {
  const birthday = buyerField(raw.buyer_data, "7");

  return {
    first_name: str(raw.first_name) ?? "",
    last_name: str(raw.last_name) ?? "",
    email: str(raw.email),
    phone_number: str(raw.phone_number),
    birthday,
    regiondo_raw: raw,
  };
}

/**
 * Maps a product row from supplier/products.
 */
export function mapProduct(raw: Record<string, unknown>): ProductUpsert {
  return {
    regiondo_product_id: String(raw.id ?? raw.product_id),
    title: str(raw.name ?? raw.title) ?? "",
    description: str(raw.description),
    base_amount: num(raw.price ?? raw.base_price),
    regiondo_raw: raw,
  };
}

/**
 * Maps a flat Regiondo booking row to a BookingUpsert.
 * Requires resolvedCustomerId — the UUID returned by upsertClient — to be passed in.
 *
 * Key fields from the real API:
 *   booking_key            → regiondo_booking_id
 *   event_date_time + duration_* → dt_from / dt_to
 *   qty                    → guest_count
 *   total_amount           → parsed from string
 *   payment_status (text)  → inferred paid_amount
 *   status                 → mapped via STATUS_MAP
 */
export function mapBooking(
    raw: Record<string, unknown>,
    resolvedCustomerId: string
): BookingUpsert {
  const dtFrom = String(raw.event_date_time ?? "");
  const durationType = String(raw.duration_type ?? "minute");
  const durationValue = String(raw.duration_value ?? "0");
  const dtTo = calcDtTo(dtFrom, durationType, durationValue);

  const totalAmount = num(raw.total_amount);
  const paymentStatus = String(raw.payment_status ?? "");
  const paidAmount = inferPaidAmount(paymentStatus, totalAmount);

  return {
    regiondo_booking_id: String(raw.booking_key ?? raw.id ?? raw.booking_id),
    regiondo_customer_id: resolvedCustomerId,
    dt_from: dtFrom,
    dt_to: dtTo,
    guest_count: num(raw.qty ?? raw.guest_count, 1),
    total_amount: totalAmount,
    paid_amount: paidAmount,
    status: mapStatus(String(raw.status ?? "pending")),
    regiondo_raw: raw,
  };
}

// ─── Product / Variation / Option upsert shapes ──────────────────────────────

export interface VariationUpsert {
  variation_id: number;
  product_id: number;
  title: string;
  regiondo_raw: unknown;
}

export interface OptionUpsert {
  option_id: number;
  product_id: number;
  variation_id: number;
  title: string;
  regiondo_raw: unknown;
}

// ─── Number coercion (strips currency symbols, commas, etc.) ────────────────

export function toCleanNumber(val: unknown): number | null {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ─── Slot picker ─────────────────────────────────────────────────────────────

export interface AvailSlot {
  date: string;       // "YYYY-MM-DD"
  timeShort: string;  // "HH:MM"
  timeFull: string;   // "HH:MM:SS" (falls back to timeShort)
}

/**
 * Picks the first available date+time slot from a variation's raw_json.
 * Supports both available_dates_times and available_dates shapes.
 * Returns null if no slot can be found (variation has no future availability).
 */
export function pickSlotFromVariationRaw(variationRaw: unknown): AvailSlot | null {
  if (!variationRaw || typeof variationRaw !== "object") return null;
  const raw = variationRaw as Record<string, unknown>;

  // Shape 1: available_dates_times: { "YYYY-MM-DD": ["YYYY-MM-DD HH:MM:SS", ...] }
  const adt = raw.available_dates_times;
  if (adt && typeof adt === "object" && !Array.isArray(adt)) {
    const dates = Object.keys(adt as object).sort();
    for (const d of dates) {
      const arr = (adt as Record<string, unknown[]>)[d];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const first = String(arr[0] ?? "").trim();
      if (!first) continue;
      const parts = first.split(" ");
      const date = (parts[0] || d).slice(0, 10);
      const timeFull = (parts[1] || "").slice(0, 8);
      const timeShort = timeFull ? timeFull.slice(0, 5) : null;
      if (date && timeShort) return { date, timeShort, timeFull: timeFull || timeShort };
    }
  }

  // Shape 2: available_dates: { "YYYY-MM-DD": [["HH:MM:SS", ...], ...] | ["HH:MM:SS", ...] }
  const ad = raw.available_dates;
  if (ad && typeof ad === "object" && !Array.isArray(ad)) {
    const dates = Object.keys(ad as object).sort();
    for (const d of dates) {
      const blocks = (ad as Record<string, unknown>)[d];
      if (!Array.isArray(blocks) || blocks.length === 0) continue;
      const firstBlock = blocks[0];
      const t = Array.isArray(firstBlock) && firstBlock.length > 0 ? firstBlock[0] : firstBlock;
      const timeFull = String(t ?? "").trim().slice(0, 8);
      const timeShort = timeFull ? timeFull.slice(0, 5) : null;
      const date = String(d).slice(0, 10);
      if (date && timeShort) return { date, timeShort, timeFull: timeFull || timeShort };
    }
  }

  return null;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

export function mapVariation(
    raw: Record<string, unknown>,
    productId: number
): VariationUpsert {
  const variationId = toCleanNumber(raw.variation_id ?? raw.id ?? raw.variationId);
  return {
    variation_id: variationId!,
    product_id: productId,
    title: String(raw.name ?? raw.title ?? `Variation ${variationId}`),
    regiondo_raw: raw,
  };
}

export function mapOption(
    raw: Record<string, unknown>,
    productId: number,
    variationId: number
): OptionUpsert {
  const optionId = toCleanNumber(raw.option_id ?? raw.id ?? raw.optionId);
  return {
    option_id: optionId!,
    product_id: toCleanNumber(raw.product_id) ?? productId,
    variation_id: toCleanNumber(raw.variation_id) ?? variationId,
    title: String(raw.name ?? raw.title ?? `Option ${optionId}`),
    regiondo_raw: raw,
  };
}