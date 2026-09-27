// ============================================================================
// 0.15.0: MLX local model library scan + portable repo-id resolution (src/llm/mlxModels.ts).
// ============================================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listLocalMlxModels,
  resolveModelLibraryPath,
  resolveModelPath,
  formatModelNotFoundMessage,
  expandTilde,
  isMlxModelDir,
} from '../../src/llm/mlxModels';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}

const QMLX = JSON.stringify({ quantization: { bits: 4, group_size: 64 } });
const PT = JSON.stringify({ architectures: ['BertModel'] });
const BAD = '{not json';

function writeModel(dir: string, config: string, bytes = 8) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), config);
  const f = path.join(dir, 'weights.safetensors');
  fs.writeFileSync(f, 'x');
  if (bytes > 1) fs.truncateSync(f, bytes);
}

function hfRepo(lib: string, org: string, name: string) {
  return path.join(lib, `models--${org}--${name}`);
}

function main() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mlx-lib-'));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mlx-extra-'));

  // HF cache: quantized MLX model
  const qRepo = hfRepo(lib, 'acme', 'coder-mlx-7b');
  const qSnap = path.join(qRepo, 'snapshots', 'aaa111');
  writeModel(qSnap, QMLX, 100);

  // non-MLX (plain HF)
  const ptRepo = hfRepo(lib, 'acme', 'bert-base');
  writeModel(path.join(ptRepo, 'snapshots', 'bbb'), PT, 50);

  // mlx-community without quantization object
  const mcRepo = hfRepo(lib, 'mlx-community', 'Some-Model');
  writeModel(path.join(mcRepo, 'snapshots', 'ccc'), '{}', 30);

  // malformed config — skipped
  const badRepo = hfRepo(lib, 'acme', 'broken-weights');
  writeModel(path.join(badRepo, 'snapshots', 'ddd'), BAD, 10);

  // refs/main points at older snapshot; newer mtime on other snapshot
  const refRepo = hfRepo(lib, 'acme', 'ref-main-mlx');
  const oldSnap = path.join(refRepo, 'snapshots', 'hashfromref');
  const newSnap = path.join(refRepo, 'snapshots', 'newermtime');
  writeModel(oldSnap, QMLX, 20);
  writeModel(newSnap, QMLX, 40);
  fs.mkdirSync(path.join(refRepo, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(refRepo, 'refs', 'main'), 'hashfromref');
  fs.utimesSync(newSnap, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

  // two snapshots, no refs — pick newest by mtime
  const twoRepo = hfRepo(lib, 'acme', 'two-snaps-mlx');
  const s1 = path.join(twoRepo, 'snapshots', 'snap1');
  const s2 = path.join(twoRepo, 'snapshots', 'snap2');
  writeModel(s1, QMLX, 11);
  writeModel(s2, QMLX, 22);
  fs.utimesSync(s2, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));

  // plain folder model under library (depth 1)
  const plain = path.join(lib, 'my-local-mlx');
  writeModel(plain, QMLX, 77);

  // extra folder plain model
  const extraModel = path.join(extra, 'LM-Studio-mlx');
  writeModel(extraModel, QMLX, 55);

  const listed = listLocalMlxModels(lib, [extra]);
  const ids = listed.map((m) => m.id);
  ok(ids.includes('acme/coder-mlx-7b') && !ids.includes('acme/bert-base'), 'lists MLX HF-cache repos and excludes plain PyTorch configs');
  ok(ids.includes('mlx-community/Some-Model'), 'mlx-community entries are included without a quantization block');
  ok(!ids.some((id) => id.includes('broken-weights')), 'malformed config.json entries are skipped');
  ok(listed.find((m) => m.id === 'acme/ref-main-mlx')?.dir === path.resolve(oldSnap), 'refs/main snapshot wins over a newer mtime');
  ok(listed.find((m) => m.id === 'acme/two-snaps-mlx')?.dir === path.resolve(s2), 'without refs/main, the newest snapshot by mtime is used');
  ok(ids.includes(path.resolve(plain)) && listed.find((m) => m.dir === path.resolve(plain))?.source === 'library', 'plain folder under the library is listed with absolute-path id');
  ok(ids.includes(path.resolve(extraModel)) && listed.find((m) => m.dir === path.resolve(extraModel))?.source === 'extra', 'extra folder models are listed');
  ok(listed.every((m, i, a) => i === 0 || a[i - 1].id <= m.id), 'results are sorted by id');
  ok(new Set(listed.map((m) => m.dir)).size === listed.length, 'de-duplicated by resolved dir');

  const missingLib = path.join(os.tmpdir(), 'forge-no-such-lib-' + Date.now());
  ok(listLocalMlxModels(missingLib, [missingLib]).length === 0, 'missing folders yield an empty list, never throw');

  const tildeLib = path.join(os.homedir(), '.forge-test-mlx-lib-' + Date.now());
  fs.mkdirSync(tildeLib, { recursive: true });
  writeModel(path.join(tildeLib, 'tilde-model'), QMLX, 9);
  const tildeListed = listLocalMlxModels('~' + tildeLib.slice(os.homedir().length), []);
  ok(tildeListed.some((m) => m.dir === path.resolve(path.join(tildeLib, 'tilde-model'))), '"~" in library path is expanded');
  fs.rmSync(tildeLib, { recursive: true, force: true });

  const prevHub = process.env.HF_HUB_CACHE;
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hf-hub-env-'));
  process.env.HF_HUB_CACHE = envDir;
  ok(resolveModelLibraryPath('') === envDir, 'empty setting uses $HF_HUB_CACHE');
  if (prevHub === undefined) delete process.env.HF_HUB_CACHE;
  else process.env.HF_HUB_CACHE = prevHub;
  fs.rmSync(envDir, { recursive: true, force: true });

  ok(expandTilde('~/foo') === path.join(os.homedir(), 'foo'), 'expandTilde works');

  ok(resolveModelPath('acme/coder-mlx-7b', lib) === path.resolve(qSnap), 'resolveModelPath finds a repo id in the library');
  const extraRepoName = 'Ornith-1.5-9B-MLX-4bit';
  const extraSnap = path.join(extra, 'nested', extraRepoName);
  writeModel(extraSnap, QMLX, 33);
  ok(
    resolveModelPath(`ornith-ai/${extraRepoName}`, { libraryPath: lib, extraFolders: [extra] }) === path.resolve(extraSnap),
    'resolveModelPath finds a repo id by folder name in an extra folder'
  );

  const listedFinal = listLocalMlxModels(lib, [extra]);
  let msg = '';
  try {
    resolveModelPath('acme/missing-mlx', { libraryPath: lib, extraFolders: [extra] });
  } catch (e: any) {
    msg = e.message;
  }
  const expected = formatModelNotFoundMessage('acme/missing-mlx', lib, [extra], listedFinal);
  ok(msg === expected, 'missing-model error matches formatModelNotFoundMessage');
  ok(/acme\/missing-mlx/.test(msg) && /Searched:/.test(msg) && /Forge: Select Chat Model/.test(msg), 'missing-model message names the model, folders, and fix');
  ok(listedFinal.some((m) => msg.includes(m.id)), 'missing-model message lists found model ids');

  ok(isMlxModelDir(qSnap, 'acme', 'coder-mlx-7b'), 'isMlxModelDir accepts quantized MLX config');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('Some v0.15.0 MLX model library tests FAILED.');
    process.exit(1);
  }
  console.log('All v0.15.0 MLX model library tests passed.');
}

main();
