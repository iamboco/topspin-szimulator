#!/usr/bin/env node
// Regenerate real Monte Carlo season snapshots. No projection is relabeled or
// patched from a different dataset/model, and requested n is never downsampled.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIM = require(path.join(root, 'src', 'engine.js'));
const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const inputPath = path.resolve(value('--data', path.join(root, 'index.html')));
const outputPath = path.resolve(value('--out', path.join(root, 'app-data.generated.json')));
const input = fs.readFileSync(inputPath, 'utf8');
const app = input.trim().startsWith('<') ? JSON.parse(input.match(/<script type="application\/json" id="app-data">([\s\S]*?)<\/script>/)[1]) : JSON.parse(input);
const n = Number(value('--n', '100000'));
const seed = Number(value('--seed', String(app.meta.seed)));
if (app.meta.seed !== seed) app.meta.data_update_default_seed = app.meta.seed;
app.meta.seed = seed;
app.meta.precomputed_seed = seed;
const ids = value('--model', '') ? [value('--model')] : Object.keys(app.models);
for (const modelId of ids) {
  if (!app.models[modelId]) throw new Error('Unknown model: ' + modelId);
  const start = Date.now(); let last = 0;
  const result = await SIM.run(app, {modelId, n, seed, horizon: 18, formMultiplier: 1, overrides: {},
    onProgress(fraction) {
      if (fraction - last >= .1 || fraction === 1) { last = fraction; console.log(modelId, Math.round(fraction * 100) + '%'); }
    }});
  result.generated_at = new Date().toISOString();
  result.data_revision = app.meta.data_revision;
  app.precomputed ||= {};
  app.precomputed[modelId] = result;
  fs.writeFileSync(outputPath, JSON.stringify(app));
  console.log('Completed', modelId, n, 'seasons in', ((Date.now() - start) / 1000).toFixed(2) + 's');
}
app.notes = (app.notes || []).map(note => note.replace('régebbi 3:x eredményekhez szettpontszám nincs.', 'régebbi 3:x eredmények többségéhez szettpontszám nincs. A friss történeti gyűjtésben 4 játék 15 valódi szettpontsora elérhető.'));
app.meta.precomputed_utc = new Date().toISOString();
const complete = Object.keys(app.models).every(id => app.precomputed[id]?.data_revision === app.meta.data_revision && app.precomputed[id]?.n === n);
app.meta.precomputed_status = complete ? 'complete: all six model snapshots regenerated from the current dataset' : 'partial: only requested model snapshots were regenerated';
app.meta.precomputed_samples_per_model = n;
fs.writeFileSync(outputPath, JSON.stringify(app));
console.log('Saved', outputPath);
