# Adat- és modellfrissítés — 2026. november 6.

## Hatókör, kimenet, források

Az idei adat kizárólag a **Férfi NBIII. — Dél-Dunántúl, 2026/2027** bajnokságból származik:

- [Fordulók és teljes sorsolás](https://csb.asztaliteniszezz.hu/ligak/ferfi-nbiii-del-dunantul-2026-2027/fordulok)
- [Hivatalos tabella](https://csb.asztaliteniszezz.hu/ligak/ferfi-nbiii-del-dunantul-2026-2027/tabella)
- [Játékos-/páros-/csapatstatisztika](https://csb.asztaliteniszezz.hu/ligak/ferfi-nbiii-del-dunantul-2026-2027/statisztika)
- [Nyilvánosan közölt keretek](https://csb.asztaliteniszezz.hu/ligak/ferfi-nbiii-del-dunantul-2026-2027/csapatok)
- Mind a 25 lezárt találkozó saját `/merkozesek/{UUID}` oldala és eredeti mérkőzéslap-csatolmánya.

Division UUID: `bc7c5e52-698a-4790-9faf-e825b6f6dcfe`.
A hivatalos pillanatkép lekérései: **2026-11-06 08:09:16–08:12:41 UTC**. Az egyes oldalak pontos ideje, SHA-256-a és HTTP-státusza a `league-source/source-manifest.json` fájlban található. A `league-source/README.md`, `validation.json`, `raw/` és `scoresheets/` a forrásfeltárást, változatlan HTML-eket és eredeti csatolmányokat tartalmazza.

A friss alkalmazásadat: **`inspection/app-data.updated.json`**, UTF-8, tömör JSON, körülbelül 14 MB. Nincs benne a 9 ezer soros történeti tanítóanyag másodpéldánya; a régi és új teljes posteriorok viszont szándékosan megmaradnak. A frissítő **nem írja az `index.html`-t, a motort vagy a felületet, nem végez GitHub-műveletet**. A beágyazást és a szimulációs cache előállítását a fő építési lépés végzi.

### Ellenőrzött mennyiségek

| Adat | Friss állapot |
|---|---:|
| Forduló / csapat | 18 / 10 |
| Teljes sorsolás | 90 találkozó |
| Hivatalos eredmény / függő | 25 / 65 |
| Dátum nélküli párosítás | 45, a 10–18. fordulóban |
| `currentGames` | 450 = 400 egyéni + 50 páros |
| Játszott részmeccs / JN | 434 / 16 |
| Valódi szettpontsor / minden nyers szettsor | 1674 / 1692 |
| Tabellasor | 10, a hivatalos pozíciós sorrendben |
| Közölt kerettagság / egyedi keretjátékos | 53 / 53 |
| Hivatalos játékosstatisztikai sor | 63 |
| Keret és szereplők uniója | 66 játékos |
| Hivatalos párosstatisztikai sor | 56 |
| Felállásminták forrástalálkozói | mind a 25 lezárt találkozó, mindkét csapat oldalán |
| Klubarchívum | 6258 sor = 5808 változatlan másik/korábbi sor + 450 friss idei sor |

Az 5. fordulós **Pécsi Tüke SE – Baja I. GTKB 14:4** már ismert eredmény, nem szimulálandó hiány. A négy korábban `approved`/`home_approved` státuszú eredmény most `official`. A 9. forduló `fcba06c3-…` Pécs–Atomerőmű időpontja **2026-11-22 10:00 UTC** lett a korábbi december 13. helyett. A forrásban null dátumok nullok maradnak; tavaszi időpontot nem találunk ki. Minden közölt helyszín-, halasztási és döntési mező átkerül a sorsolásba.

## A régi adathoz viszonyított delta

Az audit nemcsak a darabszámot, hanem a `match_id:label` azonosítóhoz tartozó játékosokat, eredményt és szettpontokat is összeveti.

- Régi 432 sor → új 450 sor: **18 új sor, nincs eltűnt kulcs**.
- **16 már játszott, már tanult egyéni sor tartalma is megváltozott**, mind a `d1121105-cfc7-459f-a4d5-1498b2c3b2f9` Atomerőmű–Kaposvár találkozón. A hivatalos játék-UUID-k azonosak; nem puszta átnevezés vagy új sorok hozzáfűzése történt. Játékos-, szetteredmény- és pontadat-korrekciók egyaránt vannak.
- További **16 eltérés a JN szetteredményének helyes reprezentációja**: az eredeti 3:0 helyett a hivatalos, nem számszerű kijelzéshez tartozó nullok szerepelnek. Ez nem 16 további játszott eredmény korrekciója.
- A régi archívum 431 átfedő idei sora ugyanazzal a nyilvános UUID-val azonosítható. Egy korábbi fallback-azonosítót most a tényleges hivatalos UUID váltott fel.

A részletes mezőnkénti régi/új értékek: **`inspection/data-update-audit.json → delta`**. A korrekció miatt **nem helyes a régi posteriorhoz egyszerűen hozzáadni az új 18 részmeccset**. Ilyen szekvenciális frissítés nem történt, a régi játékok nem kerültek kétszer a tanításba.

## JN, tabella, játékosok és keretek

A 16 JN sor megmarad az eredményközlésben, de sem a játékosstatisztikába, sem a modellbe nem számít. Szerződésük:

```text
walkover = true; awarded = true; administrative_or_unplayed = true
home_sets = null; away_sets = null
winner = "home"
winner_evidence = "official_rendered_winner_highlight_for_JN"
```

A győztest a hivatalos kiemelés igazolja. A motor **nem** dönthet a null értékek nullára konvertálásával. Hat JN sorban három-három 11:0 adminisztratív szettpontpár is van: a nyers `sets` tömbben forráshűen megmarad, de a statisztika és a `known_metrics` csak tényleges játékot összegez. A hiányos szett-/poénkritériumot explicit hiányjelző kíséri; hiányzó pontadat nem 0 pont.

A `currentTable` a hivatalos tabella **pozícióit és értékeit** tartalmazza, `provisional:false`, `source_kind:"official_standings"`. Minden számlálót mind a 25 csapateredményből függetlenül újraszámolva egyezést kapunk. Az upstream `updated_at` mező nem azonos a pillanatkép idejével, ezért változatlan értéke mellett ott van a lekérési proveniencia is. Az upstream `form` kihagyja a döntetleneket; ezért `form_official` néven, nem garantált teljes utolsó öt eredményként szerepel.

A játékosok `current` számlálói a 434 nem-JN sorból újraszámolva a 63 hivatalos sor minden használt számlálójával megegyeznek. A három csak keretben szereplő játékos jelenlegi számlálói nullák. `roster_teams`, `statistics_teams`, `published_roster_member` különbözteti meg a 53 közölt keretjátékost a szereplőktől: **13 statisztikai résztvevő nincs a most közölt keretekben**. A tényleges szereplés nem igazol automatikusan jövőbeli nevezési vagy sportorvosi jogosultságot.

## Felállásminták

A 25 lezárt lap játéksoraiból, nem a lapok külön „Keretek” felsorolásából épülnek. Egy minta tartalmazza a két tényleges párost és a négy egyéni hely négy-négy egymást követő szereplését (`paths[4][4]`). A cserék és a hiányzó játékosok nullként megmaradnak.

A sorrend: A–V, B–X, C–Y, D–Z; A–X, B–Y, C–Z, D–V; A–Y, B–Z, C–V, D–X; A–Z, B–V, C–X, D–Y.

Egy r-edik fordulóból vett megfigyelés nyers súlya `2^(-(5-r)/2)`. Az azonos teljes minták összeadódnak, csapatonként a súlyok 1-re normalizálódnak. Az öt forduló mind az 50 csapatoldala szerepel a forráshivatkozásokban. A felezési idő **modellfeltevés, nem frissen bizonyított paraméter**.

## A történeti tanítóanyag visszanyerése

Az eredeti repo nem tartalmazta a tanítókódot és a nyers történeti korpuszt. Ezért először mind a **66 eredeti játékos** saját, licencazonosítós nyilvános profilját újraarchiváltuk (`/jatekosok/{license}`). Az anonim HTTP GET lekérések ideje **2026-11-06 08:25:06–08:25:25 UTC**. Nincs bejelentkezés vagy privát API.

A Next.js Flight/React Server Component payloadot JSON-dekódolással olvassuk, a weboldal szkriptjeinek futtatása nélkül. A 66 forrásoldal raw bájtjai és metaadatai: **`inspection/history-source/raw/`**. A normalizálás előtti, forráshivatkozásos egyesítés: **`inspection/history-source/training-history.json`**.

- 26 535 profil-játéksor, összes idényből 23 314 különböző játék-UUID; az átfedő profilok azonos UUID-jú rekordjai közt **0 tartalmi konfliktus**.
- A tanító-korpuszt kizárólag az előző öt megnevezett idényre, **2021/22–2025/26-ra** szűrjük: **9385 nyers egyedi sor**.
- A 49 játék nélküli és 169 hiányos/ismétlődő résztvevős megjelölés átfed; összesen **178 különböző sor kizárt**, tehát **9207** a felhasználható történeti sor.
- Ebből **4981** tartozik az előző három idényhez. A történeti adatok közt 16 `approved` és a többi `official` terminális, érvényes eredmény. E szűrés a fit metában külön rögzített.
- **4 történeti játék 15 szabályos, teljes szettpontsora** visszanyerhető; a többi régi 3:x eredményhez nem készül mesterséges 11:x pontadat.
- A profilok 501 idei játékát **nem importáljuk az idei ligába**: annak minden adata továbbra is kizárólag a kijelölt 450-soros hivatalos ligapillanatkép.

Az eredeti meta 9267 történeti nyers sort jelzett, az új nyilvános visszagyűjtés 9385-öt ad. Az eredeti nyers fájl nélkül e különbség pontos eredete nem állapítható meg: lehet korábbi szűrés vagy későbbi forrásváltozás. **Nem állítunk bitpontos azonosságot az eredeti korpusszal vagy tanítással.** Az újraillesztés a most elmentett és ellenőrizhető korpuszból reprodukálható; nem az egész régi liga teljes népszámlálása.

### Hibás történeti dátumok

A nyers korpuszban 123 sor 2022/23-as idényhez rendelt, de `2022-05-31…` dátumú; ezekből 114 érvényes tanítósor. A nyers dátum **nem változik meg**, nem találunk ki január 15-i vagy más „javított” dátumot.

A megbízható időpontoknál a súly a tényleges időpontból számolódik. Az idényen kívüli időpontú történeti soroknál külön feltevésként a diszkontot analitikusan átlagoljuk az adott július 1.–következő július 1. idényintervallumon:

```text
k = ln(2) / felezési_napok
w = exp(-k·(t_zárás-t_idényvége)) · (1-exp(-k·idényhossz)) / (k·idényhossz)
```

Ez csak súlyátlagolás, **nem dátumimputáció és nem rekonstruált tudáspálya**. A 3 idényes modellben nincs ilyen dátumanomália.

## Mind a hat modell újraillesztése

Teljes új illesztés történt, nem kézi `mu`-módosítás, régi posteriorra duplán tanítás vagy szimulációs eredményekből visszaszámolt erősség. Az eredeti modellazonosítók és hiperparaméterek megmaradnak.

| Modell | Idei játszott | Történeti játszott | Összes tanítósor | Exportált dimenzió |
|---|---:|---:|---:|---:|
| `set_current` | 434 | 0 | 434 | 123 |
| `point_current` | 434 | 0 | 434 | 123 |
| `set_history3` | 434 | 4981 | 5415 | 162 |
| `point_history3` | 434 | 4981 | 5415 | 162 |
| `point_history5` | 434 | 9207 | 9641 | 170 |
| `point_history5_fast` | 434 | 9207 | 9641 | 170 |

Az export sorrendje `players` (66) + `pairs` (56/95/103) + hazai hatás. A tanítás minden történeti ellenfél játékosát és minden megfigyelt párost is tartalmazza (az öt idényes változatnál **831 játékos, 873 páros**); a fájlba az eredeti alkalmazásszerződés szerint a jelenlegi 66 játékoshoz és az ő párosaikhoz tartozó **teljes marginális** Gaussian kerül. A nem exportált paraméterek bizonytalanságát nem felejtjük el: a teljes közös Hessian megfelelő inverzoszlopaiból marginalizálunk.

### Tényleges likelihood és közös effektusok

```text
η_g = átlag(θ_hazai) − átlag(θ_vendég)
      + átlag(u_hazai,játékos,csapatmeccs) − átlag(u_vendég,játékos,csapatmeccs)
      + párosszinergia_hazai − párosszinergia_vendég + h + ε_g
```

- A játékos/csapatmeccs-napi forma ugyanazon játékos adott csapattalálkozójának minden egyéni/páros sorában közös; nem független formát tanítunk minden sorra. Az idei modellekben 210 ilyen nuisance effektus van.
- Az eredeti nulla várható értékű, független Gaussian priorok és szórásaik szerepelnek: `tau`, `pair_sd`, `home_sd`, `day_sd`, az eredeti config szerint.
- Szettmodell: `q=sigmoid(η)` és a tényleges megnyert/vesztett szettek likelihoodja.
- Pontmodell, teljes pontadat esetén: `p=sigmoid(η)` és `p^hazai_pont (1-p)^vendég_pont`. Ugyanezen játék 3:x eredményét **nem adjuk hozzá még egyszer**. A szabályos megállás és a pontokból nem ismert sorrend η-független kombinatorikus tényezői az optimumot nem módosítják; az objective ezeket a konstansokat nem tartalmazza.
- Pontmodell, csak régi 3:x adat esetén: az **egzakt 11 pontig/két különbségig tartó szett valószínűségét** `q=g(p)` használjuk, végtelen deuce folytatással. A log-valószínűséget és első/második deriváltját stabil log-sum-exp alakban számoljuk.
- A `rubber_sd` közös részmeccsmaradékot **a teljes részmeccs likelihoodjából integráljuk ki**, 41 pontos Gauss–Hermite-kvadratúrával. Nem külön szettenként vagy pontonként integrálunk, és nem helyettesítjük egyszerű plug-in logittel.
- A teljes integrált log-likelihood idődiszkontált: idei sorokra **180 nap**, történetire a config szerinti **730 / 365 nap** a felezési idő. A súly a log-likelihood előtt áll; nem a Gaussian prior újrasúlyozása. Referencia: a ligapillanatkép utolsó lekérése, `2026-11-06T08:12:41.040992+00:00`.
- A jövőbeli `drift_sd` nem történeti tanítási zaj: az eredeti szimulációs feltevés marad. `through_round=5`.

### Optimálás és teljes kovariancia

A Gaussian prior szerinti fehérített paramétereken **L-BFGS-B** minimalizálja a tényleges integrált negatív log-poszteriort, analitikus gradienssel (`ftol=1e-14`, `gtol=2e-7`, maximum 2500 iteráció). A hat futás 41/41/92/96/110/80 iteráció alatt konvergált.

Az új kovariancia **observed-information Laplace-közelítés**: a MAP-pontbeli teljes negatív log-poszterior analitikus Hessianjának megfelelő teljes inverzblokkja. Nem az eredeti, nem elérhető Fisher-kóddal való azonosság állítása, nem diagonális becslés és nem MCMC. A közös napi és minden nem exportált ellenfél-/párosparaméter marginalizálása megtörténik. A teljes eredeti `mu`, `cov`, `fit`, `inference`, config és eredeti tanítászárás minden modell **`originalSnapshot`** mezőjében változatlanul megmarad.

Az idei két modell a teljes, javított és kijelölt aktuális forráson, a dokumentált modell szerint újraillesztett MAP. A négy történeti modell **teljes, új forrásarchívumból reprodukálható rekonstrukció**, de az eredeti hiányzó tanítás bitpontos reprodukcióját nem ígérjük. A régi posterior mint prior szekvenciális közelítésére végül **nem volt szükség**.

## Numerikus audit és tesztek

A `fit.audit` és az önálló `inspection/data-update-audit.json` tartalmazza a számszerű eredményeket. A hat futás közül a legrosszabb értékek:

| Ellenőrzés | Maximum / eredmény |
|---|---:|
| Fehérített gradiens legnagyobb abszolút koordinátája | 8,20×10⁻⁵ |
| Analitikus vs. differenciált iránygradiens abszolút hiba | 4,17×10⁻⁸ |
| Teljes Hessian-vektor szorzat relatív differenciálási hibája | 7,51×10⁻¹¹ |
| 41 vs. 81 pontos GH, legnagyobb log-likelihood eltérés | 1,43×10⁻¹⁴ |
| 41 vs. 81 pontos GH, legnagyobb score-eltérés | 4,27×10⁻¹⁴ |
| A teljes inverzoszlopok `H·C−I` legnagyobb maradéka | 1,05×10⁻¹⁴ |
| Exportált kovarianciák | szimmetrikusak, minden sajátérték pozitív |
| Ismételt teljes újraillesztés | azonos `mu` és `cov` (rögzített környezet/1 BLAS-szál) |

A `scripts/test_data_update.py` **11 offline tesztet** futtat. Többek között minden játék-UUID-t visszaellenőriz a hivatalos csomagra; ellenőrzi a JN null eredményét és nyertesét; a teljes régi archívum 5808 másik sorának tartalmi azonosságát; mind a hat régi posterior és régi jelentések változatlan megőrzését; valamint az integrált likelihoodot független adaptív numerikus integrállal és a megállított szettképlet deriváltjait véges differenciával.

**Ezek adatintegritási és numerikus tanítási ellenőrzések, nem friss prediktív visszatesztek.** Az eredeti 264/67 részmeccses validációs jelentések változatlanul megmaradtak, de kifejezetten az **eredeti 2026-10-17-i** adatokhoz és modellekhez címkézve. A 16 korrigált játék az eredeti ellenőrző mintát is érinti. `validation.current_models_validated=false`. Modellválasztást nem igazolunk újra a régi számokkal; a teljes szezon helyezéseloszlásának kalibráltsága továbbra sincs bizonyítva.

A frissítő köztes JSON-jában a `precomputed` szándékosan üres objektum: a régi esélyek nem érvényesek az új modellekre/eredményekre. A kiadott index.html-ben a scripts/precompute.mjs a friss motorral mind a hat modellhez ténylegesen újraszámolta a 100 000 szezonos alaphelyzetet (9. és 18. forduló), összesen 600 000 teljes szezon lefuttatásával. A kiadott meta.precomputed_status complete, az eredmények az új data_revision-höz kötődnek. A ténylegesen használt Monte Carlo-mag 20261017 maradt; ez véletlenmag, nem adatzárás. A frissítő 20261106-os ajánlott magja külön data_update_default_seed mezőben megmarad. Az eredményeket nem címkéztük át más seedre.

## Klubarchívum megőrzése

Csak a kijelölt idei liga 432 régi sora cserélődik 450 friss sorra; UUID és `(matchId,gameNumber)` szinten is egyediséget ellenőrzünk. **Az összes 5808 másik/korábbi sor tartalma és sorrendje változatlan**. A régi meta és audit `originalSnapshot` alatt megmarad. Az új aktív meta: 6258 összes sor, 6092 játszott sor, 434 pontadatot tartalmazó játszott sor, 1674 valódi szettpontsor. A saját kluboldali 4750 archívsor és 4623 játszott sor megmarad. A régi 33 klubtag és bizonyított tagsági adataik nem tűnnek el.

A 66 profilból visszanyert külön történeti modell-korpuszt nem öntjük bele a klubarchívumba: ez megváltoztatná annak tagsági és történeti lefedettségét. A klubarchívum nem minden idők teljes archívuma, és hiányzó idény nem nulla teljesítmény.

## Reprodukció

Környezet: Python **3.9.25**, numpy **2.0.2**, scipy **1.13.1**. A scipy nyilvános PyPI-csomagként települt; nincs magáncsomag vagy távoli író API. A pontos követelmények a `scripts/requirements-data-update.txt` fájlban vannak.

A közös munkakönyvtárból:

```bash
python3 -m pip install -r topspin-szimulator/scripts/requirements-data-update.txt

# Offline: a 66 változatlan raw HTML-ből újra előállítja a profil-uniót.
python3 topspin-szimulator/scripts/collect_training_history.py \
  --original inspection/app-data.json \
  --output inspection/history-source

# Ha hiányoznak a raw fájlok: --fetch. Ez friss élő pillanatképet jelenthet,
# nem garantálja a 2026-11-06-i archivált állapotot. Meglévő fájlt nem ír felül.

OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
python3 topspin-szimulator/scripts/update_data.py \
  --original inspection/app-data.json \
  --source league-source/league-data.json \
  --history inspection/history-source/training-history.json \
  --output inspection/app-data.updated.json \
  --audit inspection/data-update-audit.json \
  --model-cache inspection/model-refit-cache.json

OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
python3 topspin-szimulator/scripts/test_data_update.py
```

Az opcionális modellcache csak az eredeti JSON, a ligaforrás, a teljes történeti pillanatkép, mindkét feldolgozószkript és a függőségek **pontos SHA-256/verzió-egyezésénél** használható. Elhagyható a teljes refithez. Az inputok és scriptek hash-ei az auditban és `meta.input_fingerprints` alatt szerepelnek. A numerikus kimenet determinisztikus; a tényleges `build_utc` természetesen eltér egy másik futásnál.

A fő inputok SHA-256 értékei:

```text
inspection/app-data.json
8b9fe9c62f1ded5b09168109e0b447f29961bc3c916514270d665188f46d4680

league-source/league-data.json
c7b182f31341144c36e3685d83c589937193d9102973cdb5c2629a1e598a8800

inspection/history-source/training-history.json
92cc35f2d540fc95bda784b2163eb6a6c6a9a9ac5419716a8115c944b72364c0
```

A raw forráscsomagokat a kimenettel együtt meg kell őrizni. Az élő profilok jövőbeli újralekérése önmagában nem helyettesíti a most archivált pillanatképet.

## Kiadási ellenőrzés

A JavaScript/adat/UI regressziós csomag 27 tesztje és a Python adatintegritási/numerikus csomag 11 tesztje átment. Valódi Chromium böngészőben az A → B → A felállásváltás pontosan két SIM.runFixture hívást és nulla SIM.run hívást okozott; a teljes szezon nézete változatlan maradt. A 100 000 mintás egymeccses futás Blob workerben csak a kiválasztott fixtureId-t értékelte, más mérkőzés-szimuláció nélkül. A render-ellenőrzés nem talált konzolhibát vagy sikertelen hálózati kérést.
