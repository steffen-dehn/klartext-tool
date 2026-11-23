# Klartext

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

Voraussetzung: Node.js ab 22.13.

```bash
npm install
```

```bash
MODERATOR_PASSWORD=geheim ANTHROPIC_API_KEY=sk-ant-... npm start
```

Dann `http://localhost:3000/admin` öffnen. Ohne `ANTHROPIC_API_KEY` läuft alles
außer dem KI-Clustering.

## Deployment

Die App ist ein einzelner Node-Prozess mit einer SQLite-Datei. Sie braucht:

- einen Dienst, der das `Dockerfile` baut und per HTTPS ausliefert,
- ein dauerhaftes Laufwerk, eingehängt unter `/app/data`,
- die Variablen aus `.env.example` (`MODERATOR_PASSWORD`, `ANTHROPIC_API_KEY`, `PUBLIC_URL`),
- genau **eine** Instanz (SQLite, kein Mehrfachbetrieb).

Das geht bei Anbietern wie Railway, Render oder Fly.io ohne weitere Anpassung.
Wähle einen Tarif, bei dem die App nicht einschläft, sonst dauert der erste
Aufruf im Workshop lange.

## Anonymität: was gilt und was nicht

**Die App speichert und loggt nicht:** Namen, IP-Adressen, Geräte- oder
Browserkennungen, Zeitstempel pro Beitrag, die Reihenfolge des Eingangs.
Beiträge bekommen eine zufällige ID und werden überall in zufälliger Reihenfolge
gezeigt. Das Abstimmungs-Token entsteht erst bei der Abstimmung im Browser und
ist mit keinem Beitrag verknüpft. `npm test` prüft diese Punkte gegen die echte
Datenbankdatei.

**Grenzen, die du kennen solltest:**

- Der Hosting-Anbieter kann vor der App eigene Zugriffsprotokolle mit IP-Adressen
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
Claude API wird dabei durch einen lokalen Stellvertreter ersetzt; das echte
Clustering wurde damit nicht geprüft.

## Aufbau

| Datei | Inhalt |
|---|---|
| `server.js` | HTTP-Server, Routen, Phasenlogik, Export |
| `db.js` | Tabellen, Löschfrist |
| `cluster.js` | Prompt und Aufruf der Claude API |
| `public/` | Oberflächen (ohne Build-Schritt), DEC-Design in `styles.css` |
