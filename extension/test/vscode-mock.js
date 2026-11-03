// A small stand-in for the `vscode` module, enough to run extension.js outside VS Code in tests.
// Files are real files on disk; dialogs answer through `mock.answers`; everything shown is recorded in `mock.log`.
const fs = require('fs');
const path = require('path');

class Uri {
  constructor(scheme, p, query = '') { this.scheme = scheme; this.path = p; this.query = query; }
  get fsPath() { return this.path; }
  toString() { if (this.raw) return this.raw; return this.scheme === 'file' ? 'file://' + encodeURI(this.path) : `${this.scheme}:${this.path}${this.query ? '?' + this.query : ''}`; }
  static file(p) { return new Uri('file', path.resolve(p)); }
  static parse(s) {
    if (s.startsWith('file://')) return new Uri('file', decodeURI(s.slice(7)));
    const m = String(s).match(/^([\w+.-]+):(?:\/\/)?([^?]*)(?:\?(.*))?$/);
    const u = new Uri(m[1], m[2], m[3] || '');
    if (/^[\w+.-]+:\/\//.test(s)) u.raw = String(s);
    return u;
  }
  static joinPath(u, ...parts) { return new Uri(u.scheme, path.posix.join(u.path, ...parts), u.query); }
  static from(o) { return new Uri(o.scheme, o.path || '', o.query || ''); }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class WorkspaceEdit { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, range, text }); } }
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class RelativePattern { constructor(base, pattern) { this.base = typeof base === 'string' ? Uri.file(base) : base; this.pattern = pattern; } }
class TabInputTextDiff {}

class Doc {
  constructor(uri, text) { this.uri = uri; this._text = text; this.isDirty = false; this.languageId = path.extname(uri.path).slice(1) || 'plaintext'; }
  getText(range) { return range ? this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this._text; }
  get lineCount() { return this._text.split('\n').length; }
  lineAt(i) { return { text: this._text.split(/\r?\n/)[i] ?? '' }; }
  offsetAt(pos) { const lines = this._text.split('\n'); let o = 0; for (let i = 0; i < pos.line; i++) o += lines[i].length + 1; return o + pos.character; }
  positionAt(off) { const lines = this._text.slice(0, off).split('\n'); return new Position(lines.length - 1, lines[lines.length - 1].length); }
  async save() { fs.writeFileSync(this.uri.fsPath, this._text); this.isDirty = false; return true; }
}

function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.storage', '.trash-bin']);

function create(root) {
  const docs = [];
  const diagnostics = new Map(); // fsPath -> [diagnostic]
  const commands = new Map();
  const providers = {};
  const config = { aiBridge: {}, claudeBridge: {} }; // settings by section
  const defaults = { serverUrl: '', windowName: '', autoApproveCommands: ['git status'], idleMinutes: 20 };
  const log = { info: [], warn: [], error: [], executed: [], shown: [], status: [], opened: [], trashed: [], untitled: [] };
  const trashDir = path.join(root, '.trash-bin');
  const answers = { info: () => undefined, warn: () => undefined, input: () => undefined, pick: () => undefined, open: () => undefined };
  const listeners = { termStart: [], termEnd: [] };
  const clipboard = { text: '' };
  const root$ = Uri.file(root);
  const findDoc = (uri) => docs.find((d) => d.uri.toString() === uri.toString());
  const statOf = (p) => { try { return fs.statSync(p); } catch { const e = new Error('FileNotFound: ' + p); e.code = 'FileNotFound'; throw e; } };

  const vscode = {
    Uri, Position, Range, WorkspaceEdit, CodeAction, RelativePattern, TabInputTextDiff,
    CodeActionKind: { QuickFix: 'quickfix' },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1 },
    FileType: { File: 1, Directory: 2 },
    workspace: {
      name: path.basename(root),
      workspaceFolders: [{ uri: root$, name: path.basename(root), index: 0 }],
      get textDocuments() { return docs; },
      getConfiguration: (section) => {
        const sec = (config[section] = config[section] || {});
        return {
          get: (k, d) => (sec[k] !== undefined ? sec[k] : defaults[k] !== undefined ? defaults[k] : d),
          update: async (k, v) => { sec[k] = v; },
          inspect: (k) => ({ key: section + '.' + k, defaultValue: defaults[k], globalValue: sec[k] }),
        };
      },
      registerTextDocumentContentProvider: (scheme, p) => { providers[scheme] = p; return { dispose() {} }; },
      asRelativePath: (u) => path.relative(root, u.fsPath).split(path.sep).join('/'),
      async openTextDocument(uri) {
        if (uri && !(uri instanceof Uri) && typeof uri.content === 'string') { const d = new Doc(new Uri('untitled', '/Untitled-' + (docs.length + 1)), uri.content); docs.push(d); log.untitled.push(uri.content); return d; }
        let d = findDoc(uri);
        if (!d) { d = new Doc(uri, fs.readFileSync(uri.fsPath, 'utf8')); docs.push(d); }
        return d;
      },
      async applyEdit(we) {
        for (const op of we.ops) {
          const d = await vscode.workspace.openTextDocument(op.uri);
          d._text = d._text.slice(0, d.offsetAt(op.range.start)) + op.text + d._text.slice(d.offsetAt(op.range.end));
          d.isDirty = true;
        }
        return true;
      },
      async findFiles(glob, exclude, max = 1e9) {
        let base = root; let pattern = glob;
        if (glob instanceof RelativePattern) { base = glob.base.fsPath; pattern = glob.pattern; }
        const re = globRe(pattern);
        const out = [];
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (re.test(path.relative(base, full).split(path.sep).join('/'))) out.push(Uri.file(full));
          }
        };
        walk(base);
        return out.slice(0, max);
      },
      fs: {
        async readFile(uri) { return new Uint8Array(fs.readFileSync(uri.fsPath)); },
        async writeFile(uri, bytes) {
          fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
          const d = findDoc(uri);
          if (d && !d.isDirty) d._text = Buffer.from(bytes).toString('utf8');
        },
        async stat(uri) { const s = statOf(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
        async readDirectory(uri) { return fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? 2 : 1]); },
        async createDirectory(uri) { fs.mkdirSync(uri.fsPath, { recursive: true }); },
        async rename(src, dst, o = {}) {
          statOf(src.fsPath);
          if (!o.overwrite && fs.existsSync(dst.fsPath)) { const e = new Error('FileExists: ' + dst.fsPath); e.code = 'FileExists'; throw e; }
          fs.renameSync(src.fsPath, dst.fsPath);
        },
        async delete(uri, o = {}) {
          statOf(uri.fsPath);
          if (o.useTrash) { const bin = path.join(trashDir, Date.now() + '-' + path.basename(uri.fsPath)); fs.mkdirSync(trashDir, { recursive: true }); fs.renameSync(uri.fsPath, bin); log.trashed.push(uri.fsPath); return; }
          fs.rmSync(uri.fsPath, { recursive: !!o.recursive || true, force: true });
        },
      },
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      tabGroups: { all: [], close() {} },
      showInformationMessage: async (msg, ...items) => { log.info.push(msg); return answers.info(msg, items); },
      showWarningMessage: async (msg, ...rest) => { const items = rest.filter((x) => typeof x === 'string'); log.warn.push(msg); return answers.warn(msg, items, rest.find((x) => typeof x === 'object')); },
      showErrorMessage: async (msg) => { log.error.push(msg); },
      showInputBox: async (o) => answers.input(o),
      showQuickPick: async (items, o) => answers.pick(items, o),
      showOpenDialog: async (o) => answers.open(o),
      showTextDocument: async (d) => { log.shown.push(d.uri ? d.uri.fsPath : String(d)); },
      setStatusBarMessage: (m) => { log.status.push(m); return { dispose() {} }; },
      createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, dispose() {} }),
      registerWebviewViewProvider: (id, p) => { providers.view = p; return { dispose() {} }; },
      onDidStartTerminalShellExecution: (fn) => { listeners.termStart.push(fn); return { dispose() {} }; },
      onDidEndTerminalShellExecution: (fn) => { listeners.termEnd.push(fn); return { dispose() {} }; },
    },
    languages: {
      getDiagnostics: (uri) => (uri ? diagnostics.get(uri.fsPath) || [] : [...diagnostics.entries()].map(([p, d]) => [Uri.file(p), d])),
      registerCodeActionsProvider: (sel, p) => { providers.codeActions = p; return { dispose() {} }; },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...args) => { log.executed.push({ id, args }); const fn = commands.get(id); return fn ? fn(...args) : undefined; },
    },
    env: {
      clipboard: { writeText: async (t) => { clipboard.text = t; }, readText: async () => clipboard.text },
      openExternal: async (u) => { log.opened.push(u.toString()); return true; },
    },
    extensions: { getExtension: () => undefined },
  };

  function memento() { const m = new Map(); return { get: (k, d) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()] }; }
  const secrets = new Map();
  const context = {
    subscriptions: [],
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); } },
    workspaceState: memento(),
    globalState: memento(),
    extensionUri: Uri.file(path.join(__dirname, '..')),
    storageUri: Uri.file(path.join(root, '.storage')),
    globalStorageUri: Uri.file(path.join(root, '.storage-global')),
  };

  // a fake webview: records what the extension posts, lets the test click like the panel does
  const view = {
    states: [],
    webview: {
      options: {}, html: '', cspSource: 'vscode-resource:',
      asWebviewUri: (u) => u,
      postMessage: (m) => { if (m.type === 'state') view.states.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (fn) => { view.send = fn; return { dispose() {} }; },
    },
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    get state() { return view.states[view.states.length - 1]; },
  };

  return { vscode, context, view, providers, diagnostics, commands, config, log, answers, listeners, clipboard, secrets, docs };
}

module.exports = { create, Uri };
