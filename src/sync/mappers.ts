import type { RegiondoBooking, RegiondoProduct } from './types.js';

const statusMapping: Record<string, string> = {
  created: 'pending',
  pending: 'pending',
  confirmed: 'confirmed',
  checked_in: 'checked_in',
  completed: 'completed',
  cancelled: 'cancelled',
  no_show: 'no_show'
};

export function mapBookingStatus(status: string | undefined): string {
  if (!status) {
    return 'pending';
  }

  return statusMapping[status] ?? 'pending';
}

export function mapProductForDb(product: RegiondoProduct) {
  return {
    regiondoProductId: String(product.id),
    title: product.title ?? 'Untitled Product',
    description: product.description ?? null,
    imageUrl: product.image_url ?? null,
    baseAmount: Number(product.price ?? 0),
    raw: product
  };
}

export function mapBookingForDb(booking: RegiondoBooking) {
  const fallbackStart = new Date().toISOString();
  const fallbackEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  return {
    regiondoBookingId: String(booking.id),
    regiondoCustomerId: booking.customer?.id ? String(booking.customer.id) : null,
    regiondoLocationId: booking.location?.id ? String(booking.location.id) : null,
    status: mapBookingStatus(booking.status),
    guestCount: Number(booking.guest_count ?? 1),
    totalAmount: Number(booking.total_price ?? 0),
    paidAmount: Number(booking.paid_amount ?? 0),
    dtFrom: booking.start_date ?? fallbackStart,
    dtTo: booking.end_date ?? fallbackEnd,
    raw: booking,
    bookingProducts: booking.products ?? (booking.product?.id ? [{ id: booking.product.id, quantity: 1, price: booking.product.price ?? 0 }] : [])
  };
}
