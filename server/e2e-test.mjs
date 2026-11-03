// End-to-end test of the worker: run `npx wrangler dev --port 8799 --ip 127.0.0.1` with BRIDGE_TOKEN=testtoken123 in .dev.vars, then `node e2e-test.mjs`.
// It plays both sides: Claude (MCP calls) and one or two VS Code windows (the /api the extension uses).
const B = 'http://127.0.0.1:8799';
const T = 'testtoken123';
let rid = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } else console.log('ok -', m); };

async function mcp(method, params, tok = T) {
  const r = await fetch(`${B}/mcp/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) });
  if (r.status !== 200) return { status: r.status };
  return r.json();
}
const tool = async (name, args) => {
  const r = await mcp('tools/call', { name, arguments: args });
  const t = r.result.content[0].text;
  return r.result.isError ? 'ERROR: ' + t : t;
};

// a fake VS Code window: polls for jobs and answers them
function windowClient(id, label, answers) {
  const headers = { authorization: 'Bearer ' + T, 'content-type': 'application/json', 'x-bridge-client': id, 'x-bridge-label': encodeURIComponent(label) };
  const api = async (method, p, body) => { const r = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json() }; };
  const c = { id, api, received: [], on: true };
  c.loop = async () => {
    for (;;) {
      if (!c.on) { await sleep(300); continue; }
      const { j } = await api('GET', '/api/poll?wait=25');
      if (j.jobs.length) await api('POST', '/api/ack', { ids: j.jobs.map((x) => x.id) });
      for (const job of j.jobs) {
        c.received.push(job);
        const h = answers[job.type];
        if (h) await api('POST', '/api/result', { id: job.id, ...h(job.params) });
      }
    }
  };
  c.request = (kind, text, context = {}, extra = {}) => api('POST', '/api/request', { kind, text, context: { os: 'Windows', workspace: [{ name: 'proj', path: 'C:\\proj' }], ...context }, ...extra }).then((r) => r.j);
  return c;
}
const cursorOf = (t) => Number(t.match(/cursor: (\d+)/)[1]);

// ---------- protocol ----------
const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
assert(init.result.serverInfo.name === 'vscode-bridge' && init.result.serverInfo.version === '2.0.0' && init.result.instructions.includes('propose_changes'), 'initialize');
const notif = await fetch(`${B}/mcp/${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
assert(notif.status === 202, 'notification -> 202');
const tl = await mcp('tools/list', {});
const names = tl.result.tools.map((t) => t.name);
assert(names.length === 19, 'tools/list has 19 tools');
for (const n of ['follow_vscode', 'list_dir', 'propose_file_ops', 'propose_changes', 'update_plan', 'save_memory', 'save_handoff', 'get_terminal_output', 'list_vscode_windows']) assert(names.includes(n), 'tool ' + n);
assert(tl.result.tools.find((t) => t.name === 'read_file').inputSchema.properties.window, 'tools take a window');
assert((await mcp('tools/list', {}, 'wrong')).status === 404, 'wrong token on MCP -> 404');
assert((await fetch(B + '/api/poll', { headers: { authorization: 'Bearer nope' } })).status === 401, 'wrong token on API -> 401');

// ---------- window 1 ----------
const w1 = windowClient('w1', 'proj · PC1', {
  read_file: () => ({ ok: true, result: 'src/a.py — 2 righe\n1| x=1\n2| y=2' }),
  context: () => ({ ok: true, result: { os: 'Windows', workspace: [{ name: 'proj', path: 'C:\\proj' }], file: 'src/a.py', language: 'python', lines: 2, cursorLine: 1 } }),
  propose_edit: () => ({ ok: false, error: 'edit 1: old_text non trovato' }),
  propose_changes: (p) => ({ ok: true, result: `Applied at once (agent mode) — edit e9: ${p.files.map((f) => f.path).join(', ')}.` }),
  memory: () => ({ ok: true, result: { memory: '# Memoria\n- i test si lanciano con pytest', handoff: null } }),
  save_memory: (p) => ({ ok: true, result: `Saved .claude-bridge/MEMORY.md (${p.content.length} characters).` }),
  save_handoff: () => ({ ok: true, result: 'Handoff saved in .claude-bridge/HANDOFF.md.' }),
  terminal_output: () => ({ ok: true, result: '$ npm test\n(terminal "pwsh", exit code 1)\nFAIL x' }),
  list_dir: (p) => ({ ok: true, result: `${p.path} — 2 entries\n[file] a.pdf  1.0 KB  2026-11-01 10:00` }),
  propose_file_ops: (p) => ({ ok: true, result: `Shown to the user for review (f1: ${p.operations.length} moves).` }),
});
const p0 = await w1.api('GET', '/api/poll?wait=0');
assert(p0.j.claudeListening === false && p0.j.window === 'w1', 'not listening at start; window id echoed');
w1.loop();

// first round: project memory, then an AGENT MODE request with an attached file
const t0 = Date.now();
const followP = tool('follow_vscode', {});
await sleep(2000);
const rq = await w1.request('chat', 'Aggiungi la validazione', { file: 'src/a.py', language: 'python', lines: 2, cursorLine: 1, attachments: [{ path: 'notes.txt', kind: 'file', note: '2 lines', text: '1| usa pydantic\n2| niente print' }] }, { agent: true });
assert(rq.claudeListening === true, 'listening while follow_vscode waits');
const f1 = await followP;
assert(f1.includes('Project memory') && f1.includes('pytest'), 'first round carries the project memory');
assert(f1.includes(`Request #${rq.seq}`) && f1.includes('AGENT MODE') && f1.includes('update_plan') && Date.now() - t0 < 8000, 'agent-mode request delivered quickly with instructions');
assert(f1.includes('attached file: notes.txt') && f1.includes('usa pydantic'), 'attached file in the context');
let cursor = cursorOf(f1);

await sleep(500);
assert(w1.received.some((j) => j.type === 'status' && j.params.state === 'working'), 'window got "working"');
assert(w1.received.some((j) => j.type === 'status' && j.params.listening === true), 'window got "listening"');

assert((await tool('update_plan', { request_id: rq.seq, steps: [{ title: 'Leggere il codice', status: 'done' }, { title: 'Validare', status: 'in_progress' }] })).includes('1/2'), 'update_plan answer');
await sleep(500);
assert(w1.received.some((j) => j.type === 'plan' && j.params.steps.length === 2 && j.params.request_id === rq.seq), 'plan delivered to the window');
assert((await tool('propose_changes', { description: 'validazione', request_id: rq.seq, files: [{ path: 'a.py', new_content: 'x' }, { path: 'b.py', new_content: 'y' }] })).includes('a.py, b.py'), 'propose_changes round trip');
assert((await tool('read_file', { path: 'src/a.py' })).includes('1| x=1'), 'read_file round trip');
assert((await tool('get_editor_context', {})).includes('Active file: src/a.py'), 'get_editor_context formatted');
assert((await tool('propose_edit', { path: 'src/a.py', description: 'x', edits: [{ old_text: 'zzz', new_text: 'q' }] })).startsWith('ERROR') , 'tool error propagated as isError');
assert((await tool('save_memory', { content: '- usa pydantic' })).includes('Saved'), 'save_memory round trip');
assert((await tool('get_terminal_output', {})).includes('npm test'), 'get_terminal_output round trip');
assert((await tool('list_dir', { path: '~/Downloads' })).includes('a.pdf'), 'list_dir round trip');
assert((await tool('propose_file_ops', { description: 'x', operations: [{ op: 'move', path: 'a', to: 'b' }] })).includes('1 moves'), 'propose_file_ops round trip');

// reply via follow, then an event comes back
const f2P = tool('follow_vscode', { cursor, reply: { request_id: rq.seq, text: 'Fatto: **validazione** aggiunta.' } });
await sleep(800);
assert(w1.received.some((j) => j.type === 'reply' && j.params.text.includes('validazione')), 'window got the reply');
await w1.api('POST', '/api/event', { event: 'edit_result', data: { edit_id: 'e5', paths: ['src/a.py'], accepted: true, problems: 'Problems VS Code now reports: none' } });
const f2 = await f2P;
assert(f2.includes('ACCEPTED') && f2.includes('Problems VS Code'), 'edit result event delivered');
assert(!f2.includes('Project memory'), 'memory only on the first round');
cursor = cursorOf(f2);
await w1.api('POST', '/api/event', { event: 'revert', data: { request_id: rq.seq, paths: ['a.py', 'b.py'] } });
await w1.api('POST', '/api/event', { event: 'ops_result', data: { ops_id: 'f1', summary: '2 moves', accepted: true } });
const f2b = await tool('follow_vscode', { cursor });
const f2c = f2b.includes('ACCEPTED and done') ? f2b : f2b + await tool('follow_vscode', { cursor: cursorOf(f2b) });
assert(f2c.includes('UNDID') && f2c.includes('a.py, b.py'), 'revert event delivered');
assert(f2c.includes('file operations f1 (2 moves) were ACCEPTED and done'), 'file operations event delivered');
cursor = cursorOf(f2c.slice(f2c.lastIndexOf('cursor: ')));

// ---------- window 2 ----------
const w2 = windowClient('w2', 'altro · PC2', { read_file: () => ({ ok: true, result: 'from w2' }) });
w2.loop();
await sleep(1000);
const wl = await tool('list_vscode_windows', {});
assert(wl.includes('"w1"') && wl.includes('"w2"') && wl.includes('altro · PC2'), 'list_vscode_windows lists both windows');
assert((await tool('read_file', { path: 'x', window: 'w2' })) === 'from w2', 'tool routed by window id');
assert((await tool('read_file', { path: 'x', window: 'altro' })) === 'from w2', 'tool routed by window name');
assert((await tool('read_file', { path: 'x', request_id: rq.seq })).includes('1| x=1'), 'tool routed by request_id');
assert((await tool('read_file', { path: 'x', window: 'zz zz' })).startsWith('ERROR'), 'unknown window name -> error');

// a chat bound to window 2 and a chat following every window share the work
const fBound = tool('follow_vscode', { cursor, window: 'w2' });
await sleep(400);
const fAll = tool('follow_vscode', { cursor });
await sleep(400);
const r2 = await w2.request('chat', 'domanda dalla finestra 2');
const r1 = await w1.request('chat', 'domanda dalla finestra 1');
const [b, a] = await Promise.all([fBound, fAll]);
assert(b.includes('domanda dalla finestra 2') && !b.includes('domanda dalla finestra 1') && b.includes('Pass window="w2"'), 'bound chat gets only its window');
assert(a.includes('domanda dalla finestra 1') && !a.includes('domanda dalla finestra 2') && a.includes('[window "w1"'), 'chat following all leaves window 2 to its own chat');
assert((await w2.api('GET', '/api/poll?wait=0')).j.claudeListening === true, 'window 2 sees a chat listening');
w2.on = false;
cursor = Math.max(cursorOf(a), r1.seq, r2.seq);

// ---------- other kinds of requests ----------
const kP = tool('follow_vscode', { cursor });
await sleep(300);
await w1.request('commit', 'Scrivi il messaggio di commit', { noEditor: true, diff: 'diff --git a/x b/x\n+riga nuova', diffStaged: true, recentCommits: ['Fix login'] });
await w1.request('fix', 'Sistema questo problema', { problem: 'src/a.py:3:1 error: undefined name y', snippet: '3| print(y)' });
await sleep(300);
const k = await kP;
assert(k.includes('COMMIT MESSAGE') && k.includes('+riga nuova') && k.includes('ONLY the commit message') && k.includes('Fix login'), 'commit request with diff and instructions');
cursor = cursorOf(k);
const k2 = k.includes('FIX a problem') ? k : await tool('follow_vscode', { cursor });
assert(k2.includes('FIX a problem') && k2.includes('undefined name y'), 'fix request with the problem');
cursor = cursorOf(k2);

const hP = tool('follow_vscode', { cursor });
await sleep(300);
await w1.request('handoff', 'Passa a una nuova chat', { noEditor: true });
const h = await hP;
assert(h.includes('HANDOFF') && h.includes('save_handoff') && !h.includes('Send each answer'), 'handoff request tells Claude to save and stop');
assert((await tool('save_handoff', { summary: 'riassunto' })).includes('do NOT call follow_vscode'), 'save_handoff tells Claude to stop');
cursor = cursorOf(h);

// a huge context is cut to fit the storage
const big = 'x'.repeat(1200000);
const bigR = await w1.request('chat', 'file enorme', { attachments: [{ path: 'big.txt', kind: 'file', note: '1 line', text: big }] });
assert(bigR.seq > 0, 'huge request accepted');
const bigF = await tool('follow_vscode', { cursor });
assert(bigF.includes('big.txt') && bigF.includes('[cut:') && bigF.length < 1000000, 'huge attachment cut to fit');
cursor = cursorOf(bigF);

// ---------- timing ----------
const t1 = Date.now();
const f3 = await tool('follow_vscode', { cursor });
assert(f3.includes('No new requests') && Date.now() - t1 > 24000, 'empty round waits ~25s');

w1.on = false;
await sleep(26000); // let the in-flight poll finish
const pend = await tool('read_file', { path: 'src/a.py' });
assert(pend.includes('Still pending') && pend.includes('get_result'), 'pending when the window does not answer');
const jobId = pend.match(/job_id "([^"]+)"/)[1];
w1.on = true;
assert((await tool('get_result', { job_id: jobId })).includes('1| x=1'), 'get_result returns the late result');

// ---------- stop ----------
const sP = tool('follow_vscode', { cursor });
await w1.request('stop', 'STOP');
const s = await sP;
assert(s.includes('STOP') && s.includes('Do NOT call follow_vscode'), 'stop handled');
console.log('ALL OK');
process.exit(0);
