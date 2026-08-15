// Forge chat webview UI. Deliberately vanilla JS (no framework, no bundler)
// so the extension has zero runtime npm dependencies and nothing here needs
// a build step. Talks to the extension host via the standard
// acquireVsCodeApi() postMessage bridge; see src/webview/protocol.ts for the
// message shapes this file must stay in sync with.
(function () {
  const vscodeApi = acquireVsCodeApi();

  const state = {
    connected: true,
    models: [],
    chatModel: '',
    tabCompletionEnabled: true,
    indexStatus: { indexed: 0, total: 0, embeddingsAvailable: false },
    pendingEdits: [],
    modes: [],
    skills: [],
    sessions: [], // {id, title, mode, updatedAt}
    busyBySession: {},
    activeSessionId: '',
    activeMode: 'agent',
    history: [],
    attachedFiles: [],
  };

  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="forge-app">
      <div class="forge-header">
        <div class="forge-header-title"><span class="forge-logo">&#9670;</span> Forge</div>
        <div class="forge-header-actions">
          <button id="btn-index" class="icon-btn" title="Index workspace for @codebase search">&#8635;</button>
          <button id="btn-new-chat" class="icon-btn" title="New chat">+</button>
        </div>
      </div>
      <div id="tab-strip" class="forge-tab-strip"></div>
      <div id="banner" class="forge-banner" style="display:none;"></div>
      <div id="pending-panel" class="forge-pending-panel" style="display:none;">
        <div class="forge-pending-header">
          <span id="pending-count"></span>
          <span class="spacer"></span>
          <button id="btn-accept-all" class="link-btn">Accept all</button>
          <button id="btn-reject-all" class="link-btn">Reject all</button>
        </div>
        <div id="pending-list"></div>
      </div>
      <div id="transcript" class="forge-transcript"></div>
      <div class="forge-composer">
        <div id="mode-strip" class="forge-mode-strip"></div>
        <div id="chips" class="forge-chips"></div>
        <div id="mention-dropdown" class="forge-mention-dropdown" style="display:none;"></div>
        <textarea id="input" class="forge-input" rows="3" placeholder="Ask Forge, @ to attach a file, / for a skill… (Enter to send, Shift+Enter for newline)"></textarea>
        <div class="forge-composer-footer">
          <button id="btn-model" class="model-btn" title="Change model"></button>
          <label class="tab-toggle" title="Toggle Tab autocomplete">
            <input type="checkbox" id="tab-toggle-input" /> Tab-complete
          </label>
          <span class="spacer"></span>
          <span id="index-status" class="index-status"></span>
          <button id="btn-send" class="send-btn">Send</button>
        </div>
      </div>
      <div id="toast-host" class="toast-host"></div>
    </div>
  `;

  const el = {
    tabStrip: document.getElementById('tab-strip'),
    banner: document.getElementById('banner'),
    pendingPanel: document.getElementById('pending-panel'),
    pendingCount: document.getElementById('pending-count'),
    pendingList: document.getElementById('pending-list'),
    transcript: document.getElementById('transcript'),
    modeStrip: document.getElementById('mode-strip'),
    chips: document.getElementById('chips'),
    mentionDropdown: document.getElementById('mention-dropdown'),
    input: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')),
    modelBtn: document.getElementById('btn-model'),
    tabToggle: /** @type {HTMLInputElement} */ (document.getElementById('tab-toggle-input')),
    indexStatusEl: document.getElementById('index-status'),
    sendBtn: document.getElementById('btn-send'),
    toastHost: document.getElementById('toast-host'),
  };

  document.getElementById('btn-new-chat').addEventListener('click', () => vscodeApi.postMessage({ type: 'newChat' }));
  document.getElementById('btn-index').addEventListener('click', () => vscodeApi.postMessage({ type: 'indexWorkspace' }));
  document.getElementById('btn-accept-all').addEventListener('click', () => vscodeApi.postMessage({ type: 'acceptAllEdits' }));
  document.getElementById('btn-reject-all').addEventListener('click', () => vscodeApi.postMessage({ type: 'rejectAllEdits' }));
  el.modelBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'selectModel' }));
  el.tabToggle.addEventListener('change', () => vscodeApi.postMessage({ type: 'toggleTabCompletion', enabled: el.tabToggle.checked }));

  // ---------- mode strip ----------
  function renderModeStrip() {
    el.modeStrip.innerHTML = '';
    for (const m of state.modes) {
      const btn = document.createElement('button');
      btn.className = 'mode-btn' + (m.id === state.activeMode ? ' active' : '');
      btn.textContent = m.label;
      btn.title = m.description;
      btn.addEventListener('click', () => {
        if (m.id === state.activeMode) return;
        state.activeMode = m.id;
        renderModeStrip();
        vscodeApi.postMessage({ type: 'setMode', mode: m.id });
      });
      el.modeStrip.appendChild(btn);
    }
  }

  // ---------- tab strip (multitask) ----------
  function renderTabStrip() {
    el.tabStrip.innerHTML = '';
    for (const s of state.sessions) {
      const tab = document.createElement('div');
      tab.className = 'chat-tab' + (s.id === state.activeSessionId ? ' active' : '');
      const busy = !!state.busyBySession[s.id];
      tab.innerHTML = `
        ${busy ? '<span class="tab-spinner"></span>' : ''}
        <span class="tab-title">${escapeHtml(s.title || 'New chat')}</span>
        <span class="tab-close" title="Delete this chat permanently">&times;</span>
      `;
      tab.querySelector('.tab-title').addEventListener('click', () => {
        if (s.id !== state.activeSessionId) vscodeApi.postMessage({ type: 'switchSession', id: s.id });
      });
      tab.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        const label = s.title || 'this chat';
        if (!window.confirm(`Delete "${label}"? This permanently removes its saved history from .forge/chat.`)) return;
        vscodeApi.postMessage({ type: 'closeSession', id: s.id });
      });
      el.tabStrip.appendChild(tab);
    }
  }

  // ---------- composer ----------
  el.sendBtn.addEventListener('click', onSendOrStop);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSendOrStop();
    } else if (e.key === 'Escape') {
      hideMentionDropdown();
    }
  });
  el.input.addEventListener('input', onInputChanged);

  function onSendOrStop() {
    if (state.busyBySession[state.activeSessionId]) {
      vscodeApi.postMessage({ type: 'stop' });
      return;
    }
    const text = el.input.value.trim();
    if (!text && state.attachedFiles.length === 0) return;
    vscodeApi.postMessage({ type: 'send', text, files: state.attachedFiles.slice() });
    el.input.value = '';
    state.attachedFiles = [];
    renderChips();
    hideMentionDropdown();
  }

  let mentionQueryStart = -1;
  let mentionTrigger = '@';
  function onInputChanged() {
    const val = el.input.value;
    const caret = el.input.selectionStart || 0;
    const upToCaret = val.slice(0, caret);

    // Slash-command (skill) autocomplete only makes sense at the very start of the message.
    if (upToCaret.startsWith('/') && !upToCaret.slice(1).includes(' ') && !upToCaret.includes('\n')) {
      mentionTrigger = '/';
      mentionQueryStart = 0;
      showSkillResults(upToCaret.slice(1));
      return;
    }

    const atIdx = upToCaret.lastIndexOf('@');
    if (atIdx >= 0 && !/\s/.test(upToCaret.slice(atIdx + 1)) && (atIdx === 0 || /\s/.test(upToCaret[atIdx - 1]))) {
      mentionTrigger = '@';
      mentionQueryStart = atIdx;
      vscodeApi.postMessage({ type: 'queryFiles', query: upToCaret.slice(atIdx + 1) });
    } else {
      hideMentionDropdown();
    }
  }

  function hideMentionDropdown() {
    mentionQueryStart = -1;
    el.mentionDropdown.style.display = 'none';
    el.mentionDropdown.innerHTML = '';
  }

  function showSkillResults(query) {
    const q = query.toLowerCase();
    const matches = state.skills.filter((s) => s.name.toLowerCase().includes(q));
    if (matches.length === 0) {
      hideMentionDropdown();
      return;
    }
    el.mentionDropdown.style.display = 'block';
    el.mentionDropdown.innerHTML = '';
    for (const s of matches.slice(0, 12)) {
      const item = document.createElement('div');
      item.className = 'mention-item';
      item.innerHTML = `<strong>/${escapeHtml(s.name)}</strong>${s.description ? ` <span class="mention-desc">${escapeHtml(s.description)}</span>` : ''}`;
      item.addEventListener('click', () => {
        el.input.value = `/${s.name} `;
        hideMentionDropdown();
        el.input.focus();
        el.input.setSelectionRange(el.input.value.length, el.input.value.length);
      });
      el.mentionDropdown.appendChild(item);
    }
  }

  function showMentionResults(files) {
    if (mentionQueryStart < 0 || mentionTrigger !== '@') return;
    if (files.length === 0) {
      hideMentionDropdown();
      return;
    }
    el.mentionDropdown.style.display = 'block';
    el.mentionDropdown.innerHTML = '';
    for (const f of files.slice(0, 12)) {
      const item = document.createElement('div');
      item.className = 'mention-item';
      item.textContent = f;
      item.addEventListener('click', () => {
        const caret = el.input.selectionStart || 0;
        el.input.value = el.input.value.slice(0, mentionQueryStart) + el.input.value.slice(caret);
        if (!state.attachedFiles.includes(f)) state.attachedFiles.push(f);
        renderChips();
        hideMentionDropdown();
        el.input.focus();
      });
      el.mentionDropdown.appendChild(item);
    }
  }

  function renderChips() {
    el.chips.innerHTML = '';
    el.chips.style.display = state.attachedFiles.length ? 'flex' : 'none';
    for (const f of state.attachedFiles) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = `<span class="chip-label"></span><span class="chip-remove" title="Remove">&times;</span>`;
      chip.querySelector('.chip-label').textContent = f;
      chip.querySelector('.chip-remove').addEventListener('click', () => {
        state.attachedFiles = state.attachedFiles.filter((x) => x !== f);
        renderChips();
      });
      el.chips.appendChild(chip);
    }
  }

  // ---------- pending edits panel ----------
  function renderPendingEdits() {
    const n = state.pendingEdits.length;
    el.pendingPanel.style.display = n > 0 ? 'block' : 'none';
    if (n === 0) return;
    el.pendingCount.textContent = `${n} proposed change${n === 1 ? '' : 's'}`;
    el.pendingList.innerHTML = '';
    for (const edit of state.pendingEdits) {
      const row = document.createElement('div');
      row.className = 'pending-row';
      row.innerHTML = `
        <span class="pending-path" title="${escapeAttr(edit.relativePath)}">${escapeHtml(shortenPath(edit.relativePath))}</span>
        <span class="pending-stats"><span class="add">+${edit.additions}</span> <span class="del">-${edit.deletions}</span></span>
        <span class="pending-kind">${edit.kind}</span>
        <button class="link-btn" data-act="review">Review</button>
        <button class="link-btn" data-act="accept">Accept</button>
        <button class="link-btn" data-act="reject">Reject</button>
      `;
      row.querySelector('[data-act="review"]').addEventListener('click', () => vscodeApi.postMessage({ type: 'openDiff', id: edit.id }));
      row.querySelector('[data-act="accept"]').addEventListener('click', () => vscodeApi.postMessage({ type: 'acceptEdit', id: edit.id }));
      row.querySelector('[data-act="reject"]').addEventListener('click', () => vscodeApi.postMessage({ type: 'rejectEdit', id: edit.id }));
      el.pendingList.appendChild(row);
    }
  }

  // ---------- transcript rendering ----------
  function scrollToBottom() {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderAllHistory() {
    el.transcript.innerHTML = '';
    for (const entry of state.history) appendEntryDom(entry);
    scrollToBottom();
  }

  function appendEntryDom(entry) {
    const node = buildEntryNode(entry);
    if (node) {
      el.transcript.appendChild(node);
      scrollToBottom();
    }
  }

  function updateEntryDom(entry) {
    const existing = el.transcript.querySelector(`[data-id="${entry.id}"]`);
    if (entry.kind === 'assistant' && !entry.text && !entry.streaming) {
      if (existing) existing.remove();
      return;
    }
    const fresh = buildEntryNode(entry);
    if (!fresh) return;
    if (existing) existing.replaceWith(fresh);
    else el.transcript.appendChild(fresh);
    scrollToBottom();
  }

  function buildEntryNode(entry) {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-id', entry.id);

    if (entry.kind === 'user') {
      wrap.className = 'msg msg-user';
      const files = (entry.files || []).map((f) => `<span class="msg-file-chip">${escapeHtml(f)}</span>`).join('');
      wrap.innerHTML = `${files ? `<div class="msg-files">${files}</div>` : ''}<div class="msg-body">${renderMarkdown(entry.text)}</div>`;
      return wrap;
    }

    if (entry.kind === 'assistant') {
      wrap.className = 'msg msg-assistant' + (entry.streaming ? ' streaming' : '');
      const bodyHtml = entry.streaming ? escapeHtml(entry.text) : renderMarkdown(entry.text);
      wrap.innerHTML = `<div class="msg-avatar">&#9670;</div><div class="msg-body" data-raw="${entry.streaming ? '1' : '0'}">${bodyHtml}</div>`;
      return wrap;
    }

    if (entry.kind === 'plan') {
      wrap.className = 'plan-card' + (entry.executed ? ' executed' : '');
      wrap.innerHTML = `
        <div class="plan-head"><span class="plan-icon">&#9776;</span> Plan</div>
        <div class="plan-body">${renderMarkdown(entry.text)}</div>
        <div class="plan-actions">
          ${entry.executed ? '<span class="plan-executed-label">Executing in Agent mode…</span>' : '<button class="approve-btn" data-act="execute">Execute plan</button>'}
        </div>
      `;
      if (!entry.executed) {
        wrap.querySelector('[data-act="execute"]').addEventListener('click', () => vscodeApi.postMessage({ type: 'executePlan', id: entry.id }));
      }
      return wrap;
    }

    if (entry.kind === 'tool') {
      wrap.className = 'tool-card ' + (entry.status === 'running' ? 'running' : entry.ok ? 'ok' : 'fail');
      const icon = entry.status === 'running' ? spinnerSvg() : entry.ok ? '&#10003;' : '&#10007;';
      const argSummary = summarizeArgs(entry.tool, entry.args);
      wrap.innerHTML = `
        <div class="tool-card-head">
          <span class="tool-icon">${icon}</span>
          <span class="tool-name">${escapeHtml(entry.tool)}</span>
          <span class="tool-args">${escapeHtml(argSummary)}</span>
        </div>
        ${entry.summary ? `<div class="tool-summary">${escapeHtml(entry.summary)}</div>` : ''}
      `;
      return wrap;
    }

    if (entry.kind === 'approval') {
      wrap.className = 'approval-card ' + entry.status;
      wrap.innerHTML = `
        <div class="approval-detail"><span class="approval-label">Run command?</span><code>${escapeHtml(entry.detail)}</code></div>
        <div class="approval-actions">
          ${entry.status === 'pending' ? `<button data-act="approve" class="approve-btn">Approve</button><button data-act="deny" class="deny-btn">Deny</button>` : `<span class="approval-status">${entry.status === 'approved' ? 'Approved' : 'Denied'}</span>`}
        </div>
      `;
      if (entry.status === 'pending') {
        wrap.querySelector('[data-act="approve"]').addEventListener('click', () => vscodeApi.postMessage({ type: 'resolveApproval', callId: entry.callId, approved: true }));
        wrap.querySelector('[data-act="deny"]').addEventListener('click', () => vscodeApi.postMessage({ type: 'resolveApproval', callId: entry.callId, approved: false }));
      }
      return wrap;
    }

    if (entry.kind === 'error') {
      wrap.className = 'msg msg-error';
      wrap.innerHTML = `<span class="error-icon">&#9888;</span> ${escapeHtml(entry.text)}`;
      return wrap;
    }

    if (entry.kind === 'system') {
      wrap.className = 'msg msg-system';
      wrap.textContent = entry.text;
      return wrap;
    }

    return null;
  }

  function summarizeArgs(tool, args) {
    if (!args) return '';
    if (typeof args.path === 'string') return args.path + (args.search ? ' (targeted edit)' : '');
    if (typeof args.command === 'string') return args.command;
    if (typeof args.query === 'string') return `"${args.query}"`;
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }

  function spinnerSvg() {
    return '<span class="spinner"></span>';
  }

  // ---------- toasts ----------
  function showToast(level, text) {
    const t = document.createElement('div');
    t.className = 'toast toast-' + level;
    t.textContent = text;
    el.toastHost.appendChild(t);
    setTimeout(() => {
      t.classList.add('fade-out');
      setTimeout(() => t.remove(), 300);
    }, 4000);
  }

  // ---------- header / status ----------
  function renderModelBtn() {
    el.modelBtn.textContent = state.chatModel ? `⚙ ${state.chatModel}` : '⚙ Select model…';
  }

  function renderConnectionBanner() {
    if (state.connected) {
      el.banner.style.display = 'none';
      return;
    }
    el.banner.style.display = 'block';
    el.banner.className = 'forge-banner forge-banner-error';
    el.banner.textContent = 'Can\'t reach Ollama. Run "ollama serve" on your Mac, then reopen this panel.';
  }

  function renderIndexStatus() {
    const s = state.indexStatus;
    if (!s || s.total === 0) {
      el.indexStatusEl.textContent = 'not indexed';
      return;
    }
    el.indexStatusEl.textContent = s.embeddingsAvailable ? `index: ${s.indexed}/${s.total}` : `index: ${s.total} (keyword)`;
  }

  function renderBusy() {
    const busy = !!state.busyBySession[state.activeSessionId];
    el.sendBtn.textContent = busy ? 'Stop' : 'Send';
    el.sendBtn.classList.toggle('stop', busy);
  }

  function loadSession(session) {
    state.activeSessionId = session.id;
    state.activeMode = session.mode;
    state.busyBySession[session.id] = session.busy;
    state.history = session.history;
    renderModeStrip();
    renderTabStrip();
    renderBusy();
    renderAllHistory();
  }

  // ---------- message handling ----------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init': {
        Object.assign(state, {
          connected: msg.state.connected,
          models: msg.state.models,
          chatModel: msg.state.chatModel,
          tabCompletionEnabled: msg.state.tabCompletionEnabled,
          indexStatus: msg.state.indexStatus,
          pendingEdits: msg.state.pendingEdits,
          modes: msg.state.modes,
          skills: msg.state.skills,
          sessions: msg.state.sessions,
        });
        el.tabToggle.checked = state.tabCompletionEnabled;
        renderModelBtn();
        renderConnectionBanner();
        renderIndexStatus();
        renderPendingEdits();
        loadSession(msg.state.activeSession);
        if (!state.connected) showToast('error', msg.state.connectionError ? `Ollama: ${msg.state.connectionError}` : 'Ollama not reachable.');
        break;
      }
      case 'sessionsList': {
        state.sessions = msg.sessions;
        state.activeSessionId = msg.activeId;
        renderTabStrip();
        break;
      }
      case 'sessionSwitched': {
        loadSession(msg.session);
        break;
      }
      case 'entry': {
        if (msg.sessionId !== state.activeSessionId) break;
        state.history.push(msg.entry);
        appendEntryDom(msg.entry);
        break;
      }
      case 'entryUpdate': {
        if (msg.sessionId !== state.activeSessionId) break;
        const idx = state.history.findIndex((e) => e.id === msg.entry.id);
        if (idx >= 0) state.history[idx] = msg.entry;
        else state.history.push(msg.entry);
        updateEntryDom(msg.entry);
        break;
      }
      case 'tokenAppend': {
        if (msg.sessionId !== state.activeSessionId) break;
        const node = el.transcript.querySelector(`[data-id="${msg.id}"] .msg-body`);
        if (node) {
          node.textContent += msg.text;
          scrollToBottom();
        }
        break;
      }
      case 'pendingEdits': {
        state.pendingEdits = msg.edits;
        renderPendingEdits();
        break;
      }
      case 'busy': {
        state.busyBySession[msg.sessionId] = msg.busy;
        if (msg.sessionId === state.activeSessionId) renderBusy();
        renderTabStrip();
        break;
      }
      case 'filesResult': {
        showMentionResults(msg.files);
        break;
      }
      case 'skillsList': {
        state.skills = msg.skills;
        break;
      }
      case 'toast': {
        showToast(msg.level, msg.text);
        break;
      }
      case 'indexStatus': {
        state.indexStatus = { indexed: msg.indexed, total: msg.total, embeddingsAvailable: msg.embeddingsAvailable };
        renderIndexStatus();
        break;
      }
      case 'prefill': {
        if (msg.text) el.input.value = (el.input.value ? el.input.value + '\n' : '') + msg.text;
        if (msg.files) {
          for (const f of msg.files) if (!state.attachedFiles.includes(f)) state.attachedFiles.push(f);
          renderChips();
        }
        el.input.focus();
        break;
      }
    }
  });

  // ---------- markdown-lite ----------
  function renderMarkdown(raw) {
    if (!raw) return '';
    const parts = [];
    const fenceRe = /```(\w*)\n?([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fenceRe.exec(raw))) {
      if (m.index > last) parts.push({ type: 'text', content: raw.slice(last, m.index) });
      parts.push({ type: 'code', lang: m[1], content: m[2] });
      last = fenceRe.lastIndex;
    }
    if (last < raw.length) parts.push({ type: 'text', content: raw.slice(last) });

    return parts
      .map((p) => {
        if (p.type === 'code') {
          return `<pre class="code-block"><code>${escapeHtml(p.content)}</code></pre>`;
        }
        let html = escapeHtml(p.content);
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
        html = html
          .split('\n')
          .map((line) => {
            const bm = /^(\s*)[-*]\s+(.*)$/.exec(line);
            const nm = /^(\s*)\d+\.\s+(.*)$/.exec(line);
            if (bm) return `<li>${bm[2]}</li>`;
            if (nm) return `<li>${nm[2]}</li>`;
            return line;
          })
          .join('\n');
        html = html.replace(/(<li>.*?<\/li>\n?)+/gs, (block) => `<ul>${block.replace(/\n/g, '')}</ul>`);
        html = html.replace(/\n/g, '<br>');
        return html;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }
  function shortenPath(p) {
    if (p.length <= 46) return p;
    const parts = p.split('/');
    const file = parts.pop();
    return '…/' + file;
  }

  // ---------- boot ----------
  vscodeApi.postMessage({ type: 'ready' });
})();
