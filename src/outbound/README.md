# src/outbound — Zeitbasierter Outbound-Layer

Sendet Buchungsdaten als strukturierte HTTP-POST-Payloads an Retool-Webhooks,
basierend auf definierten Zeitfenstern relativ zum Event-Zeitpunkt.

---

## Aktive Trigger (v1)

| ID | Zeitpunkt          | Trigger-Type          | Webhook-Config                    |
|----|--------------------|-----------------------|-----------------------------------|
| T1 | -7 Tage (dt_from)  | `client_message_7d`   | `RETOOL_WEBHOOK_CLIENT_MESSAGE`   |
| T2 | -1 Tag (dt_from)   | `client_message_1d`   | `RETOOL_WEBHOOK_CLIENT_MESSAGE`   |
| T4 | Check-Out (dt_to)  | `check_out`           | `RETOOL_WEBHOOK_CHECK_OUT`        |

Alle Jobs laufen alle 5 Minuten. Das Zeitfenster betraegt jeweils +/- 30 Minuten
um den Zielzeitpunkt.

---

## Umgebungsvariablen

```
OUTBOUND_ENABLED=false                  # Muss explizit auf true gesetzt werden
RETOOL_WEBHOOK_CLIENT_MESSAGE=https://  # Webhook fuer T1 + T2
RETOOL_WEBHOOK_CHECK_OUT=https://       # Webhook fuer T4
CHECKOUT_GOODBYE_TEXT=...               # Abschiedstext im CheckOut-Payload
OUTBOUND_STARTUP_CATCHUP_MINUTES=60    # Startup-Recovery-Fenster in Minuten
```

---

## Payload-Formate

### ClientMessagePayload (T1, T2)

```json
{
  "type": "client_message_7d",
  "bookingId": "uuid",
  "firstName": "Max",
  "lastName": "Mustermann",
  "preferredContactType": "email",
  "groupName": "Firmenname GmbH",
  "groupSize": 8,
  "eventDateTime": "2026-04-15T14:00:00.000Z",
  "bookingType": "Escape Room Deluxe"
}
```

### CheckOutPayload (T4)

```json
{
  "type": "check_out",
  "bookingId": "uuid",
  "firstName": "Max",
  "lastName": "Mustermann",
  "groupName": null,
  "groupSize": 4,
  "attendeeNames": null,
  "eventDateTime": "2026-04-15T14:00:00.000Z",
  "bookingType": "Escape Room Standard",
  "agentGeneratedGoodbye": "Danke fuer euren Besuch!..."
}
```

---

## Architektur

```
scheduler.ts
  └── registerOutboundJobs()
        ├── cron(*/5) → client-message-7d.ts → createJob(...)
        ├── cron(*/5) → client-message-1d.ts → createJob(...)
        └── cron(*/5) → check-out.ts         → createJob(...)

index.ts (startup)
  └── runStartupCatchup()   ← startup-catchup.ts

job-runner.ts (generisch)
  ├── isRunning-Lock        ← verhindert ueberlappende Ausfuehrungen
  ├── Idempotenz-Check      ← outbound_log.status == 'sent'
  └── Exponential Backoff   ← 3 Versuche (1s, 2s, 4s)

payload-builder.ts
  ├── fetchBookingsInWindow()     ← fuer T1, T2
  ├── fetchBookingsByCheckOut()   ← fuer T4
  ├── buildClientMessagePayload()
  ├── buildCheckOutPayload()
  ├── isAlreadySent()
  └── upsertOutboundLog()
```

---

## Datenbankschema

Die `outbound_log`-Tabelle (Migration `016_outbound_log.sql`) dient als
Idempotenz-Store. Sie enthaelt **kein PII** -- nur booking_id (UUID),
trigger_type, Status und Fehlertext.

DSGVO: Eintraege werden nach 90 Tagen geloescht (Cleanup-Job separat zu
konfigurieren, z.B. via pg_cron oder externem Scheduler).

---

## Sicherheits- und DSGVO-Hinweise

- Kein PII (Namen, Kontaktdaten) in Logs -- nur booking_id und Status.
- `OUTBOUND_ENABLED=false` ist der sichere Standard fuer neue Deployments.
- Webhook-URLs werden per Zod als gueltiges URL-Format validiert.
- Retry-Logik mit Backoff verhindert Webhook-Ueberlastung bei Ausfaellen.

---

## Manuelle Schritte vor Produktivbetrieb

1. Migration `016_outbound_log.sql` in der Datenbank ausfuehren.
2. `RETOOL_WEBHOOK_CLIENT_MESSAGE` und/oder `RETOOL_WEBHOOK_CHECK_OUT` in den
   Umgebungsvariablen setzen.
3. `OUTBOUND_ENABLED=true` setzen, um Jobs zu aktivieren.
4. Optional: DSGVO-Cleanup-Job fuer `outbound_log`-Eintraege aelter als 90 Tage
   einrichten (z.B. pg_cron oder Render Cron Job).
