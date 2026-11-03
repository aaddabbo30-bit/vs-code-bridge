(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const statusEl = $('status');
  const attsEl = $('atts');
  const q = $('q');
  const form = $('f');
  const toBottom = $('toBottom');
  const pills = { agent: $('agentBtn'), sel: $('selBtn'), file: $('fileBtn') };
  const saved = vscode.getState() || {};
  let opts = { sel: saved.sel !== false, file: !!saved.file };
  let state = { messages: [] };
  let lastKey = '';
  let maxSeenId = Number(saved.maxSeenId || 0);
  const codeStore = [];

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ic = (name) => `<i class="codicon codicon-${name}"></i>`;
  const time = (t) => (t ? new Date(t).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const saveUi = () => vscode.setState({ sel: opts.sel, file: opts.file, maxSeenId });

  // ---------- markdown (small, safe: everything is escaped first) ----------
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 <span style="opacity:.7">($2)</span>');
  }
  function md(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { html += '<p>' + inline(esc(para.join('\n'))).replace(/\n/g, '<br>') + '</p>'; para = []; } };
    const flushList = () => { if (list) { html += `<${list.t}>` + list.items.map((x) => '<li>' + inline(esc(x)) + '</li>').join('') + `</${list.t}>`; list = null; } };
    while (i < lines.length) {
      const l = lines[i];
      const fence = l.match(/^\s*```\s*([\w+#.-]*)/);
      if (fence) {
        flushPara(); flushList();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        const idx = codeStore.push(buf.join('\n')) - 1;
        html += `<div class="code"><div class="bar"><span>${esc(lang || 'code')}</span><button class="icon" data-act="copy" data-code="${idx}" title="Copy">${ic('copy')}</button><button class="icon" data-act="insert" data-code="${idx}" title="Insert at the cursor / replace the selection">${ic('insert')}</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
        continue;
      }
      const h = l.match(/^(#{1,6})\s+(.*)/);
      const ul = l.match(/^\s*[-*+]\s+(.*)/);
      const ol = l.match(/^\s*\d+[.)]\s+(.*)/);
      if (h) { flushPara(); flushList(); html += '<h4>' + inline(esc(h[2])) + '</h4>'; }
      else if (ul || ol) {
        flushPara();
        const t = ul ? 'ul' : 'ol';
        if (!list || list.t !== t) { flushList(); list = { t, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!l.trim()) { flushPara(); flushList(); }
      else if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += ' ' + l.trim(); }
      else { flushList(); para.push(l); }
      i++;
    }
    flushPara(); flushList();
    return html;
  }

  // ---------- header ----------
  function renderStatus() {
    let dot = 'off'; let txt = ''; let cta = '';
    if (!state.hasToken || state.conn === 'unconfigured') { txt = 'Not set up'; cta = `<button class="small cta" data-act="configure">Configure</button>`; }
    else if (state.conn === 'offline') { txt = 'Server unreachable'; cta = `<button class="small sec cta" data-act="configure">Configure</button>`; }
    else if (state.listening) { dot = 'on'; txt = 'AI is listening'; }
    else { dot = 'warn'; txt = 'Not listening'; cta = `<button class="small cta" data-act="copyPrompt" title="Copy the prompt to paste into an AI chat (new or existing)">Copy prompt</button>`; }
    if (state.windows > 1 && state.windowLabel) txt += ' · ' + state.windowLabel;
    statusEl.innerHTML = cta
      ? `<span class="pill-status compact" title="${esc(txt + (state.connError ? ': ' + state.connError : ''))}"><span class="dot ${dot}"></span></span>${cta}`
      : `<span class="pill-status" title="${esc(txt)}"><span class="dot ${dot}"></span><span>${esc(txt)}</span></span>`;
    const linked = state.session && state.session.url;
    $('linkBtn').innerHTML = ic(linked ? 'link-external' : 'link');
    $('linkBtn').title = linked ? 'Open the linked AI chat (or change the link)' : 'Link this conversation to its AI chat';
    $('historyBtn').classList.toggle('on', state.mode === 'history' || state.mode === 'view');
    $('stop').style.display = state.listening ? '' : 'none';
    pills.agent.setAttribute('aria-pressed', String(!!state.agent));
    document.body.classList.toggle('agent-on', !!state.agent);
    pills.sel.setAttribute('aria-pressed', String(opts.sel));
    pills.file.setAttribute('aria-pressed', String(opts.file));
  }

  function renderAtts() {
    const a = state.attachments || [];
    attsEl.innerHTML = a.map((x) => `<span class="chip" title="${esc(x.label)}">${ic(x.kind === 'folder' ? 'folder' : 'file')}<span>${esc(x.label)}</span><button data-act="removeAttachment" data-id="${x.id}" title="Remove">${ic('close')}</button></span>`).join('');
    attsEl.style.display = a.length ? '' : 'none';
  }

  // ---------- messages ----------
  const cmdState = { auto: ['run', 'ok'], asking: ['waiting for your approval', 'warn'], running: ['running', 'info'], done: ['done', 'ok'], failed: ['failed', 'err'], denied: ['denied', 'muted'] };
  const editState = { pending: ['to review', 'info'], accepted: ['accepted', 'ok'], applied: ['applied', 'ok'], rejected: ['rejected', 'muted'], expired: ['expired', 'muted'], reverted: ['undone', 'warn'], partial: ['stopped halfway', 'err'] };
  const stepIcon = { done: 'pass-filled', in_progress: 'circle-filled', skipped: 'circle-slash', pending: 'circle-large-outline' };
  const opIcon = { mkdir: 'new-folder', move: 'arrow-right', rename: 'edit', trash: 'trash' };
  const badge = (pair) => (pair ? `<span class="badge ${pair[1]}">${esc(pair[0])}</span>` : '');
  const working = (t) => `<div class="working"><span class="dots"><i></i><i></i><i></i></span>${esc(t)}</div>`;

  function checkpointOf(requestId, cpId) {
    const cps = state.checkpoints || [];
    const has = (c) => c.files.length || c.ops;
    if (cpId) return cps.find((c) => c.id === cpId);
    if (requestId == null) return null;
    const list = cps.filter((c) => c.requestId === requestId);
    return list.find((c) => !c.reverted && has(c)) || list[list.length - 1] || null;
  }
  function undoHtml(cp) {
    if (!cp || !(cp.files.length || cp.ops)) return '';
    if (cp.reverted) return `<div class="undo"><span class="badge warn">${ic('discard')} changes undone</span></div>`;
    const parts = [];
    if (cp.files.length) parts.push(`${cp.files.length} ${cp.files.length === 1 ? 'file' : 'files'}`);
    if (cp.ops) parts.push(`${cp.ops} file ${cp.ops === 1 ? 'operation' : 'operations'}`);
    return `<div class="undo"><button class="small sec" data-act="revert" data-id="${esc(cp.id)}" title="${esc(cp.files.join('\n'))}">${ic('discard')} Undo changes (${esc(parts.join(', '))})</button></div>`;
  }

  function renderMsg(m, isLastUser, ro) {
    const fresh = m.id > maxSeenId ? ' new' : '';
    if (m.role === 'user') {
      const meta = [];
      if (m.kind === 'edit') meta.push('edit');
      if (m.kind === 'fix') meta.push('fix');
      if (m.kind === 'commit') meta.push('commit message');
      if (m.kind === 'handoff') meta.push('move to a new chat');
      if (m.agent) meta.push('agent');
      if (m.sel) meta.push(m.sel);
      if (m.atts && m.atts.length) meta.push('📎 ' + m.atts.join(', '));
      let st = '';
      if (!ro) {
        if (m.state === 'sending') st = working('sending');
        else if (m.state === 'error') st = `<div class="meta">${ic('warning')} not sent: ${esc(m.error || '')}</div>`;
        else if (m.state === 'sent' && isLastUser) st = working(state.listening ? 'waiting for the AI' : 'waiting for an AI chat to listen');
        else if (m.state === 'working') st = working('AI is working');
      }
      return `<div class="msg user${fresh}" title="${esc(time(m.at))}"><div class="body">${esc(m.text)}</div>${meta.length ? `<div class="meta">${esc(meta.join(' · '))}</div>` : ''}${st}${undoHtml(checkpointOf(m.requestId))}</div>`;
    }
    if (m.role === 'claude') return `<div class="msg claude${fresh}" title="${esc(time(m.at))}"><div class="who"><span class="avatar">${ic('sparkle')}</span>AI</div><div class="body">${md(m.text)}</div></div>`;
    if (m.role === 'plan') {
      const steps = m.steps || [];
      const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
      const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
      return `<div class="msg card plan${fresh}"><div class="head">${ic('checklist')}<span class="title">${esc(m.title || 'Plan')}</span><span class="badge ${done === steps.length ? 'ok' : 'info'}">${done}/${steps.length}</span></div><div class="progress"><div style="width:${pct}%"></div></div><ul>${steps.map((s) => `<li class="${esc(s.status)}">${ic(stepIcon[s.status] || 'circle-large-outline')}<span>${esc(s.title)}</span></li>`).join('')}</ul></div>`;
    }
    if (m.role === 'edit') {
      const files = m.files || (m.path ? [m.path] : []);
      const title = files.length > 1 ? `Change to ${files.length} files` : (files[0] || 'Change');
      let acts = '';
      if (!ro && m.state === 'pending') acts = `<div class="acts"><button class="small" data-act="accept" data-id="${esc(m.editId)}">${ic('check')} Accept</button><button class="small sec" data-act="reject" data-id="${esc(m.editId)}">${ic('close')} Reject</button><button class="small sec" data-act="diff" data-id="${esc(m.editId)}">${ic('diff')} View diff</button></div>`;
      else if (!ro && (m.state === 'applied' || m.state === 'accepted')) acts = `<div class="acts"><button class="link" data-act="diff" data-id="${esc(m.editId)}">${ic('diff')} see the changes</button></div>`;
      if (m.requestId == null && m.cpId) acts += undoHtml(checkpointOf(null, m.cpId));
      const list = files.length > 1 ? `<ul class="files">${files.map((f) => `<li>${ic(/\(new\)$/.test(f) ? 'new-file' : /\(deleted\)$/.test(f) ? 'trash' : 'file')}<span>${esc(f)}</span></li>`).join('')}</ul>` : '';
      return `<div class="msg card edit ${esc(m.state)}${fresh}"><div class="head">${ic('diff')}<span class="title" title="${esc(files.join('\n'))}">${esc(title)}</span>${badge(editState[m.state])}</div>${m.desc ? `<div class="desc">${esc(m.desc)}</div>` : ''}${list}${acts}</div>`;
    }
    if (m.role === 'fileops') {
      const items = m.items || [];
      const shown = items.slice(0, 8);
      const more = (m.total || items.length) - shown.length;
      // paths are shown relative to the folder they all share, which is named once above the list
      const cut = (p) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      let base = items.length ? items[0].a.slice(0, cut(items[0].a)) : '';
      if (!base || !items.every((x) => x.a.startsWith(base) && x.a.length > base.length)) base = '';
      const short = (p) => (base && p && p.startsWith(base) && p.length > base.length ? p.slice(base.length + 1) : p || '');
      const line = (x) => (x.op === 'mkdir' ? esc(short(x.a)) + '/' : x.op === 'trash' ? `${esc(short(x.a))} <span class="muted">→ Recycle Bin</span>` : `${esc(short(x.a))} <span class="muted">→</span> ${esc(x.op === 'rename' ? x.b : short(x.b))}`);
      const list = `<ul class="files ops">${shown.map((x) => `<li title="${esc(x.a + (x.b ? ' → ' + x.b : ''))}">${ic(opIcon[x.op] || 'file')}<span>${line(x)}</span></li>`).join('')}</ul>${more > 0 ? `<button class="link small-link" data-act="showOps" data-id="${esc(m.opsId)}">+ ${more} more — show all</button>` : ''}`;
      let acts = '';
      if (!ro && m.state === 'pending') acts = `<div class="acts"><button class="small" data-act="acceptOps" data-id="${esc(m.opsId)}">${ic('check')} Accept</button><button class="small sec" data-act="rejectOps" data-id="${esc(m.opsId)}">${ic('close')} Reject</button><button class="small sec" data-act="showOps" data-id="${esc(m.opsId)}">${ic('list-flat')} Show all</button></div>`;
      if (m.error) acts += `<div class="desc err">${ic('warning')} ${esc(m.error)}</div>`;
      if (m.requestId == null && m.cpId) acts += undoHtml(checkpointOf(null, m.cpId));
      return `<div class="msg card fileops ${esc(m.state)}${fresh}"><div class="head">${ic('files')}<span class="title">Organize files</span>${badge(editState[m.state])}</div>${m.desc ? `<div class="desc">${esc(m.desc)}</div>` : ''}<div class="desc muted">${esc(m.summary || '')}${base ? ' · in ' + esc(base) : ''}</div>${list}${acts}</div>`;
    }
    if (m.role === 'cmd') return `<div class="msg card cmd${fresh}">${ic('terminal')}<code>${esc(m.text)}</code>${badge(cmdState[m.state])}</div>`;
    let extra = '';
    if (!ro && m.prompt) extra += ` <button class="link" data-act="copyPrompt">Copy prompt</button>`;
    if (!ro && m.action === 'openMemory') extra += ` <button class="link" data-act="openMemory">Open</button>`;
    if (!ro && m.action === 'linkChat') extra += ` <button class="link" data-act="linkChat">Link the chat</button>`;
    return `<div class="msg system${fresh}">${ic(m.icon || 'info')}${esc(m.text)}${extra}</div>`;
  }

  function welcome() {
    let cta = '';
    if (!state.hasToken || state.conn === 'unconfigured') cta = `<div class="cta-row"><button data-act="configure">${ic('gear')} Configure server and token</button></div>`;
    else if (!state.listening) cta = `<div class="cta-row"><button data-act="copyPrompt">${ic('copy')} Copy the prompt for the AI chat</button></div><div>Paste it into a new chat, or into a chat where you already discussed the work: the AI will use that context here.</div>`;
    const sug = state.listening ? `<div class="suggest">
      <button data-act="suggest" data-text="Explain what this file does" data-file="1">Explain the active file</button>
      <button data-act="suggest" data-text="Find possible bugs in the selected code">Find bugs in the selection</button>
      <button data-act="suggest" data-text="Write tests for the selected code">Write tests</button>
      <button data-act="suggest" data-text="Look at my Downloads folder (~/Downloads) and propose how to organize it">Organize Downloads</button></div>` : '';
    return `<div class="empty"><div class="logo">${ic('sparkle')}</div><h3>AI in VS Code</h3>${cta}
      <ol><li>Type here, or select code and press <span class="kbd">Ctrl+Alt+C</span> (ask) or <span class="kbd">Ctrl+Alt+E</span> (edit).</li>
      <li>Drop files here to attach them to the request.</li>
      <li>Changes arrive as diffs. With <strong>Agent</strong> on, the AI applies them itself and you undo everything with one click.</li></ol>${sug}</div>`;
  }

  function historyView() {
    const h = state.history || [];
    const head = `<div class="msg system">${ic('history')}Past conversations in this folder <button class="link" data-act="closeHistory">back to the chat</button></div>`;
    if (!h.length) return head + `<div class="empty">No archived conversations yet. When you press ${ic('add')} (new conversation) or move to a new chat, the current one ends up here.</div>`;
    return head + h.slice().reverse().map((s) => `<div class="msg card"><div class="head">${ic('comment-discussion')}<span class="title" title="${esc(s.title)}">${esc(s.title)}</span><span class="badge">${s.count} msg</span></div>
      <div class="desc muted">${esc(time(s.startedAt))} → ${esc(time(s.endedAt))}${s.url ? ' · linked to its AI chat' : ''}</div>
      <div class="acts"><button class="small" data-act="viewSession" data-id="${esc(s.id)}">${ic('eye')} Open</button><button class="small sec" data-act="resumeSession" data-id="${esc(s.id)}" title="Summary of this conversation for a new chat">${ic('debug-restart')} Resume</button>${s.url ? `<button class="small sec" data-act="openChat" data-id="${esc(s.id)}">${ic('link-external')} Open chat</button>` : ''}<button class="small sec" data-act="linkChat" data-id="${esc(s.id)}" title="Link the AI chat">${ic('link')}</button><button class="small sec" data-act="deleteSession" data-id="${esc(s.id)}" title="Delete">${ic('trash')}</button></div></div>`).join('');
  }

  function viewSession() {
    const v = state.viewing;
    const head = `<div class="msg card"><div class="head">${ic('history')}<span class="title">${esc(v.title)}</span></div><div class="desc muted">${esc(time(v.startedAt))} → ${esc(time(v.endedAt))} · read only</div>
      <div class="acts"><button class="small" data-act="resumeSession" data-id="${esc(v.id)}">${ic('debug-restart')} Resume in a chat</button>${v.url ? `<button class="small sec" data-act="openChat" data-id="${esc(v.id)}">${ic('link-external')} Open chat</button>` : ''}<button class="small sec" data-act="openHistory">${ic('arrow-left')} History</button><button class="small sec" data-act="closeHistory">Current chat</button></div></div>`;
    return head + (v.messages || []).map((m) => renderMsg(m, false, true)).join('');
  }

  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function placeToBottom() { toBottom.style.bottom = (form.offsetHeight + 10) + 'px'; }

  function render() {
    renderStatus();
    renderAtts();
    codeStore.length = 0;
    const wasNear = nearBottom();
    const ms = state.messages || [];
    let html;
    if (state.mode === 'history') html = historyView();
    else if (state.mode === 'view' && state.viewing) html = viewSession();
    else if (!ms.length) html = welcome();
    else {
      const lastUserIdx = ms.map((m) => m.role).lastIndexOf('user');
      html = ms.map((m, i) => renderMsg(m, i === lastUserIdx, false)).join('');
    }
    log.innerHTML = html;
    const key = state.mode + ':' + (state.mode === 'chat' ? ms.length + ':' + (ms.length ? ms[ms.length - 1].id : 0) : (state.viewing && state.viewing.id) || '');
    if (key !== lastKey) {
      const mine = ms.length && ms[ms.length - 1].role === 'user';
      if (state.mode !== 'chat') log.scrollTop = 0;
      else if (wasNear || mine || !lastKey) log.scrollTop = log.scrollHeight;
      lastKey = key;
    }
    maxSeenId = ms.reduce((a, m) => Math.max(a, m.id || 0), maxSeenId);
    saveUi();
    placeToBottom();
    toBottom.classList.toggle('show', state.mode === 'chat' && !nearBottom());
  }

  // ---------- events ----------
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'copy' || act === 'insert') vscode.postMessage({ type: act, text: codeStore[Number(b.dataset.code)] });
    else if (act === 'accept' || act === 'reject' || act === 'diff') vscode.postMessage({ type: act, editId: b.dataset.id });
    else if (act === 'removeAttachment') vscode.postMessage({ type: act, id: Number(b.dataset.id) });
    else if (act === 'suggest') {
      q.value = b.dataset.text;
      if (b.dataset.file) { opts.file = true; opts.sel = false; renderStatus(); saveUi(); }
      grow(); q.focus();
    } else vscode.postMessage({ type: act, id: b.dataset.id });
  });

  function grow() { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 200) + 'px'; placeToBottom(); }
  function send() {
    const text = q.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text, sel: opts.sel, file: opts.file });
    q.value = '';
    grow();
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  q.addEventListener('input', grow);
  $('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('attach').addEventListener('click', () => vscode.postMessage({ type: 'pickFiles' }));
  pills.agent.addEventListener('click', () => vscode.postMessage({ type: 'agent', on: !state.agent }));
  pills.sel.addEventListener('click', () => { opts.sel = !opts.sel; renderStatus(); saveUi(); });
  pills.file.addEventListener('click', () => { opts.file = !opts.file; renderStatus(); saveUi(); });
  toBottom.addEventListener('click', () => { log.scrollTop = log.scrollHeight; });
  log.addEventListener('scroll', () => toBottom.classList.toggle('show', state.mode === 'chat' && !nearBottom()));
  window.addEventListener('resize', placeToBottom);

  // ---------- drag & drop: files from VS Code's Explorer or from the computer become attachments ----------
  const FILE_TYPES = /uri-list|resourceurls|codefiles|^files$/i;
  const isFileDrag = (dt) => !!dt && Array.from(dt.types || []).some((t) => FILE_TYPES.test(t));
  const looksLikePaths = (s) => {
    const lines = String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return lines.length > 0 && lines.length <= 50 && lines.every((x) => /^(file|vscode-remote|vscode-userdata):\/\//i.test(x) || /^[a-zA-Z]:[\\/]/.test(x) || x.startsWith('\\\\'));
  };
  function urisFrom(dt) {
    const get = (t) => { try { return dt.getData(t) || ''; } catch { return ''; } };
    let list = (get('application/vnd.code.uri-list') || get('text/uri-list')).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    for (const t of ['ResourceURLs', 'CodeFiles']) {
      if (list.length) break;
      const raw = get(t);
      if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a)) list = a.filter((x) => typeof x === 'string'); } catch { /* not JSON */ } }
    }
    if (!list.length) { const t = get('text/plain'); if (looksLikePaths(t)) list = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); }
    return list;
  }
  let depth = 0;
  const dragOff = () => { depth = 0; document.body.classList.remove('dragging'); };
  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', () => { if (--depth <= 0) dragOff(); });
  document.addEventListener('drop', async (e) => {
    dragOff();
    const dt = e.dataTransfer;
    if (!dt) return;
    const uris = urisFrom(dt);
    if (uris.length) { e.preventDefault(); vscode.postMessage({ type: 'attachUris', uris }); return; }
    const files = Array.from(dt.files || []);
    if (!files.length) return; // plain text: let the text box take it
    e.preventDefault();
    const withPath = files.filter((f) => f.path).map((f) => f.path);
    if (withPath.length === files.length) { vscode.postMessage({ type: 'attachUris', uris: withPath }); return; }
    const out = [];
    for (const f of files) {
      if (f.size > 2 * 1024 * 1024) { out.push({ name: f.name, error: 'too big (max 2 MB)' }); continue; }
      try {
        const text = await f.text();
        if (text.slice(0, 8000).includes('\u0000')) out.push({ name: f.name, error: 'binary file' });
        else out.push({ name: f.name, text });
      } catch (err) { out.push({ name: f.name, error: String(err && err.message || err) }); }
    }
    vscode.postMessage({ type: 'attachFiles', files: out });
  }, true);

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') { state = e.data; render(); }
  });
  grow();
  vscode.postMessage({ type: 'ready' });
})();
