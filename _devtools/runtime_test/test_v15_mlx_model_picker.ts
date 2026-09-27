// ============================================================================
// MLX model QuickPick helpers (src/llm/mlxModelPicker.ts).
// ============================================================================
import * as path from 'path';
import {
  buildMlxModelQuickPickItems,
  formatMlxModelSize,
  mlxModelMatchesSetting,
  MlxModelQuickPickItem,
} from '../../src/llm/mlxModelPicker';
import { MlxLocalModel } from '../../src/llm/mlxModels';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}

function main() {
  const model: MlxLocalModel = {
    id: 'acme/coder-mlx-7b',
    dir: '/cache/hub/snapshots/abc',
    sizeBytes: 2 * 1024 ** 3,
    source: 'library',
  };

  ok(mlxModelMatchesSetting(model, 'acme/coder-mlx-7b'), 'current by repo id');
  ok(mlxModelMatchesSetting(model, '/cache/hub/snapshots/abc'), 'current by legacy absolute snapshot path');
  ok(!mlxModelMatchesSetting(model, 'other/model'), 'not current for unrelated id');

  const size = formatMlxModelSize(model.sizeBytes);
  ok(size === '2.0 GB', 'human size in GB');

  const items = buildMlxModelQuickPickItems([model], 'acme/coder-mlx-7b');
  ok(items.length === 3, 'model row + two action rows');
  const row = items[0];
  ok(row.label === 'acme/coder-mlx-7b' && row.description === '2.0 GB (current)' && row.action === 'model', 'marks current by id with size');
  ok(items[1].action === 'addFolder' && items[1].label.includes('Add a model folder'), 'add-folder item present');
  ok(items[2].action === 'changeLibrary' && items[2].label.includes('Change model library'), 'change-library item present');

  const byPath = buildMlxModelQuickPickItems([model], '/cache/hub/snapshots/abc');
  ok(byPath[0].description === '2.0 GB (current)', 'marks current when setting is old absolute path');

  const empty = buildMlxModelQuickPickItems([], '');
  ok(empty.length === 2 && empty.every((i: MlxModelQuickPickItem) => i.action !== 'model'), 'no-models still offers folder + library actions');

  const mb = formatMlxModelSize(50 * 1024 ** 2);
  ok(mb.endsWith(' MB'), 'sub-GB sizes in MB');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
