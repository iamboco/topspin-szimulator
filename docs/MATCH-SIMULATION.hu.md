# Mérkőzésenkénti újraszimulálás

## Használat

1. A Mérkőzések nézetben válassz egy még le nem játszott találkozót.
2. A két oldalon válassz korábbi felállást, vagy szerkeszd a saját négyest és a két párost.
3. Nyomd meg a Csak ezt a meccset számolom újra gombot. A felső mintaszám, modell, seed és formaingadozás erre a számításra is érvényes.
4. Másik felállás kipróbálásához módosítsd a játékosokat és nyomd meg újra ugyanezt a gombot.
5. A Kipróbált felállások alatt visszatöltheted a korábbi változat felállását, beállításait és kész eredményét. Ugyanazt a változatot a lap gyorsítótárból adja vissza.

A külön meccsfuttatás nem igényel előzetes felállásmentést. Nem számít újra másik mérkőzést, és nem írja át a megőrzött szezoneredményt. A meccsmodell nem a részmeccsek független esélyeinek összeadása: megmarad a közös játékoserősség-, napi forma- és párosbizonytalanság.

Ha a felállás helyezési esélyekre gyakorolt hatása is érdekel, külön mentsd a felállást a szezonhoz, majd használd a Teljes szezon újraszámítása gombot. Egy önálló meccs margóeloszlásából a teljes szezon korrelált helyezéseloszlása nem frissíthető helyesen.

## Eredmény és korábbi változatok

- Zöld címke: a jelenleg kiválasztott két felállásra és beállításokra elkészült egymeccses eredmény.
- Sárga címke: az utolsó egymeccses eredmény látható, de azóta a felállás vagy más számítási beállítás megváltozott. Nem mutatjuk úgy, mintha ez már az új változat eredménye lenne.
- Szezonfutás címke: még nincs külön meccsbecslés; a megőrzött szezon megfelelő találkozójának becslése látható. A szezon alaphelyzetben történeti felálláskeveréket használ, nem feltétlenül a szerkesztő konkrét négyesét.
- A Meccseredmény JSON gomb a jelenlegi felállás külön eredményét, beállításait, adatverzióját és időbélyegét exportálja. A fejléc szezonexportja továbbra is a teljes szezonra vonatkozik.

A gyorsítótár legfeljebb 48 külön meccs–felállás–beállítás eredményt tart. Az összehasonlító, görgethető listában az adott meccs minden még tárolt változata megjelenik. A tár csak a megnyitott lap memóriájában él: újratöltéskor eltűnik; nem kerül automatikusan helyi tárhelyre. A JSON-export használható tartós másolatként. A cache találatakor a már kiszámított esélyek nem változnak; a gyorsítótárból kiesett változat ugyanazzal az adatverzióval és seeddel reprodukálható.

## Fejlesztői API

```js
await SIM.runFixture(APP, {
  fixtureId,
  modelId,
  n: 10000,
  seed: 20261106,
  formMultiplier: 1,
  homeScenario: { paths, doubles },
  awayScenario: { paths, doubles },
  onProgress(fraction, text) {}
});
```

A felállás alakja: négy hely × négy egyéni megjelenés a paths mezőben, két kéttagú páros a doubles mezőben. A null tényleges hiányzás. A felállásparaméter elhagyása az adott oldal empirikus teljesfelállás-keverékét jelenti. A kézi felállás csak a jelenlegi nyilvános keretből választható; egy változatlan, forrással igazolt korábbi felállás a tényleges múltbeli résztvevőit őrizheti, anélkül hogy ez jövőbeli jogosultságot állítana.

A visszatérés tartalmazza:

- fixtureId, modelId, n, seed, formMultiplier és known;
- score: 19 elemű hazai részgyőzelem-eloszlás;
- away_score: 19 elemű vendégeloszlás;
- joint_score: 19 × 19 elem, sorfolytonosan h × 19 + a címmel;
- wdl: hazai győzelem, döntetlen, vendéggyőzelem;
- mean_home, mean_away és a futási auditot tartalmazó runtime.

A kétoldali eloszlás szükséges a kettős hiányzások helyes kezeléséhez: ilyenkor nem biztos, hogy a vendég részgyőzelme 18 mínusz a hazai részgyőzelem. A valós rögzített eredmény és a csapatszintű játék nélküli eredmény fix, nem újrasorsolt.

A motor csak a célmérkőzést fordítja le és szimulálja. Egy mintában közösen húzza a releváns illesztett paraméterek teljes Gaussian kovarianciáját; az új párosok/játékosok priorja, a közös játékosnapi forma és a részmeccsenkénti közös szettmaradék az eredeti szezonmotor feltevéseit követi. Egyetlen jövőbeli fordulóhoz a Gaussian random walk pontos egypontos margóját használja. A forma szorzója a napi és részmeccsszórást változtatja, a driftet nem.

A véletlenfolyamot a seed, a fixtureId és a verziózott egymeccses sampler azonosítja. A többi meccs felállásai és a 9/18 fordulós szezonnézet nem befolyásolják. A külön meccsfutás számszerűen nem ugyanaz a mintasorozat, mint a teljes szezon megfelelő találkozója; azonos modellbeli margót becsül. Nem ragasztjuk vissza a szezonba független mintaként.

## Tesztek és build

```sh
npm test
npm run build
```

A Node beépített tesztfuttatóján kívül nincs JavaScript-csomagfüggőség. A tesztek ellenőrzik többek között az A → B → A ismételhetőséget, a cache elkülönítését, a többi mérkőzés és a szezon változatlanságát, a worker/fallback egyezést, mind a hat modellt, a kovarianciából eredő korrelációt, a hiányzást és a rögzített eredményeket.

A src könyvtár szerkeszthető scriptjeit a scripts/build.mjs visszaágyazza az index.html-be. A kiadott HTML továbbra is önálló: GitHub Pagesen és letöltve, internetkapcsolat nélkül is működik; nincs kiszolgálói számítás vagy futás közbeni adatletöltés.
