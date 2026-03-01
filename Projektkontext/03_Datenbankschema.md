# Datenbankschema

## Übersicht

```
┌────────────────┐       ┌──────────────────┐       ┌────────────────┐
│    clients     │       │    bookings       │       │   locations    │
│────────────────│       │──────────────────│       │────────────────│
│ client_id (PK) │◀──┐   │ booking_id (PK)  │   ┌──▶│ location_id(PK)│
│ first_name     │   └───│ client_id (FK)   │   │   │ title          │
│ last_name      │       │ location_id (FK) │───┘   │ description    │
│ email (unique) │       │ status           │       │ image_url      │
│ phone_number   │       │ guest_count      │       └───────┬────────┘
│ birthday       │       │ total_amount     │               │
└───────┬────────┘       │ paid_amount      │       ┌───────▼────────┐
        │                │ dt_from / dt_to  │       │location_products│
┌───────▼────────┐       └──┬────┬──────────┘       │────────────────│
│client_group_   │          │    │                   │ location_id(FK)│
│  members       │          │    │                   │ product_id (FK)│
│────────────────│  ┌───────▼┐   │                   └───────┬────────┘
│ group_id (FK)  │  │booking_│   │                           │
│ client_id (FK) │  │products│   │                   ┌───────▼────────┐
└───────┬────────┘  │────────│   │                   │   products     │
        │           │booking │   │                   │────────────────│
┌───────▼────────┐  │  _id   │   │                   │ product_id(PK) │
│ client_groups  │  │product │   │                   │ title          │
│────────────────│  │  _id   │   │                   │ base_amount    │
│ group_id (PK)  │  │quantity│   │                   └───────┬────────┘
│ title (unique) │  │unit_   │   │                           │
└────────────────┘  │ price  │   │                   ┌───────▼────────┐
                    └────────┘   │                   │product_resources│
                                 │                   │────────────────│
                    ┌────────────▼──┐                │ product_id(FK) │
                    │ consumptions  │                │ resource_id(FK)│
                    │───────────────│                │ quantity       │
                    │consumption_id │                └───────┬────────┘
                    │ booking_id(FK)│                        │
                    │resource_id(FK)│                ┌───────▼────────┐
                    │ type          │                │   resources    │
                    │ dt_from/dt_to │◀───────────────│────────────────│
                    │ capacity_used │                │ resource_id(PK)│
                    └───────────────┘                │ location_id(FK)│
                                                     │ type           │
                    ┌───────────────┐                │ capacity       │
                    │   payments    │                └────────────────┘
                    │───────────────│
                    │ payment_id(PK)│      ┌────────────────┐
                    │ booking_id(FK)│      │    coupons     │
                    │ amount        │      │────────────────│
                    │ type          │      │ coupon_id (PK) │
                    │ provider_ref  │      │ code (unique)  │
                    └───────────────┘      │ discount       │
                                           │ type           │
                    ┌───────────────┐      │ valid_from/to  │
                    │booking_coupons│      │ max_uses       │
                    │───────────────│      └───────┬────────┘
                    │booking_id (FK)│──────────────▶│
                    │coupon_id (FK) │
                    │discount_applied│
                    └───────────────┘
```

## Tabellendefinitionen

### Kerntabellen

#### `clients` -- Kunden
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `client_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `first_name` | text | NOT NULL | |
| `last_name` | text | NOT NULL | |
| `birthday` | date | | |
| `email` | citext | UNIQUE | Case-insensitive (benötigt `citext`-Extension) |
| `phone_number` | text | | |
| `preferred_contact_type` | text | | 'email', 'phone', 'sms', 'whatsapp', 'telegram' |
| `subscribed_to_newsletter` | boolean | NOT NULL DEFAULT false | |
| `regiondo_customer_id` | text | UNIQUE | Mapping zu Regiondo |
| `regiondo_raw` | jsonb | | Original-Payload von Regiondo |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `locations` -- Standorte
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `location_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `title` | text | NOT NULL | |
| `description` | text | | |
| `image_url` | text | | |
| `regiondo_location_id` | text | UNIQUE | Mapping zu Regiondo |
| `regiondo_raw` | jsonb | | Original-Payload von Regiondo |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `products` -- Buchbare Produkte
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `product_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `title` | text | NOT NULL | |
| `description` | text | | |
| `image_url` | text | | |
| `base_amount` | numeric(12,2) | NOT NULL DEFAULT 0, CHECK >= 0 | |
| `regiondo_product_id` | text | UNIQUE | Mapping zu Regiondo |
| `regiondo_raw` | jsonb | | Original-Payload |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `resources` -- Physische Ressourcen (Räume, PCs, etc.)
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `resource_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `location_id` | uuid | FK → locations, ON DELETE RESTRICT | |
| `type` | text | NOT NULL, CHECK IN (...) | 'pc-room', 'bed-room', 'console-room', 'beverages', 'other' |
| `capacity_available` | integer | NOT NULL, CHECK >= 0 | |
| `title` | text | NOT NULL | |
| `description` | text | | |
| `image_url` | text | | |
| `independently_bookable` | boolean | NOT NULL DEFAULT false | Kann ohne Produkt gebucht werden |
| `base_amount` | numeric(12,2) | NOT NULL DEFAULT 0 | |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `bookings` -- Buchungen
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `booking_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `client_id` | uuid | FK → clients, ON DELETE RESTRICT | |
| `location_id` | uuid | FK → locations, ON DELETE RESTRICT | |
| `status` | text | NOT NULL DEFAULT 'pending', CHECK IN (...) | 'draft', 'pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show' |
| `guest_count` | integer | NOT NULL DEFAULT 1, CHECK > 0 | |
| `total_amount` | numeric(12,2) | NOT NULL DEFAULT 0, CHECK >= 0 | |
| `paid_amount` | numeric(12,2) | NOT NULL DEFAULT 0, CHECK >= 0 | |
| `dt_from` | timestamptz | NOT NULL | |
| `dt_to` | timestamptz | NOT NULL, CHECK dt_to > dt_from | |
| `source` | text | NOT NULL DEFAULT 'regiondo', CHECK IN (...) | 'regiondo', 'manual', 'api', 'self-service', 'app' |
| `regiondo_booking_id` | text | UNIQUE | Mapping zu Regiondo |
| `regiondo_raw` | jsonb | | Original-Payload |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `consumptions` -- Ressourcenverbrauch pro Buchung
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `consumption_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `booking_id` | uuid | FK → bookings, ON DELETE CASCADE | |
| `resource_id` | uuid | FK → resources, ON DELETE RESTRICT | |
| `type` | text | NOT NULL DEFAULT 'reserved', CHECK IN (...) | 'reserved', 'consumed', 'blocked', 'maintenance' |
| `dt_from` | timestamptz | NOT NULL | |
| `dt_to` | timestamptz | NOT NULL, CHECK dt_to > dt_from | |
| `capacity_used` | integer | NOT NULL DEFAULT 1, CHECK > 0 | |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `payments` -- Zahlungen
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `payment_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `booking_id` | uuid | FK → bookings, ON DELETE CASCADE | |
| `amount` | numeric(12,2) | NOT NULL, CHECK > 0 | |
| `type` | text | NOT NULL, CHECK IN (...) | 'cash', 'card', 'paypal', 'sepa', 'bank_transfer', 'voucher', 'other' |
| `provider_ref` | text | | Externe Transaktions-ID |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `coupons` -- Gutscheine / Rabatte
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `coupon_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `code` | text | NOT NULL UNIQUE | Gutscheincode |
| `discount` | numeric(12,2) | NOT NULL, CHECK > 0 | |
| `type` | text | NOT NULL, CHECK IN (...) | 'fixed', 'percent' |
| `valid_from` | timestamptz | | |
| `valid_to` | timestamptz | | |
| `max_uses` | integer | | NULL = unbegrenzt |
| `times_used` | integer | NOT NULL DEFAULT 0 | |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |

#### `client_groups` -- Kundengruppen
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `group_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `title` | text | NOT NULL UNIQUE | |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | |

### Systemtabellen

#### `sync_log` -- Protokoll der Regiondo-Synchronisierung
| Spalte | Typ | Constraint | Beschreibung |
|--------|-----|-----------|--------------|
| `sync_id` | uuid | PK, DEFAULT gen_random_uuid() | |
| `sync_type` | text | NOT NULL | 'bookings', 'customers', 'products' |
| `status` | text | NOT NULL | 'started', 'completed', 'failed' |
| `records_synced` | integer | NOT NULL DEFAULT 0 | Anzahl synchronisierter Datensätze |
| `error_message` | text | | Bei Fehler: Fehlerbeschreibung |
| `started_at` | timestamptz | NOT NULL DEFAULT now() | |
| `completed_at` | timestamptz | | |

### Zwischentabellen (Relationen)

#### `booking_products` -- Produkte pro Buchung
| Spalte | Typ | Constraint |
|--------|-----|-----------|
| `booking_id` | uuid | FK → bookings, ON DELETE CASCADE |
| `product_id` | uuid | FK → products, ON DELETE RESTRICT |
| `quantity` | integer | NOT NULL DEFAULT 1, CHECK > 0 |
| `unit_price` | numeric(12,2) | NOT NULL |
| **PK**: (`booking_id`, `product_id`) |

#### `product_resources` -- Ressourcen pro Produkt
| Spalte | Typ | Constraint |
|--------|-----|-----------|
| `product_id` | uuid | FK → products, ON DELETE CASCADE |
| `resource_id` | uuid | FK → resources, ON DELETE RESTRICT |
| `quantity` | integer | NOT NULL DEFAULT 1 |
| **PK**: (`product_id`, `resource_id`) |

#### `location_products` -- Verfügbare Produkte pro Standort
| Spalte | Typ | Constraint |
|--------|-----|-----------|
| `location_id` | uuid | FK → locations, ON DELETE CASCADE |
| `product_id` | uuid | FK → products, ON DELETE CASCADE |
| **PK**: (`location_id`, `product_id`) |

#### `client_group_members` -- Kunden in Gruppen
| Spalte | Typ | Constraint |
|--------|-----|-----------|
| `group_id` | uuid | FK → client_groups, ON DELETE CASCADE |
| `client_id` | uuid | FK → clients, ON DELETE CASCADE |
| `joined_at` | timestamptz | NOT NULL DEFAULT now() |
| **PK**: (`group_id`, `client_id`) |

#### `booking_coupons` -- Eingelöste Gutscheine pro Buchung
| Spalte | Typ | Constraint |
|--------|-----|-----------|
| `booking_id` | uuid | FK → bookings, ON DELETE CASCADE |
| `coupon_id` | uuid | FK → coupons, ON DELETE RESTRICT |
| `discount_applied` | numeric(12,2) | NOT NULL |
| **PK**: (`booking_id`, `coupon_id`) |

## Empfohlene Indizes

```sql
-- Buchungen: Häufige Abfragen
CREATE INDEX idx_bookings_client      ON bookings(client_id);
CREATE INDEX idx_bookings_location    ON bookings(location_id);
CREATE INDEX idx_bookings_status      ON bookings(status);
CREATE INDEX idx_bookings_dt_from     ON bookings(dt_from);
CREATE INDEX idx_bookings_source      ON bookings(source);

-- Zeitbereich-Index für Überlappungs-Queries
CREATE INDEX idx_bookings_dt_range    ON bookings USING gist (tstzrange(dt_from, dt_to));

-- Consumptions: Verfügbarkeits-Prüfung
CREATE INDEX idx_consumptions_resource ON consumptions(resource_id);
CREATE INDEX idx_consumptions_booking  ON consumptions(booking_id);
CREATE INDEX idx_consumptions_dt_range ON consumptions USING gist (tstzrange(dt_from, dt_to));

-- Payments
CREATE INDEX idx_payments_booking     ON payments(booking_id);

-- Resources
CREATE INDEX idx_resources_location   ON resources(location_id);
CREATE INDEX idx_resources_type       ON resources(type);

-- Regiondo-Mapping (Partial Indexes, nur für vorhandene IDs)
CREATE INDEX idx_bookings_regiondo    ON bookings(regiondo_booking_id) WHERE regiondo_booking_id IS NOT NULL;
CREATE INDEX idx_clients_regiondo     ON clients(regiondo_customer_id) WHERE regiondo_customer_id IS NOT NULL;
CREATE INDEX idx_products_regiondo    ON products(regiondo_product_id) WHERE regiondo_product_id IS NOT NULL;
CREATE INDEX idx_locations_regiondo   ON locations(regiondo_location_id) WHERE regiondo_location_id IS NOT NULL;

-- Sync-Log
CREATE INDEX idx_sync_log_type       ON sync_log(sync_type);
CREATE INDEX idx_sync_log_started    ON sync_log(started_at DESC);
```

## Trigger

### `updated_at` automatisch aktualisieren

Alle Tabellen mit `updated_at` erhalten einen Trigger:

```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Anwenden auf: clients, locations, products, resources, bookings, client_groups
```

## Designentscheidungen

1. **JSONB nur für externe Rohdaten** (`regiondo_raw`) -- nicht für interne Relationen
2. **UUID statt Serial** -- verteilungssicher, keine erratbaren IDs
3. **ON DELETE RESTRICT** bei Stammdaten -- verhindert versehentliches Löschen
4. **ON DELETE CASCADE** bei abhängigen Daten -- Buchungsdetails werden mit Buchung gelöscht
5. **`citext` für E-Mail** -- case-insensitive Duplikat-Erkennung
6. **`timestamptz`** -- korrekte Zeitzonen-Unterstützung
7. **Regiondo-Felder** (`regiondo_*_id`, `regiondo_raw`) in allen Kerntabellen für Migrations-Mapping (clients, locations, products, bookings)
8. **`sync_log`-Tabelle** zur Protokollierung und Steuerung des Regiondo-Sync (referenziert in `04_API_Integrationen.md`)
