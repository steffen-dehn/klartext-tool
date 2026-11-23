# Klartext Tool

Anonymes 3W-Feedback (Wahrnehmung, Wirkung, Wunsch) für moderierte Workshops.
Teilnehmende scannen einen QR-Code, schreiben anonym, der Moderator sichtet und
clustert, danach sieht die Gruppe die Originaltexte und priorisiert per Punktevergabe.

## Ansichten

| Ansicht | Adresse | Für wen |
|---|---|---|
| Moderation | `/admin` | Du, mit Passwort. Sessions anlegen, Phasen steuern, clustern, exportieren. |
| Teilnahme | `/s/<id>` | Teilnehmende auf dem Smartphone, über den QR-Code. |
| Beamer | `/b/<id>` | Zweites Browserfenster auf dem Beamer. Folgt automatisch der Phase. |

## Ablauf im Workshop

1. **Vorher:** Unter `/admin` eine Session anlegen. Beamer-Ansicht in einem zweiten
   Fenster öffnen und auf den Beamer ziehen (Vollbild: F11).
2. **Sammeln:** Die Gruppe scannt den QR-Code. Der Beamer zeigt nur die Anzahl der
   Beiträge. Auch du siehst in dieser Phase keine Inhalte.
3. **Sichten:** „Sammlung schließen“. Die Gruppe sieht weiter nichts. Du clusterst
   per KI oder von Hand, benennst um, legst zusammen und blendest einzelne
   Beiträge aus, etwa bei persönlichen Angriffen.
4. **Freigabe:** Alle sehen die Cluster mit den Originaltexten. Mit „Auf Beamer
   groß zeigen“ gehst du Cluster für Cluster durch.
5. **Abstimmung:** Jede Person verteilt ihre Punkte. Der Zwischenstand bleibt verdeckt.
6. **Ergebnis:** Rangliste auf Beamer und Smartphones. Danach Export (Markdown, CSV)
   und Session löschen.

## Lokal starten

Voraussetzung: Node.js ab 22.

```bash
npm install
```

```bash
MODERATOR_PASSWORD=geheim npm start
```

Dann `http://localhost:3000/admin` öffnen. Die Daten liegen lokal in
`data/klartext.db`. Ohne `ANTHROPIC_API_KEY` läuft alles außer dem KI-Clustering.

## Deployment ohne laufende Kosten

Aufbau: Die App läuft als Gratis-Webdienst bei Render, die Daten liegen in einer
Gratis-Datenbank bei Turso. Der Render-Dienst schläft ohne Zugriffe ein und
verliert dabei seine lokalen Dateien; deshalb liegen die Daten extern.
Prüfe die aktuellen Bedingungen der Gratis-Tarife beim Anlegen.

**1. Datenbank (turso.tech)**

1. Konto anlegen, eine Datenbank erstellen (Region Frankfurt, falls angeboten).
2. Die Datenbank-URL (`libsql://…`) und ein Token kopieren.

**2. App (render.com)**

1. Mit GitHub anmelden, „New“ → „Blueprint“, dieses Repository wählen.
   Render liest `render.yaml` und fragt die Variablen ab.
2. Eintragen: `MODERATOR_PASSWORD`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   optional `ANTHROPIC_API_KEY`. `PUBLIC_URL` vorerst leer lassen.
3. Nach dem Deploy `/admin` an der Render-Adresse öffnen. Im Render-Log steht
   beim Start „Daten: Turso“. Steht dort „lokale Datei“, fehlt die Datenbank-URL.

**3. Eigene Adresse (optional)**

1. In Render unter „Custom Domains“ z. B. `klartext.dehn-consulting.com` anlegen.
2. Den angezeigten CNAME beim Domain-Anbieter eintragen.
3. `PUBLIC_URL` auf diese Adresse setzen, damit der QR-Code dorthin zeigt.

**Im Betrieb beachten**

- Nach einer Pause braucht der erste Aufruf bis zu einer Minute. Öffne `/admin`
  einige Minuten vor dem Workshop.
- Es darf genau **eine** Instanz laufen (der Zwischenspeicher für den Abruf
  liegt im Prozess).
- Jeder Push auf `main` wird automatisch ausgeliefert.

## Anonymität: was gilt und was nicht

**Die App speichert und loggt nicht:** Namen, IP-Adressen, Geräte- oder
Browserkennungen, Zeitstempel pro Beitrag, die Reihenfolge des Eingangs.
Beiträge bekommen eine zufällige ID und werden überall in zufälliger Reihenfolge
gezeigt. Das Abstimmungs-Token entsteht erst bei der Abstimmung im Browser und
ist mit keinem Beitrag verknüpft. `npm test` prüft diese Punkte gegen eine lokale
Datenbankdatei.

**Grenzen, die du kennen solltest:**

- Nach außen, also für Teilnehmende, Kunde und Moderator, ist nicht
  nachvollziehbar, wer was geschrieben hat. Technische Dienstleister sehen mehr:
- Die Beitragstexte liegen bei Turso (Datenbank). Gelöschte Sessions sind dort
  aus der Datenbank entfernt; ob der Anbieter Sicherungen vorhält, liegt bei ihm.
  Das Überschreiben gelöschter Daten auf der Platte gilt nur für die lokale Datei.
- Der Hosting-Anbieter (Render) kann vor der App eigene Zugriffsprotokolle mit IP-Adressen
  führen. Die enthalten keine Beitragstexte, aber Zeitpunkte von Zugriffen.
- In kleinen Gruppen kann der Schreibstil eine Person erkennbar machen. Die App
  zeigt immer die Originaltexte.
- Für das KI-Clustering gehen die Beitragstexte an die Claude API von Anthropic.
- Die Punktevergabe ist pro Browser begrenzt, nicht pro Person. Wer den Speicher
  des Browsers leert, kann erneut abstimmen.

## Daten

- Session löschen entfernt alle Beiträge, Cluster und Stimmen endgültig.
- Nicht gelöschte Sessions verschwinden 30 Tage nach dem Anlegen automatisch
  (`RETENTION_DAYS`).
- Ausgeblendete Beiträge stehen in keinem Export.

## Test

```bash
npm test
```

Spielt einen kompletten Workshop durch: 3 simulierte Smartphones, 15 Beiträge,
alle Phasen, Export, Löschung. Braucht ein global installiertes Playwright. Die
Claude API wird dabei durch einen lokalen Stellvertreter ersetzt und die Daten
liegen in einer lokalen Datei. Das echte Clustering und die Verbindung zu Turso
prüft der Test nicht.

## Aufbau

| Datei | Inhalt |
|---|---|
| `server.js` | HTTP-Server, Routen, Phasenlogik, Export |
| `db.js` | Datenbankzugriff (lokale Datei oder Turso), Tabellen, Löschfrist |
| `render.yaml` | Vorlage für den Gratis-Dienst bei Render |
| `cluster.js` | Prompt und Aufruf der Claude API |
| `public/` | Oberflächen (ohne Build-Schritt), DEC-Design in `styles.css` |
