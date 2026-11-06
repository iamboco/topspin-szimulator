#!/usr/bin/env node
// Keep GitHub Pages and file:// deployment completely self-contained.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const dataFlag = process.argv.indexOf('--data');
if (dataFlag >= 0) {
  if (!process.argv[dataFlag + 1]) throw new Error('--data requires an APP JSON file.');
  const data = JSON.parse(fs.readFileSync(process.argv[dataFlag + 1], 'utf8'));
  const safe = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const pattern = /(<script type="application\/json" id="app-data">)[\s\S]*?(<\/script>)/;
  if (!pattern.test(html)) throw new Error('APP data script not found.');
  html = html.replace(pattern, (_, start, end) => start + safe + end);
}
for (const [id, filename] of [['simulation-engine', 'engine.js'], ['club-statistics', 'club-statistics.js'], ['topspin-ui', 'ui.js']]) {
  const source = fs.readFileSync(path.join(root, 'src', filename), 'utf8');
  if (/<\/script/i.test(source)) throw new Error('Unsafe inline script terminator in ' + filename);
  const pattern = new RegExp('(<script id="' + id + '">)[\\s\\S]*?(<\\/script>)');
  if (!pattern.test(html)) throw new Error('Script not found: ' + id);
  html = html.replace(pattern, (_, start, end) => start + '\n' + source.trim() + '\n' + end);
}
const css = `
/* Topspin v5: standalone fixture calculation, same desktop/mobile layout. */
.fixture-run-actions{padding:18px 0;margin-bottom:18px;border-bottom:1px solid var(--line)}
.fixture-editor>.fixture-run-actions{padding:18px 20px;margin-bottom:0;border-top:1px solid var(--line);border-bottom:0}
.fixture-run-actions>.chart-note{margin:9px 0 0;max-width:760px}
.fixture-run-history .override-item{gap:12px;overflow-wrap:anywhere}
.fixture-run-history .override-item>div{min-width:0}
.fixture-run-history-list{max-height:480px;overflow-y:auto;overscroll-behavior:contain}
@media(max-width:650px){.fixture-run-actions>.btn{width:100%;white-space:normal}.fixture-run-history .override-item{align-items:stretch;flex-direction:column}}
`;
if (!html.includes('/* Topspin v5: standalone fixture calculation')) html = html.replace('</style>', css + '</style>');
if (!html.includes('.fixture-run-history-list{')) html = html.replace('</style>', '.fixture-run-history-list{max-height:480px;overflow-y:auto;overscroll-behavior:contain}\n</style>');
html = html.replace('Eredmény JSON <span', 'Szezoneredmény JSON <span');
html = html.replace('ritka Fisher–Laplace-kovarianciát', 'ritka, teljes kovarianciás Laplace-közelítést');
html = html.replace('A választás 264 részmeccsen, 15 csapattalálkozón alapul;', 'Az eredeti, 2026. október 17-i modellválasztás 264 részmeccsen, 15 csapattalálkozón alapult;');
if (!html.includes('A november 6-i adatfrissítéshez mind a hat modell újraillesztést kapott;')) html = html.replace('A teljes szezon helyezéseloszlásának kalibráltsága nincs ettől igazolva.', 'A teljes szezon helyezéseloszlásának kalibráltsága nincs ettől igazolva. A november 6-i adatfrissítéshez mind a hat modell újraillesztést kapott; ez a régi ellenőrző jelentés nem a friss modellek prediktív validálása.');
fs.writeFileSync(htmlPath, html);
console.log('Built index.html: ' + Buffer.byteLength(html).toLocaleString('en-US') + ' bytes');
