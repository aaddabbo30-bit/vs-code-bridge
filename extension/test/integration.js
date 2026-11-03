// Runs the real extension.js (with a stand-in `vscode` module) against a running worker, playing Claude through MCP.
// Start the worker first: cd server && echo BRIDGE_TOKEN=testtoken123 > .dev.vars && npx wrangler dev --port 8799 --ip 127.0.0.1
// Then: node extension/test/integration.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');
const { create, Uri } = require('./vscode-mock');

const B = process.env.BRIDGE_URL || 'http://127.0.0.1:8799';
const T = process.env.BRIDGE_TOKEN || 'testtoken123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } else console.log('ok -', m); };
async function until(cond, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(100); }
  console.error('FAIL: timed out waiting for', what);
  process.exit(1);
}
let rid = 0;
async function tool(name, args) {
  const r = await fetch(`${B}/mcp/${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  return (j.result.isError ? 'ERROR: ' : '') + j.result.content[0].text;
}
const cursorOf = (t) => Number(t.match(/cursor: (\d+)/)[1]);

(async () => {
  // ---------- a workspace on disk ----------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ws-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.py'), 'x = 1\ny = 2\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Progetto\nNote del progetto.\n');
  const file = (...p) => path.join(root, ...p);
  const read = (...p) => fs.readFileSync(file(...p), 'utf8');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-home-'));
  process.env.HOME = home; // ~ is this folder for the extension
  const mock = create(root);
  // settings and token as an earlier version saved them: they must move to the new names
  mock.config.claudeBridge.serverUrl = B;
  await mock.context.secrets.store('claudeBridge.token', T);
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? mock.vscode : orig.call(this, req, ...rest); };
  const ext = require('../extension.js');

  await ext.activate(mock.context);
  mock.providers.view.resolveWebviewView(mock.view);
  const panel = (m) => mock.view.send(m);
  const st = () => mock.view.state;
  const msgs = () => st().messages;
  assert(mock.view.webview.html.includes('codicon.css') && mock.view.webview.html.includes('font-src'), 'panel html loads the icons');
  await until(() => st() && st().conn === 'online', 'extension online');
  assert(true, 'extension connected to the server');
  assert(mock.config.aiBridge.serverUrl === B && (await mock.context.secrets.get('aiBridge.token')) === T, 'old settings and token migrated');

  // ---------- the prompt names this window ----------
  mock.answers.pick = (items) => items.find((i) => i.id === 'new');
  await panel({ type: 'copyPrompt' });
  const win = (mock.clipboard.text.match(/window "([a-z0-9]+)"/) || [])[1];
  assert(win && mock.clipboard.text.includes('follow_vscode'), 'copied prompt names the window');
  mock.answers.pick = (items) => items.find((i) => i.id === 'existing');
  await panel({ type: 'copyPrompt' });
  assert(mock.clipboard.text.includes('Connect this chat') && mock.clipboard.text.includes(`window "${win}"`), 'prompt for an existing chat');

  // ---------- first round + request with an attached file ----------
  const f1P = tool('follow_vscode', { window: win });
  await until(() => msgs().some((m) => m.kind === 'connected'), 'connected notice');
  await panel({ type: 'attachUris', uris: [Uri.file(file('README.md')).toString()] });
  await until(() => st().attachments.length === 1, 'attachment chip');
  await panel({ type: 'send', text: 'Spiega il progetto', sel: true, file: false });
  const f1 = await f1P;
  assert(f1.includes('No project memory yet'), 'first round: no memory yet');
  assert(f1.includes('Spiega il progetto') && f1.includes('attached file: README.md') && f1.includes('Note del progetto'), 'attached file content reaches Claude');
  assert(f1.includes(`following window "${win}"`), 'chat bound to this window');
  assert(st().attachments.length === 0, 'attachments cleared after sending');
  const rq1 = (await until(() => msgs().find((m) => m.role === 'user' && m.text === 'Spiega il progetto' && m.requestId != null), 'request id')).requestId;
  let cursor = cursorOf(f1);
  await until(() => msgs().find((m) => m.requestId === rq1 && m.role === 'user').state === 'working', 'request marked working');

  // ---------- plan ----------
  await tool('update_plan', { request_id: rq1, window: win, steps: [{ title: 'Leggere', status: 'done' }, { title: 'Scrivere', status: 'in_progress' }] });
  await until(() => msgs().some((m) => m.role === 'plan' && m.steps.length === 2), 'plan in the panel');
  await tool('update_plan', { request_id: rq1, window: win, steps: [{ title: 'Leggere', status: 'done' }, { title: 'Scrivere', status: 'done' }] });
  await until(() => msgs().filter((m) => m.role === 'plan').length === 1 && msgs().find((m) => m.role === 'plan').steps[1].status === 'done', 'plan updated in place');

  // ---------- agent mode: applied at once, then undone ----------
  await panel({ type: 'agent', on: true });
  assert(st().agent === true, 'agent mode on');
  const pc = await tool('propose_changes', {
    request_id: rq1, window: win, description: 'cambio y, nuovo file, via il README',
    files: [{ path: 'src/a.py', edits: [{ old_text: 'y = 2', new_text: 'y = 3' }] }, { path: 'src/new.py', new_content: 'print(1)\n' }, { path: 'README.md', delete: true }],
  });
  assert(pc.includes('Applied at once') && pc.includes('src/a.py') && pc.includes('src/new.py'), 'change set applied in agent mode');
  assert(read('src', 'a.py') === 'x = 1\ny = 3\n' && read('src', 'new.py') === 'print(1)\n' && !fs.existsSync(file('README.md')), 'files changed on disk');
  const cp1 = st().checkpoints.find((c) => c.requestId === rq1);
  assert(cp1 && cp1.files.length === 3 && !cp1.reverted, 'restore point with 3 files');
  const bad = await tool('propose_changes', { request_id: rq1, window: win, description: 'x', files: [{ path: 'src/a.py', edits: [{ old_text: 'y = 3', new_text: 'y = 4' }] }, { path: 'src/a.py', new_content: 'z' }] });
  assert(bad.startsWith('ERROR') && read('src', 'a.py') === 'x = 1\ny = 3\n', 'invalid change set applies nothing');

  mock.answers.warn = (msg, items) => (items.includes('Undo changes') ? 'Undo changes' : undefined);
  await panel({ type: 'revert', id: cp1.id });
  assert(read('src', 'a.py') === 'x = 1\ny = 2\n' && !fs.existsSync(file('src', 'new.py')) && read('README.md').includes('Note del progetto'), 'undo restores every file');
  assert(st().checkpoints.find((c) => c.id === cp1.id).reverted, 'restore point marked as undone');
  const f2 = await tool('follow_vscode', { cursor, window: win, reply: { request_id: rq1, text: 'Ecco **il progetto**.' } });
  assert(f2.includes('UNDID') && f2.includes('src/a.py'), 'Claude learns about the undo');
  cursor = cursorOf(f2);
  await until(() => msgs().some((m) => m.role === 'claude' && m.text.includes('il progetto')), 'reply in the panel');
  assert(msgs().find((m) => m.requestId === rq1 && m.role === 'user').state === 'answered', 'request answered');

  // ---------- normal mode: diff, accept with problems, reject with a note ----------
  await panel({ type: 'agent', on: false });
  const pe = await tool('propose_edit', { window: win, path: 'src/a.py', description: 'y vale 5', edits: [{ old_text: 'y = 2', new_text: 'y = 5' }] });
  assert(pe.includes('Diff shown'), 'propose_edit shows a diff');
  assert(mock.log.executed.some((e) => e.id === 'vscode.diff'), 'diff editor opened');
  assert(read('src', 'a.py') === 'x = 1\ny = 2\n', 'nothing changes before accepting');
  const card = await until(() => msgs().find((m) => m.role === 'edit' && m.state === 'pending'), 'pending card');
  mock.diagnostics.set(file('src', 'a.py'), [{ severity: 0, message: 'boom', source: 'pylint', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } }]);
  await panel({ type: 'accept', editId: card.editId });
  assert(read('src', 'a.py') === 'x = 1\ny = 5\n', 'accepted edit saved');
  const f3 = await tool('follow_vscode', { cursor, window: win });
  assert(f3.includes('ACCEPTED') && f3.includes('boom'), 'Claude gets the outcome and the new problems');
  cursor = cursorOf(f3);
  mock.diagnostics.clear();

  await tool('propose_changes', { window: win, description: 'due file', files: [{ path: 'src/a.py', edits: [{ old_text: 'x = 1', new_text: 'x = 0' }] }, { path: 'src/b.py', new_content: 'b = 1\n' }] });
  assert(mock.log.executed.some((e) => e.id === 'vscode.changes'), 'multi-file diff opened');
  const card2 = await until(() => msgs().find((m) => m.role === 'edit' && m.state === 'pending'), 'pending change set');
  assert(card2.files.length === 2, 'card lists both files');
  mock.answers.input = () => 'non mi piace';
  await panel({ type: 'reject', editId: card2.editId });
  assert(read('src', 'a.py') === 'x = 1\ny = 5\n' && !fs.existsSync(file('src', 'b.py')), 'rejected change set leaves files alone');
  const f4 = await tool('follow_vscode', { cursor, window: win });
  assert(f4.includes('REJECTED') && f4.includes('non mi piace'), 'Claude gets the rejection note');
  cursor = cursorOf(f4);

  // ---------- commands, terminal, memory ----------
  mock.answers.warn = (msg, items) => (items.includes('Run') ? 'Run' : undefined);
  const rc = await tool('run_command', { window: win, command: 'echo ciao' });
  assert(rc.includes('exit code: 0') && rc.includes('ciao'), 'run_command after approval');
  async function* stream() { yield '\x1b[32mPASS\x1b[0m test_a\r\n'; yield 'progress 10%\rprogress 100%\n'; }
  const execution = { commandLine: { value: 'npm test' }, cwd: Uri.file(root), read: stream };
  mock.listeners.termStart.forEach((fn) => fn({ terminal: { name: 'pwsh' }, execution }));
  await sleep(100);
  mock.listeners.termEnd.forEach((fn) => fn({ terminal: { name: 'pwsh' }, execution, exitCode: 0 }));
  const term = await tool('get_terminal_output', { window: win });
  assert(term.includes('$ npm test') && term.includes('PASS test_a') && term.includes('progress 100%') && !term.includes('progress 10%') && !term.includes('\x1b') && term.includes('exit code 0'), 'terminal output captured and cleaned');
  const sm = await tool('save_memory', { window: win, content: '# Memoria\n- i test: pytest' });
  assert(sm.includes('Saved') && read('.ai-bridge', 'MEMORY.md').includes('pytest'), 'memory saved in the project');

  // ---------- quick fix, commit message, file from the computer ----------
  const actions = mock.providers.codeActions.provideCodeActions(await mock.vscode.workspace.openTextDocument(Uri.file(file('src', 'a.py'))), null, { diagnostics: [{ severity: 0, message: 'undefined name z', source: 'pyflakes', range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } } }] });
  assert(actions.length === 1 && actions[0].command.command === 'aiBridge.fixDiagnostic', 'lightbulb offers the fix');
  const kP = tool('follow_vscode', { cursor, window: win });
  await mock.vscode.commands.executeCommand(actions[0].command.command, ...actions[0].command.arguments);
  const k = await kP;
  assert(k.includes('FIX a problem') && k.includes('undefined name z') && k.includes('y = 5'), 'fix request with the problem and the code around it');
  cursor = cursorOf(k);

  const git = (c) => cp.execSync(c, { cwd: root, stdio: 'pipe' }).toString();
  git('git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm "Primo commit"');
  fs.writeFileSync(file('src', 'a.py'), 'x = 1\ny = 6\n');
  git('git add src/a.py');
  const cP = tool('follow_vscode', { cursor, window: win });
  await mock.vscode.commands.executeCommand('aiBridge.commitMessage');
  const c = await cP;
  assert(c.includes('COMMIT MESSAGE') && c.includes('+y = 6') && c.includes('Primo commit'), 'commit request carries the staged diff and recent commits');
  cursor = cursorOf(c);
  const crq = (await until(() => msgs().find((m) => m.kind === 'commit' && m.requestId != null), 'commit request id')).requestId;
  await tool('reply', { window: win, request_id: crq, text: 'Imposta y a 6\n\nValore aggiornato.' });
  await until(() => mock.clipboard.text === 'Imposta y a 6\n\nValore aggiornato.', 'commit message handed over');
  assert(true, 'commit message goes to the commit box (clipboard without the Git extension)');

  await panel({ type: 'attachFiles', files: [{ name: 'appunti.txt', text: 'idea: cache' }, { name: 'foto.png', error: 'file binario' }] });
  assert(st().attachments.length === 1 && mock.log.warn.some((w) => w.includes('foto.png')), 'file from the computer attached, binary refused');
  const dP = tool('follow_vscode', { cursor, window: win });
  await panel({ type: 'send', text: 'usa gli appunti', sel: false, file: false });
  const d = await dP;
  assert(d.includes('appunti.txt') && d.includes('idea: cache') && d.includes('not in the workspace'), 'dropped file reaches Claude');
  cursor = cursorOf(d);

  // ---------- organize a folder outside the project ----------
  const rqD = msgs().find((m) => m.role === 'user' && m.text === 'usa gli appunti').requestId;
  const dl = path.join(home, 'Downloads');
  fs.mkdirSync(dl);
  for (const [n, c] of [['report.pdf', '%PDF'], ['photo.jpg', 'JPG'], ['setup.exe', 'MZ'], ['old.zip', 'PK'], ['notes.txt', 'hi']]) fs.writeFileSync(path.join(dl, n), c);
  const dlp = (...p) => path.join(dl, ...p);
  const ld = await tool('list_dir', { window: win, path: '~/Downloads' });
  assert(ld.includes(dl) && ld.includes('[file] report.pdf') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ld), 'list_dir shows a folder outside the project, with dates');
  const ops1 = await tool('propose_file_ops', {
    window: win, request_id: rqD, description: 'riordina Download',
    operations: [
      { op: 'mkdir', path: '~/Downloads/Documents' },
      { op: 'move', path: '~/Downloads/report.pdf', to: '~/Downloads/Documents/report.pdf' },
      { op: 'move', path: '~/Downloads/photo.jpg', to: '~/Downloads/Images/2026/photo.jpg' },
      { op: 'rename', path: '~/Downloads/notes.txt', to: '~/Downloads/note.txt' },
      { op: 'trash', path: '~/Downloads/old.zip' },
    ],
  });
  assert(ops1.includes('Shown to the user') && ops1.includes('2 moves') && ops1.includes('1 rename') && ops1.includes('1 new folder') && ops1.includes('Recycle Bin'), 'file operations proposed, with a summary');
  assert(fs.existsSync(dlp('report.pdf')), 'nothing moves before accepting');
  const fcard = await until(() => msgs().find((m) => m.role === 'fileops' && m.state === 'pending'), 'file operations card');
  assert(fcard.items.length === 5 && fcard.items[1].a === '~/Downloads/report.pdf', 'card lists the operations with short paths');
  await panel({ type: 'showOps', id: fcard.opsId });
  assert(mock.log.untitled.some((t) => t.includes('report.pdf') && t.includes('Recycle Bin')), '"show all" opens the full list');
  await panel({ type: 'acceptOps', id: fcard.opsId });
  assert(fs.existsSync(dlp('Documents', 'report.pdf')) && fs.existsSync(dlp('Images', '2026', 'photo.jpg')) && fs.existsSync(dlp('note.txt')) && !fs.existsSync(dlp('old.zip')) && mock.log.trashed.some((x) => x.endsWith('old.zip')), 'operations done, old.zip in the Recycle Bin');
  const fo = await tool('follow_vscode', { cursor, window: win });
  assert(fo.includes('file operations') && fo.includes('ACCEPTED'), 'the AI gets the outcome');
  cursor = cursorOf(fo);
  const clash = await tool('propose_file_ops', { window: win, description: 'x', operations: [{ op: 'move', path: '~/Downloads/setup.exe', to: '~/Downloads/x.exe' }, { op: 'move', path: '~/Downloads/note.txt', to: '~/Downloads/Documents/report.pdf' }] });
  assert(clash.startsWith('ERROR') && clash.includes('already exists') && fs.existsSync(dlp('setup.exe')), 'a clash stops everything before anything moves');
  assert((await tool('propose_file_ops', { window: win, description: 'x', operations: [{ op: 'trash', path: '/usr/bin' }] })).includes('system folder'), 'system folders are refused');
  assert((await tool('propose_file_ops', { window: win, description: 'x', operations: [{ op: 'trash', path: '~' }] })).includes('refusing'), 'the home folder itself is refused');
  const fcp = st().checkpoints.find((c) => c.id === msgs().find((m) => m.opsId === fcard.opsId).cpId);
  assert(fcp && fcp.ops >= 5 && fcp.requestId === rqD, 'restore point counts the operations');
  mock.answers.warn = (msg, items) => (items.includes('Undo changes') ? 'Undo changes' : undefined);
  await panel({ type: 'revert', id: fcp.id });
  assert(fs.existsSync(dlp('report.pdf')) && fs.existsSync(dlp('photo.jpg')) && fs.existsSync(dlp('notes.txt')) && !fs.existsSync(dlp('Documents')) && !fs.existsSync(dlp('Images')), 'undo moves everything back and removes the new folders');
  assert(!fs.existsSync(dlp('old.zip')) && mock.log.info.some((t) => t.includes('Recycle Bin')), 'the Recycle Bin item stays there, and the user is told');
  const fu = await tool('follow_vscode', { cursor, window: win });
  assert(fu.includes('UNDID') && fu.includes('Recycle Bin'), 'the AI learns about the undo');
  cursor = cursorOf(fu);
  await panel({ type: 'agent', on: true });
  const ag = await tool('propose_file_ops', { window: win, request_id: rqD, description: 'installers', operations: [{ op: 'move', path: '~/Downloads/setup.exe', to: '~/Downloads/Installers/setup.exe' }] });
  assert(ag.includes('Done at once') && fs.existsSync(dlp('Installers', 'setup.exe')), 'agent mode does it at once');
  await panel({ type: 'agent', on: false });

  // ---------- handoff to a new chat, history, link ----------
  const hP = tool('follow_vscode', { cursor, window: win });
  await panel({ type: 'handoff' });
  const h = await hP;
  assert(h.includes('HANDOFF'), 'handoff request reaches the chat');
  const sh = await tool('save_handoff', { window: win, summary: 'Obiettivo: cache. Fatto: y=6.' });
  assert(sh.includes('do NOT call follow_vscode'), 'save_handoff answer');
  assert(read('.ai-bridge', 'HANDOFF.md').includes('Obiettivo: cache'), 'handoff written in the project');
  await until(() => st().history.length === 1 && msgs().length === 1, 'old conversation archived');
  assert(mock.clipboard.text.includes('follow_vscode'), 'prompt for the new chat in the clipboard');
  const n1 = await tool('follow_vscode', { window: win });
  assert(n1.includes('HANDOFF from the previous chat') && n1.includes('Obiettivo: cache') && n1.includes('pytest'), 'new chat gets handoff and memory');
  const n2 = await tool('follow_vscode', { window: win, cursor: cursorOf(n1) });
  assert(!n2.includes('HANDOFF from the previous chat'), 'handoff given only once');

  await panel({ type: 'toggleHistory' });
  assert(st().mode === 'history' && st().history[0].title === 'Spiega il progetto', 'history lists the old conversation');
  const sid = st().history[0].id;
  await panel({ type: 'viewSession', id: sid });
  assert(st().mode === 'view' && st().viewing.messages.some((m) => m.text === 'Spiega il progetto'), 'old conversation can be read');
  mock.answers.input = (o) => (o.validateInput('ftp://x') && !o.validateInput('https://claude.ai/chat/abc') ? 'https://claude.ai/chat/abc' : undefined);
  await panel({ type: 'linkChat', id: sid });
  assert(st().history[0].url === 'https://claude.ai/chat/abc' && st().viewing.url === 'https://claude.ai/chat/abc', 'claude.ai link saved');
  await panel({ type: 'openChat', id: sid });
  assert(mock.log.opened.includes('https://claude.ai/chat/abc'), 'chat opens in the browser');
  await panel({ type: 'resumeSession', id: sid });
  assert(read('.ai-bridge', 'HANDOFF.md').includes('Spiega il progetto'), 'resume writes a summary of that conversation');
  await panel({ type: 'closeHistory' });
  assert(st().mode === 'chat', 'back to the chat');

  // ---------- stop ----------
  const sP = tool('follow_vscode', { cursor: cursorOf(n2), window: win });
  await panel({ type: 'stop' });
  const s = await sP;
  assert(s.includes('STOP'), 'stop reaches the chat');

  ext.deactivate();
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
