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
    checkpoints: [], // {id, label, createdAt} for the active session
    verifyCommand: '', // optional "definition of done" command for the active session (Agent/Auto/Outcome modes)
    orchestrationEnabled: false, // item 4c: per-chat orchestration-mode toggle
    taskLedger: [], // item 4a/4b: mandatory checkpoint-progress ledger for the active session, [{id, description, status, summary, parentTaskId}]
    hwStatus: { loadedModels: [] },
    lastMetrics: undefined,
    mentionResults: [], // [{path, kind}] or skill matches, whichever is active
    mentionSelectedIndex: -1,
    searchOpen: false,
    allChatsOpen: false,
    settingsOpen: false,
    settings: null, // populated lazily from 'settingsData' the first time the panel is opened
    numCtxOverride: undefined, // active session's per-chat context override, if any
    sessionModel: '', // active session's own model override, if any — item "run separate models in different chats"
    statusText: '', // brief "what is the agent doing" line — item "brief status messages"
    statusActivity: undefined, // machine-readable category paired with statusText — item "progress indicators"
    bgCommandsOpen: false,
    backgroundCommands: [], // item "ability to kill commands while running from the chat window"
    // Highest 'sessionsList'/'allChatsList' seq applied so far — a lower-seq
    // message that arrives late (two overlapping extension-host reads
    // resolving out of order) is discarded instead of rolling the tab strip
    // back to stale data. See chatViewProvider.ts's sessionsListSeq doc comment.
    sessionsListSeq: -1,
    allChatsListSeq: -1,
  };

  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="forge-app">
      <div class="forge-header">
        <div class="forge-header-title"><span class="forge-logo">&#9670;</span> Forge</div>
        <div class="forge-header-actions">
          <button id="btn-search" class="icon-btn" title="Search all chats">&#128269;</button>
          <button id="btn-all-chats" class="icon-btn" title="All chats (including closed ones)">&#128193;</button>
          <button id="btn-bg-commands" class="icon-btn" title="Background commands">&#9881;&#9654;</button>
          <button id="btn-settings" class="icon-btn" title="Settings">&#9881;</button>
          <button id="btn-index" class="icon-btn" title="Index workspace for @codebase search">&#8635;</button>
          <button id="btn-new-chat" class="icon-btn" title="New chat">+</button>
        </div>
      </div>
      <div id="tab-strip" class="forge-tab-strip"></div>
      <div id="search-panel" class="forge-search-panel" style="display:none;">
        <input id="search-input" type="text" placeholder="Search every chat…" />
        <div id="search-results" class="search-results"></div>
      </div>
      <div id="all-chats-panel" class="forge-search-panel" style="display:none;">
        <div class="all-chats-header">All chats <span class="all-chats-hint">closed chats are still saved — click to reopen</span></div>
        <div id="all-chats-list" class="search-results"></div>
      </div>
      <div id="bg-commands-panel" class="forge-search-panel" style="display:none;">
        <div class="all-chats-header">Background commands <span class="all-chats-hint">started via run_command with background:true — shared across every chat</span></div>
        <div id="bg-commands-list" class="search-results"></div>
      </div>
      <div id="settings-panel" class="forge-search-panel forge-settings-panel" style="display:none;">
        <div class="all-chats-header">Settings</div>
        <div id="settings-body" class="settings-body"></div>
      </div>
      <div id="confirm-overlay" class="forge-modal-overlay" style="display:none;">
        <div class="forge-modal">
          <div id="confirm-modal-text" class="forge-modal-text"></div>
          <div class="forge-modal-actions">
            <button id="confirm-modal-cancel" class="link-btn">Cancel</button>
            <button id="confirm-modal-ok" class="deny-btn">Confirm</button>
          </div>
        </div>
      </div>
      <div id="prompt-overlay" class="forge-modal-overlay" style="display:none;">
        <div class="forge-modal">
          <div id="prompt-modal-text" class="forge-modal-text"></div>
          <input id="prompt-modal-input" type="text" class="forge-modal-input" />
          <div class="forge-modal-actions">
            <button id="prompt-modal-cancel" class="link-btn">Cancel</button>
            <button id="prompt-modal-ok" class="approve-btn">Save</button>
          </div>
        </div>
      </div>
      <div id="banner" class="forge-banner" style="display:none;"></div>
      <div id="auto-banner" class="forge-banner forge-banner-warn" style="display:none;"></div>
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
        <div id="verify-row" class="forge-verify-row" style="display:none;">
          <span class="verify-row-label" title="Optional shell command Forge automatically re-runs after every final answer in this mode — a non-zero exit is fed back and the run keeps going instead of stopping.">&#127919; Definition of done:</span>
          <input id="verify-input" type="text" placeholder="optional command, e.g. npm test — leave blank to skip" />
        </div>
        <div id="orch-row" class="forge-orch-row" style="display:none;">
          <label class="orch-toggle" title="When on, the model acts as an orchestrator: it breaks the task into a plan (plan_tasks), delegates each piece to a sub-agent one at a time (spawn_subagent), and reports/re-plans between each one — instead of doing everything itself inline. The task ledger below tracks progress either way, so an interrupted session can resume without redoing finished work.">
            <input type="checkbox" id="orch-toggle-input" /> &#129504; Orchestration mode
          </label>
          <span id="orch-progress" class="orch-progress"></span>
        </div>
        <div id="chips" class="forge-chips"></div>
        <div id="mention-dropdown" class="forge-mention-dropdown" style="display:none;"></div>
        <div id="status-line" class="forge-status-line" style="display:none;"></div>
        <textarea id="input" class="forge-input" rows="3" placeholder="Ask Forge, @ to attach a file, / for a skill… (Enter to send, Shift+Enter for newline)"></textarea>
        <div class="forge-composer-footer">
          <button id="btn-model" class="model-btn" title="Change model"></button>
          <label class="tab-toggle" title="Toggle Tab autocomplete">
            <input type="checkbox" id="tab-toggle-input" /> Tab-complete
          </label>
          <span class="spacer"></span>
          <span id="hw-readout" class="hw-readout" title="Click to refresh HW status"></span>
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
    autoBanner: document.getElementById('auto-banner'),
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
    hwReadout: document.getElementById('hw-readout'),
    sendBtn: document.getElementById('btn-send'),
    toastHost: document.getElementById('toast-host'),
    searchBtn: document.getElementById('btn-search'),
    searchPanel: document.getElementById('search-panel'),
    searchInput: /** @type {HTMLInputElement} */ (document.getElementById('search-input')),
    searchResults: document.getElementById('search-results'),
    verifyRow: document.getElementById('verify-row'),
    verifyInput: /** @type {HTMLInputElement} */ (document.getElementById('verify-input')),
    orchRow: document.getElementById('orch-row'),
    orchToggleInput: /** @type {HTMLInputElement} */ (document.getElementById('orch-toggle-input')),
    orchProgress: document.getElementById('orch-progress'),
    allChatsBtn: document.getElementById('btn-all-chats'),
    allChatsPanel: document.getElementById('all-chats-panel'),
    allChatsList: document.getElementById('all-chats-list'),
    bgCommandsBtn: document.getElementById('btn-bg-commands'),
    bgCommandsPanel: document.getElementById('bg-commands-panel'),
    bgCommandsList: document.getElementById('bg-commands-list'),
    confirmOverlay: document.getElementById('confirm-overlay'),
    confirmText: document.getElementById('confirm-modal-text'),
    confirmOk: document.getElementById('confirm-modal-ok'),
    confirmCancel: document.getElementById('confirm-modal-cancel'),
    promptOverlay: document.getElementById('prompt-overlay'),
    promptText: document.getElementById('prompt-modal-text'),
    promptInput: /** @type {HTMLInputElement} */ (document.getElementById('prompt-modal-input')),
    promptOk: document.getElementById('prompt-modal-ok'),
    promptCancel: document.getElementById('prompt-modal-cancel'),
    settingsBtn: document.getElementById('btn-settings'),
    settingsPanel: document.getElementById('settings-panel'),
    settingsBody: document.getElementById('settings-body'),
    statusLine: document.getElementById('status-line'),
  };

  // ---------- custom confirm dialog ----------
  // VS Code webviews do not reliably support window.confirm()/alert() — it's
  // a documented webview limitation, and every previous use of window.confirm
  // in this file (closing a chat, restoring a checkpoint, switching to
  // Auto/Outcome mode) could silently no-op because of it, which looks
  // exactly like "nothing happens when I click X". This is a real in-DOM
  // modal instead, so it always works the same way the rest of the UI does.
  let confirmResolve = null;
  function confirmDialog(message) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      el.confirmText.textContent = message;
      el.confirmOverlay.style.display = 'flex';
    });
  }
  function settleConfirm(result) {
    el.confirmOverlay.style.display = 'none';
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }
  el.confirmOk.addEventListener('click', () => settleConfirm(true));
  el.confirmCancel.addEventListener('click', () => settleConfirm(false));
  el.confirmOverlay.addEventListener('click', (e) => {
    if (e.target === el.confirmOverlay) settleConfirm(false);
  });
  document.addEventListener('keydown', (e) => {
    if (el.confirmOverlay.style.display !== 'none' && e.key === 'Escape') settleConfirm(false);
  });

  // ---------- custom text-prompt dialog ----------
  // Same rationale as confirmDialog above: window.prompt() has the identical
  // VS Code webview reliability problem as window.confirm(), so chat rename
  // (item "CHAT RENAME option") uses this in-DOM equivalent instead of ever
  // calling window.prompt().
  let promptResolve = null;
  function textPromptDialog(message, defaultValue) {
    return new Promise((resolve) => {
      promptResolve = resolve;
      el.promptText.textContent = message;
      el.promptInput.value = defaultValue || '';
      el.promptOverlay.style.display = 'flex';
      setTimeout(() => {
        el.promptInput.focus();
        el.promptInput.select();
      }, 0);
    });
  }
  function settlePrompt(result) {
    el.promptOverlay.style.display = 'none';
    const resolve = promptResolve;
    promptResolve = null;
    if (resolve) resolve(result);
  }
  el.promptOk.addEventListener('click', () => settlePrompt(el.promptInput.value.trim() || null));
  el.promptCancel.addEventListener('click', () => settlePrompt(null));
  el.promptOverlay.addEventListener('click', (e) => {
    if (e.target === el.promptOverlay) settlePrompt(null);
  });
  el.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      settlePrompt(el.promptInput.value.trim() || null);
    } else if (e.key === 'Escape') {
      settlePrompt(null);
    }
  });

  // A JS error anywhere in this file (a bad message shape, a null ref in a
  // render function, etc.) would otherwise fail completely silently in a
  // webview — no console visible by default, nothing in the VS Code UI —
  // which is exactly what "I clicked X and nothing happened" looks like
  // from the outside. Surface it as a toast so it's at least visible, and
  // still log it for "Developer: Open Webview Developer Tools".
  window.addEventListener('error', (e) => {
    console.error('Forge webview error:', e.error || e.message);
    showToast('error', `Forge UI error: ${(e.error && e.error.message) || e.message || 'unknown error'} — see Developer: Open Webview Developer Tools for details.`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('Forge webview unhandled rejection:', e.reason);
    showToast('error', `Forge UI error: ${(e.reason && e.reason.message) || e.reason || 'unknown error'} — see Developer: Open Webview Developer Tools for details.`);
  });

  document.getElementById('btn-new-chat').addEventListener('click', () => vscodeApi.postMessage({ type: 'newChat' }));
  document.getElementById('btn-index').addEventListener('click', () => vscodeApi.postMessage({ type: 'indexWorkspace' }));
  document.getElementById('btn-accept-all').addEventListener('click', () => vscodeApi.postMessage({ type: 'acceptAllEdits' }));
  document.getElementById('btn-reject-all').addEventListener('click', () => vscodeApi.postMessage({ type: 'rejectAllEdits' }));
  el.modelBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'selectModel' }));
  el.tabToggle.addEventListener('change', () => vscodeApi.postMessage({ type: 'toggleTabCompletion', enabled: el.tabToggle.checked }));
  el.hwReadout.addEventListener('click', () => vscodeApi.postMessage({ type: 'refreshHwStatus' }));

  // ---------- chat search (item #6) ----------
  el.searchBtn.addEventListener('click', () => {
    state.searchOpen = !state.searchOpen;
    el.searchPanel.style.display = state.searchOpen ? 'flex' : 'none';
    if (state.searchOpen) {
      if (state.bgCommandsOpen) {
        state.bgCommandsOpen = false;
        el.bgCommandsPanel.style.display = 'none';
      }
      el.searchInput.value = '';
      el.searchResults.innerHTML = '';
      el.searchInput.focus();
    }
  });
  let searchDebounce;
  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = el.searchInput.value.trim();
    if (!q) {
      el.searchResults.innerHTML = '';
      return;
    }
    searchDebounce = setTimeout(() => vscodeApi.postMessage({ type: 'searchChats', query: q }), 200);
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.searchOpen = false;
      el.searchPanel.style.display = 'none';
    }
  });
  function renderSearchResults(results, query) {
    el.searchResults.innerHTML = '';
    if (results.length === 0) {
      el.searchResults.innerHTML = `<div class="search-empty">No matches${query ? ` for "${escapeHtml(query)}"` : ''}.</div>`;
      return;
    }
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const snippetHtml = escapeHtml(r.snippet).replace(new RegExp(escapeRegExp(escapeHtml(query)), 'ig'), (m) => `<mark>${m}</mark>`);
      item.innerHTML = `<div class="search-result-title">${escapeHtml(r.sessionTitle)}</div><div class="search-result-snippet">${snippetHtml}</div>`;
      item.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'switchSession', id: r.sessionId });
        state.searchOpen = false;
        el.searchPanel.style.display = 'none';
      });
      el.searchResults.appendChild(item);
    }
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------- all chats (open + closed) ----------
  el.allChatsBtn.addEventListener('click', () => {
    state.allChatsOpen = !state.allChatsOpen;
    el.allChatsPanel.style.display = state.allChatsOpen ? 'flex' : 'none';
    if (state.allChatsOpen) {
      if (state.searchOpen) {
        state.searchOpen = false;
        el.searchPanel.style.display = 'none';
      }
      if (state.bgCommandsOpen) {
        state.bgCommandsOpen = false;
        el.bgCommandsPanel.style.display = 'none';
      }
      vscodeApi.postMessage({ type: 'listAllChats' });
    }
  });

  function renderAllChats(sessions) {
    el.allChatsList.innerHTML = '';
    if (sessions.length === 0) {
      el.allChatsList.innerHTML = '<div class="search-empty">No chats yet.</div>';
      return;
    }
    // Open chats first (they're what you're most likely looking for), most-recently-updated within each group.
    const sorted = sessions.slice().sort((a, b) => (!!a.closed === !!b.closed ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.closed ? 1 : -1));
    for (const s of sorted) {
      const item = document.createElement('div');
      item.className = 'search-result-item all-chats-item';
      item.innerHTML = `
        <div class="all-chats-row">
          <span class="all-chats-title">${escapeHtml(s.title || 'New chat')}</span>
          ${s.closed ? '<span class="all-chats-badge">closed</span>' : ''}
          <span class="spacer"></span>
          <button class="link-btn all-chats-rename" title="Rename">&#9998;</button>
          <button class="link-btn all-chats-delete" title="Delete permanently">&#128465;</button>
        </div>
      `;
      item.querySelector('.all-chats-title').addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'switchSession', id: s.id });
        state.allChatsOpen = false;
        el.allChatsPanel.style.display = 'none';
      });
      item.querySelector('.all-chats-rename').addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = await textPromptDialog('Rename chat', s.title || 'New chat');
        if (!next) return;
        vscodeApi.postMessage({ type: 'renameSession', id: s.id, title: next });
      });
      item.querySelector('.all-chats-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        const label = s.title || 'this chat';
        if (!(await confirmDialog(`Permanently delete "${label}"? This removes its saved history from .forge/chat and cannot be undone.`))) return;
        vscodeApi.postMessage({ type: 'deleteSession', id: s.id });
      });
      el.allChatsList.appendChild(item);
    }
  }

  // ---------- background commands panel (item "ability to kill commands
  // while they are running from the chat window") ----------
  el.bgCommandsBtn.addEventListener('click', () => {
    state.bgCommandsOpen = !state.bgCommandsOpen;
    el.bgCommandsPanel.style.display = state.bgCommandsOpen ? 'flex' : 'none';
    if (state.bgCommandsOpen) {
      if (state.searchOpen) {
        state.searchOpen = false;
        el.searchPanel.style.display = 'none';
      }
      if (state.allChatsOpen) {
        state.allChatsOpen = false;
        el.allChatsPanel.style.display = 'none';
      }
      vscodeApi.postMessage({ type: 'listBackgroundCommands' });
    }
  });

  function renderBackgroundCommands(commands) {
    state.backgroundCommands = commands;
    el.bgCommandsList.innerHTML = '';
    if (commands.length === 0) {
      el.bgCommandsList.innerHTML = '<div class="search-empty">No background commands — the agent starts one with run_command\'s {"background": true}.</div>';
      return;
    }
    for (const c of commands) {
      const item = document.createElement('div');
      item.className = 'search-result-item all-chats-item';
      item.innerHTML = `
        <div class="all-chats-row">
          <span class="all-chats-title bg-cmd-title" title="${escapeAttr(c.command)}"><code>${escapeHtml(truncateMiddleText(c.command, 60))}</code></span>
          <span class="all-chats-badge ${c.status === 'running' ? 'bg-cmd-running' : ''}">${c.status === 'running' ? 'running' : `exited (${c.exitCode ?? 'unknown'})`}</span>
          <span class="spacer"></span>
          ${c.status === 'running' ? '<button class="link-btn bg-cmd-kill" title="Stop this command">&#9632; Stop</button>' : ''}
        </div>
      `;
      const killBtn = item.querySelector('.bg-cmd-kill');
      if (killBtn) {
        killBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'killBackgroundCommand', id: c.id }));
      }
      el.bgCommandsList.appendChild(item);
    }
  }

  // ---------- settings panel (item "a new setting pane") ----------
  el.settingsBtn.addEventListener('click', () => {
    state.settingsOpen = !state.settingsOpen;
    el.settingsPanel.style.display = state.settingsOpen ? 'flex' : 'none';
    if (state.settingsOpen) {
      if (state.searchOpen) {
        state.searchOpen = false;
        el.searchPanel.style.display = 'none';
      }
      if (state.allChatsOpen) {
        state.allChatsOpen = false;
        el.allChatsPanel.style.display = 'none';
      }
      if (state.bgCommandsOpen) {
        state.bgCommandsOpen = false;
        el.bgCommandsPanel.style.display = 'none';
      }
      vscodeApi.postMessage({ type: 'getSettings' });
    }
  });

  function settingRow(label, hint, inputHtml) {
    return `<div class="setting-row"><div class="setting-label">${escapeHtml(label)}${hint ? `<div class="setting-hint">${escapeHtml(hint)}</div>` : ''}</div><div class="setting-control">${inputHtml}</div></div>`;
  }

  // Item "lot of ram sitting idle, can that be somehow leveraged for
  // increased context": a best-effort, clearly-hedged suggestion (see
  // util/hwMetrics.ts's estimateSuggestedNumCtx doc comment for exactly
  // why this is deliberately rough, not precise) shown right under the
  // per-chat context override, with a one-click way to apply it.
  function renderNumCtxSuggestion() {
    const suggested = state.hwStatus && state.hwStatus.suggestedNumCtx;
    if (!suggested) return '';
    return `<div class="setting-row numctx-suggestion">
      <div class="setting-label"></div>
      <div class="setting-control">
        <div class="numctx-suggestion-text">You have idle RAM right now — you could try raising this to ~${suggested.toLocaleString()} tokens. This is a rough estimate based on free memory, not a guarantee it'll fit; watch the HW readout after changing it.</div>
        <button id="use-suggested-numctx" class="numctx-suggestion-btn" data-value="${suggested}">Use ${suggested.toLocaleString()}</button>
      </div>
    </div>`;
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) {
      el.settingsBody.innerHTML = '<div class="search-empty">Loading…</div>';
      return;
    }
    el.settingsBody.innerHTML = `
      <div class="settings-section-title">This chat</div>
      ${settingRow(
        'Context window override',
        'Tokens this chat may use — blank uses the global default below. A lighter/faster model leaves more memory headroom, so it can often afford a larger number here than a big model could.',
        `<input id="set-session-numctx" type="number" min="512" step="512" placeholder="${s.numCtx}" value="${state.numCtxOverride || ''}" />`
      )}
      ${renderNumCtxSuggestion()}
      ${settingRow(
        'Model for this chat',
        'Overrides the global default (and any per-mode routing) for this one chat — item "run separate models in different chats".',
        `<select id="set-session-model"><option value="">(use global default)</option>${state.models.map((m) => `<option value="${escapeAttr(m.name)}" ${m.name === state.sessionModel ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}</select>`
      )}
      <div class="settings-section-title">Global defaults</div>
      ${settingRow('Context window (forge.numCtx)', 'Applies to every chat without its own override.', `<input id="set-numCtx" type="number" min="512" step="512" value="${s.numCtx}" />`)}
      ${settingRow('Temperature', '', `<input id="set-temperature" type="number" min="0" max="2" step="0.1" value="${s.temperature}" />`)}
      ${settingRow('Keep model loaded (minutes)', '-1 = never unload between messages, 0 = Ollama default (~5 min).', `<input id="set-keepAliveMinutes" type="number" step="1" value="${s.keepAliveMinutes}" />`)}
      ${settingRow('Require approval for file edits', '', `<input id="set-requireApprovalForWrites" type="checkbox" ${s.requireApprovalForWrites ? 'checked' : ''} />`)}
      ${settingRow('Require approval for commands', '', `<input id="set-requireApprovalForCommands" type="checkbox" ${s.requireApprovalForCommands ? 'checked' : ''} />`)}
      ${settingRow('Show brief status messages', 'e.g. "Reading foo.ts…" while the agent works.', `<input id="set-showStatusMessages" type="checkbox" ${s.showStatusMessages ? 'checked' : ''} />`)}
      ${settingRow('Loop detection (Auto/Outcome mode)', 'Stops the agent if it looks like it\'s repeating the same action in a loop. check_background_command is always exempt regardless of this setting. Turn off if it\'s incorrectly triggering on legitimately repetitive work.', `<input id="set-loopDetectionEnabled" type="checkbox" ${s.loopDetectionEnabled ? 'checked' : ''} />`)}
      <div class="settings-section-title">Task ledger &amp; cost-aware planning</div>
      ${settingRow('Cost-aware task planning', 'Estimate each planned task\'s rough cost (cheap/moderate/expensive — the model\'s own estimate when it gives one, a free keyword heuristic otherwise) so an expensive plan can be flagged before it starts. Costs no extra model calls.', `<input id="set-costAwarePlanningEnabled" type="checkbox" ${s.costAwarePlanningEnabled ? 'checked' : ''} />`)}
      ${settingRow('Review expensive plans before starting', 'Pause for your approval when a plan\'s estimated cost crosses the threshold below. Agent mode only — Auto/Outcome never pause for approval by design, and post a non-blocking warning in the transcript instead.', `<input id="set-reviewExpensivePlansEnabled" type="checkbox" ${s.reviewExpensivePlansEnabled ? 'checked' : ''} />`)}
      ${settingRow('Expensive-plan threshold', 'Weighted cost score (cheap=1, moderate=3, expensive=8 per task, summed) at or above which a plan is flagged. 8 ≈ one expensive task, or several moderate ones. Lower to get flagged more readily.', `<input id="set-expensivePlanReviewThreshold" type="number" min="1" step="1" value="${s.expensivePlanReviewThreshold}" />`)}
      <div class="settings-section-title">Advanced / experimental (each costs extra model calls — try, keep only what helps your model)</div>
      ${settingRow('Structured tool-call output', 'Uses Ollama\'s schema-constrained decoding for the tool-call contract instead of the fenced text block — can eliminate malformed-tool-call bugs if your model/Ollama version honor it well. Falls back automatically for any response that doesn\'t respect the schema.', `<input id="set-structuredOutputEnabled" type="checkbox" ${s.structuredOutputEnabled ? 'checked' : ''} />`)}
      ${settingRow('Plan before acting', 'One extra no-tool "think first" model call at the start of each Agent/Auto/Outcome turn, grounded with relevant codebase snippets.', `<input id="set-planFirstEnabled" type="checkbox" ${s.planFirstEnabled ? 'checked' : ''} />`)}
      ${settingRow('Self-critique large edits', 'One extra model call after a large edit asking "does this look right," fed back to the agent alongside the edit result.', `<input id="set-selfCritiqueEnabled" type="checkbox" ${s.selfCritiqueEnabled ? 'checked' : ''} />`)}
      ${settingRow('Best-of-N for large rewrites', 'Samples several candidates for a large full-file rewrite of an existing file and keeps the best-scoring one instead of trusting the first.', `<input id="set-bestOfNEnabled" type="checkbox" ${s.bestOfNEnabled ? 'checked' : ''} />`)}
      <div class="settings-section-title">MCP servers</div>
      <div id="mcp-status" class="mcp-status"></div>
      <div class="setting-hint">Configure servers via forge.mcp.servers in settings.json, then run "Forge: Reload MCP Servers".</div>
      <div class="settings-section-title">Sub-agents</div>
      ${settingRow(
        'Sub-agent model',
        'Model used for spawn_subagent tasks. Blank reuses whichever model is running the parent turn.',
        `<select id="set-subAgentModel"><option value="">(same as parent)</option>${state.models.map((m) => `<option value="${escapeAttr(m.name)}" ${m.name === s.subAgentModel ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}</select>`
      )}
      ${settingRow('Sub-agent max steps', 'Tool-call cap per sub-agent task.', `<input id="set-subAgentMaxIterations" type="number" min="1" step="1" value="${s.subAgentMaxIterations}" />`)}
      ${settingRow('Max sub-agent nesting depth', 'How many levels deep a sub-agent may spawn further sub-agents.', `<input id="set-maxSubAgentDepth" type="number" min="1" max="4" step="1" value="${s.maxSubAgentDepth}" />`)}
      <div class="settings-section-title">Web search</div>
      ${settingRow('Enable web search', 'Off by default — this is the one Forge feature that sends data outside your machine (a search query has to reach a provider; fetched pages come from third-party servers).', `<input id="set-webSearchEnabled" type="checkbox" ${s.webSearchEnabled ? 'checked' : ''} />`)}
      ${settingRow(
        'Provider',
        '"auto" uses the best provider you have configured, falling back to the no-key DuckDuckGo scrape (works with zero setup, but lower quality/more fragile — configure a real key below for anything beyond casual use).',
        `<select id="set-webSearchProvider">${['auto', 'tavily', 'brave', 'google', 'searxng', 'duckduckgo'].map((id) => `<option value="${id}" ${id === s.webSearchProvider ? 'selected' : ''}>${id}</option>`).join('')}</select>`
      )}
      ${settingRow('Max results per search', '', `<input id="set-webSearchMaxResults" type="number" min="1" max="20" step="1" value="${s.webSearchMaxResults}" />`)}
      ${settingRow('Respect robots.txt', 'web_fetch checks the target site’s robots.txt before downloading a page. Recommended to leave on.', `<input id="set-webSearchRespectRobotsTxt" type="checkbox" ${s.webSearchRespectRobotsTxt ? 'checked' : ''} />`)}
      ${settingRow('SearXNG instance URL', 'Only used if you self-host SearXNG. Not a secret, unlike the API keys below.', `<input id="set-webSearchSearxngUrl" type="text" placeholder="https://searx.example.com" value="${escapeAttr(s.webSearchSearxngUrl || '')}" />`)}
      <div id="websearch-providers" class="websearch-providers"></div>
    `;
    renderWebSearchProviders(s.webSearchProviders || []);
    renderMcpStatus(s.mcpStatus || []);

    document.getElementById('set-session-numctx').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      vscodeApi.postMessage({ type: 'setSessionNumCtx', numCtx: v ? parseInt(v, 10) : null });
    });
    document.getElementById('set-session-model').addEventListener('change', (e) => {
      state.sessionModel = e.target.value;
      vscodeApi.postMessage({ type: 'setSessionModel', model: e.target.value });
      renderModelBtn();
    });
    const suggestBtn = document.getElementById('use-suggested-numctx');
    if (suggestBtn) {
      suggestBtn.addEventListener('click', () => {
        const v = parseInt(suggestBtn.dataset.value, 10);
        if (!Number.isFinite(v)) return;
        document.getElementById('set-session-numctx').value = v;
        vscodeApi.postMessage({ type: 'setSessionNumCtx', numCtx: v });
      });
    }
    for (const key of ['numCtx', 'temperature', 'keepAliveMinutes', 'subAgentMaxIterations', 'maxSubAgentDepth']) {
      document.getElementById(`set-${key}`).addEventListener('change', (e) => {
        const num = parseFloat(e.target.value);
        if (Number.isFinite(num)) vscodeApi.postMessage({ type: 'updateSetting', key, value: num });
      });
    }
    for (const key of ['requireApprovalForWrites', 'requireApprovalForCommands', 'showStatusMessages']) {
      document.getElementById(`set-${key}`).addEventListener('change', (e) => {
        vscodeApi.postMessage({ type: 'updateSetting', key, value: e.target.checked });
      });
    }
    // Web-search settings — and loop detection, same reason — are handled by
    // dedicated listeners below (rather than the generic loop above) since
    // their config keys are dotted (webSearch.maxResults, loopDetection.enabled)
    // while their DOM ids are camelCase (set-webSearchMaxResults,
    // set-loopDetectionEnabled) — folding them into the generic loop would
    // require deriving one from the other and getting it wrong silently.
    document.getElementById('set-loopDetectionEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'loopDetection.enabled', value: e.target.checked });
    });
    document.getElementById('set-costAwarePlanningEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'taskLedger.costAwarePlanning', value: e.target.checked });
    });
    document.getElementById('set-reviewExpensivePlansEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'taskLedger.reviewExpensivePlans', value: e.target.checked });
    });
    document.getElementById('set-expensivePlanReviewThreshold').addEventListener('change', (e) => {
      const num = parseFloat(e.target.value);
      if (Number.isFinite(num)) vscodeApi.postMessage({ type: 'updateSetting', key: 'taskLedger.expensivePlanReviewThreshold', value: num });
    });
    document.getElementById('set-structuredOutputEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'structuredOutput.enabled', value: e.target.checked });
    });
    document.getElementById('set-planFirstEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'planFirst.enabled', value: e.target.checked });
    });
    document.getElementById('set-selfCritiqueEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'selfCritique.enabled', value: e.target.checked });
    });
    document.getElementById('set-bestOfNEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'bestOfN.enabled', value: e.target.checked });
    });
    document.getElementById('set-subAgentModel').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'subAgentModel', value: e.target.value });
    });
    document.getElementById('set-webSearchProvider').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'webSearch.provider', value: e.target.value });
    });
    document.getElementById('set-webSearchMaxResults').addEventListener('change', (e) => {
      const num = parseFloat(e.target.value);
      if (Number.isFinite(num)) vscodeApi.postMessage({ type: 'updateSetting', key: 'webSearch.maxResults', value: num });
    });
    document.getElementById('set-webSearchRespectRobotsTxt').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'webSearch.respectRobotsTxt', value: e.target.checked });
    });
    document.getElementById('set-webSearchEnabled').addEventListener('change', (e) => {
      vscodeApi.postMessage({ type: 'updateSetting', key: 'webSearch.enabled', value: e.target.checked });
    });
    let searxngCommitTimer;
    document.getElementById('set-webSearchSearxngUrl').addEventListener('input', (e) => {
      clearTimeout(searxngCommitTimer);
      const value = e.target.value.trim();
      searxngCommitTimer = setTimeout(() => vscodeApi.postMessage({ type: 'updateSetting', key: 'webSearch.searxngUrl', value }), 600);
    });
  }

  /** Connection status for every configured MCP server (forge.mcp.servers) — see mcp/mcpManager.ts. Read-only here; servers are configured in settings.json and reconnected via "Forge: Reload MCP Servers". */
  function renderMcpStatus(servers) {
    const host = document.getElementById('mcp-status');
    if (!host) return;
    if (servers.length === 0) {
      host.innerHTML = '<div class="search-empty">No MCP servers configured.</div>';
      return;
    }
    host.innerHTML = servers
      .map((s) => {
        const status = s.connected
          ? `<span class="wsp-status wsp-configured">connected · ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}</span>`
          : '<span class="wsp-status wsp-missing">not connected</span>';
        return `<div class="wsp-row"><span class="wsp-name">${escapeHtml(s.server)}</span>${status}</div>`;
      })
      .join('');
  }

  /** Per-provider "configured / not configured" status + a button to set/clear its API key, for the providers that need one — see websearch/keyStore.ts. Never shows the actual key, only whether one is stored. */
  function renderWebSearchProviders(providers) {
    const host = document.getElementById('websearch-providers');
    if (!host) return;
    host.innerHTML = providers
      .map((p) => {
        const status = p.configured ? '<span class="wsp-status wsp-configured">configured</span>' : '<span class="wsp-status wsp-missing">not configured</span>';
        const action = p.requiresApiKey
          ? `<button class="link-btn wsp-set" data-id="${escapeAttr(p.id)}">Set API Key…</button>${p.configured ? `<button class="link-btn wsp-clear" data-id="${escapeAttr(p.id)}">Clear</button>` : ''}`
          : '';
        return `<div class="wsp-row"><span class="wsp-name">${escapeHtml(p.displayName)}</span>${status}<span class="spacer"></span>${action}</div>`;
      })
      .join('');
    host.querySelectorAll('.wsp-set').forEach((btn) => btn.addEventListener('click', () => vscodeApi.postMessage({ type: 'setWebSearchApiKey' })));
    host.querySelectorAll('.wsp-clear').forEach((btn) =>
      btn.addEventListener('click', () => vscodeApi.postMessage({ type: 'clearWebSearchApiKey', providerId: btn.dataset.id }))
    );
  }

  // ---------- mode strip ----------
  function renderModeStrip() {
    el.modeStrip.innerHTML = '';
    for (const m of state.modes) {
      const btn = document.createElement('button');
      btn.className = 'mode-btn' + (m.id === 'auto' ? ' mode-auto' : '') + (m.id === 'outcome' ? ' mode-outcome' : '') + (m.id === state.activeMode ? ' active' : '');
      btn.textContent = m.label;
      btn.title = m.description;
      btn.addEventListener('click', async () => {
        if (m.id === state.activeMode) return;
        if (m.id === 'auto' && !(await confirmDialog('Switch to Auto mode? Forge will edit files and run commands with NO approval prompts from here on (a hard-coded denylist still blocks a few destructive commands). A checkpoint is saved before every turn so you can revert.'))) {
          return;
        }
        if (m.id === 'outcome' && !(await confirmDialog('Switch to Outcome mode? Describe a destination, not steps — Forge works backward from it with NO approval prompts (same denylist exception as Auto mode) and keeps iterating, checking its own progress, until it\'s reached. Set an optional "definition of done" command below the mode row for a real, automatic check instead of relying on the model\'s own judgment. A checkpoint is saved before every turn so you can revert.'))) {
          return;
        }
        state.activeMode = m.id;
        renderModeStrip();
        renderAutoBanner();
        renderVerifyRow();
        renderOrchRow();
        vscodeApi.postMessage({ type: 'setMode', mode: m.id });
        showToast('info', `Switched to ${m.label} mode.`);
      });
      el.modeStrip.appendChild(btn);
    }
  }

  function renderAutoBanner() {
    if (state.activeMode === 'auto') {
      el.autoBanner.style.display = 'block';
      el.autoBanner.innerHTML = '&#9888; Auto mode: no approvals — edits and commands run immediately. A checkpoint is saved before each turn.';
    } else if (state.activeMode === 'outcome') {
      el.autoBanner.style.display = 'block';
      el.autoBanner.innerHTML = '&#127919; Outcome mode: state the destination, not the steps — Forge works backward from it, no approvals, and keeps iterating until it\'s reached. A checkpoint is saved before each turn.';
    } else {
      el.autoBanner.style.display = 'none';
    }
  }

  // Modes that take autonomous action and so can meaningfully use a
  // "definition of done" check — mirrors modeSupportsVerifyCommand() in
  // src/agent/modes.ts. Ask/Plan never touch anything, so there's nothing
  // for a done-check to check.
  const VERIFY_CAPABLE_MODES = ['agent', 'auto', 'outcome'];

  function renderVerifyRow() {
    const show = VERIFY_CAPABLE_MODES.includes(state.activeMode);
    el.verifyRow.style.display = show ? 'flex' : 'none';
    if (show) el.verifyInput.value = state.verifyCommand || '';
  }

  let verifyCommitTimer;
  function commitVerifyCommand() {
    clearTimeout(verifyCommitTimer);
    const value = el.verifyInput.value.trim();
    if (value === (state.verifyCommand || '')) return;
    state.verifyCommand = value;
    vscodeApi.postMessage({ type: 'setVerifyCommand', command: value });
  }
  el.verifyInput.addEventListener('blur', commitVerifyCommand);
  el.verifyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitVerifyCommand();
      el.verifyInput.blur();
    }
  });
  el.verifyInput.addEventListener('input', () => {
    clearTimeout(verifyCommitTimer);
    verifyCommitTimer = setTimeout(commitVerifyCommand, 800);
  });

  // ---------- orchestration mode toggle + task-ledger progress readout (item 4c) ----------
  // Shown in the same modes as the verify row (Agent/Auto/Outcome — Ask is
  // read-only and Plan has no tools at all, so orchestration has nothing to
  // orchestrate in either) — mirrors modeSupportsVerifyCommand()'s reasoning.
  function renderOrchRow() {
    const show = VERIFY_CAPABLE_MODES.includes(state.activeMode);
    el.orchRow.style.display = show ? 'flex' : 'none';
    if (show) el.orchToggleInput.checked = !!state.orchestrationEnabled;
    renderTaskLedgerProgress();
  }
  el.orchToggleInput.addEventListener('change', () => {
    state.orchestrationEnabled = el.orchToggleInput.checked;
    vscodeApi.postMessage({ type: 'setOrchestrationMode', enabled: state.orchestrationEnabled });
    showToast('info', state.orchestrationEnabled ? 'Orchestration mode on — the model will plan, delegate to sub-agents one at a time, and track progress in the task ledger.' : 'Orchestration mode off.');
  });

  /**
   * Mandatory checkpoint-progress framework (item 4a/4b): a compact "3/5
   * done" readout next to the toggle, always visible (not just when
   * orchestration mode is on) since plan_tasks/spawn_subagent can populate
   * the ledger in any mode — see agent/taskLedger.ts's doc comment on why
   * this is "mandatory," not opt-in. Hovering shows the full task list with
   * status/summary so progress is legible without opening dev tools or the
   * raw .forge/chat/<id>.tasks.md file.
   */
  function renderTaskLedgerProgress() {
    const tasks = state.taskLedger || [];
    if (tasks.length === 0) {
      el.orchProgress.textContent = '';
      el.orchProgress.title = '';
      return;
    }
    const done = tasks.filter((t) => t.status === 'done').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const mark = { pending: '○', in_progress: '◐', done: '✓', failed: '✗' };
    el.orchProgress.textContent = `Tasks: ${done}/${tasks.length}${failed ? ` (${failed} failed)` : ''}`;
    // Cost-aware task planning: show each task's estimated tier in the same
    // hover readout, right alongside its status — see agent/taskCost.ts.
    // Absent on tasks from a session saved before this field existed.
    el.orchProgress.title = tasks.map((t) => `${mark[t.status] || '?'} ${t.costTier ? `(${t.costTier}) ` : ''}${t.description}${t.summary ? ` — ${t.summary}` : ''}`).join('\n');
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
        <span class="tab-title" title="Double-click to rename">${escapeHtml(s.title || 'New chat')}</span>
        <span class="tab-close" title="Close (still saved — reopen from All Chats)">&times;</span>
      `;
      tab.querySelector('.tab-title').addEventListener('click', () => {
        if (s.id !== state.activeSessionId) vscodeApi.postMessage({ type: 'switchSession', id: s.id });
      });
      // Item "CHAT RENAME option": double-click a tab title to rename it in place.
      tab.querySelector('.tab-title').addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        const next = await textPromptDialog('Rename chat', s.title || 'New chat');
        if (!next) return;
        vscodeApi.postMessage({ type: 'renameSession', id: s.id, title: next });
      });
      tab.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        // Closing just archives the chat now — nothing destructive happens,
        // so no confirmation needed. Permanent deletion lives in the All
        // Chats panel, where it's a deliberate, separate, confirmed action.
        vscodeApi.postMessage({ type: 'closeSession', id: s.id });
      });
      el.tabStrip.appendChild(tab);
    }
  }

  // ---------- composer ----------
  el.sendBtn.addEventListener('click', onSendOrStop);
  el.input.addEventListener('keydown', (e) => {
    const dropdownOpen = mentionQueryStart >= 0 && el.mentionDropdown.style.display !== 'none';
    if (dropdownOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      // Item #5: navigate @/  mention results with arrow keys, not just the mouse.
      e.preventDefault();
      const n = state.mentionResults.length;
      if (n === 0) return;
      state.mentionSelectedIndex = e.key === 'ArrowDown' ? (state.mentionSelectedIndex + 1) % n : (state.mentionSelectedIndex - 1 + n) % n;
      renderMentionSelection();
      return;
    }
    if (dropdownOpen && (e.key === 'Enter' || e.key === 'Tab') && state.mentionSelectedIndex >= 0) {
      e.preventDefault();
      chooseMentionResult(state.mentionResults[state.mentionSelectedIndex]);
      return;
    }
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
    state.mentionResults = [];
    state.mentionSelectedIndex = -1;
    el.mentionDropdown.style.display = 'none';
    el.mentionDropdown.innerHTML = '';
  }

  /** Renders whatever's currently in state.mentionResults (skills or file/folder entries — tagged with a `_kind` so click/Enter selection is uniform) and wires arrow-key highlight + click, both routing through chooseMentionResult(). */
  function renderMentionDropdown() {
    if (state.mentionResults.length === 0) {
      hideMentionDropdown();
      return;
    }
    el.mentionDropdown.style.display = 'block';
    el.mentionDropdown.innerHTML = '';
    state.mentionResults.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'mention-item' + (i === state.mentionSelectedIndex ? ' selected' : '');
      item.dataset.idx = String(i);
      if (r._kind === 'skill') {
        item.innerHTML = `<strong>/${escapeHtml(r.name)}</strong>${r.description ? ` <span class="mention-desc">${escapeHtml(r.description)}</span>` : ''}`;
      } else {
        const icon = r.kind === 'folder' ? '\u{1F4C1}' : '\u{1F4C4}'; // 📁 / 📄
        item.innerHTML = `<span class="mention-kind">${icon}</span>${escapeHtml(r.path)}`;
      }
      item.addEventListener('mouseenter', () => {
        state.mentionSelectedIndex = i;
        renderMentionSelection();
      });
      item.addEventListener('click', () => chooseMentionResult(r));
      el.mentionDropdown.appendChild(item);
    });
  }

  /** Cheap re-highlight after arrow-key nav — avoids rebuilding the whole dropdown on every keypress. */
  function renderMentionSelection() {
    const items = el.mentionDropdown.querySelectorAll('.mention-item');
    items.forEach((it, i) => {
      it.classList.toggle('selected', i === state.mentionSelectedIndex);
      if (i === state.mentionSelectedIndex) it.scrollIntoView({ block: 'nearest' });
    });
  }

  function chooseMentionResult(r) {
    if (!r) return;
    if (r._kind === 'skill') {
      el.input.value = `/${r.name} `;
      hideMentionDropdown();
      el.input.focus();
      el.input.setSelectionRange(el.input.value.length, el.input.value.length);
      return;
    }
    const caret = el.input.selectionStart || 0;
    el.input.value = el.input.value.slice(0, mentionQueryStart) + el.input.value.slice(caret);
    if (!state.attachedFiles.includes(r.path)) state.attachedFiles.push(r.path);
    renderChips();
    hideMentionDropdown();
    el.input.focus();
  }

  function showSkillResults(query) {
    const q = query.toLowerCase();
    const matches = state.skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 12).map((s) => ({ ...s, _kind: 'skill' }));
    state.mentionResults = matches;
    state.mentionSelectedIndex = matches.length ? 0 : -1;
    renderMentionDropdown();
  }

  function showMentionResults(results) {
    if (mentionQueryStart < 0 || mentionTrigger !== '@') return;
    state.mentionResults = results.slice(0, 12).map((r) => ({ ...r, _kind: 'file' }));
    state.mentionSelectedIndex = state.mentionResults.length ? 0 : -1;
    renderMentionDropdown();
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
      wrap.className = 'msg-user-wrap';
      const bubble = document.createElement('div');
      bubble.className = 'msg msg-user';
      const files = (entry.files || []).map((f) => `<span class="msg-file-chip">${escapeHtml(f)}</span>`).join('');
      bubble.innerHTML = `${files ? `<div class="msg-files">${files}</div>` : ''}<div class="msg-body">${renderMarkdown(entry.text)}</div>`;
      wrap.appendChild(bubble);
      // Item #3: every user turn is a checkpoint boundary — offer to jump
      // back to it (and undo everything since) as long as it still exists
      // (it's dropped once you've already restored past it).
      const checkpoint = entry.checkpointId ? state.checkpoints.find((c) => c.id === entry.checkpointId) : undefined;
      if (checkpoint) {
        // Item #1: the mechanically-logged milestone for the turn this
        // checkpoint started — a cheap, always-available "what happened
        // here" caption, independent of (and complementary to) whatever
        // compaction later folds away. Absent until the turn finishes.
        if (checkpoint.milestone) {
          const caption = document.createElement('div');
          caption.className = 'checkpoint-milestone';
          caption.textContent = checkpoint.milestone;
          caption.title = 'Mechanically-generated summary of this turn (not from the model)';
          wrap.appendChild(caption);
        }
        const btnRow = document.createElement('div');
        btnRow.className = 'checkpoint-btn-row';
        const forkBtn = document.createElement('button');
        forkBtn.className = 'checkpoint-restore-btn';
        forkBtn.textContent = '⑂ Fork here';
        forkBtn.title = 'Open a new chat starting from this point, with files reverted to match — this conversation is left untouched';
        forkBtn.addEventListener('click', async () => {
          if (!(await confirmDialog('Fork this chat from here? Opens a new chat containing everything up to this point and reverts shared workspace files to match — this conversation stays exactly as it is.'))) return;
          vscodeApi.postMessage({ type: 'forkChat', id: entry.checkpointId });
        });
        btnRow.appendChild(forkBtn);
        const btn = document.createElement('button');
        btn.className = 'checkpoint-restore-btn';
        btn.textContent = '⟲ Restore to here';
        btn.title = 'Revert every file edit and message from this point on';
        btn.addEventListener('click', async () => {
          if (!(await confirmDialog('Restore to this point? This reverts every file edit made from here on and removes the messages after it. This cannot be undone.'))) return;
          vscodeApi.postMessage({ type: 'restoreCheckpoint', id: entry.checkpointId });
        });
        btnRow.appendChild(btn);
        wrap.appendChild(btnRow);
      }
      return wrap;
    }

    if (entry.kind === 'assistant') {
      wrap.className = 'msg msg-assistant' + (entry.streaming ? ' streaming' : '');
      const bodyHtml = entry.streaming ? escapeHtml(entry.text) : renderMarkdown(entry.text);
      const claimWarning = entry.unverifiedClaims?.length
        ? `<div class="claim-warning">&#9888; Says it changed ${entry.unverifiedClaims.map((p) => `<code>${escapeHtml(p)}</code>`).join(', ')} but Forge found no matching write_file call — double-check before trusting this.</div>`
        : '';
      wrap.innerHTML = `<div class="msg-avatar">&#9670;</div><div style="flex:1;min-width:0;"><div class="msg-body" data-raw="${entry.streaming ? '1' : '0'}">${bodyHtml}</div>${claimWarning}</div>`;
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
      const argSummary = summarizeArgsHtml(entry.tool, entry.args);
      wrap.innerHTML = `
        <div class="tool-card-head">
          <span class="tool-icon">${icon}</span>
          <span class="tool-name">${escapeHtml(entry.tool)}</span>
          <span class="tool-args">${argSummary}</span>
        </div>
        ${entry.summary ? `<div class="tool-summary">${escapeHtml(entry.summary)}</div>` : ''}
        ${renderToolAttachmentsHtml(entry.attachments)}
      `;
      return wrap;
    }

    if (entry.kind === 'approval') {
      wrap.className = 'approval-card ' + entry.status;
      // Cost-aware task planning reuses this same card for a second kind of
      // approval ('plan_review' — see agent/taskCost.ts) alongside the
      // original command approval; `reviewKind` picks the label (a
      // plan_review's `detail` is already the full multi-line plan text, so
      // the same <code> block — pre-wrap, see webview.css — renders it fine
      // as-is). Missing reviewKind (an old, already-persisted session) falls
      // back to the original "Run command?" label.
      const isPlanReview = entry.reviewKind === 'plan_review';
      const label = isPlanReview ? 'Review this plan before it starts?' : 'Run command?';
      wrap.innerHTML = `
        <div class="approval-detail"><span class="approval-label">${label}</span><code>${escapeHtml(entry.detail)}</code></div>
        <div class="approval-actions">
          ${entry.status === 'pending' ? `<button data-act="approve" class="approve-btn">${isPlanReview ? 'Start' : 'Approve'}</button><button data-act="deny" class="deny-btn">${isPlanReview ? 'Revise plan' : 'Deny'}</button>` : `<span class="approval-status">${entry.status === 'approved' ? 'Approved' : 'Denied'}</span>`}
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

    if (entry.kind === 'warning') {
      // Item "Outcome mode introduces cheap tricks bypass" (agent/gamingDetection.ts):
      // deliberately distinct styling from msg-error — the turn succeeded,
      // this is a "double-check this" flag, not a failure.
      wrap.className = 'msg msg-warning';
      const details = (entry.details || [])
        .map((d) => `<li><code>${escapeHtml(d.path)}</code> — ${escapeHtml(d.reason)}</li>`)
        .join('');
      wrap.innerHTML = `<span class="warning-icon">&#9888;</span> ${escapeHtml(entry.text)}${details ? `<ul class="warning-details">${details}</ul>` : ''}`;
      return wrap;
    }

    if (entry.kind === 'subagent') {
      wrap.className = 'tool-card subagent-card ' + (entry.status === 'running' ? 'running' : entry.ok ? 'ok' : 'fail');
      const icon = entry.status === 'running' ? spinnerSvg() : entry.ok ? '&#10003;' : '&#10007;';
      wrap.innerHTML = `
        <div class="tool-card-head">
          <span class="tool-icon">${icon}</span>
          <span class="tool-name">Sub-agent${entry.depth > 1 ? ` (depth ${entry.depth})` : ''}</span>
          <span class="tool-args">${escapeHtml(truncateMiddleText(entry.task, 100))}</span>
        </div>
        ${entry.status === 'running' ? '<div class="tool-summary">Working…</div>' : `<div class="tool-summary">${escapeHtml(entry.summary || '')}</div>`}
      `;
      return wrap;
    }

    if (entry.kind === 'verify') {
      wrap.className = 'tool-card verify-card ' + (entry.status === 'running' ? 'running' : entry.ok ? 'ok' : 'fail');
      const icon = entry.status === 'running' ? spinnerSvg() : entry.ok ? '&#10003;' : '&#10007;';
      wrap.innerHTML = `
        <div class="tool-card-head">
          <span class="tool-icon">${icon}</span>
          <span class="tool-name">Definition of done</span>
          <span class="tool-args"><code>${escapeHtml(entry.command)}</code></span>
        </div>
        ${entry.status === 'running' ? '<div class="tool-summary">Checking…</div>' : `<div class="tool-summary">${entry.ok ? 'Passed.' : 'Not met yet — Forge is feeding this back and continuing.'} ${escapeHtml(entry.summary || '')}</div>`}
      `;
      return wrap;
    }

    return null;
  }

  function summarizeArgs(tool, args) {
    if (!args) return '';
    if (typeof args.path === 'string') return args.path + (args.search ? ' (targeted edit)' : '');
    if (typeof args.command === 'string') return args.command;
    if (typeof args.url === 'string') return args.url + (args.offset ? ` (offset ${args.offset})` : '');
    if (typeof args.query === 'string') return `"${args.query}"`;
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }

  /**
   * MCP standardization (0.14.0): renders a tool result's non-text content
   * blocks (see agent/types.ts's ToolResultAttachment) — an `image` block
   * with base64 `dataBase64`+`mimeType` becomes an actual inline `<img>`;
   * anything else (a `resource`/`resource_link`, or an image missing its own
   * base64 payload) becomes a small labeled chip naming its type/URI/text
   * preview. This is the "data shown to the user, not fed back into the
   * model" half of the MCP content-block split — the model only ever sees
   * the one-line count-and-type note mcpManager.ts's buildToolSpec()
   * appends to the tool's text content, never this. Returns '' when there's
   * nothing to show, so callers can splice it in unconditionally.
   */
  function renderToolAttachmentsHtml(attachments) {
    if (!attachments || !attachments.length) return '';
    const items = attachments.map((a) => {
      if (a.type === 'image' && a.dataBase64 && a.mimeType) {
        return `<div class="tool-attachment tool-attachment-image"><img src="data:${escapeAttr(a.mimeType)};base64,${escapeAttr(a.dataBase64)}" alt="MCP tool image attachment" /></div>`;
      }
      const label = a.uri || a.mimeType || a.type || 'attachment';
      const preview = a.text ? escapeHtml(a.text.length > 200 ? a.text.slice(0, 200) + '…' : a.text) : '';
      return `<div class="tool-attachment tool-attachment-generic"><span class="tool-attachment-badge">${escapeHtml(a.type || 'resource')}</span> <span class="tool-attachment-label">${escapeHtml(label)}</span>${preview ? `<div class="tool-attachment-preview">${preview}</div>` : ''}</div>`;
    });
    return `<div class="tool-attachments">${items.join('')}</div>`;
  }

  /** Item #9: same as summarizeArgs, but when the tool call is about a file path, that path is a clickable file-ref span instead of plain text. */
  function summarizeArgsHtml(tool, args) {
    if (!args) return '';
    if (typeof args.path === 'string') {
      const suffix = args.search ? ' (targeted edit)' : '';
      return `<span class="file-ref" data-path="${escapeAttr(args.path)}">${escapeHtml(args.path)}</span>${escapeHtml(suffix)}`;
    }
    return escapeHtml(summarizeArgs(tool, args));
  }

  /** Heuristic for whether an inline-code span in a rendered message looks like a workspace file path worth making clickable (item #9). Deliberately conservative — a false positive just means a click does nothing useful (chatViewProvider shows "could not open" and moves on), so this favors precision over recall. */
  function looksLikePath(code) {
    if (/\s/.test(code) || code.length > 200) return false;
    return /^[\w.\-]+(\/[\w.\-]+)*\.[A-Za-z0-9]{1,10}$/.test(code) || /^[\w.\-]+\/[\w.\-/]+$/.test(code);
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
    // Item "ability to run separate models in different chats": a session
    // override (set via the Settings panel's "This chat" section) takes
    // priority over the global default in the label itself, so it's obvious
    // at a glance that this particular chat isn't using the global model —
    // matching resolveModelForMode()'s own priority order server-side.
    if (state.sessionModel) {
      el.modelBtn.textContent = `⚙ ${state.sessionModel} (this chat)`;
      el.modelBtn.title = `This chat is pinned to ${state.sessionModel}. Change in Settings → This chat → Model for this chat.`;
    } else {
      el.modelBtn.textContent = state.chatModel ? `⚙ ${state.chatModel}` : '⚙ Select model…';
      el.modelBtn.title = 'Change the global default model';
    }
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
    state.checkpoints = session.checkpoints || [];
    state.verifyCommand = session.verifyCommand || '';
    state.numCtxOverride = session.numCtxOverride;
    state.sessionModel = session.model || '';
    state.orchestrationEnabled = !!session.orchestrationEnabled;
    state.taskLedger = session.taskLedger || [];
    state.statusText = '';
    state.statusActivity = undefined;
    renderStatusLine();
    renderModeStrip();
    renderAutoBanner();
    renderVerifyRow();
    renderOrchRow();
    renderTabStrip();
    renderBusy();
    renderModelBtn();
    renderAllHistory();
  }

  // Item #9: one delegated listener covers every current AND future
  // .file-ref span (tool-card paths, backtick-quoted paths in prose) —
  // no per-node listener wiring needed as the transcript re-renders.
  el.transcript.addEventListener('click', (e) => {
    const target = e.target.closest('.file-ref');
    if (target && target.dataset.path) {
      vscodeApi.postMessage({ type: 'openFile', path: target.dataset.path });
    }
  });

  function renderHwReadout() {
    const m = state.lastMetrics;
    const hw = state.hwStatus || {};
    const loaded = hw.loadedModels || [];
    const parts = [];
    if (m && m.tokensPerSecond) parts.push(`${m.tokensPerSecond.toFixed(1)} tok/s`);
    if (hw.contextWindow && hw.contextWindow.maxTokens) {
      const pct = Math.round((hw.contextWindow.usedTokens / hw.contextWindow.maxTokens) * 100);
      parts.push(`ctx ${hw.contextWindow.usedTokens}/${hw.contextWindow.maxTokens} (${pct}%)`);
    }
    if (loaded.length) {
      const vram = loaded.reduce((n, x) => n + (x.vramGB || x.sizeGB || 0), 0);
      parts.push(`${loaded.length} model${loaded.length === 1 ? '' : 's'} loaded (${vram.toFixed(1)}GB)`);
    }
    const mem = hw.memory;
    if (mem) {
      // Accurate (Activity-Monitor-style) memory: used, and what is actually available. A wrong number is worse than none, so a missing source shows n/a.
      let t = `Mem ${mem.usedGB}/${mem.totalGB}GB used \u00b7 ${mem.availableGB}GB free`;
      if (mem.pressure === 'warn') t += ' \u26a0 pressure';
      else if (mem.pressure === 'critical') t += ' \u26d4 pressure!';
      parts.push(t);
      if (typeof mem.swapUsedGB === 'number' && mem.swapUsedGB >= 0.5) parts.push(`swap ${mem.swapUsedGB}GB`);
    } else if (hw.ram) {
      parts.push(`RAM ${hw.ram.usedGB}/${hw.ram.totalGB}GB (approx.)`);
    } else {
      parts.push('Mem n/a');
    }
    if (hw.gpus && hw.gpus.length) {
      const g = hw.gpus[0];
      parts.push(`GPU ${g.avgPct}%${typeof g.inUseGB === 'number' ? ` \u00b7 ${g.inUseGB}GB` : ''}`);
    } else if (hw.gpu && hw.gpu.length) {
      const g = hw.gpu[0];
      parts.push(`GPU ${g.utilizationPct}% (${g.usedVramGB}/${g.totalVramGB}GB)`);
    } else {
      parts.push('GPU n/a');
    }
    el.hwReadout.textContent = parts.join(' \u00b7 ');
    const titleLines = [];
    if (loaded.length) titleLines.push(...loaded.map((x) => `${x.name}: ${x.sizeGB}GB${x.vramGB !== undefined ? ` (${x.vramGB}GB in GPU-visible memory)` : ''}`));
    if (mem) {
      const age = Math.max(0, Math.round((Date.now() - mem.sampledAtMs) / 1000));
      titleLines.push(
        `Memory (${mem.source === 'darwin' ? 'exact, from vm_stat/sysctl' : 'approximate'}, ${age}s ago):`,
        `  used ${mem.usedGB}GB = apps + wired (${mem.wiredGB}GB) + compressed (${mem.compressedGB}GB) \u2014 same definition as Activity Monitor`,
        `  free ${mem.availableGB}GB = total \u2212 used (includes ${mem.cachedGB}GB of reclaimable file cache; ${mem.freeGB}GB is completely unused)`,
        `  pressure: ${mem.pressure} (macOS's own memory-pressure state)`
      );
    }
    if (hw.gpus && hw.gpus.length) {
      const g = hw.gpus[0];
      titleLines.push(
        `GPU${g.name ? ' ' + g.name : ''}${g.cores ? ' (' + g.cores + ' cores)' : ''}: ${g.avgPct}% (average over ~4s; now ${g.utilizationPct}%, peak this turn ${g.peakPct}%)`,
        `  GPU memory in use ${typeof g.inUseGB === 'number' ? g.inUseGB + 'GB' : 'n/a'} \u2014 unified memory, the same pool as RAM (not separate VRAM)`
      );
    }
    el.hwReadout.title = titleLines.length ? titleLines.join('\n') : 'Click to refresh hardware status';
  }

  // ---------- brief status line (item "brief messages…" / "progress
  // indicators — what file is being edited, is the model thinking/reading") ----------
  // Maps AgentActivity (agent/types.ts) to a small icon so the status line
  // reads at a glance instead of always showing the same generic spinner —
  // this is the whole point of the activity field the agent loop started
  // tagging every 'status' event with.
  const ACTIVITY_ICONS = {
    think: '\u{1F4AD}', // 💭
    read: '\u{1F4D6}', // 📖
    write: '\u{270F}\u{FE0F}', // ✏️
    delete: '\u{1F5D1}\u{FE0F}', // 🗑️
    run: '\u{2699}\u{FE0F}', // ⚙️
    search: '\u{1F50D}', // 🔍
    diagnostics: '\u{1FA7A}', // 🩺
    memory: '\u{1F9E0}', // 🧠
    delegate: '\u{1F91D}', // 🤝
    verify: '\u{2705}', // ✅
    web: '\u{1F310}', // 🌐
    other: '\u{2699}\u{FE0F}', // ⚙️
  };
  function renderStatusLine() {
    const show = !!state.statusText && (!state.settings || state.settings.showStatusMessages !== false);
    el.statusLine.style.display = show ? 'block' : 'none';
    const icon = state.statusActivity && ACTIVITY_ICONS[state.statusActivity];
    el.statusLine.textContent = (icon ? icon + ' ' : '') + (state.statusText || '');
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
          hwStatus: msg.state.hwStatus || { loadedModels: [] },
        });
        el.tabToggle.checked = state.tabCompletionEnabled;
        renderModelBtn();
        renderConnectionBanner();
        renderIndexStatus();
        renderPendingEdits();
        renderHwReadout();
        loadSession(msg.state.activeSession);
        if (!state.connected) showToast('error', msg.state.connectionError ? `Ollama: ${msg.state.connectionError}` : 'Ollama not reachable.');
        break;
      }
      case 'sessionsList': {
        // Stale/out-of-order guard — see the seq doc comment on this
        // message type in protocol.ts. A message with a seq we've already
        // passed is discarded rather than applied.
        if (msg.seq < state.sessionsListSeq) break;
        state.sessionsListSeq = msg.seq;
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
      case 'taskLedgerUpdate': {
        if (msg.sessionId !== state.activeSessionId) break;
        state.taskLedger = msg.tasks || [];
        renderTaskLedgerProgress();
        break;
      }
      case 'busy': {
        state.busyBySession[msg.sessionId] = msg.busy;
        if (msg.sessionId === state.activeSessionId) {
          renderBusy();
          if (!msg.busy) {
            state.statusText = '';
            state.statusActivity = undefined;
            renderStatusLine();
          }
        }
        renderTabStrip();
        break;
      }
      case 'statusUpdate': {
        if (msg.sessionId !== state.activeSessionId) break;
        state.statusText = msg.text;
        state.statusActivity = msg.activity;
        renderStatusLine();
        break;
      }
      case 'settingsData': {
        state.settings = msg.settings;
        renderSettings();
        renderStatusLine();
        break;
      }
      case 'filesResult': {
        showMentionResults(msg.results);
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
      case 'hwStatus': {
        state.hwStatus = msg.status;
        renderHwReadout();
        if (state.settingsOpen && state.settings) renderSettings();
        break;
      }
      case 'metricsUpdate': {
        if (msg.sessionId !== state.activeSessionId) break;
        state.lastMetrics = msg.metrics;
        renderHwReadout();
        break;
      }
      case 'checkpointRestored': {
        showToast(msg.ok ? 'info' : 'error', msg.message);
        break;
      }
      case 'chatForked': {
        // On success a sessionSwitched + sessionsList follow this and do the
        // real UI work (new tab, new active session) — this toast is just
        // the confirmation/error message, same role as checkpointRestored's.
        showToast(msg.ok ? 'info' : 'error', msg.message);
        break;
      }
      case 'searchResults': {
        renderSearchResults(msg.results, msg.query);
        break;
      }
      case 'allChatsList': {
        if (msg.seq < state.allChatsListSeq) break;
        state.allChatsListSeq = msg.seq;
        renderAllChats(msg.sessions);
        break;
      }
      case 'backgroundCommandsList': {
        renderBackgroundCommands(msg.commands);
        break;
      }
      case 'modeChanged': {
        // Item "doesn't recognize that the mode has changed": a dedicated
        // notification (see ChatSession.postModeChanged()) so the mode pill
        // updates immediately no matter which server-side code path changed
        // it — previously only a full sessionSwitched/init payload did this,
        // which executePlan's agent-mode handoff never sent.
        if (msg.sessionId !== state.activeSessionId) break;
        state.activeMode = msg.mode;
        renderModeStrip();
        renderAutoBanner();
        renderVerifyRow();
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
        // Item #9: a backtick-quoted path the model mentions (e.g. "created
        // `src/foo.ts`") becomes a clickable reference — click opens it in
        // the editor, same as clicking a tool card's path (see the
        // delegated .file-ref click handler and summarizeArgsHtml above).
        // Item "file references don't open on click" (webview half): `code`
        // here is already escapeHtml'd (from `let html = escapeHtml(...)`
        // above) for TEXT-content purposes — `&`/`<`/`>` are safe, but a
        // literal `"` isn't, and dropping it straight into `data-path="..."`
        // would terminate the attribute early for any path containing one.
        // Not escapeAttr(code): that would re-escape the `&`/`<`/`>` that
        // are already escaped, double-encoding them. Just the one character
        // that's actually unsafe in this specific context.
        html = html.replace(/`([^`]+)`/g, (m, code) => (looksLikePath(code) ? `<code class="file-ref" data-path="${code.replace(/"/g, '&quot;')}">${code}</code>` : `<code>${code}</code>`));
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
  function truncateMiddleText(s, maxLen) {
    const oneLine = String(s || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
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
