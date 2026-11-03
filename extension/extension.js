// AI Bridge — VS Code extension
// Talks only to the user's own VS Code Bridge server (HTTPS out). No API keys.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TOKEN_KEY = 'aiBridge.token';
const OLD_TOKEN_KEY = 'claudeBridge.token';
const EXCLUDE = '**/{node_modules,.git,.svn,.venv,venv,env,__pycache__,.mypy_cache,.pytest_cache,.ruff_cache,dist,build,out,.idea,.ipynb_checkpoints,.Rproj.user}/**';
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.venv', 'venv', '__pycache__']);
const BRIDGE_DIR = '.ai-bridge';
const VIEW = 'workbench.view.extension.aiBridge';
const MAX_ATTACH_TOTAL = 150000; // characters of attached files per request
const MAX_ATTACH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const KEEP_CHECKPOINTS = 30;
const DIR = 2; // vscode.FileType.Directory

let ctxExt;
let token = '';
let running = true;
let conn = 'unconfigured'; // unconfigured | online | offline
let connError = '';
let listening = false;
let lastActivity = Date.now();
let messages = []; // {id, role, text, requestId, state, ...}
let panel; // ChatViewProvider
let statusItem;
let msgSeq = 0;
let clientId = '';
let windowsOnline = 1;
let agentMode = false;
let handoffPending = false;
let checkpoints = []; // [{id, requestId, files: [relPath], uris: [uri], ops, reverted, at}]
let attachments = []; // [{id, kind: 'file'|'folder', label, uri?, text?}]
let attSeq = 0;
let session = null; // the panel conversation in progress: {id, startedAt, url}
let history = []; // archived conversations: [{id, title, startedAt, endedAt, url, count}]
let uiMode = 'chat'; // chat | history | view
let viewing = null; // archived conversation shown read-only
const proposals = new Map(); // editId -> change set {editId, files, desc, status, requestId, cpId}
const opSets = new Map(); // opsId -> file operations {opsId, ops, desc, status, requestId, cpId}
const cpCache = new Map(); // checkpoint id -> {files: {uri: {existed, content}}, ops: [...]}
const seenJobs = new Set();
const termLog = []; // recent commands run in the integrated terminal

// ---------------- activation ----------------
async function activate(context) {
  ctxExt = context;
  token = (await context.secrets.get(TOKEN_KEY)) || '';
  if (!token) {
    // the token saved by earlier versions
    token = (await context.secrets.get(OLD_TOKEN_KEY)) || '';
    if (token) await context.secrets.store(TOKEN_KEY, token);
  }
  await migrateSettings();
  const hasWorkspace = !!(vscode.workspace.workspaceFolders || vscode.workspace.workspaceFile);
  clientId = hasWorkspace ? context.workspaceState.get('claudeBridge.clientId') : '';
  if (!clientId) {
    clientId = Math.random().toString(36).slice(2, 10);
    if (hasWorkspace) context.workspaceState.update('claudeBridge.clientId', clientId);
  }
  agentMode = !!context.workspaceState.get('claudeBridge.agent', false);
  handoffPending = !!context.workspaceState.get('claudeBridge.handoffPending', false);
  checkpoints = context.workspaceState.get('claudeBridge.checkpoints', []);
  history = context.workspaceState.get('claudeBridge.history', []);
  session = context.workspaceState.get('claudeBridge.session') || newSession();
  messages = context.workspaceState.get('claudeBridge.messages', []);
  msgSeq = messages.reduce((m, x) => Math.max(m, x.id || 0), 0);
  // a request left "in progress" from a previous session is no longer tracked
  messages.forEach((m) => {
    if (m.role === 'user' && m.state !== 'answered') m.state = 'old';
    if ((m.role === 'edit' || m.role === 'fileops') && m.state === 'pending') m.state = 'expired';
  });

  panel = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiBridge.chat', panel, { webviewOptions: { retainContextWhenHidden: true } }));

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ai-proposal', { provideTextDocumentContent: (u) => changeText(u, 'proposed') }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ai-orig', { provideTextDocumentContent: (u) => changeText(u, 'originalText') }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ai-empty', { provideTextDocumentContent: () => '' }));

  context.subscriptions.push(vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], new FixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
  setupTerminalCapture(context);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = VIEW;
  context.subscriptions.push(statusItem);
  updateStatus();
  statusItem.show();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('aiBridge.configure', configure);
  reg('aiBridge.ask', () => askCommand('chat'));
  reg('aiBridge.editSelection', () => askCommand('edit'));
  reg('aiBridge.stop', () => sendRequest('stop', 'STOP', { includeSelection: false }));
  reg('aiBridge.clear', newConversation);
  reg('aiBridge.history', () => { uiMode = uiMode === 'chat' ? 'history' : 'chat'; viewing = null; refresh(); vscode.commands.executeCommand(VIEW); });
  reg('aiBridge.linkChat', () => linkMenu());
  reg('aiBridge.copyPrompt', copyPrompt);
  reg('aiBridge.acceptEdit', (id) => acceptEdit(id));
  reg('aiBridge.rejectEdit', (id) => rejectEdit(id));
  reg('aiBridge.toggleAgent', () => setAgent(!agentMode));
  reg('aiBridge.undoLast', undoLast);
  reg('aiBridge.handoff', handoffCommand);
  reg('aiBridge.commitMessage', commitMessageCommand);
  reg('aiBridge.fixDiagnostic', fixDiagnostic);
  reg('aiBridge.attach', attachCommand);
  reg('aiBridge.openMemory', openMemory);

  context.subscriptions.push({ dispose: () => { running = false; } });
  if (!token) {
    vscode.window.showInformationMessage('AI Bridge: enter the server URL and token to get started.', 'Configure').then((c) => { if (c) configure(); });
  }
  pollLoop();
}

function deactivate() { running = false; }

// ---------------- config & http ----------------
function cfg() { return vscode.workspace.getConfiguration('aiBridge'); }
function serverUrl() { return String(cfg().get('serverUrl') || '').replace(/\/+$/, ''); }
function windowLabel() { return String(cfg().get('windowName') || '').trim() || `${vscode.workspace.name || 'no folder'} · ${os.hostname()}`; }

// Settings saved by earlier versions (claudeBridge.*) move to aiBridge.*
async function migrateSettings() {
  try {
    const old = vscode.workspace.getConfiguration('claudeBridge');
    for (const k of ['serverUrl', 'windowName', 'autoApproveCommands', 'idleMinutes']) {
      const o = old.inspect && old.inspect(k);
      const n = cfg().inspect && cfg().inspect(k);
      if (o && o.globalValue !== undefined && n && n.globalValue === undefined) await cfg().update(k, o.globalValue, vscode.ConfigurationTarget.Global);
    }
  } catch { /* nothing to migrate */ }
}

function promptText() {
  return `Follow VS Code with the VS Code Bridge connector (window «${windowLabel()}», window "${clientId}"): call follow_vscode with window "${clientId}" in a loop and answer my requests inside VS Code until I press Stop. Don't write in this chat.`;
}
function existingChatPromptText() {
  return `Connect this chat to VS Code with the VS Code Bridge connector (window «${windowLabel()}», window "${clientId}"): use what we discussed here as context for my requests from VS Code. If this chat has decisions that matter for the project, first save them with save_memory (mode "append"). Then call follow_vscode with window "${clientId}" in a loop and answer my requests inside VS Code until I press Stop. Don't write in this chat.`;
}

async function copyPrompt() {
  const pick = await vscode.window.showQuickPick([
    { label: '$(add) For a new chat', detail: 'Open a new AI chat, turn on the VS Code Bridge connector and paste.', id: 'new' },
    { label: '$(comment-discussion) For a chat that already exists', detail: 'Paste it into a chat where you already discussed the work: the AI uses that context to act here in VS Code.', id: 'existing' },
  ], { title: 'Copy the prompt for the AI chat', placeHolder: 'Where will you paste it?' });
  if (!pick) return;
  await vscode.env.clipboard.writeText(pick.id === 'existing' ? existingChatPromptText() : promptText());
  const c = await vscode.window.showInformationMessage('Prompt copied: paste it into the AI chat (with the VS Code Bridge connector on). Do you also want to link that chat, to reopen it from here?', 'Link chat');
  if (c) linkChat();
}

async function configure() {
  const url = await vscode.window.showInputBox({ title: 'AI Bridge (1/2)', prompt: 'Address of the VS Code Bridge server', value: serverUrl(), ignoreFocusOut: true });
  if (url === undefined) return;
  await cfg().update('serverUrl', url.trim().replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
  const t = await vscode.window.showInputBox({ title: 'AI Bridge (2/2)', prompt: 'Token (the same as the BRIDGE_TOKEN secret on the server)', password: true, value: token, ignoreFocusOut: true });
  if (t === undefined) return;
  token = t.trim();
  await ctxExt.secrets.store(TOKEN_KEY, token);
  try {
    const r = await api('GET', '/api/poll?wait=0', null, 15000);
    conn = 'online'; listening = !!r.claudeListening; connError = '';
    vscode.window.showInformationMessage('AI Bridge: connected to the server.');
  } catch (e) {
    conn = 'offline'; connError = e.message;
    vscode.window.showErrorMessage('AI Bridge: cannot connect — ' + e.message);
  }
  refresh();
}

function api(method, p, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(serverUrl() + p); } catch (e) { return reject(new Error('invalid server URL')); }
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'X-Bridge-Client': clientId, 'X-Bridge-Label': encodeURIComponent(windowLabel()) };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = lib.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) return reject(new Error('wrong token (401)'));
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + t.slice(0, 200)));
        try { resolve(t ? JSON.parse(t) : {}); } catch { reject(new Error('invalid response: ' + t.slice(0, 120))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollLoop() {
  while (running) {
    if (!token || !serverUrl()) { conn = 'unconfigured'; updateStatus(); await sleep(3000); continue; }
    const idleMs = Number(cfg().get('idleMinutes') || 20) * 60000;
    const fast = listening || Date.now() - lastActivity < idleMs;
    try {
      // the first poll (and the first after an error) answers at once, so the panel shows "online" right away
      const r = await api('GET', '/api/poll?wait=' + (fast && conn === 'online' ? 25 : 0), null, 45000);
      const wasOnline = conn === 'online';
      conn = 'online'; connError = '';
      const l = !!r.claudeListening;
      const w = Number(r.windows) || 1;
      if (l !== listening || !wasOnline || w !== windowsOnline) { listening = l; windowsOnline = w; refresh(); }
      const fresh = (r.jobs || []).filter((j) => !seenJobs.has(j.id));
      if ((r.jobs || []).length) api('POST', '/api/ack', { ids: r.jobs.map((j) => j.id) }).catch(() => {});
      for (const j of fresh) { seenJobs.add(j.id); lastActivity = Date.now(); handleJob(j); }
      if (seenJobs.size > 2000) seenJobs.clear();
      if (!fast && !(r.jobs || []).length) await sleep(15000);
    } catch (e) {
      if (conn !== 'offline' || connError !== e.message) { conn = 'offline'; connError = e.message; refresh(); }
      await sleep(5000);
    }
  }
}

// ---------------- jobs from the AI ----------------
const HANDLERS = {
  context: () => buildContext({ selCap: 20000 }),
  read_file: readFileJob,
  list_files: listFilesJob,
  list_dir: listDirJob,
  search: searchJob,
  get_diagnostics: diagnosticsJob,
  propose_edit: (p, j) => proposeChangesJob({ description: p.description, request_id: p.request_id, files: [{ path: p.path, edits: p.edits, new_content: p.new_content }] }, j),
  propose_changes: proposeChangesJob,
  propose_file_ops: proposeFileOpsJob,
  run_command: runCommandJob,
  open_file: openFileJob,
  terminal_output: terminalJob,
  memory: memoryJob,
  save_memory: saveMemoryJob,
  save_handoff: saveHandoffJob,
};

async function handleJob(j) {
  try {
    switch (j.type) {
      case 'reply': return onReply(j.params || {});
      case 'status': return onStatus(j.params || {});
      case 'plan': return onPlan(j.params || {});
    }
    const h = HANDLERS[j.type];
    if (!h) throw new Error('Unknown job type: ' + j.type + ' (update the AI Bridge extension)');
    const result = await h(j.params || {}, j);
    await api('POST', '/api/result', { id: j.id, ok: true, result });
  } catch (e) {
    try { await api('POST', '/api/result', { id: j.id, ok: false, error: String(e && e.message || e) }); } catch { /* offline */ }
  }
}

function onReply(p) {
  const text = String(p.text || '');
  addMessage({ role: 'claude', text, requestId: p.request_id ?? null });
  if (p.request_id != null && p.final !== false) {
    setRequestState(p.request_id, 'answered');
    const u = messages.find((x) => x.role === 'user' && x.requestId === p.request_id);
    if (u && u.kind === 'commit') setCommitMessage(u.repoRoot, text);
  }
}

function onStatus(p) {
  if (p.listening !== undefined) { listening = !!p.listening; refresh(); }
  if (p.request_id != null && p.state) setRequestState(p.request_id, p.state);
}

function onPlan(p) {
  const rid = p.request_id ?? null;
  const steps = (Array.isArray(p.steps) ? p.steps : []).map((s) => ({ title: String(s.title || ''), status: String(s.status || 'pending') }));
  const i = messages.map((m) => m.role === 'plan' && m.requestId === rid).lastIndexOf(true);
  if (i >= 0) {
    // the updated plan moves to the bottom, where the user is looking
    const m = messages.splice(i, 1)[0];
    m.steps = steps; m.title = p.title || m.title; m.at = Date.now();
    messages.push(m);
    persist();
  } else addMessage({ role: 'plan', requestId: rid, title: p.title || '', steps });
}

const earlyStates = new Map(); // request id -> state that arrived before the request's own answer from the server
function setRequestState(id, state) {
  const m = messages.find((x) => x.role === 'user' && x.requestId === id);
  if (!m) { earlyStates.set(id, state); if (earlyStates.size > 50) earlyStates.delete(earlyStates.keys().next().value); return; }
  if (m.state !== 'answered') { m.state = state; persist(); }
}

// ---------------- paths & files ----------------
function folders() { return vscode.workspace.workspaceFolders || []; }

function resolvePath(p) {
  if (!p) throw new Error('path missing');
  p = String(p).trim();
  if (/^file:\/\//i.test(p)) return vscode.Uri.parse(p);
  if (p === '~' || /^~[\\/]/.test(p)) return vscode.Uri.file(path.join(os.homedir(), p.slice(2)));
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return vscode.Uri.file(p);
  const fs = folders();
  if (!fs.length) throw new Error('No folder is open in VS Code: use an absolute path (or one starting with ~).');
  const parts = p.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  if (fs.length > 1) {
    const f = fs.find((x) => x.name === parts[0]);
    if (f) return vscode.Uri.joinPath(f.uri, ...parts.slice(1));
  }
  return vscode.Uri.joinPath(fs[0].uri, ...parts);
}

function rel(uri) {
  if (uri.scheme !== 'file') return uri.toString();
  return vscode.workspace.asRelativePath(uri, folders().length > 1);
}

function homeShort(p) {
  const h = os.homedir();
  return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

function openDoc(uri) {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
}

async function readText(uri) {
  const d = openDoc(uri);
  if (d) return { text: d.getText(), dirty: d.isDirty };
  const bytes = await vscode.workspace.fs.readFile(uri);
  return { text: Buffer.from(bytes).toString('utf8'), dirty: false };
}

async function exists(uri) {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

// Writes through a document (keeps undo history, encoding and open editors in sync) or creates the file.
async function writeText(uri, text) {
  if (await exists(uri)) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const cur = doc.getText();
    if (cur !== text) {
      const we = new vscode.WorkspaceEdit();
      we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(cur.length)), text);
      if (!(await vscode.workspace.applyEdit(we))) throw new Error('VS Code did not apply the change to ' + rel(uri));
    }
    if (doc.isDirty) await doc.save();
  } else {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }
}

async function deleteFile(uri) {
  try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch { await vscode.workspace.fs.delete(uri, { useTrash: false }); }
}

const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);
const cap = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [truncated, ${s.length - n} more characters]` : s);

function numbered(lines, start) {
  const w = String(start + lines.length).length;
  return lines.map((l, i) => String(start + i).padStart(w, ' ') + '| ' + l).join('\n');
}

function fmtDiag(d, uri) {
  const sev = ['error', 'warning', 'info', 'hint'][d.severity] || 'info';
  return `${uri ? rel(uri) + ':' : 'line '}${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message}${d.source ? ' (' + d.source + ')' : ''}`;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const z = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

function bridgeUri(name) {
  const f = folders()[0];
  if (!f) throw new Error('No folder is open in VS Code: the memory and the handoff are saved in the project.');
  return vscode.Uri.joinPath(f.uri, BRIDGE_DIR, name);
}
async function readBridgeFile(name) {
  try { return (await readText(bridgeUri(name))).text; } catch { return null; }
}
async function writeBridgeFile(name, text) {
  const uri = bridgeUri(name);
  await writeText(uri, text);
  return uri;
}

// ---------------- context ----------------
function buildContext(opts = {}) {
  const ctx = {
    os: process.platform === 'win32' ? 'Windows (commands run in cmd.exe)' : process.platform,
    workspace: folders().map((f) => ({ name: f.name, path: f.uri.fsPath })),
  };
  if (opts.noEditor) { ctx.noEditor = true; return ctx; }
  try {
    ctx.openTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .map((t) => (t.input && t.input.uri ? rel(t.input.uri) : t.label)).slice(0, 30);
  } catch { /* old VS Code */ }
  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const d = ed.document;
    ctx.file = rel(d.uri);
    ctx.language = d.languageId;
    ctx.lines = d.lineCount;
    ctx.dirty = d.isDirty;
    ctx.cursorLine = ed.selection.active.line + 1;
    const vr = ed.visibleRanges[0];
    if (vr) ctx.visible = { startLine: vr.start.line + 1, endLine: vr.end.line + 1 };
    const s = ed.selection;
    if (opts.includeSelection !== false && !s.isEmpty) {
      ctx.selection = { startLine: s.start.line + 1, endLine: s.end.line + 1, text: cap(d.getText(s), opts.selCap || 30000) };
    }
    const diags = vscode.languages.getDiagnostics(d.uri)
      .filter((x) => x.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 30);
    if (diags.length) ctx.diagnostics = diags.map((x) => fmtDiag(x));
    if (opts.includeFile) {
      const lines = d.getText().split(/\r?\n/);
      ctx.fileText = cap(numbered(lines.slice(0, 2000), 1), 90000) + (lines.length > 2000 ? `\n… [long file: ${lines.length} lines, use read_file for the rest]` : '');
    }
  }
  return ctx;
}

// ---------------- tool handlers ----------------
async function readFileJob(p) {
  const uri = resolvePath(p.path);
  const { text, dirty } = await readText(uri);
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Number(p.start_line) || 1);
  const end = Math.min(lines.length, Number(p.end_line) || lines.length, start + 1499);
  const body = cap(numbered(lines.slice(start - 1, end), start), 120000);
  let head = `${rel(uri)} — ${lines.length} lines${dirty ? ' (unsaved changes included)' : ''}; showing ${start}-${end}`;
  if (end < lines.length) head += ` — continue with start_line=${end + 1}`;
  return head + '\n' + body;
}

async function listFilesJob(p) {
  const max = Math.min(Number(p.max) || 300, 2000);
  const files = await vscode.workspace.findFiles(p.glob || '**/*', EXCLUDE, max + 1);
  const list = files.map(rel).sort();
  const more = list.length > max;
  return `${Math.min(list.length, max)} files${more ? ' (list cut: use a narrower glob)' : ''}:\n` + list.slice(0, max).join('\n');
}

async function listDirJob(p) {
  const uri = resolvePath(p.path);
  let st;
  try { st = await vscode.workspace.fs.stat(uri); } catch { throw new Error('not found: ' + uri.fsPath); }
  if (!(st.type & DIR)) throw new Error('not a folder: ' + uri.fsPath);
  const max = Math.min(Number(p.max) || 500, 3000);
  const depthMax = p.recursive ? 3 : 1;
  const rows = [];
  let cut = false;
  async function walk(dir, prefix, depth) {
    let entries;
    try { entries = await vscode.workspace.fs.readDirectory(dir); } catch (e) { rows.push(`${prefix || '.'}: cannot be read (${e.message})`); return; }
    entries.sort((a, b) => ((b[1] & DIR) - (a[1] & DIR)) || a[0].localeCompare(b[0]));
    for (const [name, type] of entries) {
      if (rows.length >= max) { cut = true; return; }
      const child = vscode.Uri.joinPath(dir, name);
      const r = prefix ? prefix + '/' + name : name;
      const isDir = !!(type & DIR);
      let size = ''; let when = '';
      try { const s = await vscode.workspace.fs.stat(child); when = fmtDate(s.mtime); if (!isDir) size = fmtSize(s.size); } catch { /* unreadable */ }
      rows.push(`${isDir ? '[dir] ' : '[file]'} ${r}${isDir ? '/' : ''}${size ? '  ' + size : ''}${when ? '  ' + when : ''}`);
      if (isDir && depth < depthMax && !SKIP_DIRS.has(name)) await walk(child, r, depth + 1);
    }
  }
  await walk(uri, '', 1);
  return `${uri.fsPath} — ${rows.length} entries${cut ? ' (list cut: look into a subfolder, or raise max)' : ''}${p.recursive ? ', with subfolders up to 3 levels' : ''}; size and last-modified date for each:\n` + (rows.join('\n') || '(empty folder)');
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function searchJob(p) {
  if (!p.query) throw new Error('query missing');
  const max = Math.min(Number(p.max) || 150, 500);
  let re;
  try { re = new RegExp(p.regex ? p.query : escRe(p.query), p.case_sensitive ? '' : 'i'); } catch (e) { throw new Error('invalid regex: ' + e.message); }
  const files = await vscode.workspace.findFiles(p.glob || '**/*', EXCLUDE, 5000);
  const deadline = Date.now() + 20000;
  const out = [];
  let scanned = 0; let truncated = false;
  for (const f of files) {
    if (Date.now() > deadline) { truncated = true; break; }
    try {
      const d = openDoc(f);
      let text;
      if (d) text = d.getText();
      else {
        const st = await vscode.workspace.fs.stat(f);
        if (st.size > 1500000) continue;
        const bytes = await vscode.workspace.fs.readFile(f);
        if (isBinary(bytes)) continue;
        text = Buffer.from(bytes).toString('utf8');
      }
      scanned++;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${rel(f)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          if (out.length >= max) { truncated = true; break; }
        }
      }
      if (out.length >= max) break;
    } catch { /* unreadable */ }
  }
  return `${out.length} matches in ${scanned} files${truncated ? ' (cut)' : ''}` + (out.length ? ':\n' + out.join('\n') : '.');
}

async function diagnosticsJob(p) {
  let pairs;
  if (p.path) { const u = resolvePath(p.path); pairs = [[u, vscode.languages.getDiagnostics(u)]]; }
  else pairs = vscode.languages.getDiagnostics();
  const lines = [];
  for (const [u, ds] of pairs) for (const d of ds) lines.push({ sev: d.severity, s: fmtDiag(d, u) });
  lines.sort((a, b) => a.sev - b.sev);
  if (!lines.length) return 'VS Code reports no problems' + (p.path ? ' for this file.' : '.') + ' (VS Code only reports problems for files a linter or language server has analysed.)';
  return `${lines.length} problems:\n` + lines.slice(0, 300).map((x) => x.s).join('\n');
}

async function openFileJob(p) {
  const uri = resolvePath(p.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = Math.max(0, (Number(p.line) || 1) - 1);
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
  return `Opened ${rel(uri)}${p.line ? ' at line ' + p.line : ''}.`;
}

// ---- change sets (propose_edit / propose_changes) ----
function changeText(uri, field) {
  const [id, i] = String(uri.query).split('|');
  const cs = proposals.get(id);
  const f = cs && cs.files[Number(i)];
  return f ? f[field] : '';
}

function applyEdits(text, edits) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\n/g, eol);
  let out = text;
  edits.forEach((e, i) => {
    const oldT = norm(e.old_text);
    const newT = norm(e.new_text);
    if (!oldT) throw new Error(`edit ${i + 1}: old_text is empty`);
    let count = 0; let idx = -1; let from = 0;
    while ((idx = out.indexOf(oldT, from)) !== -1) { count++; from = idx + oldT.length; if (count > 1) break; }
    if (count === 0) throw new Error(`edit ${i + 1}: old_text not found in the file (read it again with read_file and copy it exactly)`);
    if (count > 1) throw new Error(`edit ${i + 1}: old_text appears more than once: add surrounding lines to make it unique`);
    const at = out.indexOf(oldT);
    out = out.slice(0, at) + newT + out.slice(at + oldT.length);
  });
  return out;
}

async function buildChange(s) {
  const uri = resolvePath(s.path);
  const ex = await exists(uri);
  if (s.delete) {
    if (!ex) throw new Error('the file does not exist, it cannot be deleted');
    return { uri, del: true, isNew: false, originalText: (await readText(uri)).text, proposed: '', edits: null };
  }
  if (!ex) {
    if (typeof s.new_content !== 'string') throw new Error('the file does not exist: to create it use new_content');
    return { uri, del: false, isNew: true, originalText: '', proposed: s.new_content, edits: null };
  }
  const originalText = (await readText(uri)).text;
  const edits = Array.isArray(s.edits) && s.edits.length ? s.edits : null;
  let proposed;
  if (edits) proposed = applyEdits(originalText, edits);
  else if (typeof s.new_content === 'string') {
    const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
    proposed = s.new_content.replace(/\r\n/g, '\n').replace(/\n/g, eol);
  } else throw new Error('edits or new_content (or delete) is needed');
  if (proposed === originalText) return null; // nothing to change in this file
  return { uri, del: false, isNew: false, originalText, proposed, edits };
}

function latestRequestId() {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.requestId != null && ['chat', 'edit', 'fix'].includes(m.kind || 'chat')) return m.requestId;
  }
  return null;
}

async function proposeChangesJob(p, job) {
  const specs = Array.isArray(p.files) ? p.files : [];
  if (!specs.length) throw new Error('no files given');
  if (specs.length > 50) throw new Error('too many files at once (max 50)');
  const files = [];
  const seen = new Set();
  for (const [i, s] of specs.entries()) {
    try {
      const f = await buildChange(s || {});
      if (!f) continue;
      const k = f.uri.toString();
      if (seen.has(k)) throw new Error('the same file appears twice');
      seen.add(k);
      files.push(f);
    } catch (e) {
      throw new Error((specs.length > 1 ? `file ${i + 1} (${s && s.path}): ` : '') + e.message);
    }
  }
  if (!files.length) throw new Error('the change does not change anything in the files');
  const editId = 'e' + String(job.id).replace(/^j/, '');
  const requestId = p.request_id ?? latestRequestId();
  const cs = { editId, files, desc: String(p.description || '').slice(0, 300), status: 'pending', requestId, cpId: null };
  proposals.set(editId, cs);
  const list = files.map((f) => rel(f.uri) + (f.isNew ? ' (new)' : f.del ? ' (deleted)' : ''));

  if (agentMode) {
    await applyChangeset(cs);
    cs.status = 'applied';
    addMessage({ role: 'edit', editId, files: list, desc: cs.desc, state: 'applied', requestId, cpId: cs.cpId });
    const probs = await problemsIn(files);
    return `Applied at once (agent mode) — edit ${editId}: ${list.join(', ')}. The user can undo everything done for this request from the panel.\n${probs}`;
  }

  addMessage({ role: 'edit', editId, files: list, desc: cs.desc, state: 'pending', requestId });
  await showChanges(editId);
  const what = files.length > 1 ? `changes to ${files.length} files` : `a change to ${path.basename(files[0].uri.fsPath)}`;
  vscode.window.showInformationMessage(`The AI proposes ${what}: ${cs.desc}`, 'Accept', 'Reject').then((c) => {
    if (c === 'Accept') acceptEdit(editId);
    else if (c === 'Reject') rejectEdit(editId);
  });
  return `Diff shown to the user (edit id ${editId}: ${list.join(', ')}). They will accept or reject it${files.length > 1 ? ' as a whole' : ''}; the outcome arrives as an event in follow_vscode.`;
}

// Re-checks every file, saves a restore point for the request, then writes.
async function applyChangeset(cs) {
  const steps = [];
  for (const f of cs.files) {
    const ex = await exists(f.uri);
    if (f.del) { if (ex) steps.push({ f, op: 'delete' }); continue; }
    if (f.isNew) {
      if (ex) {
        if ((await readText(f.uri)).text === f.proposed) continue;
        throw new Error(`${rel(f.uri)} already exists`);
      }
      steps.push({ f, op: 'write', text: f.proposed });
      continue;
    }
    if (!ex) throw new Error(`${rel(f.uri)} no longer exists`);
    const cur = (await readText(f.uri)).text;
    let text = f.proposed;
    if (cur !== f.originalText) {
      if (!f.edits) throw new Error(`${rel(f.uri)} changed after the proposal`);
      text = applyEdits(cur, f.edits);
    }
    steps.push({ f, op: 'write', text });
  }
  const point = await checkpointFor(cs.requestId);
  for (const s of steps) await snapshot(point, s.f.uri);
  cs.cpId = point.id;
  saveCheckpoints();
  for (const s of steps) {
    if (s.op === 'delete') await deleteFile(s.f.uri);
    else await writeText(s.f.uri, s.text);
  }
}

async function problemsIn(files, waitMs = 1500) {
  const uris = files.filter((f) => !f.del).map((f) => f.uri);
  if (!uris.length) return '';
  await sleep(waitMs); // let linters / language servers look at the new text
  const lines = [];
  for (const u of uris) {
    for (const d of vscode.languages.getDiagnostics(u)) if (d.severity <= vscode.DiagnosticSeverity.Warning) lines.push(fmtDiag(d, u));
  }
  return lines.length
    ? `Problems VS Code now reports in the changed files (${lines.length}):\n` + lines.slice(0, 60).join('\n')
    : 'VS Code reports no errors or warnings in the changed files (it only checks files a linter or language server analyses).';
}

async function showChanges(editId) {
  const cs = proposals.get(editId);
  if (!cs) { vscode.window.showWarningMessage('This change is no longer available (VS Code was restarted).'); return; }
  const done = cs.status === 'applied' || cs.status === 'accepted';
  const title = `AI: ${cs.desc.slice(0, 60) || 'change'} [${editId}]`;
  const triples = cs.files.map((f, i) => {
    const name = '/' + path.basename(f.uri.fsPath);
    const q = `${editId}|${i}`;
    const empty = vscode.Uri.from({ scheme: 'ai-empty', path: name });
    if (done) return [f.uri, f.isNew ? empty : vscode.Uri.from({ scheme: 'ai-orig', path: name, query: q }), f.del ? empty : f.uri];
    return [f.uri, f.isNew ? empty : f.uri, f.del ? empty : vscode.Uri.from({ scheme: 'ai-proposal', path: name, query: q })];
  });
  if (triples.length > 1) {
    try { await vscode.commands.executeCommand('vscode.changes', title, triples); return; } catch { /* older VS Code: one diff per file */ }
  }
  for (const [, left, right] of triples) {
    await vscode.commands.executeCommand('vscode.diff', left, right, triples.length > 1 ? `${title} ${path.basename(right.path)}` : title, { preview: false });
  }
}

function closeDiff(editId) {
  try {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => String(t.label || '').includes(`[${editId}]`));
    if (tabs.length) vscode.window.tabGroups.close(tabs);
  } catch { /* ignore */ }
}

async function acceptEdit(editId) {
  const cs = proposals.get(editId);
  if (!cs || cs.status !== 'pending') return;
  try {
    await applyChangeset(cs);
    cs.status = 'accepted';
    closeDiff(editId);
    const first = cs.files.find((f) => !f.del);
    if (first) {
      const d = await vscode.workspace.openTextDocument(first.uri);
      await vscode.window.showTextDocument(d, { preview: false });
    }
    await finishEdit(cs, true);
  } catch (e) {
    vscode.window.showErrorMessage('AI Bridge: change not applied — ' + e.message);
  }
}

async function rejectEdit(editId) {
  const cs = proposals.get(editId);
  if (!cs || cs.status !== 'pending') return;
  const note = await vscode.window.showInputBox({ prompt: 'Want to tell the AI why? (optional)', ignoreFocusOut: false });
  cs.status = 'rejected';
  closeDiff(editId);
  await finishEdit(cs, false, note || '');
}

async function finishEdit(cs, accepted, note = '') {
  const m = messages.find((x) => x.role === 'edit' && x.editId === cs.editId);
  if (m) { m.state = accepted ? 'accepted' : 'rejected'; if (accepted) m.cpId = cs.cpId; }
  persist();
  lastActivity = Date.now();
  const problems = accepted ? await problemsIn(cs.files) : '';
  api('POST', '/api/event', { event: 'edit_result', data: { edit_id: cs.editId, paths: cs.files.map((f) => rel(f.uri)), accepted, note, request_id: cs.requestId, problems } }).catch(() => {});
}

// ---- file operations anywhere on the computer (propose_file_ops) ----
const SYSTEM_DIRS = process.platform === 'win32'
  ? [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files( \(x86\))?(\\|$)/i, /^[a-z]:\\programdata(\\|$)/i]
  : [/^\/(bin|sbin|usr|etc|var|lib|lib32|lib64|boot|dev|proc|sys|System|Library|Applications|private|opt|snap)(\/|$)/];

function guardPath(p, what) {
  const abs = path.resolve(p);
  if (abs === path.parse(abs).root || abs === os.homedir()) throw new Error(`${what}: refusing to touch ${abs} itself`);
  if (SYSTEM_DIRS.some((re) => re.test(abs))) throw new Error(`${what}: ${abs} is a system folder`);
  return abs;
}

async function diskKind(p) {
  try { const s = await vscode.workspace.fs.stat(vscode.Uri.file(p)); return (s.type & DIR) ? 'dir' : 'file'; } catch { return null; }
}

// Checks every operation in order, against the disk as earlier operations will have left it.
async function planOps(list) {
  const virt = new Map(); // path -> 'dir' | 'file' | null (gone), as left by earlier operations
  const moved = []; // folders moved earlier: their contents move along
  const under = (p, dir) => p.startsWith(dir + path.sep);
  const kind = async (p) => {
    if (virt.has(p)) return virt.get(p);
    for (let i = moved.length - 1; i >= 0; i--) {
      const m = moved[i];
      if (under(p, m.to)) { const old = m.from + p.slice(m.to.length); return virt.has(old) ? virt.get(old) : diskKind(old); }
      if (under(p, m.from)) return null;
    }
    for (const [q, v] of virt) if (v === null && under(p, q)) return null;
    return diskKind(p);
  };
  const missingParents = async (dir) => {
    const created = [];
    let cur = dir;
    for (;;) {
      const k = await kind(cur);
      if (k === 'dir') break;
      if (k === 'file') throw new Error(`${cur} is a file, not a folder`);
      created.unshift(cur);
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    for (const c of created) virt.set(c, 'dir');
    return created;
  };
  const out = [];
  for (const [i, o] of list.entries()) {
    const where = `operation ${i + 1} (${o && o.op} ${o && o.path})`;
    try {
      const op = String((o && o.op) || '').toLowerCase();
      const from = guardPath(resolvePath(o.path).fsPath, 'path');
      if (op === 'mkdir') {
        const k = await kind(from);
        if (k === 'dir') continue; // already there
        if (k === 'file') throw new Error('a file with that name exists');
        out.push({ op: 'mkdir', path: from, created: await missingParents(from) });
      } else if (op === 'move' || op === 'rename') {
        if (!o.to) throw new Error('"to" is missing');
        const to = guardPath(resolvePath(o.to).fsPath, 'to');
        const k = await kind(from);
        if (!k) throw new Error('not found');
        if (to === from) continue;
        if (await kind(to)) throw new Error(`${to} already exists (nothing is ever overwritten)`);
        if (k === 'dir' && under(to, from)) throw new Error('a folder cannot be moved into itself');
        const created = await missingParents(path.dirname(to));
        virt.set(from, null);
        virt.set(to, k);
        if (k === 'dir') moved.push({ from, to });
        out.push({ op: path.dirname(from) === path.dirname(to) ? 'rename' : 'move', path: from, to, created });
      } else if (op === 'trash' || op === 'delete') {
        const k = await kind(from);
        if (!k) throw new Error('not found');
        virt.set(from, null);
        out.push({ op: 'trash', path: from });
      } else throw new Error('unknown op: use mkdir, move, rename or trash');
    } catch (e) {
      throw new Error(`${where}: ${e.message}`);
    }
  }
  if (!out.length) throw new Error('nothing to do: everything is already in place');
  return out;
}

function opsSummary(ops) {
  const n = (k) => ops.filter((o) => o.op === k).length;
  const parts = [];
  if (n('move')) parts.push(`${n('move')} ${n('move') === 1 ? 'move' : 'moves'}`);
  if (n('rename')) parts.push(`${n('rename')} ${n('rename') === 1 ? 'rename' : 'renames'}`);
  if (n('mkdir')) parts.push(`${n('mkdir')} new ${n('mkdir') === 1 ? 'folder' : 'folders'}`);
  if (n('trash')) parts.push(`${n('trash')} to the Recycle Bin`);
  return parts.join(' · ');
}

function opItem(o) {
  if (o.op === 'mkdir') return { op: 'mkdir', a: homeShort(o.path) };
  if (o.op === 'rename') return { op: 'rename', a: homeShort(o.path), b: path.basename(o.to) };
  if (o.op === 'move') return { op: 'move', a: homeShort(o.path), b: homeShort(o.to) };
  return { op: 'trash', a: homeShort(o.path) };
}
function opLine(o) {
  const x = opItem(o);
  if (x.op === 'mkdir') return `+ new folder  ${x.a}`;
  if (x.op === 'rename') return `✎ rename      ${x.a}  →  ${x.b}`;
  if (x.op === 'move') return `→ move        ${x.a}  →  ${x.b}`;
  return `🗑 to the Recycle Bin  ${x.a}`;
}

async function proposeFileOpsJob(p, job) {
  const list = Array.isArray(p.operations) ? p.operations : [];
  if (!list.length) throw new Error('no operations given');
  if (list.length > 2000) throw new Error('too many operations at once (max 2000)');
  const ops = await planOps(list);
  const opsId = 'f' + String(job.id).replace(/^j/, '');
  const requestId = p.request_id ?? latestRequestId();
  const set = { opsId, ops, desc: String(p.description || '').slice(0, 300), status: 'pending', requestId, cpId: null };
  opSets.set(opsId, set);
  const summary = opsSummary(ops);
  const card = { role: 'fileops', opsId, desc: set.desc, summary, items: ops.slice(0, 300).map(opItem), total: ops.length, requestId };
  if (agentMode) {
    const m = addMessage({ ...card, state: 'applied' });
    try {
      await applyOps(set);
    } catch (e) {
      m.state = 'partial'; m.error = e.message; m.cpId = set.cpId; persist();
      throw new Error(`${e.message}. The operations done before it can be undone from the panel.`);
    }
    set.status = 'applied'; m.cpId = set.cpId; persist();
    return `Done at once (agent mode) — ${opsId}: ${summary}. The user can undo it from the panel (except what went to the Recycle Bin).`;
  }
  addMessage({ ...card, state: 'pending' });
  vscode.commands.executeCommand(VIEW);
  vscode.window.showInformationMessage(`The AI proposes to organize files: ${summary}${set.desc ? ' — ' + set.desc : ''}`, 'Accept', 'Show all', 'Reject').then((c) => {
    if (c === 'Accept') acceptOps(opsId);
    else if (c === 'Reject') rejectOps(opsId);
    else if (c === 'Show all') showOps(opsId);
  });
  return `Shown to the user for review (${opsId}: ${summary}). They will accept or reject it as a whole; the outcome arrives as an event in follow_vscode.`;
}

// Does the operations in order and records each one in the request's restore point, so they can be undone.
async function applyOps(set) {
  const point = await checkpointFor(set.requestId);
  set.cpId = point.id;
  const data = await loadCp(point.id);
  data.ops = data.ops || [];
  const done = [];
  try {
    for (const o of set.ops) {
      for (const c of o.created || []) {
        if (!(await exists(vscode.Uri.file(c)))) { await vscode.workspace.fs.createDirectory(vscode.Uri.file(c)); done.push({ op: 'mkdir', path: c }); }
      }
      if (o.op === 'move' || o.op === 'rename') {
        if (await exists(vscode.Uri.file(o.to))) throw new Error(`${o.to} already exists`);
        await vscode.workspace.fs.rename(vscode.Uri.file(o.path), vscode.Uri.file(o.to), { overwrite: false });
        done.push({ op: 'move', path: o.path, to: o.to });
      } else if (o.op === 'trash') {
        // the Recycle Bin only: if the system has none, stop rather than delete for good
        await vscode.workspace.fs.delete(vscode.Uri.file(o.path), { recursive: true, useTrash: true });
        done.push({ op: 'trash', path: o.path });
      }
    }
  } catch (e) {
    throw new Error(`stopped after ${done.length} operations: ${e.message}`);
  } finally {
    data.ops.push(...done);
    point.ops = (point.ops || 0) + done.length;
    await vscode.workspace.fs.createDirectory(cpDir());
    await vscode.workspace.fs.writeFile(cpFile(point.id), Buffer.from(JSON.stringify(data), 'utf8'));
    saveCheckpoints();
  }
}

async function acceptOps(opsId) {
  const set = opSets.get(opsId);
  if (!set || set.status !== 'pending') return;
  set.status = 'running';
  const m = messages.find((x) => x.role === 'fileops' && x.opsId === opsId);
  let error = '';
  try {
    await applyOps(set);
    set.status = 'accepted';
    if (m) m.state = 'accepted';
  } catch (e) {
    error = e.message;
    set.status = 'partial';
    if (m) { m.state = 'partial'; m.error = error; }
    vscode.window.showErrorMessage('AI Bridge: file operations ' + error);
  }
  if (m) m.cpId = set.cpId;
  persist();
  lastActivity = Date.now();
  api('POST', '/api/event', { event: 'ops_result', data: { ops_id: opsId, summary: opsSummary(set.ops), accepted: true, error, request_id: set.requestId } }).catch(() => {});
}

async function rejectOps(opsId) {
  const set = opSets.get(opsId);
  if (!set || set.status !== 'pending') return;
  const note = await vscode.window.showInputBox({ prompt: 'Want to tell the AI why? (optional)', ignoreFocusOut: false });
  set.status = 'rejected';
  const m = messages.find((x) => x.role === 'fileops' && x.opsId === opsId);
  if (m) m.state = 'rejected';
  persist();
  lastActivity = Date.now();
  api('POST', '/api/event', { event: 'ops_result', data: { ops_id: opsId, summary: opsSummary(set.ops), accepted: false, note: note || '', request_id: set.requestId } }).catch(() => {});
}

async function showOps(opsId) {
  const set = opSets.get(opsId);
  const m = messages.find((x) => x.role === 'fileops' && x.opsId === opsId) || (viewing && (viewing.messages || []).find((x) => x.role === 'fileops' && x.opsId === opsId));
  let lines;
  if (set) lines = set.ops.map(opLine);
  else if (m) lines = (m.items || []).map((x) => opLine({ op: x.op, path: x.a, to: x.b })).concat(m.total > (m.items || []).length ? [`… and ${m.total - m.items.length} more`] : []);
  else return;
  const head = `AI file operations ${opsId}: ${set ? opsSummary(set.ops) : m.summary}${(set || m).desc ? '\n' + (set || m).desc : ''}\n\n`;
  const doc = await vscode.workspace.openTextDocument({ content: head + lines.join('\n') + '\n', language: 'plaintext' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

// ---- restore points: one per request, so everything the AI did for it can be undone ----
function cpDir() { return vscode.Uri.joinPath(ctxExt.storageUri || ctxExt.globalStorageUri, 'checkpoints'); }
function cpFile(id) { return vscode.Uri.joinPath(cpDir(), id + '.json'); }

async function loadCp(id) {
  if (cpCache.has(id)) return cpCache.get(id);
  let data = { files: {}, ops: [] };
  try { data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(cpFile(id))).toString('utf8')); } catch { /* none yet */ }
  data.files = data.files || {};
  data.ops = data.ops || [];
  cpCache.set(id, data);
  return data;
}

async function checkpointFor(requestId) {
  let c = requestId != null ? [...checkpoints].reverse().find((x) => x.requestId === requestId && !x.reverted) : null;
  if (!c) {
    c = { id: 'cp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), requestId: requestId ?? null, files: [], uris: [], ops: 0, reverted: false, at: Date.now() };
    checkpoints.push(c);
    while (checkpoints.length > KEEP_CHECKPOINTS) {
      const old = checkpoints.shift();
      cpCache.delete(old.id);
      Promise.resolve(vscode.workspace.fs.delete(cpFile(old.id))).catch(() => {});
    }
  }
  return c;
}

async function snapshot(point, uri) {
  const k = uri.toString();
  const data = await loadCp(point.id);
  if (data.files[k]) return; // the first state before this request is the one to restore
  const ex = await exists(uri);
  let content = null;
  if (ex) {
    const st = await vscode.workspace.fs.stat(uri);
    if (st.size > MAX_SNAPSHOT_BYTES) throw new Error(`${rel(uri)} is too big for the restore point (more than 5 MB)`);
    content = (await readText(uri)).text;
  }
  data.files[k] = { existed: ex, content };
  point.files.push(rel(uri));
  point.uris.push(k);
  await vscode.workspace.fs.createDirectory(cpDir());
  await vscode.workspace.fs.writeFile(cpFile(point.id), Buffer.from(JSON.stringify(data), 'utf8'));
}

function saveCheckpoints() {
  ctxExt.workspaceState.update('claudeBridge.checkpoints', checkpoints);
  refresh();
}

async function revertCheckpoint(id) {
  const c = checkpoints.find((x) => x.id === id);
  if (!c || c.reverted || !(c.files.length || c.ops)) return;
  const data = await loadCp(c.id);
  const what = [];
  if (c.files.length) what.push(`These files go back to how they were:\n${c.files.join('\n')}`);
  if (data.ops.length) what.push(`${data.ops.length} file operations are undone (files moved back, new empty folders removed)${data.ops.some((o) => o.op === 'trash') ? '; files sent to the Recycle Bin stay there: restore them from the Recycle Bin' : ''}.`);
  const pick = await vscode.window.showWarningMessage(
    `Undo the AI's changes${c.requestId != null ? ' for request #' + c.requestId : ''}?`,
    { modal: true, detail: `${what.join('\n\n')}\n\nIf you changed these files yourself afterwards, those changes are lost too.` },
    'Undo changes');
  if (pick !== 'Undo changes') return;
  const errs = [];
  const trashed = [];
  for (const o of [...data.ops].reverse()) {
    try {
      if (o.op === 'move') {
        const now = vscode.Uri.file(o.to);
        const back = vscode.Uri.file(o.path);
        if (!(await exists(now))) errs.push(`${homeShort(o.to)}: no longer there`);
        else if (await exists(back)) errs.push(`${homeShort(o.path)}: already exists, not overwritten`);
        else await vscode.workspace.fs.rename(now, back, { overwrite: false });
      } else if (o.op === 'mkdir') {
        const dir = vscode.Uri.file(o.path);
        if ((await exists(dir)) && !(await vscode.workspace.fs.readDirectory(dir)).length) await vscode.workspace.fs.delete(dir, { recursive: false, useTrash: false });
      } else if (o.op === 'trash') trashed.push(homeShort(o.path));
    } catch (e) { errs.push(`${homeShort(o.path)}: ${e.message}`); }
  }
  for (const [k, s] of Object.entries(data.files)) {
    const uri = vscode.Uri.parse(k);
    try {
      if (!s.existed) { if (await exists(uri)) await deleteFile(uri); }
      else if (s.content == null) errs.push(rel(uri) + ': no saved copy');
      else await writeText(uri, s.content);
    } catch (e) { errs.push(rel(uri) + ': ' + e.message); }
  }
  c.reverted = true;
  for (const cs of proposals.values()) if (cs.cpId === c.id) cs.status = 'reverted';
  for (const set of opSets.values()) if (set.cpId === c.id) set.status = 'reverted';
  messages.forEach((m) => { if ((m.role === 'edit' || m.role === 'fileops') && m.cpId === c.id) m.state = 'reverted'; });
  saveCheckpoints();
  persist();
  lastActivity = Date.now();
  const paths = c.files.concat(data.ops.filter((o) => o.op === 'move').map((o) => homeShort(o.path)));
  api('POST', '/api/event', { event: 'revert', data: { request_id: c.requestId, paths, trashed } }).catch(() => {});
  if (errs.length) vscode.window.showErrorMessage('AI Bridge: some changes were not undone — ' + errs.join('; '));
  else if (trashed.length) vscode.window.showInformationMessage(`AI Bridge: changes undone. ${trashed.length} item(s) are still in the Recycle Bin: restore them from there if you need them.`);
  else vscode.window.setStatusBarMessage('AI: changes undone', 4000);
}

async function undoLast() {
  const c = [...checkpoints].reverse().find((x) => !x.reverted && (x.files.length || x.ops));
  if (!c) { vscode.window.showInformationMessage('AI Bridge: no AI changes to undo.'); return; }
  await revertCheckpoint(c.id);
}

// ---- run_command ----
const META = /[&|;<>`$()\n\r%^]/;

async function runCommandJob(p) {
  const command = String(p.command || '').trim();
  if (!command) throw new Error('command missing');
  const base = folders()[0] ? folders()[0].uri.fsPath : process.cwd();
  const cwd = p.cwd ? resolvePath(p.cwd).fsPath : base;
  const auto = (cfg().get('autoApproveCommands') || []).some((a) => (command === a || command.startsWith(a + ' '))) && !META.test(command);
  const msgRef = addMessage({ role: 'cmd', text: command, state: auto ? 'auto' : 'asking' });
  if (!auto) {
    const choice = await vscode.window.showWarningMessage(
      'The AI wants to run this command:', { modal: true, detail: `${command}\n\nFolder: ${cwd}${p.reason ? '\nWhy: ' + p.reason : ''}` }, 'Run');
    if (choice !== 'Run') { msgRef.state = 'denied'; persist(); return 'The user did NOT allow this command. Ask them in your reply if it is needed, or do without it.'; }
  }
  msgRef.state = 'running'; persist();
  const timeout = Math.min(Number(p.timeout_seconds) || 120, 600) * 1000;
  const r = await new Promise((resolve) => {
    cp.exec(command, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
  msgRef.state = r.code === 0 ? 'done' : 'failed'; persist();
  const tail = (s, n) => (s.length > n ? `… [first ${s.length - n} characters left out]\n` + s.slice(-n) : s);
  return `$ ${command}\n(cwd: ${cwd})\nexit code: ${r.code}${r.killed ? ' (stopped by the timeout)' : ''}\n--- stdout ---\n${tail(r.stdout, 15000) || '(empty)'}\n--- stderr ---\n${tail(r.stderr, 6000) || '(empty)'}`;
}

// ---- integrated terminal (shell integration, VS Code 1.93+) ----
function setupTerminalCapture(context) {
  const w = vscode.window;
  if (typeof w.onDidStartTerminalShellExecution !== 'function') return;
  context.subscriptions.push(w.onDidStartTerminalShellExecution(async (e) => {
    const ex = e.execution;
    const rec = { exec: ex, terminal: e.terminal.name, command: (ex.commandLine && ex.commandLine.value) || '', cwd: ex.cwd ? ex.cwd.fsPath : '', at: Date.now(), out: '', running: true, exitCode: undefined };
    termLog.push(rec);
    if (termLog.length > 30) termLog.shift();
    try {
      for await (const d of ex.read()) {
        rec.out += d;
        if (rec.out.length > 300000) rec.out = rec.out.slice(-200000);
      }
    } catch { /* stream closed */ }
  }));
  if (typeof w.onDidEndTerminalShellExecution === 'function') {
    context.subscriptions.push(w.onDidEndTerminalShellExecution((e) => {
      const rec = [...termLog].reverse().find((r) => r.exec === e.execution);
      if (rec) { rec.running = false; rec.exitCode = e.exitCode; rec.exec = null; }
    }));
  }
}

function cleanTerm(s) {
  s = String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
  return s.split('\n').map((l) => { const parts = l.replace(/\r$/, '').split('\r'); return parts[parts.length - 1]; }).join('\n').trim();
}

async function terminalJob(p) {
  if (typeof vscode.window.onDidStartTerminalShellExecution !== 'function') return 'Reading the terminal needs VS Code 1.93 or newer.';
  const n = Math.min(Math.max(Number(p.count) || 3, 1), 10);
  let list = termLog.slice();
  if (p.terminal) list = list.filter((r) => r.terminal.toLowerCase().includes(String(p.terminal).toLowerCase()));
  list = list.slice(-n);
  if (!list.length) return 'No terminal commands captured yet. Only commands run in VS Code\'s integrated terminal after the extension started are captured, and the terminal needs shell integration (on by default for PowerShell, bash, zsh and fish).';
  return list.map((r) => {
    const out = cleanTerm(r.out);
    const tail = out.length > 8000 ? `… [${out.length - 8000} earlier characters omitted]\n` + out.slice(-8000) : out;
    const state = r.running ? 'still running' : 'exit code ' + (r.exitCode ?? 'unknown');
    return `$ ${r.command || '(command line unknown)'}\n(terminal "${r.terminal}"${r.cwd ? ', cwd ' + r.cwd : ''}, ${state}, started ${new Date(r.at).toLocaleTimeString()})\n${tail || '(no output)'}`;
  }).join('\n\n');
}

// ---- project memory & handoff ----
async function memoryJob() {
  // the first round of a chat: an AI chat has just connected
  const last = messages[messages.length - 1];
  if (!(last && last.role === 'system' && last.kind === 'connected')) {
    addMessage({ role: 'system', kind: 'connected', icon: 'plug', text: 'An AI chat connected.', action: session.url ? '' : 'linkChat' });
  }
  if (!folders().length) return { noFolder: true };
  const memory = await readBridgeFile('MEMORY.md');
  let handoff = null;
  if (handoffPending) {
    handoff = await readBridgeFile('HANDOFF.md');
    setHandoffPending(false);
    if (handoff) addMessage({ role: 'system', icon: 'debug-restart', text: 'The chat picked up the summary of the previous work.' });
  }
  return { memory: memory ? cap(memory, 20000) : null, handoff: handoff ? cap(handoff, 30000) : null };
}

async function saveMemoryJob(p) {
  const content = String(p.content || '');
  if (!content.trim()) throw new Error('content is empty');
  let text = content.trim() + '\n';
  if (p.mode === 'append') {
    const old = (await readBridgeFile('MEMORY.md')) || '';
    text = (old.trim() ? old.trimEnd() + '\n\n' : '') + content.trim() + '\n';
  }
  if (text.length > 20000) throw new Error(`memory too long (${text.length} characters): rewrite it under 20000 with mode "replace"`);
  await writeBridgeFile('MEMORY.md', text);
  addMessage({ role: 'system', icon: 'book', text: `The AI updated the project memory (${BRIDGE_DIR}/MEMORY.md).`, action: 'openMemory' });
  return `Saved ${BRIDGE_DIR}/MEMORY.md (${text.length} characters).`;
}

function setHandoffPending(v) {
  handoffPending = v;
  ctxExt.workspaceState.update('claudeBridge.handoffPending', v);
}

async function saveHandoffJob(p) {
  const summary = String(p.summary || '').trim();
  if (!summary) throw new Error('summary is empty');
  await writeBridgeFile('HANDOFF.md', `# Handoff\n\n_Written by the AI on ${new Date().toLocaleString()}_\n\n${summary}\n`);
  await handoffReady(`The AI wrote the summary of the work (${BRIDGE_DIR}/HANDOFF.md).`);
  return `Handoff saved in ${BRIDGE_DIR}/HANDOFF.md: the next chat gets it in its first follow_vscode round.`;
}

// The summary is ready: the panel starts a new conversation (the old one goes to the history) and the prompt is in the clipboard.
async function handoffReady(what) {
  setHandoffPending(true);
  await archiveSession();
  await vscode.env.clipboard.writeText(promptText());
  addMessage({ role: 'system', icon: 'arrow-swap', text: `${what} Open a new AI chat with the connector on and paste the prompt: it is already in the clipboard. The previous conversation is in the history.`, prompt: true });
  vscode.window.showInformationMessage('AI Bridge: summary ready. Open a new AI chat and paste the prompt (already copied).');
}

function summaryFromMessages(list, note) {
  const recent = list.filter((m) => ['user', 'claude', 'edit', 'plan', 'fileops'].includes(m.role)).slice(-30);
  const lines = recent.map((m) => {
    if (m.role === 'user') return `**User:** ${cap(String(m.text || ''), 1500)}`;
    if (m.role === 'claude') return `**AI:** ${cap(String(m.text || ''), 1500)}`;
    if (m.role === 'plan') return `_Plan: ${(m.steps || []).map((s) => `${s.status === 'done' ? '✓' : '○'} ${s.title}`).join('; ')}_`;
    if (m.role === 'fileops') return `_File operations (${m.state}): ${m.summary}${m.desc ? ' — ' + m.desc : ''}_`;
    return `_Change (${m.state}): ${m.desc || ''} — ${(m.files || [m.path]).join(', ')}_`;
  });
  return `# Handoff\n\n_${note} (${new Date().toLocaleString()})._\n\n${lines.join('\n\n') || '(empty history)'}\n`;
}

async function handoffCommand() {
  if (!folders().length) { vscode.window.showWarningMessage('AI Bridge: open a folder: the summary is saved in the project.'); return; }
  if (conn === 'online' && listening) {
    vscode.commands.executeCommand(VIEW);
    await sendRequest('handoff', 'Move to a new chat: write the summary of the work for the next chat.', { noEditor: true });
    return;
  }
  // no chat listening: build the summary from this panel's conversation
  await writeBridgeFile('HANDOFF.md', summaryFromMessages(messages, 'Automatic summary of the panel conversation: no chat was listening'));
  await handoffReady(`No chat was listening: I saved a summary of the panel conversation (${BRIDGE_DIR}/HANDOFF.md).`);
}

// ---- conversations: the panel keeps past conversations and the link to their AI chat ----
function newSession() { return { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), startedAt: Date.now(), url: '' }; }
function saveSession() { ctxExt.workspaceState.update('claudeBridge.session', session); }
function saveHistory() { ctxExt.workspaceState.update('claudeBridge.history', history); }
function sessionsDir() { return vscode.Uri.joinPath(ctxExt.storageUri || ctxExt.globalStorageUri, 'sessions'); }
function sessionFile(id) { return vscode.Uri.joinPath(sessionsDir(), id + '.json'); }

async function archiveSession() {
  const talk = messages.some((m) => m.role === 'user' || m.role === 'claude');
  if (talk) {
    const first = messages.find((m) => m.role === 'user' && m.kind !== 'handoff');
    const title = first ? String(first.text).replace(/\s+/g, ' ').trim().slice(0, 90) : 'Conversation';
    const entry = { id: session.id, title, startedAt: session.startedAt || (messages[0] && messages[0].at), endedAt: Date.now(), url: session.url || '', count: messages.length };
    try {
      await vscode.workspace.fs.createDirectory(sessionsDir());
      await vscode.workspace.fs.writeFile(sessionFile(entry.id), Buffer.from(JSON.stringify(messages), 'utf8'));
      history = history.filter((h) => h.id !== entry.id);
      history.push(entry);
      while (history.length > 50) {
        const old = history.shift();
        Promise.resolve(vscode.workspace.fs.delete(sessionFile(old.id))).catch(() => {});
      }
      saveHistory();
    } catch (e) {
      vscode.window.showWarningMessage('AI Bridge: could not save the conversation in the history — ' + e.message);
    }
  }
  messages = [];
  session = newSession();
  saveSession();
  uiMode = 'chat';
  viewing = null;
  persist();
}

async function newConversation() {
  if (!messages.length) return;
  await archiveSession();
  vscode.window.setStatusBarMessage('AI: new conversation — the previous one is in the history', 4000);
}

async function loadSession(id) {
  const entry = history.find((h) => h.id === id);
  if (!entry) throw new Error('conversation not found');
  let list = [];
  try { list = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(sessionFile(id))).toString('utf8')); } catch { /* lost */ }
  return { entry, list };
}

async function viewSession(id) {
  try {
    const { entry, list } = await loadSession(id);
    viewing = { ...entry, messages: list };
    uiMode = 'view';
    refresh();
  } catch (e) { vscode.window.showWarningMessage('AI Bridge: ' + e.message); }
}

async function resumeSession(id) {
  if (!folders().length) { vscode.window.showWarningMessage('AI Bridge: open a folder: the summary is saved in the project.'); return; }
  try {
    const { entry, list } = await loadSession(id);
    await writeBridgeFile('HANDOFF.md', summaryFromMessages(list, `Resuming the conversation «${entry.title}» of ${new Date(entry.startedAt).toLocaleString()}`));
    await handoffReady(`I prepared the summary of the conversation «${entry.title}».`);
  } catch (e) { vscode.window.showWarningMessage('AI Bridge: ' + e.message); }
}

async function deleteSession(id) {
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  const c = await vscode.window.showWarningMessage(`Delete the conversation «${entry.title}» from the history?`, { modal: true }, 'Delete');
  if (c !== 'Delete') return;
  history = history.filter((h) => h.id !== id);
  saveHistory();
  Promise.resolve(vscode.workspace.fs.delete(sessionFile(id))).catch(() => {});
  if (viewing && viewing.id === id) { viewing = null; uiMode = 'history'; }
  refresh();
}

async function linkChat(id) {
  const target = id ? history.find((h) => h.id === id) : session;
  if (!target) return;
  const v = await vscode.window.showInputBox({
    title: 'Link the AI chat',
    prompt: 'Paste the link of the chat, from the browser\'s address bar (https://claude.ai/chat/…). Leave empty to unlink.',
    value: target.url || '',
    ignoreFocusOut: true,
    validateInput: (x) => (!x.trim() || /^https:\/\/(www\.)?claude\.ai\/\S+$/i.test(x.trim()) ? null : 'It must be a chat link (https://claude.ai/…)'),
  });
  if (v === undefined) return;
  target.url = v.trim();
  if (id) { saveHistory(); if (viewing && viewing.id === id) viewing.url = target.url; } else saveSession();
  messages.forEach((m) => { if (m.kind === 'connected' && target === session) m.action = target.url ? '' : 'linkChat'; });
  persist();
}

function openChat(id) {
  const target = id ? history.find((h) => h.id === id) : session;
  if (target && target.url && /^https:\/\/(www\.)?claude\.ai\//i.test(target.url)) vscode.env.openExternal(vscode.Uri.parse(target.url));
}

async function linkMenu() {
  if (!session.url) return linkChat();
  const pick = await vscode.window.showQuickPick([
    { label: '$(link-external) Open the chat in the browser', id: 'open' },
    { label: '$(edit) Change the link', id: 'change' },
    { label: '$(close) Unlink', id: 'unlink' },
  ], { placeHolder: session.url });
  if (!pick) return;
  if (pick.id === 'open') openChat();
  else if (pick.id === 'change') linkChat();
  else { session.url = ''; saveSession(); refresh(); }
}

async function openMemory() {
  let uri;
  try { uri = bridgeUri('MEMORY.md'); } catch (e) { vscode.window.showWarningMessage('AI Bridge: ' + e.message); return; }
  if (!(await exists(uri))) {
    const c = await vscode.window.showInformationMessage('There is no project memory yet: the AI creates it when it learns something about the project. Create it yourself now?', 'Create');
    if (c !== 'Create') return;
    await writeText(uri, '# Project memory\n\n- \n');
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
}

// ---- quick fix on problems ----
class FixProvider {
  provideCodeActions(doc, range, context) {
    if (!token) return [];
    return context.diagnostics.slice(0, 3).map((d) => {
      const msg = d.message.split('\n')[0];
      const a = new vscode.CodeAction(`Ask the AI to fix it: ${msg.length > 60 ? msg.slice(0, 57) + '…' : msg}`, vscode.CodeActionKind.QuickFix);
      a.command = {
        command: 'aiBridge.fixDiagnostic',
        title: 'Ask the AI to fix it',
        arguments: [doc.uri.toString(), { line: d.range.start.line, col: d.range.start.character, endLine: d.range.end.line, message: d.message, source: d.source || '', severity: d.severity }],
      };
      a.diagnostics = [d];
      return a;
    });
  }
}

async function fixDiagnostic(uriStr, d) {
  if (!uriStr || !d) { vscode.window.showInformationMessage('Use the light bulb (Ctrl+.) on an underlined problem to ask the AI to fix it.'); return; }
  const uri = vscode.Uri.parse(uriStr);
  const doc = await vscode.workspace.openTextDocument(uri);
  const start = Math.max(0, d.line - 15);
  const end = Math.min(doc.lineCount - 1, (d.endLine ?? d.line) + 15);
  const lines = [];
  for (let i = start; i <= end; i++) lines.push(doc.lineAt(i).text);
  const sev = ['error', 'warning', 'info', 'hint'][d.severity] || 'error';
  const problem = `${rel(uri)}:${d.line + 1}:${d.col + 1} ${sev}: ${d.message}${d.source ? ' (' + d.source + ')' : ''}`;
  vscode.commands.executeCommand(VIEW);
  await sendRequest('fix', `Fix this problem: ${d.message.split('\n')[0]}`, { includeSelection: false, extra: { problem, snippet: numbered(lines, start + 1) } });
}

// ---- commit message ----
async function gitApi() {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return null;
    const exp = ext.isActive ? ext.exports : await ext.activate();
    return exp && exp.getAPI ? exp.getAPI(1) : null;
  } catch { return null; }
}

function pickRepo(gapi, arg) {
  const rs = gapi.repositories || [];
  if (!rs.length) return null;
  const root = arg && arg.rootUri ? arg.rootUri.toString() : null;
  if (root) { const r = rs.find((x) => x.rootUri.toString() === root); if (r) return r; }
  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const fp = ed.document.uri.fsPath;
    const r = rs.filter((x) => fp.startsWith(x.rootUri.fsPath)).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    if (r) return r;
  }
  return rs[0];
}

function execText(cmd, cwd) {
  return new Promise((resolve) => cp.exec(cmd, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (e, out) => resolve(e ? '' : String(out || ''))));
}

async function commitMessageCommand(arg) {
  if (!token) { configure(); return; }
  const gapi = await gitApi();
  const repo = gapi ? pickRepo(gapi, arg) : null;
  let repoRoot = ''; let diff = ''; let staged = true; let recent = []; let branch = '';
  if (repo) {
    repoRoot = repo.rootUri.fsPath;
    diff = await repo.diff(true);
    if (!diff.trim()) { diff = await repo.diff(false); staged = false; }
    try { recent = (await repo.log({ maxEntries: 8 })).map((c) => String(c.message || '').split('\n')[0]); } catch { /* no history */ }
    branch = (repo.state && repo.state.HEAD && repo.state.HEAD.name) || '';
  } else {
    repoRoot = folders()[0] ? folders()[0].uri.fsPath : '';
    if (!repoRoot) { vscode.window.showWarningMessage('AI Bridge: open the folder of the Git repository.'); return; }
    diff = await execText('git diff --staged', repoRoot);
    if (!diff.trim()) { diff = await execText('git diff', repoRoot); staged = false; }
    recent = (await execText('git log -8 --format=%s', repoRoot)).split('\n').filter(Boolean);
    branch = (await execText('git branch --show-current', repoRoot)).trim();
  }
  if (!diff.trim()) { vscode.window.showWarningMessage('AI Bridge: no changes to describe (nothing staged, nothing changed).'); return; }
  vscode.commands.executeCommand(VIEW);
  await sendRequest('commit', staged ? 'Write the commit message for the staged changes.' : 'Write the commit message for the changes (nothing is staged).', { noEditor: true, repoRoot, extra: { diff: cap(diff, 60000), diffStaged: staged, recentCommits: recent, branch } });
}

async function setCommitMessage(repoRoot, text) {
  const msg = String(text || '').trim().replace(/^```[\w-]*\s*\n/, '').replace(/\n```\s*$/, '').trim();
  const gapi = await gitApi();
  const repos = gapi ? gapi.repositories || [] : [];
  const repo = repos.find((r) => r.rootUri.fsPath === repoRoot) || repos[0];
  if (!repo) {
    await vscode.env.clipboard.writeText(msg);
    vscode.window.showInformationMessage('AI Bridge: commit message copied to the clipboard.');
    return;
  }
  repo.inputBox.value = msg;
  vscode.commands.executeCommand('workbench.view.scm');
  vscode.window.setStatusBarMessage('AI: commit message ready in the Git panel', 5000);
}

// ---------------- attached files ----------------
async function attachUris(list) {
  let added = 0;
  for (const u of list) {
    let uri;
    try {
      if (typeof u !== 'string') uri = u;
      else if (/^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('/') || u.startsWith('\\\\')) uri = vscode.Uri.file(u);
      else uri = vscode.Uri.parse(u);
    } catch { continue; }
    if (!uri || attachments.some((a) => a.uri === uri.toString())) continue;
    let kind = 'file';
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.type & DIR) kind = 'folder';
    } catch { vscode.window.showWarningMessage('AI Bridge: cannot find ' + (uri.fsPath || uri.toString())); continue; }
    attachments.push({ id: ++attSeq, kind, uri: uri.toString(), label: rel(uri) });
    added++;
  }
  if (added) { refresh(); vscode.commands.executeCommand(VIEW); }
  return added;
}

function attachTexts(files) {
  const bad = [];
  for (const f of files || []) {
    if (f.error) { bad.push(`${f.name}: ${f.error}`); continue; }
    attachments.push({ id: ++attSeq, kind: 'file', label: `${f.name} (from your computer)`, name: f.name, text: String(f.text || '') });
  }
  if (bad.length) vscode.window.showWarningMessage('AI Bridge: not attached — ' + bad.join('; '));
  refresh();
}

async function attachCommand(uri, uris) {
  let list = Array.isArray(uris) && uris.length ? uris : uri && uri.scheme ? [uri] : [];
  if (!list.length && vscode.window.activeTextEditor) list = [vscode.window.activeTextEditor.document.uri];
  if (!list.length) {
    list = (await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach for the AI', defaultUri: folders()[0] && folders()[0].uri })) || [];
  }
  if (list.length) await attachUris(list);
}

async function collectAttachments() {
  const out = [];
  let total = 0;
  for (const a of attachments) {
    if (total >= MAX_ATTACH_TOTAL) { out.push({ path: a.label, kind: a.kind, note: 'not included: too much attached in one request' + (a.uri ? ', read it with read_file' : ''), text: '' }); continue; }
    try {
      if (a.kind === 'folder') {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.parse(a.uri), '**/*'), EXCLUDE, 301);
        const text = files.slice(0, 300).map(rel).sort().join('\n');
        total += text.length;
        out.push({ path: a.label, kind: 'folder', note: `${Math.min(files.length, 300)} files${files.length > 300 ? ', list cut' : ''}: read the ones you need with read_file`, text });
        continue;
      }
      let raw;
      if (a.uri) {
        const uri = vscode.Uri.parse(a.uri);
        const d = openDoc(uri);
        if (d) raw = d.getText();
        else {
          const st = await vscode.workspace.fs.stat(uri);
          if (st.size > MAX_ATTACH_FILE_BYTES) { out.push({ path: a.label, kind: 'file', note: `too big to attach (${Math.round(st.size / 1024)} KB): read it with read_file`, text: '' }); continue; }
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (isBinary(bytes)) { out.push({ path: a.label, kind: 'file', note: 'binary file: not included', text: '' }); continue; }
          raw = Buffer.from(bytes).toString('utf8');
        }
      } else raw = a.text || '';
      const lines = raw.split(/\r?\n/);
      const room = Math.max(2000, MAX_ATTACH_TOTAL - total);
      let text = numbered(lines.slice(0, 1500), 1);
      const cut = lines.length > 1500 || text.length > room;
      if (text.length > room) text = text.slice(0, room);
      total += text.length;
      out.push({ path: a.uri ? a.label : a.name, kind: 'file', note: `${lines.length} lines${cut ? `, truncated${a.uri ? ': read_file for the rest' : ''}` : ''}${a.uri ? '' : ', dropped from the user\'s computer (not in the workspace)'}`, text });
    } catch (e) {
      out.push({ path: a.label, kind: a.kind, note: 'could not be read: ' + e.message, text: '' });
    }
  }
  return out;
}

// ---------------- sending requests ----------------
async function askCommand(kind) {
  const ed = vscode.window.activeTextEditor;
  const hasSel = ed && !ed.selection.isEmpty;
  if (kind === 'edit' && !hasSel) { vscode.window.showWarningMessage('Select the code to change first.'); return; }
  const text = await vscode.window.showInputBox({
    title: kind === 'edit' ? 'Edit with AI' : 'Ask AI',
    prompt: kind === 'edit' ? 'How should the selection change?' : (hasSel ? 'Question about the selection' : 'Question (context: the active file)'),
    ignoreFocusOut: true,
  });
  if (!text) return;
  vscode.commands.executeCommand(VIEW);
  await sendRequest(kind, text, { includeSelection: true });
}

async function sendRequest(kind, text, opts = {}) {
  if (!token) { configure(); return; }
  lastActivity = Date.now();
  let context = null;
  if (kind !== 'stop') {
    context = buildContext(opts);
    if (opts.extra) Object.assign(context, opts.extra);
    if (attachments.length && ['chat', 'edit', 'fix'].includes(kind)) {
      context.attachments = await collectAttachments();
      attachments = [];
    }
  }
  const sel = context && context.selection ? `${context.file}:${context.selection.startLine}-${context.selection.endLine}` : (opts.includeFile && context && context.file ? context.file + ' (whole file)' : '');
  const m = addMessage({
    role: kind === 'stop' ? 'system' : 'user',
    text: kind === 'stop' ? 'You asked the AI to stop following VS Code.' : text,
    kind,
    state: 'sending',
    sel,
    atts: context && context.attachments ? context.attachments.map((a) => a.path) : undefined,
    agent: agentMode && ['chat', 'edit', 'fix'].includes(kind),
    repoRoot: opts.repoRoot,
  });
  try {
    const r = await api('POST', '/api/request', { kind, text, context, agent: agentMode }, 60000);
    m.requestId = r.seq;
    m.state = earlyStates.get(r.seq) || 'sent';
    earlyStates.delete(r.seq);
    if (!r.claudeListening && kind !== 'stop') {
      addMessage({ role: 'system', text: 'No AI chat is listening. Paste the prompt into an AI chat (with the VS Code Bridge connector on): the request waits in line and will be picked up.', prompt: true });
    }
    persist();
  } catch (e) {
    m.state = 'error';
    m.error = e.message;
    persist();
  }
}

function setAgent(on) {
  agentMode = !!on;
  ctxExt.workspaceState.update('claudeBridge.agent', agentMode);
  vscode.window.setStatusBarMessage(agentMode ? 'AI: agent mode on — changes are applied at once, you can undo them for each request' : 'AI: agent mode off — every change is proposed to you first', 5000);
  refresh();
}

// ---------------- messages & UI ----------------
function addMessage(m) {
  m.id = ++msgSeq;
  m.at = Date.now();
  messages.push(m);
  if (messages.length > 200) messages = messages.slice(-200);
  persist();
  return m;
}

function persist() {
  ctxExt.workspaceState.update('claudeBridge.messages', messages);
  refresh();
}

function refresh() {
  updateStatus();
  if (panel) panel.post();
}

function updateStatus() {
  if (!statusItem) return;
  const ag = agentMode ? ' · agent' : '';
  if (conn === 'unconfigured') { statusItem.text = '$(gear) AI: set up'; statusItem.tooltip = 'AI Bridge: Configure'; }
  else if (conn === 'offline') { statusItem.text = '$(debug-disconnect) AI: offline'; statusItem.tooltip = connError; }
  else if (listening) { statusItem.text = '$(comment-discussion) AI: listening' + ag; statusItem.tooltip = 'An AI chat is following VS Code'; }
  else { statusItem.text = '$(comment) AI: not listening' + ag; statusItem.tooltip = 'Copy the prompt from the AI panel and paste it into an AI chat'; }
}

const icon = (n) => `<i class="codicon codicon-${n}"></i>`;

class ChatViewProvider {
  constructor(extUri) { this.extUri = extUri; this.view = null; }
  resolveWebviewView(view) {
    this.view = view;
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const res = (...p) => w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', ...p));
    w.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${res('codicons', 'codicon.css')}"><link rel="stylesheet" href="${res('panel.css')}"></head>
<body>
<header id="top"><div id="status"></div><div class="tools">
<button class="icon" id="historyBtn" data-act="toggleHistory" title="Past conversations">${icon('history')}</button>
<button class="icon" id="linkBtn" data-act="linkMenu" title="Link this conversation to its AI chat">${icon('link')}</button>
<button class="icon" data-act="handoff" title="Move to a new AI chat: the AI writes a summary and the new chat starts from there">${icon('arrow-swap')}</button>
<button class="icon" data-act="openMemory" title="Project memory: notes the AI reads at the start of every chat">${icon('book')}</button>
<button class="icon" data-act="newConversation" title="New conversation (the current one goes to the history)">${icon('add')}</button>
<button class="icon" data-act="configure" title="Configure server and token">${icon('gear')}</button>
</div></header>
<div id="log"></div>
<button id="toBottom" class="icon" title="Go to the bottom">${icon('arrow-down')}</button>
<form id="f"><div class="composer"><div id="atts"></div>
<textarea id="q" rows="1" placeholder="Ask AI…"></textarea>
<div class="bar">
<button type="button" class="icon" id="attach" title="Attach files (or drag them into the panel)">${icon('new-file')}</button>
<button type="button" class="pill agent" id="agentBtn" aria-pressed="false" title="Agent mode: the AI applies changes on its own, and you can undo everything for each request">${icon('robot')}Agent</button>
<button type="button" class="pill" id="selBtn" aria-pressed="true" title="Include the selected code">${icon('selection')}Selection</button>
<button type="button" class="pill" id="fileBtn" aria-pressed="false" title="Include the whole active file">${icon('file')}File</button>
<span class="sp"></span>
<button type="button" class="icon" id="stop" title="Stop: the AI chat stops following VS Code">${icon('debug-stop')}</button>
<button type="submit" class="send" id="send" title="Send (Enter)">${icon('send')}</button>
</div></div>
<div class="hint">Enter to send · Shift+Enter for a new line · drop files here</div></form>
<div id="drop">${icon('new-file')}<div>Drop to attach for the AI</div><small>If VS Code opens the file instead of attaching it, hold Shift while dropping.</small></div>
<script nonce="${nonce}" src="${res('panel.js')}"></script></body></html>`;
    w.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => { if (view.visible) this.post(); });
    this.post();
  }
  post() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'state', conn, connError, listening, messages, prompt: promptText(), hasToken: !!token,
      agent: agentMode, windows: windowsOnline, windowLabel: windowLabel(),
      attachments: attachments.map(({ id, kind, label }) => ({ id, kind, label })),
      checkpoints: checkpoints.map(({ id, requestId, files, ops, reverted }) => ({ id, requestId, files, ops: ops || 0, reverted })),
      session: { url: session ? session.url : '' }, history, mode: uiMode, viewing,
    });
  }
  async onMessage(m) {
    switch (m.type) {
      case 'ready': return this.post();
      case 'send': uiMode = 'chat'; viewing = null; return sendRequest('chat', m.text, { includeSelection: m.sel, includeFile: m.file });
      case 'stop': return sendRequest('stop', 'STOP', {});
      case 'configure': return configure();
      case 'copy': await vscode.env.clipboard.writeText(m.text || ''); vscode.window.setStatusBarMessage('Copied', 2000); return;
      case 'copyPrompt': return copyPrompt();
      case 'insert': {
        const ed = vscode.window.visibleTextEditors.find((e) => e === vscode.window.activeTextEditor) || vscode.window.visibleTextEditors[0];
        if (!ed) { vscode.window.showWarningMessage('Open a file to insert the code into.'); return; }
        await ed.edit((b) => b.replace(ed.selection, m.text || ''));
        return;
      }
      case 'accept': return acceptEdit(m.editId);
      case 'reject': return rejectEdit(m.editId);
      case 'diff': return showChanges(m.editId);
      case 'acceptOps': return acceptOps(m.id);
      case 'rejectOps': return rejectOps(m.id);
      case 'showOps': return showOps(m.id);
      case 'revert': return revertCheckpoint(m.id);
      case 'agent': return setAgent(!!m.on);
      case 'handoff': return handoffCommand();
      case 'openMemory': return openMemory();
      case 'newConversation': return newConversation();
      case 'toggleHistory': uiMode = uiMode === 'chat' ? 'history' : 'chat'; viewing = null; return refresh();
      case 'openHistory': uiMode = 'history'; viewing = null; return refresh();
      case 'closeHistory': uiMode = 'chat'; viewing = null; return refresh();
      case 'viewSession': return viewSession(m.id);
      case 'resumeSession': return resumeSession(m.id);
      case 'deleteSession': return deleteSession(m.id);
      case 'linkChat': return linkChat(m.id);
      case 'openChat': return openChat(m.id);
      case 'linkMenu': return linkMenu();
      case 'attachUris': return attachUris(Array.isArray(m.uris) ? m.uris : []);
      case 'attachFiles': return attachTexts(m.files);
      case 'pickFiles': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach for the AI', defaultUri: folders()[0] && folders()[0].uri });
        if (picked && picked.length) await attachUris(picked);
        return;
      }
      case 'removeAttachment': attachments = attachments.filter((a) => a.id !== m.id); return refresh();
      case 'clear': return newConversation();
    }
  }
}

module.exports = { activate, deactivate };
