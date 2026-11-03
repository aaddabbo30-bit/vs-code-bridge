// Claude Bridge — VS Code extension
// Talks only to the user's own VS Code Bridge server (HTTPS out). No API keys.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TOKEN_KEY = 'claudeBridge.token';
const EXCLUDE = '**/{node_modules,.git,.svn,.venv,venv,env,__pycache__,.mypy_cache,.pytest_cache,.ruff_cache,dist,build,out,.idea,.ipynb_checkpoints,.Rproj.user}/**';
const BRIDGE_DIR = '.claude-bridge';
const MAX_ATTACH_TOTAL = 150000; // characters of attached files per request
const MAX_ATTACH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const KEEP_CHECKPOINTS = 30;

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
let checkpoints = []; // [{id, requestId, files: [relPath], uris: [uri], reverted, at}]
let attachments = []; // [{id, kind: 'file'|'folder', label, uri?, text?}]
let attSeq = 0;
let session = null; // the panel conversation in progress: {id, startedAt, url}
let history = []; // archived conversations: [{id, title, startedAt, endedAt, url, count}]
let uiMode = 'chat'; // chat | history | view
let viewing = null; // archived conversation shown read-only
const proposals = new Map(); // editId -> change set {editId, files, desc, status, requestId, cpId}
const cpCache = new Map(); // checkpoint id -> {files: {uri: {existed, content}}}
const seenJobs = new Set();
const termLog = []; // recent commands run in the integrated terminal

// ---------------- activation ----------------
async function activate(context) {
  ctxExt = context;
  token = (await context.secrets.get(TOKEN_KEY)) || '';
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
    if (m.role === 'edit' && m.state === 'pending') m.state = 'expired';
  });

  panel = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeBridge.chat', panel, { webviewOptions: { retainContextWhenHidden: true } }));

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('claude-proposal', { provideTextDocumentContent: (u) => changeText(u, 'proposed') }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('claude-orig', { provideTextDocumentContent: (u) => changeText(u, 'originalText') }));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('claude-empty', { provideTextDocumentContent: () => '' }));

  context.subscriptions.push(vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], new FixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
  setupTerminalCapture(context);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'workbench.view.extension.claudeBridge';
  context.subscriptions.push(statusItem);
  updateStatus();
  statusItem.show();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('claudeBridge.configure', configure);
  reg('claudeBridge.ask', () => askCommand('chat'));
  reg('claudeBridge.editSelection', () => askCommand('edit'));
  reg('claudeBridge.stop', () => sendRequest('stop', 'STOP', { includeSelection: false }));
  reg('claudeBridge.clear', newConversation);
  reg('claudeBridge.history', () => { uiMode = uiMode === 'chat' ? 'history' : 'chat'; viewing = null; refresh(); vscode.commands.executeCommand('workbench.view.extension.claudeBridge'); });
  reg('claudeBridge.linkChat', () => linkMenu());
  reg('claudeBridge.copyPrompt', copyPrompt);
  reg('claudeBridge.acceptEdit', (id) => acceptEdit(id));
  reg('claudeBridge.rejectEdit', (id) => rejectEdit(id));
  reg('claudeBridge.toggleAgent', () => setAgent(!agentMode));
  reg('claudeBridge.undoLast', undoLast);
  reg('claudeBridge.handoff', handoffCommand);
  reg('claudeBridge.commitMessage', commitMessageCommand);
  reg('claudeBridge.fixDiagnostic', fixDiagnostic);
  reg('claudeBridge.attach', attachCommand);
  reg('claudeBridge.openMemory', openMemory);

  context.subscriptions.push({ dispose: () => { running = false; } });
  if (!token) {
    vscode.window.showInformationMessage('Claude Bridge: inserisci URL del server e token per iniziare.', 'Configura').then((c) => { if (c) configure(); });
  }
  pollLoop();
}

function deactivate() { running = false; }

// ---------------- config & http ----------------
function cfg() { return vscode.workspace.getConfiguration('claudeBridge'); }
function serverUrl() { return String(cfg().get('serverUrl') || '').replace(/\/+$/, ''); }
function windowLabel() { return String(cfg().get('windowName') || '').trim() || `${vscode.workspace.name || 'senza cartella'} · ${os.hostname()}`; }
function promptText() {
  return `Segui VS Code con il connector VS Code Bridge (finestra «${windowLabel()}», window "${clientId}"): chiama follow_vscode con window "${clientId}" in loop e rispondi alle mie richieste dentro VS Code, finché non premo Stop. Non scrivere in questa chat.`;
}

function existingChatPromptText() {
  return `Collega questa chat a VS Code con il connector VS Code Bridge (finestra «${windowLabel()}», window "${clientId}"): usa quello che ci siamo detti qui come contesto per le mie richieste da VS Code. Se in questa chat ci sono decisioni utili per il progetto, salvale prima con save_memory (mode "append"). Poi chiama follow_vscode con window "${clientId}" in loop e rispondi alle mie richieste dentro VS Code, finché non premo Stop. Non scrivere in questa chat.`;
}

async function copyPrompt() {
  const pick = await vscode.window.showQuickPick([
    { label: '$(add) Per una chat nuova', detail: 'Apri una chat nuova in claude.ai, attiva il connector VS Code Bridge e incolla.', id: 'new' },
    { label: '$(comment-discussion) Per una chat che esiste già', detail: 'Incollalo in una chat dove hai già parlato del lavoro: Claude userà quel contesto per agire qui in VS Code.', id: 'existing' },
  ], { title: 'Copia il prompt per claude.ai', placeHolder: 'Dove lo incolli?' });
  if (!pick) return;
  await vscode.env.clipboard.writeText(pick.id === 'existing' ? existingChatPromptText() : promptText());
  const c = await vscode.window.showInformationMessage('Prompt copiato: incollalo nella chat di claude.ai (con il connector VS Code Bridge attivo). Vuoi collegare anche il link di quella chat, per riaprirla da qui?', 'Collega link');
  if (c) linkChat();
}

async function configure() {
  const url = await vscode.window.showInputBox({ title: 'Claude Bridge (1/2)', prompt: 'Indirizzo del server VS Code Bridge', value: serverUrl(), ignoreFocusOut: true });
  if (url === undefined) return;
  await cfg().update('serverUrl', url.trim().replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
  const t = await vscode.window.showInputBox({ title: 'Claude Bridge (2/2)', prompt: 'Token (lo stesso del secret BRIDGE_TOKEN sul server)', password: true, value: token, ignoreFocusOut: true });
  if (t === undefined) return;
  token = t.trim();
  await ctxExt.secrets.store(TOKEN_KEY, token);
  try {
    const r = await api('GET', '/api/poll?wait=0', null, 15000);
    conn = 'online'; listening = !!r.claudeListening; connError = '';
    vscode.window.showInformationMessage('Claude Bridge: collegato al server.');
  } catch (e) {
    conn = 'offline'; connError = e.message;
    vscode.window.showErrorMessage('Claude Bridge: non riesco a collegarmi — ' + e.message);
  }
  refresh();
}

function api(method, p, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(serverUrl() + p); } catch (e) { return reject(new Error('URL del server non valido')); }
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'X-Bridge-Client': clientId, 'X-Bridge-Label': encodeURIComponent(windowLabel()) };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = lib.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) return reject(new Error('token sbagliato (401)'));
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + t.slice(0, 200)));
        try { resolve(t ? JSON.parse(t) : {}); } catch { reject(new Error('risposta non valida: ' + t.slice(0, 120))); }
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

// ---------------- jobs from Claude ----------------
const HANDLERS = {
  context: () => buildContext({ selCap: 20000 }),
  read_file: readFileJob,
  list_files: listFilesJob,
  search: searchJob,
  get_diagnostics: diagnosticsJob,
  propose_edit: (p, j) => proposeChangesJob({ description: p.description, request_id: p.request_id, files: [{ path: p.path, edits: p.edits, new_content: p.new_content }] }, j),
  propose_changes: proposeChangesJob,
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
    if (!h) throw new Error('Tipo sconosciuto: ' + j.type + ' (aggiorna l\'estensione Claude Bridge)');
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
  if (!p) throw new Error('path mancante');
  p = String(p).trim();
  if (/^file:\/\//i.test(p)) return vscode.Uri.parse(p);
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return vscode.Uri.file(p);
  const fs = folders();
  if (!fs.length) throw new Error('Nessuna cartella aperta in VS Code: usa un percorso assoluto.');
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
      if (!(await vscode.workspace.applyEdit(we))) throw new Error('VS Code non ha applicato la modifica a ' + rel(uri));
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
const cap = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [troncato, ${s.length - n} caratteri in più]` : s);

function numbered(lines, start) {
  const w = String(start + lines.length).length;
  return lines.map((l, i) => String(start + i).padStart(w, ' ') + '| ' + l).join('\n');
}

function fmtDiag(d, uri) {
  const sev = ['error', 'warning', 'info', 'hint'][d.severity] || 'info';
  return `${uri ? rel(uri) + ':' : 'line '}${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message}${d.source ? ' (' + d.source + ')' : ''}`;
}

function bridgeUri(name) {
  const f = folders()[0];
  if (!f) throw new Error('Nessuna cartella aperta in VS Code: la memoria e il riassunto vengono salvati nel progetto.');
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
      ctx.fileText = cap(numbered(lines.slice(0, 2000), 1), 90000) + (lines.length > 2000 ? `\n… [file lungo: ${lines.length} righe, usa read_file per il resto]` : '');
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
  let head = `${rel(uri)} — ${lines.length} righe${dirty ? ' (modifiche non salvate incluse)' : ''}; mostrate ${start}-${end}`;
  if (end < lines.length) head += ` — continua con start_line=${end + 1}`;
  return head + '\n' + body;
}

async function listFilesJob(p) {
  const max = Math.min(Number(p.max) || 300, 2000);
  const files = await vscode.workspace.findFiles(p.glob || '**/*', EXCLUDE, max + 1);
  const list = files.map(rel).sort();
  const more = list.length > max;
  return `${Math.min(list.length, max)} file${more ? ' (lista troncata, usa un glob più preciso)' : ''}:\n` + list.slice(0, max).join('\n');
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function searchJob(p) {
  if (!p.query) throw new Error('query mancante');
  const max = Math.min(Number(p.max) || 150, 500);
  let re;
  try { re = new RegExp(p.regex ? p.query : escRe(p.query), p.case_sensitive ? '' : 'i'); } catch (e) { throw new Error('regex non valida: ' + e.message); }
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
  return `${out.length} risultati in ${scanned} file${truncated ? ' (troncato)' : ''}` + (out.length ? ':\n' + out.join('\n') : '.');
}

async function diagnosticsJob(p) {
  let pairs;
  if (p.path) { const u = resolvePath(p.path); pairs = [[u, vscode.languages.getDiagnostics(u)]]; }
  else pairs = vscode.languages.getDiagnostics();
  const lines = [];
  for (const [u, ds] of pairs) for (const d of ds) lines.push({ sev: d.severity, s: fmtDiag(d, u) });
  lines.sort((a, b) => a.sev - b.sev);
  if (!lines.length) return 'Nessun problema segnalato da VS Code' + (p.path ? ' per questo file.' : '.') + ' (VS Code segnala problemi solo per i file che il linter/language server ha analizzato.)';
  return `${lines.length} problemi:\n` + lines.slice(0, 300).map((x) => x.s).join('\n');
}

async function openFileJob(p) {
  const uri = resolvePath(p.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = Math.max(0, (Number(p.line) || 1) - 1);
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
  return `Aperto ${rel(uri)}${p.line ? ' alla riga ' + p.line : ''}.`;
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
    if (!oldT) throw new Error(`edit ${i + 1}: old_text vuoto`);
    let count = 0; let idx = -1; let from = 0;
    while ((idx = out.indexOf(oldT, from)) !== -1) { count++; from = idx + oldT.length; if (count > 1) break; }
    if (count === 0) throw new Error(`edit ${i + 1}: old_text non trovato nel file (rileggilo con read_file e copialo esatto)`);
    if (count > 1) throw new Error(`edit ${i + 1}: old_text compare più volte, aggiungi righe intorno per renderlo unico`);
    const at = out.indexOf(oldT);
    out = out.slice(0, at) + newT + out.slice(at + oldT.length);
  });
  return out;
}

async function buildChange(s) {
  const uri = resolvePath(s.path);
  const ex = await exists(uri);
  if (s.delete) {
    if (!ex) throw new Error('il file non esiste, non posso eliminarlo');
    return { uri, del: true, isNew: false, originalText: (await readText(uri)).text, proposed: '', edits: null };
  }
  if (!ex) {
    if (typeof s.new_content !== 'string') throw new Error('il file non esiste: per crearlo usa new_content');
    return { uri, del: false, isNew: true, originalText: '', proposed: s.new_content, edits: null };
  }
  const originalText = (await readText(uri)).text;
  const edits = Array.isArray(s.edits) && s.edits.length ? s.edits : null;
  let proposed;
  if (edits) proposed = applyEdits(originalText, edits);
  else if (typeof s.new_content === 'string') {
    const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
    proposed = s.new_content.replace(/\r\n/g, '\n').replace(/\n/g, eol);
  } else throw new Error('servono edits oppure new_content (o delete)');
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
  if (!specs.length) throw new Error('nessun file indicato');
  if (specs.length > 50) throw new Error('troppi file in una volta (max 50)');
  const files = [];
  const seen = new Set();
  for (const [i, s] of specs.entries()) {
    try {
      const f = await buildChange(s || {});
      if (!f) continue;
      const k = f.uri.toString();
      if (seen.has(k)) throw new Error('lo stesso file compare due volte');
      seen.add(k);
      files.push(f);
    } catch (e) {
      throw new Error((specs.length > 1 ? `file ${i + 1} (${s && s.path}): ` : '') + e.message);
    }
  }
  if (!files.length) throw new Error('la modifica non cambia niente nei file');
  const editId = 'e' + String(job.id).replace(/^j/, '');
  const requestId = p.request_id ?? latestRequestId();
  const cs = { editId, files, desc: String(p.description || '').slice(0, 300), status: 'pending', requestId, cpId: null };
  proposals.set(editId, cs);
  const list = files.map((f) => rel(f.uri) + (f.isNew ? ' (nuovo)' : f.del ? ' (eliminato)' : ''));

  if (agentMode) {
    await applyChangeset(cs);
    cs.status = 'applied';
    addMessage({ role: 'edit', editId, files: list, desc: cs.desc, state: 'applied', requestId, cpId: cs.cpId });
    const probs = await problemsIn(files);
    return `Applied at once (agent mode) — edit ${editId}: ${list.join(', ')}. The user can undo everything done for this request from the panel.\n${probs}`;
  }

  addMessage({ role: 'edit', editId, files: list, desc: cs.desc, state: 'pending', requestId });
  await showChanges(editId);
  const what = files.length > 1 ? `modifiche a ${files.length} file` : `una modifica a ${path.basename(files[0].uri.fsPath)}`;
  vscode.window.showInformationMessage(`Claude propone ${what}: ${cs.desc}`, 'Accetta', 'Rifiuta').then((c) => {
    if (c === 'Accetta') acceptEdit(editId);
    else if (c === 'Rifiuta') rejectEdit(editId);
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
        throw new Error(`${rel(f.uri)} esiste già`);
      }
      steps.push({ f, op: 'write', text: f.proposed });
      continue;
    }
    if (!ex) throw new Error(`${rel(f.uri)} non esiste più`);
    const cur = (await readText(f.uri)).text;
    let text = f.proposed;
    if (cur !== f.originalText) {
      if (!f.edits) throw new Error(`${rel(f.uri)} è cambiato dopo la proposta`);
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
  if (!cs) { vscode.window.showWarningMessage('Questa modifica non è più disponibile (VS Code è stato riavviato).'); return; }
  const done = cs.status === 'applied' || cs.status === 'accepted';
  const title = `Claude: ${cs.desc.slice(0, 60) || 'modifica'} [${editId}]`;
  const triples = cs.files.map((f, i) => {
    const name = '/' + path.basename(f.uri.fsPath);
    const q = `${editId}|${i}`;
    const empty = vscode.Uri.from({ scheme: 'claude-empty', path: name });
    if (done) return [f.uri, f.isNew ? empty : vscode.Uri.from({ scheme: 'claude-orig', path: name, query: q }), f.del ? empty : f.uri];
    return [f.uri, f.isNew ? empty : f.uri, f.del ? empty : vscode.Uri.from({ scheme: 'claude-proposal', path: name, query: q })];
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
    vscode.window.showErrorMessage('Claude Bridge: modifica non applicata — ' + e.message);
  }
}

async function rejectEdit(editId) {
  const cs = proposals.get(editId);
  if (!cs || cs.status !== 'pending') return;
  const note = await vscode.window.showInputBox({ prompt: 'Vuoi dire a Claude perché? (facoltativo)', ignoreFocusOut: false });
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

// ---- restore points: one per request, so everything Claude did for it can be undone ----
function cpDir() { return vscode.Uri.joinPath(ctxExt.storageUri || ctxExt.globalStorageUri, 'checkpoints'); }
function cpFile(id) { return vscode.Uri.joinPath(cpDir(), id + '.json'); }

async function loadCp(id) {
  if (cpCache.has(id)) return cpCache.get(id);
  let data = { files: {} };
  try { data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(cpFile(id))).toString('utf8')); } catch { /* none yet */ }
  cpCache.set(id, data);
  return data;
}

async function checkpointFor(requestId) {
  let c = requestId != null ? [...checkpoints].reverse().find((x) => x.requestId === requestId && !x.reverted) : null;
  if (!c) {
    c = { id: 'cp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), requestId: requestId ?? null, files: [], uris: [], reverted: false, at: Date.now() };
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
    if (st.size > MAX_SNAPSHOT_BYTES) throw new Error(`${rel(uri)} è troppo grande per il punto di ripristino (più di 5 MB)`);
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
  if (!c || c.reverted || !c.files.length) return;
  const pick = await vscode.window.showWarningMessage(
    `Annullare le modifiche di Claude${c.requestId != null ? ' per la richiesta #' + c.requestId : ''}?`,
    { modal: true, detail: `Questi file tornano com'erano prima:\n${c.files.join('\n')}\n\nSe li hai cambiati anche tu dopo, perdi anche quelle modifiche.` },
    'Annulla le modifiche');
  if (pick !== 'Annulla le modifiche') return;
  const data = await loadCp(c.id);
  const errs = [];
  for (const [k, s] of Object.entries(data.files)) {
    const uri = vscode.Uri.parse(k);
    try {
      if (!s.existed) { if (await exists(uri)) await deleteFile(uri); }
      else if (s.content == null) errs.push(rel(uri) + ': nessuna copia salvata');
      else await writeText(uri, s.content);
    } catch (e) { errs.push(rel(uri) + ': ' + e.message); }
  }
  c.reverted = true;
  for (const cs of proposals.values()) if (cs.cpId === c.id) cs.status = 'reverted';
  messages.forEach((m) => { if (m.role === 'edit' && m.cpId === c.id) m.state = 'reverted'; });
  saveCheckpoints();
  persist();
  lastActivity = Date.now();
  api('POST', '/api/event', { event: 'revert', data: { request_id: c.requestId, paths: c.files } }).catch(() => {});
  if (errs.length) vscode.window.showErrorMessage('Claude Bridge: alcune modifiche non sono state annullate — ' + errs.join('; '));
  else vscode.window.setStatusBarMessage('Claude: modifiche annullate', 4000);
}

async function undoLast() {
  const c = [...checkpoints].reverse().find((x) => !x.reverted && x.files.length);
  if (!c) { vscode.window.showInformationMessage('Claude Bridge: nessuna modifica di Claude da annullare.'); return; }
  await revertCheckpoint(c.id);
}

// ---- run_command ----
const META = /[&|;<>`$()\n\r%^]/;

async function runCommandJob(p) {
  const command = String(p.command || '').trim();
  if (!command) throw new Error('command mancante');
  const base = folders()[0] ? folders()[0].uri.fsPath : process.cwd();
  const cwd = p.cwd ? resolvePath(p.cwd).fsPath : base;
  const auto = (cfg().get('autoApproveCommands') || []).some((a) => (command === a || command.startsWith(a + ' '))) && !META.test(command);
  const msgRef = addMessage({ role: 'cmd', text: command, state: auto ? 'auto' : 'asking' });
  if (!auto) {
    const choice = await vscode.window.showWarningMessage(
      'Claude vuole eseguire questo comando:', { modal: true, detail: `${command}\n\nCartella: ${cwd}${p.reason ? '\nMotivo: ' + p.reason : ''}` }, 'Esegui');
    if (choice !== 'Esegui') { msgRef.state = 'denied'; persist(); return 'The user did NOT allow this command. Ask them in your reply if it is needed, or do without it.'; }
  }
  msgRef.state = 'running'; persist();
  const timeout = Math.min(Number(p.timeout_seconds) || 120, 600) * 1000;
  const r = await new Promise((resolve) => {
    cp.exec(command, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
  msgRef.state = r.code === 0 ? 'done' : 'failed'; persist();
  const tail = (s, n) => (s.length > n ? `… [${s.length - n} caratteri iniziali omessi]\n` + s.slice(-n) : s);
  return `$ ${command}\n(cwd: ${cwd})\nexit code: ${r.code}${r.killed ? ' (interrotto per timeout)' : ''}\n--- stdout ---\n${tail(r.stdout, 15000) || '(vuoto)'}\n--- stderr ---\n${tail(r.stderr, 6000) || '(vuoto)'}`;
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
  // the first round of a chat: a claude.ai chat has just connected
  const last = messages[messages.length - 1];
  if (!(last && last.role === 'system' && last.kind === 'connected')) {
    addMessage({ role: 'system', kind: 'connected', icon: 'plug', text: 'Una chat di claude.ai si è collegata.', action: session.url ? '' : 'linkChat' });
  }
  if (!folders().length) return { noFolder: true };
  const memory = await readBridgeFile('MEMORY.md');
  let handoff = null;
  if (handoffPending) {
    handoff = await readBridgeFile('HANDOFF.md');
    setHandoffPending(false);
    if (handoff) addMessage({ role: 'system', icon: 'debug-restart', text: 'La chat ha ripreso il riassunto del lavoro precedente.' });
  }
  return { memory: memory ? cap(memory, 20000) : null, handoff: handoff ? cap(handoff, 30000) : null };
}

async function saveMemoryJob(p) {
  const content = String(p.content || '');
  if (!content.trim()) throw new Error('content vuoto');
  let text = content.trim() + '\n';
  if (p.mode === 'append') {
    const old = (await readBridgeFile('MEMORY.md')) || '';
    text = (old.trim() ? old.trimEnd() + '\n\n' : '') + content.trim() + '\n';
  }
  if (text.length > 20000) throw new Error(`memoria troppo lunga (${text.length} caratteri): riscrivila più corta di 20000 con mode "replace"`);
  await writeBridgeFile('MEMORY.md', text);
  addMessage({ role: 'system', icon: 'book', text: 'Claude ha aggiornato la memoria di progetto (.claude-bridge/MEMORY.md).', action: 'openMemory' });
  return `Saved .claude-bridge/MEMORY.md (${text.length} characters).`;
}

function setHandoffPending(v) {
  handoffPending = v;
  ctxExt.workspaceState.update('claudeBridge.handoffPending', v);
}

async function saveHandoffJob(p) {
  const summary = String(p.summary || '').trim();
  if (!summary) throw new Error('summary vuoto');
  await writeBridgeFile('HANDOFF.md', `# Passaggio di consegne\n\n_Scritto da Claude il ${new Date().toLocaleString()}_\n\n${summary}\n`);
  await handoffReady('Claude ha scritto il riassunto del lavoro (.claude-bridge/HANDOFF.md).');
  return 'Handoff saved in .claude-bridge/HANDOFF.md: the next chat gets it in its first follow_vscode round.';
}

// The summary is ready: the panel starts a new conversation (the old one goes to the history) and the prompt is in the clipboard.
async function handoffReady(what) {
  setHandoffPending(true);
  await archiveSession();
  await vscode.env.clipboard.writeText(promptText());
  addMessage({ role: 'system', icon: 'arrow-swap', text: `${what} Apri una nuova chat in claude.ai con il connector attivo e incolla il prompt: è già negli appunti. La conversazione precedente è nella cronologia.`, prompt: true });
  vscode.window.showInformationMessage('Claude Bridge: riassunto pronto. Apri una nuova chat in claude.ai e incolla il prompt (già copiato).');
}

function summaryFromMessages(list, note) {
  const recent = list.filter((m) => ['user', 'claude', 'edit', 'plan'].includes(m.role)).slice(-30);
  const lines = recent.map((m) => {
    if (m.role === 'user') return `**Utente:** ${cap(String(m.text || ''), 1500)}`;
    if (m.role === 'claude') return `**Claude:** ${cap(String(m.text || ''), 1500)}`;
    if (m.role === 'plan') return `_Piano: ${(m.steps || []).map((s) => `${s.status === 'done' ? '✓' : '○'} ${s.title}`).join('; ')}_`;
    return `_Modifica (${m.state}): ${m.desc || ''} — ${(m.files || [m.path]).join(', ')}_`;
  });
  return `# Passaggio di consegne\n\n_${note} (${new Date().toLocaleString()})._\n\n${lines.join('\n\n') || '(cronologia vuota)'}\n`;
}

async function handoffCommand() {
  if (!folders().length) { vscode.window.showWarningMessage('Claude Bridge: apri una cartella, il riassunto viene salvato nel progetto.'); return; }
  if (conn === 'online' && listening) {
    vscode.commands.executeCommand('workbench.view.extension.claudeBridge');
    await sendRequest('handoff', 'Passa a una nuova chat: scrivi il riassunto del lavoro per la prossima chat.', { noEditor: true });
    return;
  }
  // no chat listening: build the summary from this panel's conversation
  await writeBridgeFile('HANDOFF.md', summaryFromMessages(messages, 'Riassunto automatico dalla conversazione del pannello: nessuna chat era in ascolto'));
  await handoffReady('Nessuna chat in ascolto: ho salvato un riassunto della conversazione del pannello (.claude-bridge/HANDOFF.md).');
}

// ---- conversations: the panel keeps past conversations and their claude.ai link ----
function newSession() { return { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), startedAt: Date.now(), url: '' }; }
function saveSession() { ctxExt.workspaceState.update('claudeBridge.session', session); }
function saveHistory() { ctxExt.workspaceState.update('claudeBridge.history', history); }
function sessionsDir() { return vscode.Uri.joinPath(ctxExt.storageUri || ctxExt.globalStorageUri, 'sessions'); }
function sessionFile(id) { return vscode.Uri.joinPath(sessionsDir(), id + '.json'); }

async function archiveSession() {
  const talk = messages.some((m) => m.role === 'user' || m.role === 'claude');
  if (talk) {
    const first = messages.find((m) => m.role === 'user' && m.kind !== 'handoff');
    const title = first ? String(first.text).replace(/\s+/g, ' ').trim().slice(0, 90) : 'Conversazione';
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
      vscode.window.showWarningMessage('Claude Bridge: non sono riuscito a salvare la conversazione nella cronologia — ' + e.message);
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
  vscode.window.setStatusBarMessage('Claude: nuova conversazione — quella di prima è nella cronologia', 4000);
}

async function loadSession(id) {
  const entry = history.find((h) => h.id === id);
  if (!entry) throw new Error('conversazione non trovata');
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
  } catch (e) { vscode.window.showWarningMessage('Claude Bridge: ' + e.message); }
}

async function resumeSession(id) {
  if (!folders().length) { vscode.window.showWarningMessage('Claude Bridge: apri una cartella, il riassunto viene salvato nel progetto.'); return; }
  try {
    const { entry, list } = await loadSession(id);
    await writeBridgeFile('HANDOFF.md', summaryFromMessages(list, `Ripresa della conversazione «${entry.title}» del ${new Date(entry.startedAt).toLocaleString()}`));
    await handoffReady(`Ho preparato il riassunto della conversazione «${entry.title}».`);
  } catch (e) { vscode.window.showWarningMessage('Claude Bridge: ' + e.message); }
}

async function deleteSession(id) {
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  const c = await vscode.window.showWarningMessage(`Eliminare dalla cronologia la conversazione «${entry.title}»?`, { modal: true }, 'Elimina');
  if (c !== 'Elimina') return;
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
    title: 'Collega la chat di claude.ai',
    prompt: 'Incolla il link della chat, dalla barra degli indirizzi del browser (https://claude.ai/chat/…). Lascia vuoto per scollegare.',
    value: target.url || '',
    ignoreFocusOut: true,
    validateInput: (x) => (!x.trim() || /^https:\/\/(www\.)?claude\.ai\/\S+$/i.test(x.trim()) ? null : 'Deve essere un link https://claude.ai/…'),
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
    { label: '$(link-external) Apri la chat in claude.ai', id: 'open' },
    { label: '$(edit) Cambia il link', id: 'change' },
    { label: '$(close) Scollega', id: 'unlink' },
  ], { placeHolder: session.url });
  if (!pick) return;
  if (pick.id === 'open') openChat();
  else if (pick.id === 'change') linkChat();
  else { session.url = ''; saveSession(); refresh(); }
}

async function openMemory() {
  let uri;
  try { uri = bridgeUri('MEMORY.md'); } catch (e) { vscode.window.showWarningMessage('Claude Bridge: ' + e.message); return; }
  if (!(await exists(uri))) {
    const c = await vscode.window.showInformationMessage('Non c\'è ancora una memoria di progetto: Claude la crea quando impara qualcosa sul progetto. Vuoi crearla tu ora?', 'Crea');
    if (c !== 'Crea') return;
    await writeText(uri, '# Memoria del progetto\n\n- \n');
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
}

// ---- quick fix on problems ----
class FixProvider {
  provideCodeActions(doc, range, context) {
    if (!token) return [];
    return context.diagnostics.slice(0, 3).map((d) => {
      const msg = d.message.split('\n')[0];
      const a = new vscode.CodeAction(`Chiedi a Claude di sistemarlo: ${msg.length > 60 ? msg.slice(0, 57) + '…' : msg}`, vscode.CodeActionKind.QuickFix);
      a.command = {
        command: 'claudeBridge.fixDiagnostic',
        title: 'Chiedi a Claude di sistemarlo',
        arguments: [doc.uri.toString(), { line: d.range.start.line, col: d.range.start.character, endLine: d.range.end.line, message: d.message, source: d.source || '', severity: d.severity }],
      };
      a.diagnostics = [d];
      return a;
    });
  }
}

async function fixDiagnostic(uriStr, d) {
  if (!uriStr || !d) { vscode.window.showInformationMessage('Usa la lampadina (Ctrl+.) su un errore sottolineato per chiedere a Claude di sistemarlo.'); return; }
  const uri = vscode.Uri.parse(uriStr);
  const doc = await vscode.workspace.openTextDocument(uri);
  const start = Math.max(0, d.line - 15);
  const end = Math.min(doc.lineCount - 1, (d.endLine ?? d.line) + 15);
  const lines = [];
  for (let i = start; i <= end; i++) lines.push(doc.lineAt(i).text);
  const sev = ['error', 'warning', 'info', 'hint'][d.severity] || 'error';
  const problem = `${rel(uri)}:${d.line + 1}:${d.col + 1} ${sev}: ${d.message}${d.source ? ' (' + d.source + ')' : ''}`;
  vscode.commands.executeCommand('workbench.view.extension.claudeBridge');
  await sendRequest('fix', `Sistema questo problema: ${d.message.split('\n')[0]}`, { includeSelection: false, extra: { problem, snippet: numbered(lines, start + 1) } });
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
    if (!repoRoot) { vscode.window.showWarningMessage('Claude Bridge: apri la cartella del repository Git.'); return; }
    diff = await execText('git diff --staged', repoRoot);
    if (!diff.trim()) { diff = await execText('git diff', repoRoot); staged = false; }
    recent = (await execText('git log -8 --format=%s', repoRoot)).split('\n').filter(Boolean);
    branch = (await execText('git branch --show-current', repoRoot)).trim();
  }
  if (!diff.trim()) { vscode.window.showWarningMessage('Claude Bridge: nessuna modifica da descrivere (né in stage né nei file).'); return; }
  vscode.commands.executeCommand('workbench.view.extension.claudeBridge');
  await sendRequest('commit', staged ? 'Scrivi il messaggio di commit per le modifiche in stage.' : 'Scrivi il messaggio di commit per le modifiche (niente in stage).', { noEditor: true, repoRoot, extra: { diff: cap(diff, 60000), diffStaged: staged, recentCommits: recent, branch } });
}

async function setCommitMessage(repoRoot, text) {
  const msg = String(text || '').trim().replace(/^```[\w-]*\s*\n/, '').replace(/\n```\s*$/, '').trim();
  const gapi = await gitApi();
  const repos = gapi ? gapi.repositories || [] : [];
  const repo = repos.find((r) => r.rootUri.fsPath === repoRoot) || repos[0];
  if (!repo) {
    await vscode.env.clipboard.writeText(msg);
    vscode.window.showInformationMessage('Claude Bridge: messaggio di commit copiato negli appunti.');
    return;
  }
  repo.inputBox.value = msg;
  vscode.commands.executeCommand('workbench.view.scm');
  vscode.window.setStatusBarMessage('Claude: messaggio di commit pronto nel pannello Git', 5000);
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
      if (st.type & vscode.FileType.Directory) kind = 'folder';
    } catch { vscode.window.showWarningMessage('Claude Bridge: non trovo ' + (uri.fsPath || uri.toString())); continue; }
    attachments.push({ id: ++attSeq, kind, uri: uri.toString(), label: rel(uri) });
    added++;
  }
  if (added) { refresh(); vscode.commands.executeCommand('workbench.view.extension.claudeBridge'); }
  return added;
}

function attachTexts(files) {
  const bad = [];
  for (const f of files || []) {
    if (f.error) { bad.push(`${f.name}: ${f.error}`); continue; }
    attachments.push({ id: ++attSeq, kind: 'file', label: `${f.name} (dal computer)`, name: f.name, text: String(f.text || '') });
  }
  if (bad.length) vscode.window.showWarningMessage('Claude Bridge: non allegati — ' + bad.join('; '));
  refresh();
}

async function attachCommand(uri, uris) {
  let list = Array.isArray(uris) && uris.length ? uris : uri && uri.scheme ? [uri] : [];
  if (!list.length && vscode.window.activeTextEditor) list = [vscode.window.activeTextEditor.document.uri];
  if (!list.length) {
    list = (await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Allega a Claude', defaultUri: folders()[0] && folders()[0].uri })) || [];
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
  if (kind === 'edit' && !hasSel) { vscode.window.showWarningMessage('Seleziona prima il codice da modificare.'); return; }
  const text = await vscode.window.showInputBox({
    title: kind === 'edit' ? 'Modifica con Claude' : 'Chiedi a Claude',
    prompt: kind === 'edit' ? 'Come vuoi modificare la selezione?' : (hasSel ? 'Domanda sulla selezione' : 'Domanda (contesto: file attivo)'),
    ignoreFocusOut: true,
  });
  if (!text) return;
  vscode.commands.executeCommand('workbench.view.extension.claudeBridge');
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
  const sel = context && context.selection ? `${context.file}:${context.selection.startLine}-${context.selection.endLine}` : (opts.includeFile && context && context.file ? context.file + ' (intero)' : '');
  const m = addMessage({
    role: kind === 'stop' ? 'system' : 'user',
    text: kind === 'stop' ? 'Hai chiesto a Claude di smettere di seguire VS Code.' : text,
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
      addMessage({ role: 'system', text: 'Nessuna chat Claude in ascolto. In claude.ai (connector VS Code Bridge attivo) incolla il prompt: la richiesta resta in coda e verrà presa.', prompt: true });
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
  vscode.window.setStatusBarMessage(agentMode ? 'Claude: modalità agente attiva — le modifiche vengono applicate subito, puoi annullarle per ogni richiesta' : 'Claude: modalità agente disattivata — ogni modifica ti viene proposta come diff', 5000);
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
  const ag = agentMode ? ' · agente' : '';
  if (conn === 'unconfigured') { statusItem.text = '$(gear) Claude: da configurare'; statusItem.tooltip = 'Claude Bridge: Configura'; }
  else if (conn === 'offline') { statusItem.text = '$(debug-disconnect) Claude: offline'; statusItem.tooltip = connError; }
  else if (listening) { statusItem.text = '$(comment-discussion) Claude: in ascolto' + ag; statusItem.tooltip = 'Una chat di claude.ai sta seguendo VS Code'; }
  else { statusItem.text = '$(comment) Claude: non in ascolto' + ag; statusItem.tooltip = 'Copia il prompt dal pannello Claude e incollalo in claude.ai'; }
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
    w.html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${res('codicons', 'codicon.css')}"><link rel="stylesheet" href="${res('panel.css')}"></head>
<body>
<header id="top"><div id="status"></div><div class="tools">
<button class="icon" id="historyBtn" data-act="toggleHistory" title="Conversazioni passate">${icon('history')}</button>
<button class="icon" id="linkBtn" data-act="linkMenu" title="Collega questa conversazione alla sua chat di claude.ai">${icon('link')}</button>
<button class="icon" data-act="handoff" title="Passa a una nuova chat di claude.ai: Claude scrive un riassunto e la chat nuova riparte da lì">${icon('arrow-swap')}</button>
<button class="icon" data-act="openMemory" title="Memoria di progetto: note che Claude legge all'inizio di ogni chat">${icon('book')}</button>
<button class="icon" data-act="newConversation" title="Nuova conversazione (quella attuale va nella cronologia)">${icon('add')}</button>
<button class="icon" data-act="configure" title="Configura server e token">${icon('gear')}</button>
</div></header>
<div id="log"></div>
<button id="toBottom" class="icon" title="Vai in fondo">${icon('arrow-down')}</button>
<form id="f"><div class="composer"><div id="atts"></div>
<textarea id="q" rows="1" placeholder="Chiedi a Claude…"></textarea>
<div class="bar">
<button type="button" class="icon" id="attach" title="Allega file (oppure trascinali nel pannello)">${icon('new-file')}</button>
<button type="button" class="pill agent" id="agentBtn" aria-pressed="false" title="Modalità agente: Claude applica le modifiche da solo e tu puoi annullare tutto per ogni richiesta">${icon('robot')}Agente</button>
<button type="button" class="pill" id="selBtn" aria-pressed="true" title="Includi il codice selezionato">${icon('selection')}Selezione</button>
<button type="button" class="pill" id="fileBtn" aria-pressed="false" title="Includi tutto il file attivo">${icon('file')}File</button>
<span class="sp"></span>
<button type="button" class="icon" id="stop" title="Stop: la chat di claude.ai smette di seguire VS Code">${icon('debug-stop')}</button>
<button type="submit" class="send" id="send" title="Invia (Invio)">${icon('send')}</button>
</div></div>
<div class="hint">Invio per inviare · Shift+Invio a capo · trascina qui i file</div></form>
<div id="drop">${icon('new-file')}<div>Rilascia per allegare a Claude</div><small>Se VS Code apre il file invece di allegarlo, tieni premuto Shift mentre rilasci.</small></div>
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
      checkpoints: checkpoints.map(({ id, requestId, files, reverted }) => ({ id, requestId, files, reverted })),
      session: { url: session ? session.url : '' }, history, mode: uiMode, viewing,
    });
  }
  async onMessage(m) {
    switch (m.type) {
      case 'ready': return this.post();
      case 'send': uiMode = 'chat'; viewing = null; return sendRequest('chat', m.text, { includeSelection: m.sel, includeFile: m.file });
      case 'stop': return sendRequest('stop', 'STOP', {});
      case 'configure': return configure();
      case 'copy': await vscode.env.clipboard.writeText(m.text || ''); vscode.window.setStatusBarMessage('Copiato', 2000); return;
      case 'copyPrompt': return copyPrompt();
      case 'insert': {
        const ed = vscode.window.visibleTextEditors.find((e) => e === vscode.window.activeTextEditor) || vscode.window.visibleTextEditors[0];
        if (!ed) { vscode.window.showWarningMessage('Apri un file in cui inserire il codice.'); return; }
        await ed.edit((b) => b.replace(ed.selection, m.text || ''));
        return;
      }
      case 'accept': return acceptEdit(m.editId);
      case 'reject': return rejectEdit(m.editId);
      case 'diff': return showChanges(m.editId);
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
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Allega a Claude', defaultUri: folders()[0] && folders()[0].uri });
        if (picked && picked.length) await attachUris(picked);
        return;
      }
      case 'removeAttachment': attachments = attachments.filter((a) => a.id !== m.id); return refresh();
      case 'clear': return newConversation();
    }
  }
}

module.exports = { activate, deactivate };
