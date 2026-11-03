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
  const ic = (name, extra = '') => `<i class="codicon codicon-${name}${extra}"></i>`;
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
        html += `<div class="code"><div class="bar"><span>${esc(lang || 'codice')}</span><button class="icon" data-act="copy" data-code="${idx}" title="Copia">${ic('copy')}</button><button class="icon" data-act="insert" data-code="${idx}" title="Inserisci al cursore / sostituisci la selezione">${ic('insert')}</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
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
    if (!state.hasToken || state.conn === 'unconfigured') { txt = 'Da configurare'; cta = `<button class="small cta" data-act="configure">Configura</button>`; }
    else if (state.conn === 'offline') { txt = 'Server non raggiungibile'; cta = `<button class="small sec cta" data-act="configure" title="${esc(state.connError || '')}">Configura</button>`; }
    else if (state.listening) { dot = 'on'; txt = 'Claude in ascolto'; }
    else { dot = 'warn'; txt = 'Non in ascolto'; cta = `<button class="small cta" data-act="copyPrompt" title="Copia il prompt da incollare in claude.ai (chat nuova o esistente)">Copia prompt</button>`; }
    if (state.windows > 1 && state.windowLabel) txt += ' · ' + state.windowLabel;
    statusEl.innerHTML = cta
      ? `<span class="pill-status compact" title="${esc(txt + (state.connError ? ': ' + state.connError : ''))}"><span class="dot ${dot}"></span></span>${cta}`
      : `<span class="pill-status" title="${esc(txt)}"><span class="dot ${dot}"></span><span>${esc(txt)}</span></span>`;
    const linked = state.session && state.session.url;
    $('linkBtn').innerHTML = ic(linked ? 'link-external' : 'link');
    $('linkBtn').title = linked ? 'Apri la chat collegata in claude.ai (o cambia link)' : 'Collega questa conversazione al link della sua chat di claude.ai';
    $('historyBtn').classList.toggle('on', state.mode === 'history' || state.mode === 'view');
    $('stop').style.display = state.listening ? '' : 'none';
    pills.agent.setAttribute('aria-pressed', String(!!state.agent));
    document.body.classList.toggle('agent-on', !!state.agent);
    pills.sel.setAttribute('aria-pressed', String(opts.sel));
    pills.file.setAttribute('aria-pressed', String(opts.file));
  }

  function renderAtts() {
    const a = state.attachments || [];
    attsEl.innerHTML = a.map((x) => `<span class="chip" title="${esc(x.label)}">${ic(x.kind === 'folder' ? 'folder' : 'file')}<span>${esc(x.label)}</span><button data-act="removeAttachment" data-id="${x.id}" title="Togli">${ic('close')}</button></span>`).join('');
    attsEl.style.display = a.length ? '' : 'none';
  }

  // ---------- messages ----------
  const cmdState = { auto: ['eseguito', 'ok'], asking: ['attende la tua approvazione', 'warn'], running: ['in esecuzione', 'info'], done: ['completato', 'ok'], failed: ['terminato con errore', 'err'], denied: ['rifiutato', 'muted'] };
  const editState = { pending: ['da rivedere', 'info'], accepted: ['accettata', 'ok'], applied: ['applicata', 'ok'], rejected: ['rifiutata', 'muted'], expired: ['scaduta', 'muted'], reverted: ['annullata', 'warn'] };
  const stepIcon = { done: 'pass-filled', in_progress: 'circle-filled', skipped: 'circle-slash', pending: 'circle-large-outline' };
  const badge = (pair) => (pair ? `<span class="badge ${pair[1]}">${esc(pair[0])}</span>` : '');
  const working = (t) => `<div class="working"><span class="dots"><i></i><i></i><i></i></span>${esc(t)}</div>`;

  function checkpointOf(requestId, cpId) {
    const cps = state.checkpoints || [];
    if (cpId) return cps.find((c) => c.id === cpId);
    if (requestId == null) return null;
    const list = cps.filter((c) => c.requestId === requestId);
    return list.find((c) => !c.reverted && c.files.length) || list[list.length - 1] || null;
  }
  function undoHtml(cp, ro) {
    if (!cp || !cp.files.length) return '';
    if (cp.reverted) return `<div class="undo"><span class="badge warn">${ic('discard')} modifiche annullate</span></div>`;
    if (ro) return '';
    return `<div class="undo"><button class="small sec" data-act="revert" data-id="${esc(cp.id)}" title="${esc(cp.files.join('\n'))}">${ic('discard')} Annulla le modifiche (${cp.files.length} file)</button></div>`;
  }

  function renderMsg(m, isLastUser, ro) {
    const fresh = m.id > maxSeenId ? ' new' : '';
    if (m.role === 'user') {
      const meta = [];
      if (m.kind === 'edit') meta.push('modifica');
      if (m.kind === 'fix') meta.push('correzione');
      if (m.kind === 'commit') meta.push('messaggio di commit');
      if (m.kind === 'handoff') meta.push('passaggio a una nuova chat');
      if (m.agent) meta.push('agente');
      if (m.sel) meta.push(m.sel);
      if (m.atts && m.atts.length) meta.push('📎 ' + m.atts.join(', '));
      let st = '';
      if (!ro) {
        if (m.state === 'sending') st = working('invio');
        else if (m.state === 'error') st = `<div class="meta">${ic('warning')} non inviata: ${esc(m.error || '')}</div>`;
        else if (m.state === 'sent' && isLastUser) st = working(state.listening ? 'in coda per Claude' : 'in attesa di una chat in ascolto');
        else if (m.state === 'working') st = working('Claude sta lavorando');
      }
      return `<div class="msg user${fresh}" title="${esc(time(m.at))}"><div class="body">${esc(m.text)}</div>${meta.length ? `<div class="meta">${esc(meta.join(' · '))}</div>` : ''}${st}${undoHtml(checkpointOf(m.requestId), false)}</div>`;
    }
    if (m.role === 'claude') return `<div class="msg claude${fresh}" title="${esc(time(m.at))}"><div class="who"><span class="avatar">${ic('sparkle')}</span>Claude</div><div class="body">${md(m.text)}</div></div>`;
    if (m.role === 'plan') {
      const steps = m.steps || [];
      const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
      const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
      return `<div class="msg card plan${fresh}"><div class="head">${ic('checklist')}<span class="title">${esc(m.title || 'Piano')}</span><span class="badge ${done === steps.length ? 'ok' : 'info'}">${done}/${steps.length}</span></div><div class="progress"><div style="width:${pct}%"></div></div><ul>${steps.map((s) => `<li class="${esc(s.status)}">${ic(stepIcon[s.status] || 'circle-large-outline')}<span>${esc(s.title)}</span></li>`).join('')}</ul></div>`;
    }
    if (m.role === 'edit') {
      const files = m.files || (m.path ? [m.path] : []);
      const title = files.length > 1 ? `Modifica di ${files.length} file` : (files[0] || 'Modifica');
      let acts = '';
      if (!ro && m.state === 'pending') acts = `<div class="acts"><button class="small" data-act="accept" data-id="${esc(m.editId)}">${ic('check')} Accetta</button><button class="small sec" data-act="reject" data-id="${esc(m.editId)}">${ic('close')} Rifiuta</button><button class="small sec" data-act="diff" data-id="${esc(m.editId)}">${ic('diff')} Vedi diff</button></div>`;
      else if (!ro && (m.state === 'applied' || m.state === 'accepted')) acts = `<div class="acts"><button class="link" data-act="diff" data-id="${esc(m.editId)}">${ic('diff')} vedi le modifiche</button></div>`;
      if (m.requestId == null && m.cpId) acts += undoHtml(checkpointOf(null, m.cpId), false);
      const list = files.length > 1 ? `<ul class="files">${files.map((f) => `<li>${ic(/\(nuovo\)$/.test(f) ? 'new-file' : /\(eliminato\)$/.test(f) ? 'trash' : 'file')}<span>${esc(f)}</span></li>`).join('')}</ul>` : '';
      return `<div class="msg card edit ${esc(m.state)}${fresh}"><div class="head">${ic('diff')}<span class="title" title="${esc(files.join('\n'))}">${esc(title)}</span>${badge(editState[m.state])}</div>${m.desc ? `<div class="desc">${esc(m.desc)}</div>` : ''}${list}${acts}</div>`;
    }
    if (m.role === 'cmd') return `<div class="msg card cmd${fresh}">${ic('terminal')}<code>${esc(m.text)}</code>${badge(cmdState[m.state])}</div>`;
    let extra = '';
    if (!ro && m.prompt) extra += ` <button class="link" data-act="copyPrompt">Copia prompt</button>`;
    if (!ro && m.action === 'openMemory') extra += ` <button class="link" data-act="openMemory">Apri</button>`;
    if (!ro && m.action === 'linkChat') extra += ` <button class="link" data-act="linkChat">Collega il link della chat</button>`;
    return `<div class="msg system${fresh}">${ic(m.icon || 'info')}${esc(m.text)}${extra}</div>`;
  }

  function welcome() {
    let cta = '';
    if (!state.hasToken || state.conn === 'unconfigured') cta = `<div class="cta-row"><button data-act="configure">${ic('gear')} Configura server e token</button></div>`;
    else if (!state.listening) cta = `<div class="cta-row"><button data-act="copyPrompt">${ic('copy')} Copia il prompt per claude.ai</button></div><div>Incollalo in una chat nuova, oppure in una chat dove hai già parlato del lavoro: Claude userà quel contesto qui.</div>`;
    const sug = state.listening ? `<div class="suggest">
      <button data-act="suggest" data-text="Spiegami cosa fa questo file" data-file="1">Spiega il file attivo</button>
      <button data-act="suggest" data-text="Trova possibili bug nel codice selezionato">Trova bug nella selezione</button>
      <button data-act="suggest" data-text="Scrivi i test per il codice selezionato">Scrivi i test</button>
      <button data-act="suggest" data-text="Come posso migliorare questo codice?">Suggerisci miglioramenti</button></div>` : '';
    return `<div class="empty"><div class="logo">${ic('sparkle')}</div><h3>Claude in VS Code</h3>${cta}
      <ol><li>Scrivi qui, oppure seleziona codice e premi <span class="kbd">Ctrl+Alt+C</span> (domanda) o <span class="kbd">Ctrl+Alt+E</span> (modifica).</li>
      <li>Trascina qui i file per allegarli alla richiesta.</li>
      <li>Le modifiche arrivano come diff. Con <strong>Agente</strong> Claude le applica da solo e tu annulli tutto con un clic.</li></ol>${sug}</div>`;
  }

  function historyView() {
    const h = state.history || [];
    const head = `<div class="msg system">${ic('history')}Conversazioni passate in questa cartella <button class="link" data-act="closeHistory">torna alla chat</button></div>`;
    if (!h.length) return head + `<div class="empty">Nessuna conversazione archiviata. Quando premi ${ic('add')} (nuova conversazione) o passi a una nuova chat, quella attuale finisce qui.</div>`;
    return head + h.slice().reverse().map((s) => `<div class="msg card"><div class="head">${ic('comment-discussion')}<span class="title" title="${esc(s.title)}">${esc(s.title)}</span><span class="badge">${s.count} msg</span></div>
      <div class="desc" style="color:var(--muted)">${esc(time(s.startedAt))} → ${esc(time(s.endedAt))}${s.url ? ' · collegata a claude.ai' : ''}</div>
      <div class="acts"><button class="small" data-act="viewSession" data-id="${esc(s.id)}">${ic('eye')} Apri</button><button class="small sec" data-act="resumeSession" data-id="${esc(s.id)}" title="Riassunto di questa conversazione per una chat nuova">${ic('debug-restart')} Riprendi</button>${s.url ? `<button class="small sec" data-act="openChat" data-id="${esc(s.id)}">${ic('link-external')} claude.ai</button>` : ''}<button class="small sec" data-act="linkChat" data-id="${esc(s.id)}" title="Collega il link della chat di claude.ai">${ic('link')}</button><button class="small sec" data-act="deleteSession" data-id="${esc(s.id)}" title="Elimina">${ic('trash')}</button></div></div>`).join('');
  }

  function viewSession() {
    const v = state.viewing;
    const head = `<div class="msg card"><div class="head">${ic('history')}<span class="title">${esc(v.title)}</span></div><div class="desc" style="color:var(--muted)">${esc(time(v.startedAt))} → ${esc(time(v.endedAt))} · sola lettura</div>
      <div class="acts"><button class="small" data-act="resumeSession" data-id="${esc(v.id)}">${ic('debug-restart')} Riprendi in una chat</button>${v.url ? `<button class="small sec" data-act="openChat" data-id="${esc(v.id)}">${ic('link-external')} Apri in claude.ai</button>` : ''}<button class="small sec" data-act="openHistory">${ic('arrow-left')} Cronologia</button><button class="small sec" data-act="closeHistory">Chat attuale</button></div></div>`;
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
      if (f.size > 2 * 1024 * 1024) { out.push({ name: f.name, error: 'troppo grande (max 2 MB)' }); continue; }
      try {
        const text = await f.text();
        if (text.slice(0, 8000).includes('\u0000')) out.push({ name: f.name, error: 'file binario' });
        else out.push({ name: f.name, text });
      } catch (err) { out.push({ name: f.name, error: String(err && err.message || err) }); }
    }
    vscode.postMessage({ type: 'attachFiles', files: out });
  }, true);

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') { state = e.data; render(); }
    if (e.data && e.data.type === 'focus') q.focus();
  });
  grow();
  vscode.postMessage({ type: 'ready' });
})();
