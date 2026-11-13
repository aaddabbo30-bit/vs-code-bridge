// Upgrade test: an earlier version of the extension (taken from git) builds up conversations, history, a restore
// point, project memory and a saved token; then the current version starts on the same VS Code storage and must
// find all of it. Needs the worker running (see integration.js). Usage: node extension/test/upgrade.js <old-commit>
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');
const { create, Uri } = require('./vscode-mock');

const B = process.env.BRIDGE_URL || 'http://127.0.0.1:8799';
const T = process.env.BRIDGE_TOKEN || 'testtoken123';
const OLD = process.argv[2] || '083dbe0';
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
  const repo = path.join(__dirname, '..', '..');
  const oldVersion = JSON.parse(cp.execSync(`git show ${OLD}:extension/package.json`, { cwd: repo }).toString()).version;
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-old-'));
  fs.writeFileSync(path.join(oldDir, 'extension.js'), cp.execSync(`git show ${OLD}:extension/extension.js`, { cwd: repo }));
  console.log(`# upgrade from ${oldVersion} (${OLD}) to the current version`);
  const v02 = oldVersion === '0.2.0';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-up-'));
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-uphome-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.py'), 'x = 1\ny = 2\n');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

  const mock = create(root);
  mock.config[v02 ? 'claudeBridge' : 'aiBridge'].serverUrl = B;
  await mock.context.secrets.store(v02 ? 'claudeBridge.token' : 'aiBridge.token', T);
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? mock.vscode : orig.call(this, req, ...rest); };
  const panel = (m) => mock.view.send(m);
  const st = () => mock.view.state;
  const msgs = () => st().messages;

  // ---------- the old version at work ----------
  const old = require(path.join(oldDir, 'extension.js'));
  await old.activate(mock.context);
  mock.providers.view.resolveWebviewView(mock.view);
  await until(() => st() && st().conn === 'online', 'old version online');
  mock.answers.pick = (items) => items.find((i) => i.id === 'new');
  await panel({ type: 'copyPrompt' });
  const win = (mock.clipboard.text.match(/window "([a-z0-9]+)"/) || [])[1];
  assert(win, 'old version: prompt with the window id');

  let fP = tool('follow_vscode', { window: win });
  await sleep(500);
  await panel({ type: 'send', text: 'first question', sel: false, file: false });
  let f = await fP;
  const rq1 = (await until(() => msgs().find((m) => m.role === 'user' && m.text === 'first question' && m.requestId != null), 'request id')).requestId;
  await panel({ type: 'agent', on: true });
  const pe = await tool('propose_edit', { window: win, request_id: rq1, path: 'src/a.py', description: 'y = 3', edits: [{ old_text: 'y = 2', new_text: 'y = 3' }] });
  assert(pe.includes('agent mode') && read('src', 'a.py').includes('y = 3'), 'old version: change applied with a restore point');
  await panel({ type: 'agent', on: false });
  await tool('save_memory', { window: win, content: '# Memory\n- old memory note' });
  f = await tool('follow_vscode', { window: win, cursor: cursorOf(f), reply: { request_id: rq1, text: 'first answer' } });
  await until(() => msgs().some((m) => m.role === 'claude' && m.text === 'first answer'), 'first answer');
  await panel({ type: 'newConversation' });
  await until(() => st().history.length === 1, 'first conversation archived');
  fP = tool('follow_vscode', { window: win, cursor: cursorOf(f) });
  await sleep(300);
  await panel({ type: 'send', text: 'second question', sel: false, file: false });
  f = await fP;
  const rq2 = (await until(() => msgs().find((m) => m.role === 'user' && m.text === 'second question' && m.requestId != null), 'request id 2')).requestId;
  await tool('reply', { window: win, request_id: rq2, text: 'second answer' });
  await until(() => msgs().some((m) => m.role === 'claude' && m.text === 'second answer'), 'second answer');
  const memDir = v02 ? '.claude-bridge' : '.ai-bridge';
  assert(fs.existsSync(path.join(root, memDir, 'MEMORY.md')), `old version: memory saved in ${memDir}/`);
  old.deactivate();
  await sleep(27000); // the old version's last poll ends

  // ---------- the current version on the same storage ----------
  mock.view.states.length = 0;
  const neu = require('../extension.js');
  await neu.activate(mock.context);
  mock.providers.view.resolveWebviewView(mock.view);
  await until(() => st() && st().conn === 'online', 'current version online with the saved token');
  assert((await mock.context.secrets.get('aiBridge.token')) === T && mock.config.aiBridge.serverUrl === B, 'token and server address kept');
  assert(msgs().some((m) => m.text === 'second question') && msgs().some((m) => m.text === 'second answer'), 'current conversation kept');
  assert(st().history.length === 1 && st().history[0].title === 'first question', 'past conversations kept');
  await panel({ type: 'viewSession', id: st().history[0].id });
  assert(st().viewing.messages.some((m) => m.text === 'first answer'), 'a past conversation still opens');
  await panel({ type: 'closeHistory' });
  mock.answers.pick = (items) => items.find((i) => i.id === 'new');
  await panel({ type: 'copyPrompt' });
  assert(mock.clipboard.text.includes(`window "${win}"`), 'same window id, so the chats bound to it keep working');
  assert(fs.existsSync(path.join(root, '.ai-bridge', 'MEMORY.md')) && !fs.existsSync(path.join(root, '.claude-bridge')), 'project memory in .ai-bridge/');
  const first = await tool('follow_vscode', { window: win });
  assert(first.includes('old memory note'), 'a new chat gets the old project memory');
  const point = st().checkpoints.find((c) => c.requestId === rq1 && !c.reverted);
  assert(point && point.files.includes('src/a.py'), 'restore point of the old version kept');
  mock.answers.warn = (msg, items) => (items.includes('Undo changes') ? 'Undo changes' : undefined);
  await panel({ type: 'revert', id: point.id });
  assert(read('src', 'a.py') === 'x = 1\ny = 2\n', 'and it still undoes the change');

  neu.deactivate();
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
