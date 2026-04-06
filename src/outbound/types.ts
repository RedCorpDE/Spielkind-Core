import { z } from 'zod';

// Client Message Payload (T1: -7d, T2: -1d)
export const ClientMessagePayloadSchema = z.object({
  type: z.enum(['client_message_7d', 'client_message_1d']),
  bookingId: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  preferredContactType: z.string().nullable(),
  groupName: z.string().nullable(),
  groupSize: z.number().int().positive(),
  eventDateTime: z.string(), // ISO 8601 UTC (dt_from)
  bookingType: z.string().nullable(),
});

export type ClientMessagePayload = z.infer<typeof ClientMessagePayloadSchema>;

// Check-Out Payload (T4)
export const CheckOutPayloadSchema = z.object({
  type: z.literal('check_out'),
  bookingId: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string(),
  groupName: z.string().nullable(),
  groupSize: z.number().int().positive(),
  attendeeNames: z.array(z.string()).nullable(),
  eventDateTime: z.string(), // ISO 8601 UTC (dt_from)
  bookingType: z.string().nullable(),
  agentGeneratedGoodbye: z.string(),
});

export type CheckOutPayload = z.infer<typeof CheckOutPayloadSchema>;

export type OutboundPayload = ClientMessagePayload | CheckOutPayload;

export type TriggerType = 'client_message_7d' | 'client_message_1d' | 'check_out';

// DB row returned by payload queries
export interface BookingRow {
  booking_id: string;
  first_name: string;
  last_name: string;
  preferred_contact_type: string | null;
  guest_count: number;
  dt_from: Date;
  dt_to: Date;
  group_name: string | null;
  booking_type: string | null;
}
