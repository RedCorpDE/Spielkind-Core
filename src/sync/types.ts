export type RegiondoProduct = {
  id: string;
  title?: string;
  description?: string;
  image_url?: string;
  price?: number;
  variants?: Array<{ id: string; title?: string; price?: number }>;
  options?: Array<{ id: string; title?: string; values?: unknown }>;
  [key: string]: unknown;
};

export type RegiondoBooking = {
  id: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  total_price?: number;
  paid_amount?: number;
  guest_count?: number;
  customer?: { id?: string };
  location?: { id?: string };
  product?: { id?: string; price?: number };
  products?: Array<{ id?: string; quantity?: number; price?: number }>;
  [key: string]: unknown;
};
