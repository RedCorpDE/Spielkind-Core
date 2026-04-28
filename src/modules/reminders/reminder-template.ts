const REMINDER_TEMPLATE_TIME_ZONE = 'Europe/Berlin';

interface ReminderTemplateContextInput {
  bookingStatus: string;
  dtFrom: string;
  dtTo: string;
  email: string | null;
  firstName: string;
  guestCount: number;
  lastName: string;
  locationTitle: string;
  paidAmount: number | string;
  products: Array<Record<string, unknown>>;
  regiondoOrderNumber: string | null;
  resources: Array<Record<string, unknown>>;
  totalAmount: number | string;
}

const formatDateTimeToken = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: REMINDER_TEMPLATE_TIME_ZONE
  }).format(date);
};

const summarizeNamedItems = (
  items: Array<Record<string, unknown>>,
  titleField: string,
  quantityField: string
) =>
  items
    .flatMap((item) => {
      const title = typeof item[titleField] === 'string' ? item[titleField].trim() : '';
      const quantity = item[quantityField];
      const normalizedQuantity =
        typeof quantity === 'number'
          ? quantity
          : typeof quantity === 'string'
            ? Number(quantity)
            : Number.NaN;

      if (!title) {
        return [];
      }

      if (Number.isFinite(normalizedQuantity) && normalizedQuantity > 0) {
        return [`${normalizedQuantity}x ${title}`];
      }

      return [title];
    })
    .join(', ');

export function buildReminderTemplateVariables(
  input: ReminderTemplateContextInput
): Record<string, string> {
  const fullName = [input.firstName, input.lastName].filter(Boolean).join(' ').trim();

  return {
    'booking.endsAt': formatDateTimeToken(input.dtTo),
    'booking.endsAtIso': input.dtTo,
    'booking.guestCount': `${input.guestCount}`,
    'booking.orderNumber': input.regiondoOrderNumber ?? '',
    'booking.paidAmount': `${input.paidAmount}`,
    'booking.startsAt': formatDateTimeToken(input.dtFrom),
    'booking.startsAtIso': input.dtFrom,
    'booking.status': input.bookingStatus,
    'booking.totalAmount': `${input.totalAmount}`,
    'client.email': input.email ?? '',
    'client.firstName': input.firstName,
    'client.fullName': fullName,
    'client.lastName': input.lastName,
    'location.title': input.locationTitle,
    'products.summary': summarizeNamedItems(input.products, 'title', 'quantity'),
    'resources.summary': summarizeNamedItems(input.resources, 'title', 'mapped_quantity')
  };
}

export function renderReminderTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (match, token: string) => {
    const replacement = variables[token];
    return replacement !== undefined ? replacement : match;
  });
}

