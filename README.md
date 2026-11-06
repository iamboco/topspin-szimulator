# Topspin · Siófoki AK szezonlabor

Magyar, offline NB III-as asztalitenisz-elemző: hivatalos eredmények és játékosstatisztikák, mérkőzésbecslések és teljes szezon-szimuláció.

## Oldal

https://iamboco.github.io/topspin-szimulator/

A gyökérben lévő index.html az önálló kiadás: GitHub Pagesen és helyi fájlként is fut, külön telepítés nélkül. Minden szimuláció a látogató saját böngészőjében történik.

## 2026. november 6-i frissítés

- A 2026/27-es férfi NB III Dél-Dunántúl teljes hivatalos sorsolása és az addigi 25 lezárt találkozó, 450 részmeccssorral.
- Friss tabella, játékosstatisztikák, keretek és tényleges korábbi felállásminták.
- Külön Csak ezt a meccset számolom újra gomb: más felállás kipróbálásakor csak a kiválasztott találkozó számolódik.
- Több kipróbált felállás eredményének megőrzése és visszatöltése, meccseredmény-JSON export.
- A külön meccsszámítás nem módosítja a többi találkozó vagy a teljes szezon megőrzött eredményeit. A tabella hatásvizsgálatához továbbra is külön teljes szezonfuttatás szükséges.

Hivatalos idei adatforrás: https://csb.asztaliteniszezz.hu/ligak/ferfi-nbiii-del-dunantul-2026-2027/fordulok

Az oldal nem élő eredménykövető: a beágyazott adatpillanatkép dátumát a fejléc jelzi. A jövőbeli felállásokra vonatkozó becslés nem sportorvosi vagy nevezési jogosultsági igazolás.

## Fejlesztés

Node.js 20 vagy újabb:

```sh
npm test
npm run build
```

Nincs JavaScript-csomagfüggőség. A src/engine.js, src/ui.js és src/club-statistics.js a szerkeszthető forrás; a build ezek tartalmát ágyazza az index.html megfelelő scriptjeibe. Az adatok külön JSON-ból is beépíthetők:

```sh
node scripts/build.mjs --data /path/to/app-data.json
node scripts/precompute.mjs --data /path/to/app-data.json --out /path/to/app-data-with-precomputed.json
node scripts/build.mjs --data /path/to/app-data-with-precomputed.json
```

A precompute ténylegesen lefuttatja mind a hat modellt, modellenként 100 000 teljes szezonnal; nem nevezi át a régi eredményeket frissnek. A frissítési/adatillesztési módszer a [DATA-UPDATE.hu.md](docs/DATA-UPDATE.hu.md) dokumentumban, a külön meccsszimuláció részletei a [MATCH-SIMULATION.hu.md](docs/MATCH-SIMULATION.hu.md) fájlban olvashatók.
