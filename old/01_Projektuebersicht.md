# Projektübersicht -- Buchungssystem

## Vision

Aufbau eines eigenen zentralen Buchungs- und Verwaltungssystems für einen Gaming-/Entertainment-Standort. Das System löst die bisherige Abhängigkeit von Regiondo als alleinige Datenquelle ab und schafft eine eigene Datenbasis, die als "Single Source of Truth" für alle angebundenen Subsysteme dient.

## Ist-Zustand

- **Regiondo** ist aktuell das Komplettsystem (Buchungen, Kunden, Zahlungen, Produkte)
- Keine eigene Datenbank vorhanden
- Subsysteme (Check-In, Schlüssel, PCs, Reinigung) sind nicht zentral gesteuert

## Ziel-Zustand

- **Eigene PostgreSQL-Datenbank** als zentrale Datenhaltung
- **Regiondo** bleibt als Buchungs-Frontend (Kundenwebseite) bestehen
- **Control Node** ist der einzige Zugangspunkt zur Datenbank und synchronisiert Regiondo-Daten über einen integrierten Sync-Service
- **Control Node** steuert alle Subsysteme (Check-In, Schlüssel, PCs, Reinigung, Messenger)
- Langfristig: Regiondo wird nur noch ein Buchungskanal unter mehreren

## Projektphasen

### Phase 1: Infrastruktur & Datenmigration (aktuell)
- Datenbankschema aufsetzen
- Control Node mit integriertem Regiondo-Sync aufbauen
- Daten-Sync einrichten (Regiondo → Control Node → eigene DB)
- Bestehende Daten einmalig migrieren (Dual-Betrieb, siehe Migrationsphasen in `02_Architektur.md`)

### Phase 2: Control Node & Subsysteme
- Zentrale Steuerungslogik aufbauen
- Check-In Terminal anbinden
- Schlüsselsystem anbinden
- PC-Systeme anbinden
- Reinigungsmanagement anbinden

### Phase 3: Erweiterungen
- Messenger Workflows (Retool)
- Messenger Self-Service
- App-Anbindung

### Phase 4: Features (Prio 3)
- Loyalty-Points / "Aufleveln"
- Rivalries / Friendcodes
- Location Map mit PC Stats

## Beteiligte

- **Niko "TheRealAndOnlyRed" Becker** -- Projektverantwortlicher

## Referenzen

- Architekturdiagramm: V1.1 (siehe `assets/`)
- Regiondo API: `https://api.regiondo.com/v1/`
