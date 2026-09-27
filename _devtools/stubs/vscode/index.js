'use strict';
// Minimal, DEV-ONLY stand-in for the `vscode` module so Forge's unit/runtime tests can run under plain Node.
// Not shipped. Backed by the real filesystem. Extend only as tests need it; anything unimplemented is a harmless no-op.
const fs = require('fs');
const path = require('path');

class Disposable { constructor(fn) { this._fn = fn; } dispose() { try { this._fn && this._fn(); } catch (_) {} } static from(...ds) { return new Disposable(() => ds.forEach((d) => d && d.dispose && d.dispose())); } }

class EventEmitter {
  constructor() { this._ls = new Set(); this.event = (l, thisArg, disposables) => { const fn = thisArg ? l.bind(thisArg) : l; this._ls.add(fn); const d = new Disposable(() => this._ls.delete(fn)); if (disposables) disposables.push(d); return d; }; }
  fire(e) { for (const l of [...this._ls]) { try { l(e); } catch (_) {} } }
  dispose() { this._ls.clear(); }
}

class Uri {
  constructor(scheme, fsPath) { this.scheme = scheme; this.fsPath = fsPath; this.path = fsPath; }
  static file(p) { return new Uri('file', path.resolve(p)); }
  static parse(v) { return v.startsWith('file://') ? Uri.file(decodeURIComponent(v.slice(7))) : new Uri('untitled', v); }
  static joinPath(base, ...parts) { return Uri.file(path.join(base.fsPath, ...parts)); }
  with(change) { return new Uri(change.scheme || this.scheme, change.path || this.fsPath); }
  toString() { return this.scheme + '://' + this.fsPath; }
  toJSON() { return { scheme: this.scheme, fsPath: this.fsPath, path: this.path }; }
}

class CancellationTokenSource {
  constructor() { this._em = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: this._em.event }; }
  cancel() { if (!this.token.isCancellationRequested) { this.token.isCancellationRequested = true; this._em.fire(undefined); } }
  dispose() { this._em.dispose(); }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
class FileSystemError extends Error { constructor(m) { super(m); this.code = 'FileNotFound'; } static FileNotFound(m) { return new FileSystemError(String(m)); } }
const toPath = (u) => (typeof u === 'string' ? u : u.fsPath);

const workspaceFs = {
  async readFile(u) { try { return new Uint8Array(fs.readFileSync(toPath(u))); } catch (e) { throw FileSystemError.FileNotFound(e.message); } },
  async writeFile(u, bytes) { fs.mkdirSync(path.dirname(toPath(u)), { recursive: true }); fs.writeFileSync(toPath(u), Buffer.from(bytes)); },
  async createDirectory(u) { fs.mkdirSync(toPath(u), { recursive: true }); },
  async readDirectory(u) { try { return fs.readdirSync(toPath(u), { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? FileType.Directory : d.isSymbolicLink() ? FileType.SymbolicLink : FileType.File]); } catch (e) { throw FileSystemError.FileNotFound(e.message); } },
  async stat(u) { try { const s = fs.statSync(toPath(u)); return { type: s.isDirectory() ? FileType.Directory : FileType.File, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }; } catch (e) { throw FileSystemError.FileNotFound(e.message); } },
  async delete(u, opts) { fs.rmSync(toPath(u), { recursive: !!(opts && opts.recursive), force: true }); },
  async rename(a, b) { fs.mkdirSync(path.dirname(toPath(b)), { recursive: true }); fs.renameSync(toPath(a), toPath(b)); },
  async copy(a, b) { fs.mkdirSync(path.dirname(toPath(b)), { recursive: true }); fs.cpSync(toPath(a), toPath(b), { recursive: true }); },
};

// crude glob -> regexp, enough for '**/*', '**/{a,b}/**', 'src/**/*.ts'
function globToRegExp(glob) {
  let re = '', i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { i += 2; if (glob[i] === '/') { re += '(?:.*/)?'; i++; } else re += '.*'; continue; } re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$');
}
function walk(dir, out) { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, d.name); if (d.isDirectory()) walk(p, out); else out.push(p); } }

const _folders = [];
const _config = {};
const workspace = {
  fs: workspaceFs,
  get workspaceFolders() { return _folders.length ? _folders : undefined; },
  __setWorkspaceRoot(p) { _folders.length = 0; if (p) _folders.push({ uri: Uri.file(p), name: path.basename(p), index: 0 }); },
  getConfiguration(section) {
    const full = (k) => (section ? section + '.' + k : k);
    return { get: (k, dflt) => (Object.prototype.hasOwnProperty.call(_config, full(k)) ? _config[full(k)] : dflt), has: (k) => Object.prototype.hasOwnProperty.call(_config, full(k)),
      update: async (k, v) => { _config[full(k)] = v; }, inspect: () => undefined };
  },
  __setConfig(obj) { Object.assign(_config, obj); },
  __resetConfig() { for (const k of Object.keys(_config)) delete _config[k]; },
  onDidChangeConfiguration: new EventEmitter().event,
  onDidChangeTextDocument: new EventEmitter().event,
  onDidSaveTextDocument: new EventEmitter().event,
  onDidChangeWorkspaceFolders: new EventEmitter().event,
  textDocuments: [],
  isTrusted: true,
  async openTextDocument(u) { return { uri: u, getText: () => fs.readFileSync(toPath(u), 'utf8') }; },
  async findFiles(include, exclude, maxResults) {
    const root = _folders[0] && _folders[0].uri.fsPath; if (!root) return [];
    const all = []; walk(root, all);
    const inc = globToRegExp(String(include)), exc = exclude ? globToRegExp(String(exclude)) : null;
    const res = [];
    for (const p of all) { const rel = path.relative(root, p).split(path.sep).join('/'); if (inc.test(rel) && !(exc && exc.test(rel))) { res.push(Uri.file(p)); if (maxResults && res.length >= maxResults) break; } }
    return res;
  },
  asRelativePath(u) { const root = _folders[0] && _folders[0].uri.fsPath; const p = toPath(u); return root ? path.relative(root, p).split(path.sep).join('/') : p; },
  createFileSystemWatcher() { return { onDidChange: new EventEmitter().event, onDidCreate: new EventEmitter().event, onDidDelete: new EventEmitter().event, dispose() {} }; },
};

const noop = () => {};
const window = {
  createOutputChannel() { return { appendLine: noop, append: noop, show: noop, dispose: noop, clear: noop }; },
  createWebviewPanel() { const em = new EventEmitter(), disp = new EventEmitter(); return { webview: { html: '', postMessage: async () => true, onDidReceiveMessage: em.event, asWebviewUri: (u) => u, cspSource: '' }, onDidDispose: disp.event, reveal: noop, dispose: () => disp.fire(undefined), visible: true }; },
  showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined, showInputBox: async () => undefined, withProgress: async (_o, task) => task({ report: noop }),
  createStatusBarItem() { return { text: '', tooltip: '', show: noop, hide: noop, dispose: noop }; },
  createTerminal() { return { show: noop, sendText: noop, dispose: noop }; },
  tabGroups: { all: [], onDidChangeTabs: new EventEmitter().event },
  activeTextEditor: undefined, visibleTextEditors: [],
  onDidChangeActiveTextEditor: new EventEmitter().event,
  registerWebviewViewProvider: () => new Disposable(noop),
};

const commands = { registerCommand: () => new Disposable(noop), executeCommand: async () => undefined };
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b, c, d) { if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } } }
class Selection extends Range {}
class ThemeColor { constructor(id) { this.id = id; } }
class WorkspaceEdit { constructor() { this.edits = []; } }
class TabInputText { constructor(uri) { this.uri = uri; } }

module.exports = {
  __setConfig: (o) => workspace.__setConfig(o), __resetConfig: () => workspace.__resetConfig(),
  Disposable, EventEmitter, Uri, CancellationTokenSource, FileType, FileSystemError, workspace, window, commands,
  Position, Range, Selection, ThemeColor, WorkspaceEdit, TabInputText,
  ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 }, StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  env: { clipboard: { writeText: async () => {}, readText: async () => '' }, openExternal: async () => true, appName: 'stub', machineId: 'stub' },
  extensions: { getExtension: () => undefined }, languages: { getDiagnostics: () => [], registerInlineCompletionItemProvider: () => new Disposable(noop) },
  version: '1.85.0-stub',
};
