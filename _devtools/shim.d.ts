/**
 * DEV-ONLY type shim used solely inside the sandboxed build environment where
 * registry.npmjs.org is not reachable, so real @types/vscode / @types/node
 * cannot be installed. This file is NOT shipped in the extension source zip
 * and is NOT referenced by the real tsconfig.json used for the actual build.
 *
 * It exists purely so `tsc` can structurally check this project's own code
 * (cross-file calls, control flow, own interfaces) while modeling just enough
 * of the `vscode` namespace and Node built-ins to compile — most members are
 * intentionally `any`. On a normal machine with network access, `npm install`
 * pulls the real, fully-typed declarations and this file is irrelevant.
 */

declare module 'vscode' {
  export type Thenable<T> = Promise<T>;
  export type Disposable = { dispose(): any };
  export type Event<T> = (listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]) => Disposable;

  export class EventEmitter<T> {
    event: Event<T>;
    fire(data: T): void;
    dispose(): void;
  }

  export class Uri {
    static file(path: string): Uri;
    static parse(value: string): Uri;
    static joinPath(base: Uri, ...paths: string[]): Uri;
    fsPath: string;
    path: string;
    scheme: string;
    [key: string]: any;
  }
  export class Position { constructor(line: number, character: number); line: number; character: number; [key: string]: any }
  export class Range { constructor(...args: any[]); start: Position; end: Position; [key: string]: any }
  export class Selection extends Range { constructor(...args: any[]); active: Position; anchor: Position }
  export class ThemeColor { constructor(id: string) }
  export class CancellationTokenSource { token: CancellationToken; cancel(): void; dispose(): void }
  export class InlineCompletionItem { constructor(text: string, range?: Range); }

  export type CancellationToken = { isCancellationRequested: boolean; onCancellationRequested: Event<any> };
  export type TextDocument = any;
  export type TextEditor = any;
  export type TextLine = any;
  export type Webview = any;
  export type WebviewView = any;
  export type WebviewViewProvider = any;
  export type WebviewViewResolveContext = any;
  export type WebviewOptions = any;
  export type OutputChannel = any;
  export type StatusBarItem = any;
  export type WorkspaceEdit = any;
  export type TextEditorDecorationType = any;
  export type Diagnostic = any;
  export type FileType = any;
  export type InlineCompletionContext = any;
  export type InlineCompletionItemProvider = any;
  export type InlineCompletionList = any;
  export type TextDocumentContentProvider = any;
  export type QuickPickItem = any;
  export type ProgressLocation = any;
  export type ConfigurationTarget = any;
  export type StatusBarAlignment = any;
  export type DecorationOptions = any;
  export type DecorationRenderOptions = any;
  export type ViewColumn = any;
  export type WorkspaceFolder = any;
  export type FileSystemWatcher = any;

  export type Memento = {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: any): Thenable<void>;
  };

  export type WorkspaceConfiguration = {
    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
    update(section: string, value: any, target?: any): Thenable<void>;
    [key: string]: any;
  };

  export type SecretStorage = {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
    onDidChange: Event<{ key: string }>;
  };

  export type ExtensionContext = {
    subscriptions: Disposable[];
    extensionUri: Uri;
    extensionPath: string;
    storageUri: Uri | undefined;
    globalStorageUri: Uri;
    workspaceState: Memento;
    globalState: Memento;
    secrets: SecretStorage;
    [key: string]: any;
  };

  export const window: {
    createStatusBarItem(...args: any[]): any;
    createOutputChannel(name: string): any;
    createTextEditorDecorationType(opts: any): any;
    withProgress<T>(options: any, task: (progress: any, token: CancellationToken) => Thenable<T>): Thenable<T>;
    registerWebviewViewProvider(...args: any[]): Disposable;
    [key: string]: any;
  };
  export const workspace: {
    getConfiguration(section?: string): WorkspaceConfiguration;
    findFiles(...args: any[]): Thenable<Uri[]>;
    fs: any;
    [key: string]: any;
  };
  export const commands: { registerCommand(...args: any[]): Disposable; executeCommand(...args: any[]): Thenable<any>; [key: string]: any };
  export const languages: { [key: string]: any };
  export const env: { [key: string]: any };
  export const extensions: { [key: string]: any };
  export const StatusBarAlignment: any;
  export const ProgressLocation: any;
  export const ConfigurationTarget: any;
  export const FileType: any;
  export const ViewColumn: any;
  export const OverviewRulerLane: any;
}

declare module 'fs' { const m: any; export = m; }
declare module 'fs/promises' { const m: any; export = m; }
declare module 'path' { const m: any; export = m; }
declare module 'child_process' {
  export function spawn(command: string, options?: any): any;
  export function exec(command: string, callback?: any): any;
  export function execFile(command: string, args?: any, options?: any, callback?: any): any;
  const m: any;
  export default m;
}
declare module 'crypto' { const m: any; export = m; }
declare module 'os' { const m: any; export = m; }
declare module 'url' { const m: any; export = m; }
declare module 'http' { const m: any; export = m; }
declare module 'https' { const m: any; export = m; }
declare module 'stream' { const m: any; export = m; }
declare module 'readline' { const m: any; export = m; }

type Buffer = any;
type Response = any;
type AbortSignal = any;
type ReadableStream<T = any> = any;

declare var process: any;
declare var require: any;
declare var module: any;
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var console: any;
declare var Buffer: any;
declare var fetch: any;
declare var AbortController: any;
declare var setTimeout: any;
declare var clearTimeout: any;
declare var setInterval: any;
declare var clearInterval: any;
// Real declarations (not `declare var URL: any`) since websearch/*.ts uses
// `new URL(...)` both as a value (constructor) and as a type annotation
// (`let u: URL`) — a `var`-only declaration only covers the value position.
declare class URLSearchParams {
  constructor(init?: any);
  get(name: string): string | null;
  set(name: string, value: string): void;
  toString(): string;
}
declare class URL {
  constructor(input: string, base?: string | URL);
  href: string;
  origin: string;
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
  searchParams: URLSearchParams;
  toString(): string;
}
declare var TextEncoder: any;
declare var TextDecoder: any;
declare var global: any;
