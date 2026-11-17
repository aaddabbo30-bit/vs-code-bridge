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
  let picks = 0;
  mock.answers.pick = (items) => (++picks === 1 ? items.find((i) => i.id === 'existing') : items.find((i) => i.id === 'paste'));
  mock.answers.input = (o) => (o.validateInput('nope') && !o.validateInput('https://claude.ai/chat/old') ? 'https://claude.ai/chat/old' : undefined);
  await panel({ type: 'copyPrompt' });
  assert(mock.clipboard.text.includes('Connect this chat') && mock.clipboard.text.includes(`window "${win}"`) && mock.log.opened.includes('https://claude.ai/chat/old') && st().session.url === 'https://claude.ai/chat/old', 'existing chat: link pasted, chat opened, message already in the clipboard');
  picks = 0;
  let offered = [];
  mock.answers.pick = (items) => { if (++picks === 1) return items.find((i) => i.id === 'existing'); offered = items; return undefined; };
  await panel({ type: 'copyPrompt' });
  assert(offered.some((i) => i.url === 'https://claude.ai/chat/old') && offered.some((i) => i.id === 'paste'), 'linked chats offered in the dropdown');

  // ---------- which commands count as read-only ----------
  const RO = ext._test.commandReadOnly;
  for (const c of ['dir', 'dir /s *.py', 'ls -la src', 'type README.md', 'cat a.txt | grep x', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git branch -a', 'git remote -v', 'node --version', 'python -m pip list', 'pip show requests', 'npm ls', 'findstr /s TODO *.py', 'cd src && dir', 'powershell -NoProfile -Command "Get-ChildItem ~/Downloads | Measure-Object"', 'echo %USERPROFILE%', 'tree /f', 'where python', 'git config --get user.name', 'git -C nea_repo log --oneline -5', 'git --no-pager diff', 'dir /b *.py 2>nul', 'git status 2>&1', 'ls -la >/dev/null 2>&1', 'powershell -NoProfile -Command "Import-Csv data.csv | Select-Object -First 5"', 'powershell -Command "Get-ChildItem C:/x -Recurse -ErrorAction SilentlyContinue 2>$null | Measure-Object"']) assert(RO(c), 'read-only: ' + c);
  for (const c of ['del a.txt', 'rm -rf x', 'echo hi > a.txt', 'type a.txt >> b.txt', 'git commit -m x', 'git branch -D main', 'git push', 'git -c core.pager=x log', 'git log --output=a.txt', 'npm install', 'npm run build', 'pip install x', 'python script.py', 'node -e "1"', 'find . -delete', 'find . -exec rm {} ;', 'sort a -o b', 'd^el a.txt', 'dir & del a.txt', 'curl https://x.y', 'powershell -Command "Remove-Item a"', 'powershell -Command "Get-ChildItem | ForEach-Object { Remove-Item $_ }"', 'cmd /c del a', 'tail -f log.txt', 'rg --pre cat x', 'set', 'env', 'dir > out.txt', 'echo hi 2> err.txt', 'git status 2>&1 > x.txt', 'type a.txt 1>b.txt', 'git -C x commit -m y', 'powershell -Command "Get-Content a | Out-File b"']) assert(!RO(c), 'asks first: ' + c);
  assert(ext._test.alwaysPrefix('npm run build -- --prod') === 'npm run build' && ext._test.alwaysPrefix('git commit -m x') === 'git commit' && ext._test.alwaysPrefix('python tools/x.py --a') === 'python tools/x.py' && ext._test.alwaysPrefix('python -c "print(1)"') === 'python -c "print(1)"' && ext._test.alwaysPrefix('python -m pytest -q') === 'python -m pytest', '"Always allow" remembers a safe prefix (a script with any arguments, inline code only exactly)');

  // ---------- drop files on the Attachments view ----------
  const dropAt = (mime, val) => ({ get: (m) => (m === mime ? { asString: async () => val } : undefined), forEach() {} });
  await mock.providers.tree.dragAndDropController.handleDrop(undefined, dropAt('text/uri-list', Uri.file(file('src', 'a.py')).toString() + '\r\n'));
  await mock.providers.tree.dragAndDropController.handleDrop(undefined, { get: () => undefined, forEach: (cb) => { cb({ asFile: () => ({ name: 'from-desktop.txt', data: async () => Buffer.from('desktop note') }) }, 'files'); cb({ asFile: () => ({ name: 'pic.png', data: async () => Buffer.from([137, 80, 0, 0]) }) }, 'files'); } });
  const tree = mock.providers.tree.treeDataProvider;
  const kids = tree.getChildren();
  assert(kids.length === 2 && tree.getTreeItem(kids[0]).label === 'a.py' && tree.getTreeItem(kids[1]).description === 'from your computer', 'files dropped on Attachments are attached (Explorer and computer)');
  assert(mock.log.warn.some((w) => w.includes('pic.png')), 'binary file dropped is refused');
  await mock.vscode.commands.executeCommand('aiBridge.removeAttachment', kids[1]);
  assert(st().attachments.length === 1, 'an attachment can be removed');
  await mock.vscode.commands.executeCommand('aiBridge.clearAttachments');
  assert(st().attachments.length === 0, 'attachments can be cleared');

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
  const rc = await tool('run_command', { window: win, command: 'echo ciao' });
  assert(rc.includes('exit code: 0') && rc.includes('ciao') && msgs().some((m) => m.role === 'cmd' && m.text === 'echo ciao' && m.state === 'readonly'), 'read-only command runs without asking');
  const nodeCmd = 'node -e "console.log(41+1)"';
  const rcP = tool('run_command', { window: win, command: nodeCmd, reason: 'calcolo' });
  const ask = await until(() => msgs().find((m) => m.role === 'cmd' && m.text === nodeCmd && m.state === 'asking'), 'approval card');
  assert(ask.reason === 'calcolo' && ask.prefix === nodeCmd && !mock.log.info.some((t) => t.includes(nodeCmd)), 'approval asked in the panel, no pop-up while the panel is open');
  const bar = mock.log.statusItems[0];
  assert(bar.text.includes('1 command waiting') && bar.backgroundColor, 'the status bar shows a command is waiting');
  await panel({ type: 'cmdAnswer', id: ask.cmdId, choice: 'always' });
  assert((await rcP).includes('42') && mock.config.aiBridge.autoApproveCommands.includes(nodeCmd), '"Always allow" runs it and remembers it');
  assert(!bar.text.includes('waiting') && !bar.backgroundColor, 'the status bar is back to normal');
  fs.mkdirSync(file('tools'));
  fs.writeFileSync(file('tools', 'hello.js'), 'console.log("hi " + process.argv[2])');
  const s1P = tool('run_command', { window: win, command: 'node tools/hello.js a' });
  const ask3 = await until(() => msgs().find((m) => m.role === 'cmd' && m.text === 'node tools/hello.js a' && m.state === 'asking'), 'script approval card');
  await panel({ type: 'cmdAnswer', id: ask3.cmdId, choice: 'always' });
  assert((await s1P).includes('hi a'), 'script allowed once and for all');
  assert((await tool('run_command', { window: win, command: 'node tools/hello.js b' })).includes('hi b') && msgs().filter((m) => m.text === 'node tools/hello.js b').pop().state === 'done', 'the same script with other arguments no longer asks');
  assert((await tool('run_command', { window: win, command: nodeCmd })).includes('42') && msgs().filter((m) => m.text === nodeCmd).pop().state === 'done', 'an always-allowed command no longer asks');
  const denyP = tool('run_command', { window: win, command: 'echo hi > made.txt' });
  const ask2 = await until(() => msgs().find((m) => m.role === 'cmd' && m.text === 'echo hi > made.txt' && m.state === 'asking'), 'second approval card');
  await panel({ type: 'cmdAnswer', id: ask2.cmdId, choice: 'deny' });
  assert((await denyP).includes('did NOT allow') && !fs.existsSync(file('made.txt')), 'denied command does not run');
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

  // ---------- artifacts in the middle of VS Code ----------
  mock.log.webviewPanels.length = 0;
  const art = await tool('show_artifact', { window: win, title: 'Report vendite', kind: 'html', content: '<h1>Vendite</h1><canvas id="c"></canvas><script>document.title="x"</script>' });
  const artId = (art.match(/artifact id "([^"]+)"/) || [])[1];
  const wp = mock.log.webviewPanels[0];
  assert(artId && wp && wp.title === 'AI: Report vendite' && wp.opts.enableScripts && wp.opts.localResourceRoots.length === 0, 'artifact opens in an editor tab');
  assert(wp.webview.html.includes("default-src 'none'") && wp.webview.html.includes('<h1>Vendite</h1>') && wp.webview.html.includes('--vscode-foreground'), 'artifact page has no network access and uses the theme');
  await tool('show_artifact', { window: win, id: artId, title: 'Report vendite 2', kind: 'html', content: '<h1>Aggiornato</h1>' });
  assert(mock.log.webviewPanels.length === 1 && wp.webview.html.includes('Aggiornato') && wp.title === 'AI: Report vendite 2' && msgs().find((m) => m.artifactId === artId).version === 2, 'same id updates the same tab');
  await tool('show_artifact', { window: win, title: 'Note', kind: 'markdown', content: '# Titolo\n\n- uno\n- **due**' });
  assert(mock.log.webviewPanels[1].webview.html.includes('<h1>Titolo</h1>') && mock.log.webviewPanels[1].webview.html.includes('<strong>due</strong>'), 'markdown artifact rendered');
  await tool('show_artifact', { window: win, title: 'Pagina', kind: 'html', content: '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>p</body></html>' });
  assert(/<head[^>]*><meta http-equiv="Content-Security-Policy" content="default-src 'none'/.test(mock.log.webviewPanels[2].webview.html), 'a whole page gets our policy first');
  mock.answers.save = (o) => Uri.file(path.join(root, 'report.html'));
  await panel({ type: 'saveArtifact', id: artId });
  assert(read('report.html').includes('Aggiornato'), 'artifact saved as a file');

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
