/**
 * Maps Regiondo API responses to our database structures.
 *
 * The exact field names depend on the actual Regiondo API response format.
 * These mappers should be adjusted once the real API response is inspected.
 * The regiondo_raw field always stores the full original payload.
 */

export interface ClientUpsert {
  regiondo_customer_id: string;
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
  regiondo_customer_id: string;
  dt_from: string;
  dt_to: string;
  guest_count: number;
  total_amount: number;
  paid_amount: number;
  status: string;
  regiondo_raw: unknown;
}

function str(val: unknown): string | null {
  if (val == null || val === "") return null;
  return String(val);
}

function num(val: unknown, fallback = 0): number {
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

const STATUS_MAP: Record<string, string> = {
  confirmed: "confirmed",
  pending: "pending",
  cancelled: "cancelled",
  completed: "completed",
};

export function mapCustomer(raw: Record<string, unknown>): ClientUpsert {
  return {
    regiondo_customer_id: String(raw.id ?? raw.customer_id),
    first_name: String(raw.first_name ?? raw.firstname ?? ""),
    last_name: String(raw.last_name ?? raw.lastname ?? ""),
    email: str(raw.email),
    phone_number: str(raw.phone ?? raw.phone_number),
    birthday: str(raw.birthday ?? raw.date_of_birth),
    regiondo_raw: raw,
  };
}

export function mapProduct(raw: Record<string, unknown>): ProductUpsert {
  return {
    regiondo_product_id: String(raw.id ?? raw.product_id),
    title: String(raw.name ?? raw.title ?? ""),
    description: str(raw.description),
    base_amount: num(raw.price ?? raw.base_price),
    regiondo_raw: raw,
  };
}

export function mapBooking(raw: Record<string, unknown>): BookingUpsert {
  const customer =
    typeof raw.customer === "object" && raw.customer !== null
      ? (raw.customer as Record<string, unknown>)
      : {};

  const regiondoStatus = String(raw.status ?? "pending").toLowerCase();

  return {
    regiondo_booking_id: String(raw.id ?? raw.booking_id),
    regiondo_customer_id: String(
      customer.id ?? raw.customer_id ?? raw.customerId
    ),
    dt_from: String(raw.start_date ?? raw.date_from ?? raw.dt_from),
    dt_to: String(raw.end_date ?? raw.date_to ?? raw.dt_to),
    guest_count: num(raw.participants ?? raw.guests ?? raw.guest_count, 1),
    total_amount: num(raw.total_price ?? raw.total ?? raw.total_amount),
    paid_amount: num(raw.paid_amount ?? raw.paid ?? 0),
    status: STATUS_MAP[regiondoStatus] ?? "pending",
    regiondo_raw: raw,
  };
}
