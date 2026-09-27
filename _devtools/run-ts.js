'use strict';
// Runs a TypeScript file under plain Node with type-stripping done by the project's own TypeScript (transpile-only, CommonJS).
// usage: node _devtools/run-ts.js <file.ts> [args...]   (sets NODE_PATH so `require('vscode')` finds _devtools/stubs/vscode)
const path = require('path');
const fs = require('fs');
const Module = require('module');
process.env.NODE_PATH = [path.join(__dirname, 'stubs'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));
require.extensions['.ts'] = function (module, filename) {
  const src = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(src, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, sourceMap: false, inlineSourceMap: true } });
  module._compile(out.outputText, filename);
};
const file = path.resolve(process.argv[2]);
process.argv.splice(1, 2, file, ...process.argv.slice(3));
require(file);
