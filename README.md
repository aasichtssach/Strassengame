# Strassenjagd Basel: Live-Version

Vier Läufer laufen durch Basel. Wer einen Strassenabschnitt (etwa 40 m) zuerst läuft, besitzt ihn. Die Live-Karte zeigt Besitz, Positionen und die Meter pro Läufer.

Das Strassennetz (308,5 km, 8'436 Abschnitte) kommt aus deinem OpenStreetMap-Export (`network.json`).

## Was im Ordner liegt

| Datei | Zweck |
|---|---|
| `server.js` | Nimmt GPS-Positionen an, ordnet sie Abschnitten zu, vergibt den Besitz, schickt den Stand per WebSocket an die Karte |
| `public/index.html` | Live-Karte mit Zählertafel |
| `public/run.html` | Läufer-Seite für den Browser (ohne App) |
| `public/admin.html` | Spiel starten, beenden, zurücksetzen, Namen ändern, Zugangslinks |
| `public/net.js` | Zerlegt das Netz in Abschnitte (Server und Karte nutzen dieselbe Datei) |
| `network.json` | Strassennetz |
| `test.js` | Simuliert GPS-Läufe und prüft die Zuordnung (`npm test`) |
| `Dockerfile` | Zum Veröffentlichen |

## 1. Lokal ausprobieren

Du brauchst Node.js ab Version 18.

```
npm install
npm start
```

Der Server schreibt beim Start die Adresse der Verwaltung und die vier Tokens ins Terminal. Öffne `http://localhost:3000/admin?key=...` und drücke «Spiel starten». Die Karte liegt unter `http://localhost:3000/`.

Mit `npm test` läuft eine Simulation mit verrauschten GPS-Daten. Sie prüft Zuordnung, Reihenfolge, Tempolimit und nachgesendete Positionen.

## 2. Im Internet veröffentlichen

Die Handys müssen den Server über HTTPS erreichen. Der Ordner enthält ein `Dockerfile`. Das funktioniert bei Render, Fly.io, Railway und ähnlichen Anbietern:

1. Ordner in ein Git-Repository legen und beim Anbieter als «Web Service» aus dem Dockerfile bauen lassen.
2. Umgebungsvariable `ADMIN_KEY` setzen (ein langes Zufallspasswort). Ohne sie wird bei jedem frischen Start ein neuer Schlüssel erzeugt und ins Log geschrieben.
3. Einen **dauerhaften Speicher** (Disk/Volume) auf `/data` einbinden. Ohne ihn geht der Spielstand bei jedem Neustart oder Update verloren.
4. Der Server läuft als **eine** Instanz. Nicht horizontal skalieren, sonst teilen sich die Instanzen den Spielstand nicht.

Danach: `https://deine-adresse/admin?key=DEIN_ADMIN_KEY`.

## 3. Handys einrichten

Auf der Verwaltungsseite steht für jeden Läufer ein eigener Token. Mit diesem Token meldet sich das Handy an.

**Empfohlen: Traccar Client** (kostenlose App für iPhone und Android, läuft auch bei gesperrtem Bildschirm)

- Geräte-Kennung: der Token des Läufers
- Server-URL: `https://deine-adresse/osmand`
- Intervall: 5 Sekunden, Genauigkeit: hoch
- Dienst starten und dem Standortzugriff «immer» zustimmen

**Alternative: OwnTracks** im HTTP-Modus mit der URL `https://deine-adresse/owntracks?token=TOKEN`.

**Ohne App:** Läufer öffnen `https://deine-adresse/run?token=TOKEN` im Browser und tippen «Tracking starten». Bildschirm anlassen und die Seite im Vordergrund lassen. Auf iPhones hält Safari die Seite im Hintergrund oft an. Dann fehlen Positionen.

Hinweis: Ich habe die Schnittstellen mit simulierten Anfragen im Format dieser Apps getestet, nicht mit den echten Apps. Mach vor dem ersten Spiel einen kurzen Probelauf zu zweit.

## 4. So werden Positionen zugeordnet

- Positionen mit schlechterer Genauigkeit als 30 m werden verworfen.
- Läufst du zwischen zwei Positionen schneller als 25 km/h, zählt dieses Stück nicht (kein Rad, kein Auto).
- Jede Position und der Weg dazwischen werden auf die nächste Strasse im Umkreis von 15 m gelegt. Parallele Strassen in der Nähe werden nicht mitgezählt.
- Jeder Abschnitt ist in vier Teilstücke geteilt. Er gehört dir, sobald du drei davon berührt hast. So zählt eine Querstrasse nicht, an der du nur vorbeirennst.
- Der frühere Zeitstempel gewinnt. Kommen Positionen verspätet an (zum Beispiel weil das Handy kurz offline war), kann ein Abschnitt noch den Besitzer wechseln, wenn der andere nachweislich früher dort war.
- Tunnel und private Zufahrten sind nicht im Netz.

Einstellungen per Umgebungsvariable: `MAX_KMH` (25), `MAX_ACCURACY` (30), `SNAP_M` (15), `DELAY_S` (30), `PORT` (3000), `DATA_DIR`.

## 5. Datenschutz

- Alle vier müssen dem Teilen ihres Standorts zustimmen.
- Die Karte zeigt Positionen und Besitz mit `DELAY_S` Sekunden Verzögerung (Standard 30). Das schützt die Läufer und verhindert, dass jemand dem Führenden direkt hinterherläuft.
- Wer den Link zur Karte kennt, sieht den Spielstand. Gib ihn nur Leuten, die das sehen dürfen.
- Auf dem Server liegen nur Besitz und Zeitstempel der Abschnitte. Einzelne GPS-Spuren werden nicht gespeichert.

## 6. Teststand

Die Simulation (1,6 km Route, 5 m GPS-Rauschen, Position alle 5 s) ergab: 95 % der Abschnitte auf der Route wurden zugeordnet, 98 % der zugeordneten Abschnitte lagen auf der Route. Echte Läufe in engen Gassen oder zwischen hohen Häusern können schlechter abschneiden. Dann hilft ein grösserer `SNAP_M`-Wert oder eine kürzere Abschnittsgrösse. Probiert es mit einem echten Lauf aus.
