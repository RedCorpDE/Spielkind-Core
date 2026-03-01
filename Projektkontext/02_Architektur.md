# Systemarchitektur

## Kernprinzip

> **Die Control Node ist der "Bahnhof im Schienennetz".**
> Kein Subsystem kommuniziert direkt mit der Datenbank. Alle Lese- und Schreibvorgänge
> laufen ausschließlich über die Control Node. Sie ist die einzige Komponente mit
> direktem Datenbankzugriff und orchestriert sämtliche angebundenen Systeme.

## Architekturdiagramm -- Ziel-Zustand

```
                                           ┌────────────────┐
                                           │   Datenbank    │
                                           │  (PostgreSQL)  │
                                           └───────┬────────┘
                                                   │
                                                   │ einziger Zugriff
                                                   ▼
┌──────────────┐    ┌─────────────────┐    ┌──────────────────────────┐
│  Kunden-     │───▶│  Buchungssystem  │──▶│                          │
│  eingabe     │    │  Frontend        │   │      CONTROL NODE        │
│              │    │  (Regiondo)      │   │    (zentraler Bahnhof)   │
└──────────────┘    └─────────────────┘   │                          │
                                           └──┬───┬───┬───┬───┬───┬──┘
                                              │   │   │   │   │   │
                         ┌────────────────────┘   │   │   │   │   └────────────────────┐
                         │          ┌─────────────┘   │   │   └─────────────┐          │
                         │          │       ┌─────────┘   └─────────┐      │          │
                         ▼          ▼       ▼                       ▼      ▼          ▼
                   ┌──────────┐ ┌────────┐ ┌──────────┐   ┌──────────┐ ┌────────┐ ┌──────────┐
                   │Check-In  │ │Schlüs- │ │PC-       │   │Reinigungs│ │Messenger│ │Workflows │
                   │Terminal  │ │sel-    │ │Systeme   │   │manage-   │ │Workflows│ │(Retool)  │
                   │          │ │system  │ │          │   │ment      │ │(Retool) │ │          │
                   └──────────┘ └────────┘ └──────────┘   └──────────┘ └───┬─────┘ └──────────┘
                                                                           │
                                                              ┌────────────┼────────────┐
                                                              │            │            │
                                                        ┌─────▼──┐   ┌────▼───┐   ┌────▼───┐
                                                        │Messenger│   │  App   │   │Messenger│
                                                        │(Self-  │   │        │   │(Reinig.)│
                                                        │Service)│   │        │   │        │
                                                        └────────┘   └────────┘   └────────┘
```

**Auch Regiondo spricht mit der Control Node, nicht direkt mit der Datenbank.** Die Control Node ist die einzige Komponente mit DB-Zugriff.

## Kommunikationsarchitektur

```
                              ┌────────────────┐
                              │   Datenbank    │
                              │  (PostgreSQL)  │
                              └───────┬────────┘
                                      │
                                      │ Lesen / Schreiben
                                      │ (NUR die Control Node hat Zugriff)
                                      │
                              ┌───────▼────────┐
                              │                │
                              │  CONTROL NODE  │
                              │                │
                              └───────┬────────┘
                                      │
         ┌────────────┬───────────┬───┼───────┬──────────┬──────────┐
         │            │           │   │       │          │          │
         ▼            ▼           ▼   ▼       ▼          ▼          ▼
     Regiondo    Check-In    Schlüssel │   Reinigung  Messenger  Retool
     (Sync)      Terminal    system    │   mgmt       Workflows  Workflows
                                       │
                                   PC-Systeme
```

**Alle Pfeile gehen durch die Control Node** -- auch Regiondo. Kein System kennt die Datenbank oder greift direkt darauf zu. Die Control Node:
- **Liest** Daten aus der DB und verteilt sie an die Subsysteme
- **Empfängt** Events/Status von den Subsystemen und schreibt sie in die DB
- **Orchestriert** Abläufe (z.B. nach Check-In → Schlüssel freigeben → PCs starten)
- **Synchronisiert** Regiondo-Daten über den integrierten Sync-Service

## Migrationsphasen: Übergang von Regiondo zur eigenen DB

> **Wichtig:** Während der Übergangsphase existieren Daten parallel in Regiondo UND in der
> eigenen Datenbank. Die folgenden Phasen beschreiben den schrittweisen Übergang.

### Phase A: Initialer Datentransfer (Dual-Betrieb)

```
┌─────────────────┐                         ┌────────────────┐
│    Regiondo     │   (weiterhin führend)    │   Datenbank    │
│  ┌───────────┐  │                         │  (PostgreSQL)  │
│  │ Buchungen │  │ ── Sync ──────────────▶ │  ┌───────────┐ │
│  │ Kunden    │  │    (einmalig +           │  │  Kopie    │ │
│  │ Produkte  │  │     laufend)             │  │  der      │ │
│  └───────────┘  │                         │  │  Daten    │ │
└─────────────────┘                         │  └───────────┘ │
       ▲                                     └───────┬────────┘
       │                                             │
       │  Kunden buchen                              │
       │  weiterhin hier            ┌────────────────▼──────┐
       │                            │    CONTROL NODE       │
       └────────────────────────────│    (liest aus DB,     │
                                    │     Regiondo bleibt   │
                                    │     Buchungsquelle)   │
                                    └───────────────────────┘
```

**Merkmale Phase A:**
- Regiondo bleibt die **primäre Buchungsquelle** (Kunden buchen weiterhin dort)
- **Einmaliger Datentransfer**: Alle bestehenden Kunden, Buchungen, Produkte aus Regiondo in eigene DB übertragen
- **Laufender Sync**: Neue Buchungen werden regelmäßig von Regiondo in die eigene DB gespiegelt
- Eigene DB ist vorerst **Read-Only-Spiegel** -- Regiondo ist "Source of Truth"
- Control Node liest aus der eigenen DB, um Subsysteme anzusteuern
- `regiondo_*_id` und `regiondo_raw` Felder gewährleisten die Zuordnung

### Phase B: Parallelbetrieb (Dual-Write)

```
┌─────────────────┐                         ┌────────────────┐
│    Regiondo     │ ◀── Sync (optional) ──  │   Datenbank    │
│                 │                         │  (PostgreSQL)  │
│                 │ ── Sync ──────────────▶ │                │
└─────────────────┘                         └───────┬────────┘
                                                    │
                                            ┌───────▼────────┐
                                            │  CONTROL NODE  │
                                            │  (schreibt in  │
                                            │   beide)       │
                                            └────────────────┘
```

**Merkmale Phase B:**
- Control Node schreibt in **beide Systeme** (eigene DB + Regiondo)
- Neue Buchungsquellen (Manual, API, Self-Service) schreiben direkt in eigene DB
- Regiondo-Buchungen werden weiterhin gesynct
- Abgleich & Konsistenzprüfung zwischen beiden Systemen

### Phase C: Eigene DB ist führend (Ziel-Zustand)

```
┌─────────────────┐                         ┌────────────────┐
│    Regiondo     │                         │   Datenbank    │
│  (nur noch ein  │ ◀── optional ────────── │  (PostgreSQL)  │
│   Buchungs-     │                         │  SOURCE OF     │
│   kanal)        │ ── Sync ──────────────▶ │  TRUTH         │
└─────────────────┘                         └───────┬────────┘
                                                    │
                                            ┌───────▼────────┐
                                            │  CONTROL NODE  │
                                            └────────────────┘
```

**Merkmale Phase C:**
- Eigene Datenbank ist die **"Source of Truth"**
- Regiondo ist nur noch einer von mehreren Buchungskanälen
- Andere Kanäle: Manual (Admin), API, Self-Service (Messenger/App)
- Regiondo kann perspektivisch komplett abgelöst werden

## Komponenten im Detail

### 1. Buchungssystem Frontend (Regiondo)
- **Typ**: Externe SaaS-Plattform
- **Kommuniziert mit**: Control Node (nicht direkt mit DB)
- **Funktion**: Kundenwebseite für Buchungen
- **Datenfluss**: Kundeneingabe → Regiondo → Control Node (Sync-Service) → Datenbank
- **Übergangsphase**: Daten existieren parallel in Regiondo UND eigener DB (siehe Migrationsphasen oben)
- **Ziel-Zustand**: Nur noch ein Buchungskanal unter mehreren
- **Buchungsparameter**:
  - Buchungszeit + Länge
  - Kunde + Kontaktdaten
  - Anzahl Gäste
  - Gebuchte Räume/Produkte
  - Zahlungsabwicklung

### 2. Datenbank (PostgreSQL)
- **Typ**: Eigene Infrastruktur
- **Funktion**: Zentrale Datenhaltung
- **Source of Truth**: Im Ziel-Zustand (Phase C). Während Phase A ist Regiondo noch führend (siehe Migrationsphasen oben)
- **Zugriff**: Ausschließlich über die Control Node -- kein anderes System greift direkt zu
- **Inhalt**: Kunden, Buchungen, Produkte, Ressourcen, Zahlungen, Standorte
- **Details**: Siehe `03_Datenbankschema.md`

### 3. Control Node (zentraler Bahnhof)
- **Typ**: Eigene Infrastruktur (geplant)
- **Funktion**: Zentrale Steuerungs- und Vermittlungslogik
- **Einzige Komponente mit direktem Datenbankzugriff**
- **Aufgaben**:
  - Daten aus der DB lesen und an Subsysteme verteilen
  - Events von Subsystemen empfangen und in die DB schreiben
  - Geschäftslogik und Orchestrierung (z.B. Buchung → Check-In → Schlüssel → PC)
  - Regiondo-Sync koordinieren
- **Angebundene Systeme**:
  - Check-In Terminal
  - Schlüsselsystem
  - PC-Systeme
  - Reinigungsmanagement
  - Messenger Workflows (Retool)
  - Retool Workflows

### 4. Check-In Terminal
- **Kommuniziert mit**: Control Node (nicht direkt mit DB)
- **Funktionen**:
  - Check-In / Check-Out
  - Location Details anzeigen
  - Infos + Tutorial Videos

### 5. Schlüsselsystem
- **Kommuniziert mit**: Control Node (nicht direkt mit DB)
- **Funktion**: Raumzugang verwalten
- **Ablauf**: Control Node sendet Freigabe-Befehl nach erfolgreichem Check-In

### 6. PC-Systeme
- **Kommuniziert mit**: Control Node (nicht direkt mit DB)
- **Funktionen**:
  - Rx Reboot (Remote-Neustart)
  - Prio 3 (Priorisierung)
  - Gaming Stats für Loyalty-Programm
- **Bidirektional**: Sendet Gaming-Stats zurück an Control Node

### 7. Reinigungsmanagement
- **Kommuniziert mit**: Control Node (nicht direkt mit DB)
- **Parameter**:
  - Cut-Off-Zeit (Wieviel Puffer zwischen Buchungen)
  - Reinigungsdauer pro Raum
  - Raum-Priorisierung (welcher Raum zuerst)
- **Kommunikation**: Über Messenger an Reinigungspersonal

### 8. Messenger Workflows (Retool)
- **Kommuniziert mit**: Control Node (nicht direkt mit DB)
- **Kanäle**: Messenger, App, Self-Service
- **Funktionen**:
  - Buchungsbestätigungen
  - Erinnerungen
  - Self-Service (Buchungen erstellen, schieben, stornieren)

### 9. Retool Workflows
- **Kommuniziert mit**: Control Node (nicht direkt mit DB)
- **Funktion**: Admin-Automatisierungen

## Datenfluss

### Buchungsablauf -- Übergangsphase (Dual-Betrieb)

```
1. Kunde bucht auf Webseite (Regiondo)
2. Regiondo speichert Buchung (Regiondo hat weiterhin eigene Daten)
3. Control Node (Sync-Service) pollt Regiondo API (alle X Minuten)
4. Control Node schreibt neue/geänderte Buchungen in eigene DB
5. Control Node orchestriert die Subsysteme:
   ├── Check-In Terminal: Buchung wird sichtbar
   ├── Schlüsselsystem: Raum wird vorbereitet
   ├── PC-Systeme: PCs werden reserviert
   ├── Reinigungsmanagement: Reinigung wird eingeplant
   └── Messenger: Kunde erhält Bestätigung

Hinweis: Während der Übergangsphase liegen Buchungsdaten sowohl in
Regiondo als auch in der eigenen DB. Die regiondo_*_id Felder stellen
die Zuordnung sicher. Bei Konflikten gilt Regiondo als führend (Phase A).
```

### Buchungsablauf -- Ziel-Zustand

```
1. Kunde bucht (über Regiondo, Self-Service, App, oder manuell)
2. Buchung geht an Control Node
3. Control Node schreibt in eigene DB (Source of Truth)
4. Control Node orchestriert die Subsysteme (wie oben)
5. Optional: Control Node spiegelt Buchung zurück an Regiondo
```

### Check-In Ablauf (Beispiel-Orchestrierung)

```
1. Kunde checkt am Terminal ein
2. Terminal meldet Check-In an Control Node
3. Control Node aktualisiert Buchungsstatus in DB (→ 'checked_in')
4. Control Node löst parallel aus:
   ├── Schlüsselsystem: Raum-Schlüssel freigeben
   ├── PC-Systeme: PCs im Raum hochfahren
   └── Messenger: Willkommensnachricht senden
```

### Checkout / Abreise

```
1. Buchungszeit endet oder Kunde checkt manuell aus
2. Control Node aktualisiert Status in DB (→ 'completed')
3. Control Node löst aus:
   ├── Schlüsselsystem: Raum-Schlüssel sperren
   ├── PC-Systeme: PCs herunterfahren, Stats auslesen
   ├── Reinigungsmanagement: Reinigungsauftrag erstellen
   └── Messenger: Feedback-Anfrage / Rechnung senden
```
