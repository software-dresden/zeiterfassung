# Zeiterfassung — Freelance Time Tracking PWA

## Zweck (Project purpose)

Persönliches Zeiterfassungstool für einen freiberuflichen IT-Berater. Erfasst Arbeitssessions
pro Kunde, misst Zeit in AE (Arbeitseinheit), und erstellt monatliche Abrechnungen. Mehrbenutzer-
App (Administrator legt Benutzer an), über mehrere Geräte hinweg genutzt (Handy, Laptop, Desktop).
Mehrere Timer können gleichzeitig laufen. Muss als PWA installierbar sein
und vollständig offline funktionieren — Timer und manuelle Erfassung laufen ohne Internet und
synchronisieren automatisch mit Supabase, sobald die Verbindung wiederhergestellt ist.

## Stack-Entscheidungen

- **Next.js 15 (App Router) + TypeScript** — moderne React-Basis, Datei-basiertes Routing.
- **Tailwind CSS v4** — utility-first Styling, mobile-first, CSS-basierte Theme-Konfiguration
  (`@theme inline` in `globals.css`) für volle Kontrolle über Dark-Theme-Design-Tokens.
- **Supabase (PostgreSQL + Auth)** — Backend als Sync-Ziel; einfache Row-Level-Security, kein eigenes Backend nötig.
- **IndexedDB via `idb`** — lokaler Offline-First-Datenspeicher; einzige Quelle für alle Reads in der UI.
- **Serwist** (nicht `next-pwa`, das ist deprecated) — Service-Worker-Generierung für PWA-Funktionalität.
- **jspdf + jspdf-autotable** — clientseitige PDF-Generierung für Abrechnungen.
- **Natives CSV-Export** — kein zusätzliches Paket nötig, einfacher String-Export mit BOM.
- **Deployment:** GitHub Pages (statischer Export, `.github/workflows/deploy-pages.yml`, Base-Path
  `/zeiterfassung`, Push auf `main` deployt). **Package Manager:** npm.
- Reine Client-Side SPA: keine Server Components, keine Server Actions, keine API-Routes. Alle
  Daten-Aufrufe laufen clientseitig durch die Sync-Engine (`src/lib/sync.ts`). Einzige serverseitige
  Logik: die Supabase Edge Function `admin-users` (Benutzerverwaltung, braucht den Service-Role-Key).

## AE-Umrechnungsregel

**1 AE = 10 Minuten.** Gilt überall konsistent (UI, PDF, CSV, Datenbank-Berechnungen).

```
30 min  = 3.0 AE  = 0:30h
45 min  = 4.5 AE  = 0:45h
90 min  = 9.0 AE  = 1:30h
150 min = 15.0 AE = 2:30h
```

Siehe `src/lib/ae.ts` für alle Umrechnungsfunktionen. AE wird immer mit 1 Nachkommastelle
angezeigt (z.B. `3.0` nicht `3`). In der UI ist AE immer der primäre Wert (fett), Stunden sind
immer sekundär (grau, klein).

## Offline-First-Architektur

Alle Reads kommen ausschließlich aus IndexedDB. Alle Writes gehen zuerst nach IndexedDB, dann zu Supabase.

**Datenfluss:**
1. App-Start → Pull aller Daten von Supabase → Speicherung in IndexedDB.
2. Alle Reads → nur aus IndexedDB (sofort verfügbar, funktioniert offline).
3. Alle Writes → zuerst IndexedDB → danach Sync-Versuch zu Supabase.
4. Online: sofortige Synchronisierung nach dem IndexedDB-Write.
5. Offline: Operation wird in `sync_queue` (IndexedDB) eingereiht.
6. Verbindung wiederhergestellt: `sync_queue` wird FIFO abgearbeitet.
7. Beim nächsten App-Start: vollständiger Re-Sync von Supabase zur Konfliktauflösung.

**Konfliktauflösung:** Beim Pull überschreibt der Serverstand lokale Zeilen, außer sie liegen noch
unsynchronisiert in der `sync_queue`. Ein Vergleich der `updated_at`-Zeitstempel findet nicht statt.

**Abgelehnte Änderungen:** Lehnt der Server einen Queue-Eintrag dauerhaft ab (Postgres-Fehlerklassen
22/23/42, z. B. RLS- oder Fremdschlüssel-Verletzung), wird er verworfen, der lokale Stand per Pull
zurückgesetzt und ein Hinweis angezeigt. Netzwerk-/Auth-Fehler bleiben in der Queue und werden
wiederholt. `drainSyncQueue` läuft nie parallel. Beim Zurückkehren ins Fenster wird (max. 1×/Minute)
neu synchronisiert, damit geteilte Kunden/Typen anderer Benutzer ankommen.

IndexedDB-Datenbank: `zeiterfassung-db-<userId>` (Version 2), **eine pro Benutzer**, gesetzt über
`setDbUser()` in `src/lib/db.ts` bevor ein Hook die DB anfasst (`(app)/layout.tsx`). Stores
`customers`, `session_types`, `time_entries` (Indizes: `by-date`, `by-customer`), `sync_queue`
(Index: `by-timestamp`), `timer_state`, `report_templates` (seit Version 2). Die alte gemeinsame `zeiterfassung-db` wird nicht mehr benutzt.

## Mehrbenutzer & Administration

- **Datenmodell:** `customers` und `session_types` sind für alle Benutzer geteilt, `time_entries`
  gehören einem Benutzer (`user_id`, Default `auth.uid()`) und sind nur für ihn sichtbar. Auch der
  Administrator sieht nur eigene Einträge.
- **Zugriff:** Jede Policy verlangt eine aktive Zeile in `profiles` (`is_active_user()`). Ein Konto ohne
  Profil (z. B. fremde GitHub-Anmeldung) oder mit `disabled = true` sieht nichts. Löschen von Kunden/Typen
  darf nur `is_admin()`; Fremdschlüssel auf `time_entries` sind `on delete restrict`.
- **Rollen:** `admin` | `user`, in `profiles.role`. Der Client liest sie über `useProfile`
  (`src/hooks/useProfile.tsx`, Rolle offline aus localStorage gecacht). Deaktivierte/profillose Konten
  werden abgemeldet; die Meldung erscheint auf der Login-Seite.
- **Admin-Tab** (`/admin`, nur für Administratoren sichtbar): Benutzer anlegen (Benutzername **oder**
  E-Mail + Passwort), auflisten, Anmeldename/E-Mail und Rolle ändern (Aktion `update`; Einträge bleiben, letzter Admin und eigene Rolle sind geschützt), Passwort ändern, deaktivieren/aktivieren, löschen (löscht auch deren
  Einträge). Alles läuft über die Edge Function `supabase/functions/admin-users/index.ts`
  (`src/lib/adminApi.ts`); sie prüft serverseitig die Admin-Rolle. Sie braucht Internet.
- **Benutzername:** wird auf die Pseudo-E-Mail `<name>@users.zeiterfassung.local` abgebildet
  (`src/lib/auth.ts`, muss mit der Edge Function übereinstimmen). Login akzeptiert beides.
- **Neues Supabase-Projekt:** `supabase/schema.sql` ausführen, ersten Benutzer im Auth-Dashboard
  anlegen und per `insert into profiles (id, role) values ('<id>', 'admin')` zum Admin machen, Edge
  Function `admin-users` deployen. „Allow new users to sign up“ im Auth-Dashboard ausschalten.
- **Anwesenheit (Admin-Ansicht):** Jede geöffnete App meldet einmal pro Minute (und bei Timer-Änderungen) „ich bin da“ plus
  ihre laufenden/pausierten Timer in die Tabelle `user_presence` (eine Zeile pro Benutzer und Gerät; `src/lib/presence.ts`,
  `src/hooks/usePresence.ts` im `AppShell`). Gemeldet werden nur Kunde, Typ, Status und verstrichene Sekunden, keine Notizen.
  Jeder darf nur seine eigenen Zeilen schreiben/lesen (RLS + `require aal2`); der Admin liest sie über die Edge Function
  (Aktion `list`: `last_seen_at`, `timers`, dazu `total_minutes`, `month_entries`). Der Admin-Tab zeigt Kacheln (online, laufende
  Timer, Sessions gesamt und im Monat) und pro Benutzer „Online“ (letzte Meldung < 3 Minuten) bzw. „Zuletzt aktiv vor …“ und
  seine Timer; Auffrischung alle 30 s. Beim Abmelden wird die Zeile des Geräts gelöscht, Zeilen älter als 7 Tage räumt `list` auf.
  Die Timer selbst bleiben lokal; ist ein Gerät offline/geschlossen, sieht der Admin den Stand der letzten Meldung.
- **Bekannte Einschränkung:** Der AE-Satz liegt am (geteilten) Kunden, nicht am Eintrag. Eine
  Änderung wirkt rückwirkend auf alle Berichte aller Benutzer.

## Sicherheit & Zwei-Faktor-Anmeldung (MFA)

**MFA (TOTP, Authenticator-App) ist für alle Benutzer Pflicht.** `MfaGate` (`src/components/auth/`) sitzt in
`(app)/layout.tsx` zwischen Anmeldung und App: `aal2` → App; `aal1` mit bestätigtem Faktor → Code-Abfrage
(`MfaChallenge`); `aal1` ohne Faktor → Einrichtung ohne „Überspringen“ (`MfaSetup`, QR-Code + Schlüssel).
Das Aal-Level wird lokal aus dem Session-Token gelesen, die App startet mit `aal2` also auch offline.
Hilfsfunktionen in `src/lib/mfa.ts`. Einstellungen → „Sicherheit“ (`SecuritySettings`): weiteres Gerät
hinzufügen, Authenticator entfernen (der letzte nicht). Es gibt keine Recovery-Codes (Supabase hat keine).

- **Handy verloren:** Administrator → Admin-Tab → „MFA zurücksetzen“ (Edge Function `resetMfa`, löscht alle
  Faktoren, meldet den Benutzer überall ab; neue Einrichtung bei der nächsten Anmeldung). Verliert der **einzige**
  Administrator sein Handy: im Supabase SQL Editor `delete from auth.mfa_factors where user_id = '<id>';`.
- **Durchsetzung in der Datenbank (seit 28.10.2026 AKTIV):** Fünf restriktive RLS-Policies „require aal2“
  (`supabase/mfa_enforcement.sql`, Migration `mfa_enforcement_aal2`) auf `auth.jwt()->>'aal'`: eine Sitzung ohne
  Authenticator-Code (`aal1`) sieht und schreibt nichts, auch nicht über die API. Die Edge Function `admin-users`
  verlangt ebenfalls `aal2` (Standard; nur das Function-Secret `REQUIRE_AAL2=false` schaltet das ab, etwa zum Anlegen
  des allerersten Administrators). Neue Benutzer können trotzdem starten: die Einrichtung läuft über den Auth-Dienst,
  nicht über die geschützten Tabellen. Ein Konto ohne MFA sieht bis zur Einrichtung keine Daten. Rückgängig machen
  (wenn jemand ausgesperrt ist): die fünf „require aal2“-Policies droppen. Wer ein neues Supabase-Projekt aufsetzt,
  wendet die Datei erst an, wenn der erste Administrator MFA eingerichtet hat.
- **Datenbankrechte:** `anon` hat auf keine Tabelle Zugriff; `authenticated` nur SELECT/INSERT/UPDATE/DELETE
  (kein TRUNCATE/TRIGGER/REFERENCES, denn TRUNCATE umgeht RLS), `profiles` nur SELECT (geschrieben wird nur über
  die Edge Function). `rls_auto_enable()` ist nicht per API aufrufbar. Steht auch in `supabase/schema.sql`.
- **Passwörter:** mindestens 12 Zeichen (Edge Function erzwingt es, Formulare spiegeln es).
- **Service Worker:** Antworten der Supabase-API (`/rest|auth|functions|storage|realtime/v1/`) laufen immer
  `NetworkOnly`. Serwists `defaultCache` würde sonst jede Cross-Origin-GET-Antwort (Kunden, Einträge,
  Unterschriften) in den Cache Storage schreiben, wo sie nach dem Abmelden lesbar bleibt. Offline-Daten
  kommen nur aus IndexedDB.
- **CSP:** `<meta http-equiv="Content-Security-Policy">` in `src/app/layout.tsx` (nur Production-Build; GitHub
  Pages kann keine Header senden). `connect-src` ist auf die App und das Supabase-Projekt beschränkt, `object-src`,
  `frame-src` auf `none`. `'unsafe-inline'` braucht Next, `'unsafe-eval'` braucht `docx-templates`. Neue externe
  Dienste müssen hier eingetragen werden, sonst blockt der Browser sie. `Referrer-Policy`: `no-referrer`.
  `frame-ancestors`/`X-Frame-Options` lassen sich per Meta-Tag nicht setzen (Clickjacking-Schutz fehlt auf Pages).
- **Keine Drittanbieter-Übertragung von Inhalten:** Notizen werden nicht mehr automatisch übersetzt (früher
  Google-Translate-Endpunkt); sie verlassen die App nur Richtung Supabase.
- **Nicht in der Hand des Codes, im Supabase-Dashboard zu setzen:** „Allow new users to sign up“ ausschalten,
  GitHub-Provider abschalten, „Leaked password protection“ einschalten (laut Supabase ggf. Pro-Plan),
  JWT-Laufzeit/Inactivity-Timeout nach Bedarf.
- **Bekannte Designgrenze:** Kunden und Typen sind für alle aktiven Benutzer änderbar (nur Löschen ist Admin-only);
  ein Benutzer kann also AE-Sätze ändern, die für alle gelten.

## Timer

Mehrere Timer gleichzeitig (`src/hooks/useTimers.ts`, `src/components/timer/TimerCard.tsx`). Jeder Timer
ist ein Datensatz in `timer_state` (Schlüssel = uuid) mit Status `running` | `paused` | `stopped`; ein
gestoppter, noch nicht gespeicherter Timer überlebt einen Reload. Timer sind lokal pro Gerät und Benutzer
und werden nicht synchronisiert.

## Unterschriften

Nach „Speichern“ eines Timer-Sessions (nicht bei manuellen Einträgen, nicht bei „Verwerfen“) öffnet
`TimerWidget` den `SignatureModal` (`src/components/signature/`). Die Session ist zu diesem Zeitpunkt
schon gespeichert. Drei Schritte: **Übersicht** (alle Details und die kompletten Notizen, damit beide
sehen, was sie unterschreiben), **Unterschrift Techniker**, **Unterschrift Kunde**. Jeder Schritt ist
überspringbar; werden beide übersprungen, bleibt die Session unsigniert. Eine spätere Unterschrift ist
nicht vorgesehen. Das Modal ist nicht per Hintergrund-Klick/Escape schließbar (`Modal dismissible=false`),
sonst würde ein Wischer über den Rand die Unterschrift verwerfen.

- **Speicherung:** Spalten `technician_signature`, `customer_signature` (PNG-Data-URL, 480×160, 3:1,
  transparent) und `signed_at` an `time_entries`; Check-Constraint: PNG-Data-URL, max. 100000 Zeichen.
  Sync unverändert (`updateEntry` → `writeWithSync`), keine IndexedDB-Versionsänderung.
- **PDF:** Unterschriften erscheinen **nur im Einzel-Session-Bericht** (`buildSessionPdf` in
  `src/lib/pdf.ts`): Detailtabelle, vollständige Notizen (lange Notizen laufen auf Folgeseiten weiter) und
  ein Unterschriftenblock mit zwei Feldern („Techniker: <Name>“, „Kunde: <Name>“, Datum, oder „Nicht
  unterschrieben“). Der Monatsbericht für alle Arbeit und der Monatsbericht pro Kunde enthalten keine
  Unterschriften; `buildReportPdf(..., { includeSignatures: true })` würde sie in der Tabelle drucken
  (Standard: aus). CSV/TXT/Mail enthalten keine Unterschriften.
- **Größe:** `select('*')` lädt die Bilder bei jedem Pull mit. Bei sehr vielen signierten Sessions wäre
  ein inkrementeller Pull (`updated_at`) oder Supabase Storage die Lösung.

## Reports

Die Seite **Reports** (`/report`, früher „Monatsreport“) hat zwei Tabs. **Alle Arbeit:** Monat wählen,
Bericht über alle Kunden (`AllWorkReport`), Export als PDF/CSV/TXT, `Abrechnung_YYYY-MM.*`. **Pro Kunde:**
Kunde anklicken, Monat wählen (`CustomerReports`), dann Monatszusammenfassung mit Export aller Sessions
des Kunden (`Abrechnung_<Kunde>_YYYY-MM.*`) und darunter jede Session einzeln mit eigenem Export
(`SessionExportButtons`: PDF mit Unterschriften, CSV, TXT; `Session_<Kunde>_<Datum>_<HHmm>.*`). Alle
Formate teilen sich die Builder in `src/lib/export.ts` (`buildReportCsv`, `buildReportTxt`,
`buildSessionTxt`) und `src/lib/reportRows.ts` (`buildMonthlyRows`, `buildSessionRow`), damit die Zahlen
überall identisch sind.

## Material und Fahrt

Auf der Abschlusskarte einer Timer-Session (Notizfeld, „Speichern“) lassen sich optional **Material**
(Bezeichnung + Menge als Freitext, max. 20 Zeilen) und eine **Fahrt in km** erfassen
(`MaterialFahrtFields`, Hilfsfunktionen in `src/lib/materials.ts`). Beides ist nur zur Dokumentation:
**keine Preise**, keine Auswirkung auf Summen (km werden nur zur Information addiert). Nur dort erfassbar,
nicht in „Neue Erfassung“ und nicht nachträglich änderbar (das Bearbeiten-Formular lässt die Felder
unberührt). Der Entwurf wird wie die Notiz nicht über einen Reload gerettet.

- **Daten:** `time_entries.materials` (jsonb, `[{name, menge}]`, Standard `[]`) und `travel_km`
  (numeric(7,1), 0–9999,9), beides per Check-Constraint abgesichert; der Eintrag wird als Ganzes synchronisiert.
- **Anzeige:** Übersicht im Unterschriften-Dialog, graue Zeilen in Sessions-Tabelle, „Heutige Sessions“ und in
  der Kundenliste der Reports (Monatssumme der Kilometer).
- **Exporte:** CSV hängt die Spalten `Fahrt_km` und `Material` hinten an; TXT (Monat und Session) und die
  Session-Mail enthalten Material-/Fahrt-Zeilen; Standard-PDF Monat: Zeilen in der Notizen-Zelle plus „Gefahrene
  Kilometer“ pro Kunde; Standard-PDF Session: Zeile „Fahrt“ und Tabelle „Verwendetes Material“. Word-Vorlagen
  bekommen `fahrt`, `material`, `materialien`, `hat_fahrt`, `hat_material`, `km_gesamt`, `$k.km`, `$s.material`,
  `$s.fahrt` (siehe Admin-Tab).

## Kundenadresse und Notizen in Berichten

- **Kundenadresse:** `customers.address` (Text, bis 4 Zeilen / 300 Zeichen, optional), im Einstellungen-Tab beim Anlegen und
  Bearbeiten eines Kunden (`src/lib/address.ts` bereinigt: Zeilen trimmen, Leerzeilen entfernen). Kunden sind geteilt, die Adresse
  also auch. Sie erscheint nur im Word-Export (Vorlagenfelder `{kunde_adresse}` bzw. `{kunde.adresse}` / `{$k.adresse}`), nicht
  in PDF/CSV/TXT. Im Kopf der mitgelieferten Vorlagen stehen Kundenname/-adresse links **auf einer Höhe** mit Firmenname/-adresse
  rechts (Logo darüber); der Adressblock erscheint nur, wenn eine Adresse hinterlegt ist.
- **Notizen werden geordnet:** `src/lib/notes.ts` erkennt, egal wie getippt, `-`, `*`, `+`, `•`, `–`, nummerierte Zeilen, eingerückte
  Unterpunkte und `Label:`-Überschriften und macht daraus Überschrift / Text / Aufzählungspunkt / Unterpunkt (Leerzeilen, Tabs
  und `**fett**` werden bereinigt). Plaintext-Exporte (PDF, CSV, TXT) bekommen einheitliche „•“-Punkte (`noteText` in
  `src/lib/export.ts`); Word-Vorlagen bekommen zusätzlich `notizen_zeilen` (Schleife `{FOR z IN notizen_zeilen}` mit je einem
  `{IF $z.ueberschrift}`, `{IF $z.absatz}`, `{IF $z.punkt}`, `{IF $z.unterpunkt}` und `{$z.text}` / `{$z.marker}`; Aufzählungspunkte
  mit hängendem Einzug). Ältere hochgeladene Vorlagen mit `{notizen}` funktionieren weiter (einheitliche Punkte, aber ohne Einzug).
  Neue Felder immer in `TEMPLATE_ROOTS` **und** den Buildern ergänzen.
- **Tabellenzeilen dürfen umbrechen:** Die Zeile pro Session im Monatsbericht hat kein `cantSplit`. Eine unteilbare Zeile, die höher
  als eine Seite ist, läuft in manchen Viewern (Handy-Apps) in die Fußzeile.

## Word-Vorlagen für Exporte

Im Admin-Tab („Export-Vorlagen (Word)“) lädt der Administrator pro Berichtsart eine `.docx`-Vorlage hoch:
**monthly** (Alle Arbeit und Monatsexport pro Kunde) und **session** (einzelne Session). Mit Vorlage
heißt der erste Export-Button „Word exportieren“ (Zeilen: „Word“) und liefert eine `.docx` im Design der
Vorlage statt des Standard-PDFs; ohne Vorlage bleibt das PDF wie bisher. CSV/TXT nutzen nie eine Vorlage.
Schlägt das Befüllen fehl, wird automatisch das Standard-PDF erstellt (mit Hinweis). Ein Template kann
nicht in ein PDF umgewandelt werden (das bräuchte einen Server).

- **Engine:** `docx-templates` (MIT), die vorgefertigte Browser-Bundle `docx-templates/lib/browser.js`
  wird erst beim Export per dynamischem `import()` geladen. Befehle: `{feld}`, `{$schleifenvar.feld}`,
  `{FOR x IN pfad}…{END-FOR x}`, `{IF pfad}…{END-IF}`, `{IMAGE pfad}`. Eine Tabellenzeile pro Session:
  `FOR` in einer eigenen Zeile über, `END-FOR` in einer eigenen Zeile unter der sich wiederholenden Zeile
  (beides in derselben Zeile würde die Zellen nebeneinander wiederholen).
- **KEINE PREISE in Word-Exporten:** Ein Word-Export ist ein Technikerbericht, keine Rechnung. Preise,
  AE-Sätze und Beträge werden den Vorlagen gar nicht erst übergeben (`src/lib/templateData.ts`, `TEMPLATE_ROOTS`
  enthält kein Preisfeld), eine Vorlage mit `{wert}`, `{satz}`, `{wert_gesamt}` o. Ä. wird vom Validator
  abgelehnt. Das Portal (Reports, Dashboard) sowie Standard-PDF, CSV und TXT zeigen weiterhin Preise.
- **SICHERHEIT:** Template-Befehle sind JavaScript und würden im Browser **jedes** Benutzers laufen.
  `validateTemplate()` (`src/lib/docxTemplate.ts`) erlaubt deshalb ausschließlich Feldzugriffe auf die
  bekannten Datenfelder (`TEMPLATE_ROOTS` in `src/lib/templateData.ts`), Schleifen, `IF` und `IMAGE`: keine
  Funktionsaufrufe, Operatoren, `EXEC`/`HTML`/`LINK`/`QUERY`, keine Makros. Geprüft wird beim Upload **und**
  vor jedem Export; beim Upload zusätzlich ein Probelauf mit Beispieldaten. Wer neue Felder ergänzt, muss
  `TEMPLATE_ROOTS` und die Builder gemeinsam ändern.
- **Speicherung:** Tabelle `report_templates` (Base64, max. ca. 2 MB Datei; nur Admins schreiben, alle aktiven
  Benutzer lesen). Lokale Kopie im IndexedDB-Store `report_templates` (DB-Version 2), damit Exporte offline
  funktionieren. `pullTemplates()` (bei Start und Fensterfokus) lädt nur Metadaten und den Inhalt nur bei
  geändertem `updated_at`.
- **Daten für Vorlagen:** `src/lib/templateData.ts` (`buildMonthlyTemplateData`, `buildSessionTemplateData`).
  Berichtsnummer wird aus Datum/Kunde abgeleitet (z. B. `TB-2026-10-IFG`, `TB-20261028-1757`); die App hat
  keinen Zähler, keine Kundenadresse, keinen Steuersatz und keine Bankdaten.
- **Mitgelieferte Vorlagen:** `scripts/generate-sample-templates.js` erzeugt
  `public/templates/MCT_Vorlage_Monatsbericht.docx` und `MCT_Vorlage_Session-Bericht.docx` im Stil einer
  deutschen Rechnung („Technikerbericht“, Logo oben rechts, Absenderzeile, Infoblock, Positionstabelle,
  Summen, Grußformel, Fußzeile mit Adresse). Logo: `scripts/assets/mct-logo.png`, **im Dokumentkörper oben rechts** (nicht in der Kopfzeile, viele Viewer zeichnen Bilder aus Kopfzeilen nicht).

## Zeitraum-Einträge

Ein Eintrag kann mehrere Tage umfassen (`time_entries.end_date`, nur gesetzt wenn > `entry_date`): Checkbox „Über mehrere Tage“
in „Neue Erfassung“ und im Bearbeiten-Formular, die Dauer ist die Gesamtdauer. Anzeige und alle Exporte nutzen `formatEntryDate`
(`src/lib/export.ts`: „01.01.2027 – 10.01.2027“, Word-Feld `datum`). Monatsberichte und Filter ordnen den Eintrag nach dem
**Startdatum** zu (ein Zeitraum über den Monatswechsel zählt ganz im Startmonat).

## Export & Versand

Abrechnung als PDF, CSV (Semikolon, UTF-8 mit BOM) und TXT (`src/lib/export.ts`). Pro Session gibt es
einen E-Mail-Button (`src/lib/mail.ts`), der immer eine TXT-Datei mit der kompletten Session samt
vollständigen Notizen erzeugt. Touch-Geräte öffnen das Teilen-Menü mit der Datei als Anhang. Auf dem
Desktop wird die Datei heruntergeladen und das Standard-Mailprogramm per `mailto:` ohne Empfänger
geöffnet (ein `mailto:` kann keine Anhänge enthalten, die Datei muss von Hand angehängt werden). Passen
die Notizen nicht in die URL (ca. 1800 Zeichen), steht im Mailtext ein Hinweis auf die Datei.

## Ordnerstruktur

```
src/
  app/
    (auth)/login/page.tsx
    (app)/
      layout.tsx           geschütztes Layout mit TopNav; setzt die Benutzer-DB, Profil, Sync
      page.tsx             Dashboard
      admin/page.tsx       Benutzerverwaltung (nur Administratoren)
      new-entry/page.tsx
      sessions/page.tsx
      report/page.tsx
      settings/page.tsx
    offline/page.tsx
    sw.ts                  Serwist Service Worker
    layout.tsx             Root-Layout mit PWA-Meta-Tags
    globals.css
  components/
    nav/       TopNav.tsx, SyncStatus.tsx, Logo.tsx, UpdatePrompt.tsx, icons.tsx
    timer/     TimerWidget.tsx, TimerCard.tsx
    entry/     AEInput.tsx, EntryForm.tsx
    report/    ReportTable.tsx, ExportButtons.tsx, SessionExportButtons.tsx, AllWorkReport.tsx, CustomerReports.tsx
    signature/ SignaturePad.tsx, SignatureModal.tsx
    ui/        Button.tsx, Input.tsx, Select.tsx, Modal.tsx, Badge.tsx, Toast.tsx, IconButton.tsx, ...
  lib/         supabase.ts, db.ts, ae.ts, sync.ts, export.ts, pdf.ts, reportRows.ts, mail.ts, auth.ts, adminApi.ts, mfa.ts
  hooks/       useCustomers.ts, useSessionTypes.ts, useTimeEntries.ts, useTimers.ts, useSync.ts,
               useOnlineStatus.ts, useProfile.tsx
  types/       index.ts
supabase/
  schema.sql   Endzustand des Schemas (manuell im Supabase SQL Editor auszuführen)
  functions/admin-users/index.ts   Edge Function (Benutzerverwaltung), per Supabase deployt
public/
  manifest.json, icons/, sw.js (generiert)
```

## Umgebungsvariablen

In `.env.local` (siehe `.env.local.example`):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

## Build & Deploy Commands

```bash
npm install          # Dependencies installieren
npm run dev           # Lokaler Dev-Server (http://localhost:3000)
npm run build          # Produktions-Build (generiert auch Service Worker via Serwist)
npm run start          # Produktions-Server lokal starten
npm run lint            # ESLint
```

Deployment: `git push` auf `main` startet den GitHub-Actions-Workflow (GitHub Pages). Die
Supabase-Werte kommen aus den Repository-Secrets `NEXT_PUBLIC_SUPABASE_URL` und
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Lokaler Test des Pages-Exports (Git Bash braucht
`MSYS_NO_PATHCONV=1`): `GITHUB_PAGES=true NEXT_PUBLIC_BASE_PATH=/zeiterfassung npm run build`.

Supabase-Setup: `supabase/schema.sql` im Supabase SQL Editor ausführen. Danach im Supabase
Auth-Dashboard manuell einen Benutzer-Account anlegen (keine Registrierungs-UI in der App).

**Aktuelles Projekt:** `rlctnbqytjphyfetzxxm` (eu-west-1) — Schema bereits angewendet,
`.env.local` bereits mit URL/Anon-Key befüllt.

**Login:** ausschließlich Benutzername oder E-Mail + Passwort (`supabase.auth.signInWithPassword`). Der
frühere „Mit GitHub anmelden“-Button wurde aus der Oberfläche entfernt. Der GitHub-Provider ist im Supabase
Dashboard (Authentication → Providers → GitHub) vermutlich noch aktiviert: wer ihn ganz abschalten will,
muss ihn dort ausschalten (ein bestehendes GitHub-Konto könnte sonst weiter über die OAuth-URL anmelden).
Benutzer legt der Administrator im Admin-Tab an.

## PWA-Installation

- **Desktop (Chrome/Edge):** Adressleiste → Installations-Icon klicken, oder Menü → "App installieren".
- **iOS Safari:** Teilen-Button → "Zum Home-Bildschirm".
- **Android Chrome:** Menü → "App installieren" / "Zum Startbildschirm hinzufügen".
- Die App funktioniert danach im Standalone-Modus (ohne Browser-UI) und vollständig offline
  dank Service Worker Caching und IndexedDB.

## Deutsches Locale

- **UI-Sprache:** Durchgehend Deutsch — keine hartcodierten englischen Strings.
- **Datumsformat:** `dd.MM.yyyy` überall (z.B. `14.09.2026`).
- **Zahlenformat:** Deutsches Locale für Währung, z.B. `1.234,56 €`.
- **CSV-Export:** Semikolon als Trennzeichen (deutscher Excel-Standard), UTF-8 mit BOM.
- **Zeit-Anzeige (Timer):** `HH:MM:SS`, sekündlich aktualisiert.
