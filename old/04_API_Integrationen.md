# API & Integrationen

## Regiondo API

### Authentifizierung

Regiondo nutzt **HMAC-SHA256** signierte Requests.

**Benötigte Credentials** (in `.env`):
```
REGIONDO_PUBLIC_KEY=...
REGIONDO_PRIVATE_KEY=...
REGIONDO_BASE_URL=https://api.regiondo.com/v1/
REGIONDO_LANGUAGE=de-DE
```

**Request-Header** für jeden API-Call:

| Header | Wert |
|--------|------|
| `X-API-ID` | Public Key |
| `X-API-TIME` | Unix-Timestamp (UTC) |
| `X-API-HASH` | HMAC-SHA256 Signatur |
| `Accept-Language` | `de-DE` |

**Signatur-Berechnung:**
```
message = timestamp + publicKey + queryParams
hash    = HMAC-SHA256(message, privateKey)
```

### Relevante Endpunkte

| Endpunkt | Methode | Mapping → Eigene DB |
|----------|---------|---------------------|
| `/bookings` | GET | → `bookings`, `booking_products`, `consumptions` |
| `/customers` | GET | → `clients` |
| `/products` | GET | → `products` |
| `/categories` | GET | → Hilfsdaten für `resources.type` |

### Sandbox vs. Production

| Umgebung | Base URL |
|----------|----------|
| Sandbox | `https://sandbox-api.regiondo.com/v1/` |
| Production | `https://api.regiondo.com/v1/` |

API-Explorer (Sandbox): https://sandbox-api.regiondo.com/docs/

## Sync-Strategie: Regiondo → Control Node → Eigene DB

> **Hinweis:** Der Sync-Service ist ein integriertes Modul innerhalb der Control Node.
> Er hat keinen eigenständigen DB-Zugriff -- alle Schreibvorgänge laufen über die
> Control Node (siehe Architektur-Kernprinzip in `02_Architektur.md`).

### Ansatz: Polling-basierter Sync

```
                                                         ┌──────────────┐
                     GET /bookings?updated_since=...     │              │
              ┌─────────────────────────────────────────▶│  Regiondo    │
              │                                          │  API         │
              │  ◀───────────────────────────────────────│              │
              │          JSON Response                   └──────────────┘
┌─────────────┴──────────────────┐
│         CONTROL NODE           │
│  ┌──────────────────────────┐  │
│  │  Sync-Modul              │  │
│  │  - Polling               │  │
│  │  - Mapping               │  │
│  │  - Upsert-Logik          │  │
│  └──────────────────────────┘  │
│                                │
│  Schreibt in DB ───────────────┼──▶ ┌──────────────┐
│                                │    │  PostgreSQL  │
│  Liest sync_log ◀──────────────┼──  │  (eigene DB) │
│                                │    └──────────────┘
└────────────────────────────────┘
```

### Sync-Ablauf

1. **Letzte Sync-Zeit** aus `sync_log`-Tabelle lesen (via Control Node)
2. **Regiondo API** abfragen mit `updated_since` Filter
3. **Daten mappen**: Regiondo-Felder → eigene Tabellenstruktur
4. **Upsert** in eigene DB (via Control Node):
   - `regiondo_booking_id` als Conflict-Key
   - `regiondo_raw` mit Original-Payload befüllen
5. **Sync-Zeit** in `sync_log` aktualisieren

### Mapping-Beispiel: Regiondo Booking → Eigene DB

```
Regiondo Response              →  Eigene DB
──────────────────                ──────────
booking.id                     →  bookings.regiondo_booking_id
booking.customer.id            →  clients.regiondo_customer_id
booking.product.id             →  products.regiondo_product_id
booking.start_date             →  bookings.dt_from
booking.end_date               →  bookings.dt_to
booking.total_price            →  bookings.total_amount
booking.status                 →  bookings.status (Mapping erforderlich)
booking (gesamter Payload)     →  bookings.regiondo_raw
```

### Fehlerbehandlung

- **Idempotent**: Gleicher Regiondo-Datensatz kann mehrfach gesynct werden (Upsert)
- **Retry-Logik**: Bei API-Fehler (Rate Limit, Timeout) automatisch wiederholen
- **Logging**: Jeder Sync-Lauf wird protokolliert (`sync_log`-Tabelle)
- **Alerting**: Bei X aufeinanderfolgenden Fehlern Benachrichtigung senden

### Sync-Intervall

Konfigurierbarer Wert über `.env`:
```
SYNC_INTERVAL_MINUTES=5
```

### Initiale Migration

Für den ersten Sync müssen alle bestehenden Daten aus Regiondo einmalig übertragen werden:

1. **Kunden**: Alle Customers abrufen und in `clients` schreiben
2. **Produkte**: Alle Products abrufen und in `products` schreiben
3. **Buchungen**: Alle Bookings abrufen und in `bookings` + Untertabellen schreiben

Reihenfolge wichtig wegen Foreign Keys: Clients & Products vor Bookings.

## Zukünftige Integrationen (geplant)

### Check-In Terminal API
- **Richtung**: Control Node → Terminal
- **Daten**: Aktive Buchungen, Check-In/Out Events

### Schlüsselsystem API
- **Richtung**: Control Node → Schlüsselsystem
- **Daten**: Raumfreigaben, Zeitfenster

### PC-Systeme API
- **Richtung**: Bidirektional
- **Daten**: Rx Reboot Commands, Gaming Stats, PC-Status

### Messenger / Retool Workflows
- **Richtung**: Control Node → Retool → Messenger-Dienste
- **Daten**: Buchungsbestätigungen, Reinigungsaufträge, Self-Service
