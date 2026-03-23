# Technologie-Stack & Infrastruktur

## Hosting: Render

| Komponente | Render-Service | Beschreibung |
|------------|---------------|-------------|
| **Datenbank** | Render PostgreSQL | Managed PostgreSQL, SSL erzwungen |
| **Control Node** | Background Worker | Node.js/TypeScript Dauerprozess (Sync-Loop) |

## Technologien

| Komponente | Technologie | Begründung |
|------------|-------------|------------|
| **DBMS** | PostgreSQL 16+ (Render) | JSONB-Support, GiST-Indizes, Exclusion Constraints, `citext`-Extension |
| **Extensions** | `citext`, `btree_gist` | Case-insensitive E-Mail, Zeitraum-Überlappungsprüfung |
| **Backend** | Node.js / TypeScript | Control Node + Sync-Modul |
| **DB-Client** | `pg` (node-postgres) | PostgreSQL-Verbindung mit SSL |

## Benötigte PostgreSQL-Extensions

```sql
CREATE EXTENSION IF NOT EXISTS citext;       -- Case-insensitive Text (für E-Mail)
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- GiST-Index für Exclusion Constraints
```

## Render-Konfiguration

### Render Blueprint (`render.yaml`)

Definiert die gesamte Infrastruktur deklarativ (Infrastructure-as-Code):
- PostgreSQL-Datenbank (`buchungssystem-db`)
- Background Worker für Control Node (`buchungssystem-control-node`)
- Environment Variables werden automatisch verknüpft

### Umgebungsvariablen (`.env`)

```env
# ── PostgreSQL (Render) ─────────────────────
# DATABASE_URL wird von Render automatisch bereitgestellt
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<db>?sslmode=require

# ── Regiondo API ────────────────────────────
REGIONDO_PUBLIC_KEY=<public_key>
REGIONDO_PRIVATE_KEY=<private_key>
REGIONDO_BASE_URL=https://api.regiondo.com/v1/
REGIONDO_LANGUAGE=de-DE

# ── App Settings ────────────────────────────
NODE_ENV=production
SYNC_INTERVAL_MINUTES=5
```

**Hinweis:** Render setzt `DATABASE_URL` automatisch, wenn die DB mit dem Worker verknüpft ist. Lokal muss die URL manuell aus dem Render Dashboard kopiert werden.

### SSL-Verbindung

Render PostgreSQL erzwingt SSL. Der DB-Client muss entsprechend konfiguriert werden:
```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
```

## Projektstruktur

```
Buchungssystem_AI/
├── .env                          # Umgebungsvariablen (nicht committen!)
├── .env.example                  # Vorlage für .env
├── .gitignore
├── render.yaml                   # Render Blueprint (Infrastructure-as-Code)
│
├── Projektkontext/               # Projektdokumentation
│   ├── 01_Projektuebersicht.md
│   ├── 02_Architektur.md
│   ├── 03_Datenbankschema.md
│   ├── 04_API_Integrationen.md
│   └── 05_Techstack_Infrastruktur.md
│
├── db/                           # Datenbank
│   ├── migrations/               # SQL-Migrationsskripte (nummeriert)
│   │   ├── 001_extensions.sql
│   │   ├── 002_clients.sql
│   │   ├── 003_locations.sql
│   │   ├── 004_products.sql
│   │   ├── 005_resources.sql
│   │   ├── 006_bookings.sql
│   │   ├── 007_consumptions.sql
│   │   ├── 008_payments.sql
│   │   ├── 009_coupons.sql
│   │   ├── 010_client_groups.sql
│   │   ├── 011_sync_log.sql
│   │   ├── 012_junction_tables.sql
│   │   ├── 013_indexes.sql
│   │   └── 014_triggers.sql
│   └── seed/                     # Testdaten (optional)
│       └── sample_data.sql
│
├── control-node/                 # Control Node (Node.js/TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # Einstiegspunkt, startet Sync-Loop
│       ├── config.ts             # .env laden, typisierte Config
│       ├── db/
│       │   └── client.ts         # PostgreSQL Pool (SSL)
│       └── sync/
│           ├── regiondo-auth.ts  # HMAC-SHA256 Signatur
│           ├── regiondo-api.ts   # Regiondo API-Client
│           ├── sync-service.ts   # Polling-Loop, Upsert, sync_log
│           ├── mappers.ts        # Regiondo → DB Mapping
│           └── initial-sync.ts   # Einmaliger Komplett-Import
│
└── assets/                       # Diagramme, Bilder
    └── architektur_v1.1.png
```

## Migrations-Reihenfolge

Die SQL-Dateien müssen in dieser Reihenfolge ausgeführt werden (wegen Foreign-Key-Abhängigkeiten):

```
1.  Extensions (citext, btree_gist)
2.  clients              (keine Abhängigkeiten)
3.  locations            (keine Abhängigkeiten)
4.  products             (keine Abhängigkeiten)
5.  resources            (→ locations)
6.  bookings             (→ clients, locations)
7.  consumptions         (→ bookings, resources)
8.  payments             (→ bookings)
9.  coupons              (keine Abhängigkeiten)
10. client_groups        (keine Abhängigkeiten)
11. sync_log             (keine Abhängigkeiten, Systemtabelle)
12. Zwischentabellen:
    - booking_products   (→ bookings, products)
    - product_resources  (→ products, resources)
    - location_products  (→ locations, products)
    - client_group_members (→ client_groups, clients)
    - booking_coupons    (→ bookings, coupons)
13. Indizes
14. Trigger (updated_at)
```

## Deployment-Ablauf

```
1. Render PostgreSQL erstellen (via Dashboard oder render.yaml)
2. DATABASE_URL aus Render Dashboard → .env (lokal)
3. db/run_migrations.sh ausführen (erstellt alle Tabellen auf Render)
4. Git-Repo mit Render verbinden → Control Node wird als Background Worker deployed
5. Environment Variables in Render setzen (REGIONDO_*, SYNC_INTERVAL_MINUTES)
6. Initial-Sync ausführen (npx tsx src/sync/initial-sync.ts)
```

## Entschiedene Punkte

- [x] Backend-Sprache: **Node.js / TypeScript**
- [x] Hosting: **Render** (Managed PostgreSQL + Background Worker)

## Noch zu klären

- [ ] CI/CD Pipeline (Render bietet Auto-Deploy aus Git)
- [ ] Monitoring & Logging (Render Logs, ggf. Sentry)
- [ ] Backup-Strategie für PostgreSQL (Render bietet automatische Backups je nach Plan)
