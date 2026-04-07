// ═══ State ═══════════════════════════════════════════════════════════════
let sessionId = null;
let agents = [];
let plan = null;
let phases = [];
let eventSource = null;
let streamingMessages = {};
let lastSummaryContent = '';
let currentView = 'game';
let currentMode = 'discussion';
let modeManifests = [];
let godViewEnabled = true;

// ═══ DOM refs ════════════════════════════════════════════════════════════
const $ = s => document.querySelector(s);
const phaseEls = { discussion: $('#discussion'), complete: $('#complete') };

const topicDisplay = $('#topic-display');
const sidebarProgress = $('#sidebar-progress');
const sidebarAgents = $('#sidebar-agents');
const statusDisplay = $('#status-display');
const messagesEl = $('#messages');
const typingIndicator = $('#typing-indicator');
const typingName = $('#typing-name');
const pauseBtn = $('#pause-btn');
const injectContainer = $('#inject-container');
const injectInput = $('#inject-input');
const injectBtn = $('#inject-btn');
const resumeBtn = $('#resume-btn');
const completeTopic = $('#complete-topic');
const summaryContent = $('#summary-content');
const conflictsSection = $('#conflicts-section');
const conflictsContent = $('#conflicts-content');
const exportBtn = $('#export-btn');
const newBtn = $('#new-btn');
const hudProgress = $('#hud-progress');
const hudAgents = $('#hud-agents');
const hudLog = $('#hud-log');
const phaseIndicator = $('#phase-indicator');
const godViewToggle = $('#god-view-toggle');
const godViewCheckbox = $('#god-view-checkbox');

const modeSelector = $('#mode-selector');
const configForm = $('#config-form');
const generateBtn = $('#generate-btn');
const regenerateBtn = $('#regenerate-btn');
const planPanel = $('#plan-panel');
const planPanelTitle = $('#plan-panel-title');
const planSubtopics = $('#plan-subtopics');
const agentCards = $('#agent-cards');
const startBtn = $('#start-btn');
const setupOverlay = $('#setup-overlay');

let agentSpeakCounts = {};
let pendingReasoning = {};

// ═══ Phase ═══════════════════════════════════════════════════════════════
function showPhase(name) {
  Object.values(phaseEls).forEach(p => p.classList.remove('active'));
  phaseEls[name]?.classList.add('active');
}

function initGameOnLoad() {
  currentView = 'game';
  const layout = $('.discussion-layout');
  if (layout) { layout.classList.remove('classic-view'); layout.classList.add('game-view'); }
  GameBridge.init('game-container');
}

// ═══ API ═════════════════════════════════════════════════════════════════
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'API error');
  }
  return res.json();
}

// ═══ Mode selection ══════════════════════════════════════════════════════
async function loadModes() {
  try {
    modeManifests = await api('GET', '/modes');
  } catch {
    modeManifests = [
      { id: 'discussion', name: 'Discussion', icon: '🎙️', configSchema: [{ key: 'topic', type: 'text', label: 'Topic', required: true, hint: 'What should the agents research and discuss?' }, { key: 'agentPreference', type: 'text', label: 'Panel Preferences', required: false, hint: 'Optional preferences' }] },
      { id: 'werewolf', name: 'Werewolf', icon: '🐺', configSchema: [{ key: 'preset', type: 'select', label: 'Preset', required: true, default: 'standard', options: [{ value: 'simple', label: 'Simple (6)' }, { value: 'standard', label: 'Standard (8)' }, { value: 'chaos', label: 'Chaos (10)' }] }, { key: 'theme', type: 'text', label: 'Theme', required: false, default: 'Medieval village' }] },
    ];
  }
  renderModeSelector();
  selectMode(currentMode);
}

function renderModeSelector() {
  modeSelector.innerHTML = modeManifests.map(m => `
    <div class="mode-card ${m.id === currentMode ? 'selected' : ''}" data-mode="${m.id}">
      <span class="mode-icon">${m.icon}</span>
      <div class="mode-info">
        <div class="mode-name">${esc(m.name)}</div>
        <div class="mode-desc">${esc(m.description || '')}</div>
      </div>
    </div>`).join('');

  modeSelector.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => selectMode(card.dataset.mode));
  });
}

function selectMode(modeId) {
  currentMode = modeId;
  modeSelector.querySelectorAll('.mode-card').forEach(c =>
    c.classList.toggle('selected', c.dataset.mode === modeId));

  const manifest = modeManifests.find(m => m.id === modeId);
  if (manifest) renderConfigForm(manifest.configSchema);

  // Update button text
  const btnText = generateBtn.querySelector('.btn-text');
  if (modeId === 'discussion') {
    btnText.textContent = 'Generate Plan';
  } else {
    btnText.textContent = 'Create Game';
  }

  planPanel.classList.add('hidden');
}

function renderConfigForm(schema) {
  configForm.innerHTML = schema.map(field => {
    let input = '';
    switch (field.type) {
      case 'text':
        const isLong = field.key === 'topic';
        input = isLong
          ? `<textarea id="cfg-${field.key}" rows="3" placeholder="${esc(field.hint || '')}">${field.default || ''}</textarea>`
          : `<input type="text" id="cfg-${field.key}" value="${field.default || ''}" placeholder="${esc(field.hint || '')}">`;
        break;
      case 'number':
        input = `<input type="number" id="cfg-${field.key}" value="${field.default || ''}" min="${field.min || ''}" max="${field.max || ''}">`;
        break;
      case 'select':
        input = `<select id="cfg-${field.key}">${(field.options || []).map(o =>
          `<option value="${o.value}" ${o.value === field.default ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
        break;
      case 'toggle':
        input = `<label class="toggle-label"><input type="checkbox" id="cfg-${field.key}" ${field.default ? 'checked' : ''} /> ${esc(field.label)}</label>`;
        return `<div class="config-field">${input}${field.hint ? `<div class="field-hint">${esc(field.hint)}</div>` : ''}</div>`;
      case 'range':
        input = `<input type="range" id="cfg-${field.key}" min="${field.min || 0}" max="${field.max || 100}" value="${field.default || 50}"><span id="cfg-${field.key}-val">${field.default || 50}</span>`;
        break;
    }
    return `<div class="config-field">
      <label for="cfg-${field.key}">${esc(field.label)}${field.required ? '' : ' <span class="optional">(optional)</span>'}</label>
      ${input}
      ${field.hint && field.type !== 'toggle' ? `<div class="field-hint">${esc(field.hint)}</div>` : ''}
    </div>`;
  }).join('');
}

function getConfigValues() {
  const manifest = modeManifests.find(m => m.id === currentMode);
  if (!manifest) return {};
  const config = {};
  for (const field of manifest.configSchema) {
    const el = document.getElementById(`cfg-${field.key}`);
    if (!el) continue;
    if (field.type === 'toggle') config[field.key] = el.checked;
    else if (field.type === 'number' || field.type === 'range') config[field.key] = Number(el.value);
    else config[field.key] = el.value;
  }
  return config;
}

// ═══ Generate / Create ═══════════════════════════════════════════════════
async function generatePlan() {
  const config = getConfigValues();
  if (currentMode === 'discussion' && !config.topic?.trim()) {
    document.getElementById('cfg-topic')?.focus();
    return;
  }

  generateBtn.disabled = true;
  generateBtn.querySelector('.btn-text').classList.add('hidden');
  generateBtn.querySelector('.btn-loading').classList.remove('hidden');
  GameBridge.setSpeaking('planner');

  try {
    let body;
    if (currentMode === 'discussion') {
      // Backward compat
      body = { topic: config.topic, agentPreference: config.agentPreference };
    } else {
      body = { mode: currentMode, config };
    }

    const data = await api('POST', '/session', body);
    sessionId = data.id;
    agents = data.agents;
    plan = data.plan || null;
    phases = data.phases || [];
    renderPlanPreview();
    planPanel.classList.remove('hidden');
  } catch (err) {
    alert('Failed to generate: ' + err.message);
  } finally {
    generateBtn.disabled = false;
    generateBtn.querySelector('.btn-text').classList.remove('hidden');
    generateBtn.querySelector('.btn-loading').classList.add('hidden');
    GameBridge.stopAll();
  }
}

function renderPlanPreview() {
  if (currentMode === 'discussion' && plan) {
    planPanelTitle.textContent = '📐 Sub-topics';
    planSubtopics.innerHTML = plan.subTopics.map((st, i) => `
      <div class="plan-st"><div class="plan-st-title">${i + 1}. ${esc(st.title)}</div>
        <div class="plan-st-goal">${esc(st.goal)}</div></div>`).join('');
  } else if (currentMode === 'werewolf') {
    planPanelTitle.textContent = '🐺 Game Setup';
    planSubtopics.innerHTML = `<div class="plan-st"><div class="plan-st-title">🎭 ${agents.length} Players</div>
      <div class="plan-st-goal">Roles will be assigned secretly when the game starts.</div></div>`;
  } else {
    planPanelTitle.textContent = '📋 Setup';
    planSubtopics.innerHTML = phases.map((p, i) => `
      <div class="plan-st"><div class="plan-st-title">${i + 1}. ${esc(p.label)}</div></div>`).join('');
  }

  agentCards.innerHTML = agents.map(a => `
    <div class="agent-card" style="--agent-color: ${a.color}">
      <div class="agent-emoji">${a.emoji}</div>
      <div class="agent-info">
        <div class="agent-name" style="color: ${a.color}">${esc(a.name)}</div>
        <div class="agent-role">${esc(a.role)}</div>
        <div class="agent-perspective">${esc(a.perspective)}</div>
      </div>
    </div>`).join('');
}

// ═══ Start ═══════════════════════════════════════════════════════════════
async function startSession() {
  if (!sessionId) return;
  const config = getConfigValues();

  if (currentMode === 'discussion') {
    topicDisplay.textContent = config.topic || '';
  } else if (currentMode === 'werewolf') {
    topicDisplay.textContent = '🐺 Werewolf';
    godViewToggle.classList.remove('hidden');
  }

  renderSidebarProgress();
  renderSidebarAgents();
  if (setupOverlay) setupOverlay.classList.add('hidden');

  // Game scene
  if (currentMode === 'discussion') {
    GameBridge.setTopic(config.topic || '');
    if (plan?.subTopics?.[0]) GameBridge.setSubtopic(plan.subTopics[0].title);
  } else {
    GameBridge.setTopic('🐺 Werewolf');
    GameBridge.setSubtopic(currentMode === 'werewolf' ? 'Night 1' : '');
  }

  await GameBridge.enterAgents(agents);
  agentSpeakCounts = {};
  renderHudProgress();
  renderHudAgents(null);
  hudLog.innerHTML = '';

  connectSSE();
  try { await api('POST', `/session/${sessionId}/start`); }
  catch (err) { alert('Failed to start: ' + err.message); }
}

function renderSidebarProgress() {
  if (currentMode === 'discussion' && plan) {
    sidebarProgress.innerHTML = plan.subTopics.map((st, i) => {
      const cls = st.status === 'completed' ? 'completed' : st.status !== 'pending' ? 'active' : 'pending';
      const icon = st.status === 'completed' ? '✅' : st.status !== 'pending' ? '▶' : '○';
      return `<div class="progress-item ${cls}" id="prog-${st.id}">
        <span class="progress-icon">${icon}</span><span>${esc(st.title)}</span></div>`;
    }).join('');
  } else {
    sidebarProgress.innerHTML = phases.map((p, i) => {
      const cls = p.status === 'resolved' ? 'completed' : p.status === 'active' ? 'active' : 'pending';
      const icon = p.status === 'resolved' ? '✅' : p.status === 'active' ? '▶' : '○';
      return `<div class="progress-item ${cls}" id="prog-${p.id}">
        <span class="progress-icon">${icon}</span><span>${esc(p.label)}</span></div>`;
    }).join('');
  }
}

function renderSidebarAgents() {
  const extra = currentMode === 'discussion' ? [
    `<div class="sidebar-agent" id="sa-critic" style="--agent-color: #4ECDC4"><span>🔍</span><span style="color: #4ECDC4">Critic</span></div>`,
    `<div class="sidebar-agent" id="sa-planner" style="--agent-color: #FFB347"><span>📐</span><span style="color: #FFB347">Host</span></div>`,
  ] : [
    `<div class="sidebar-agent" id="sa-gm" style="--agent-color: #FFD700"><span>🎭</span><span style="color: #FFD700">Game Master</span></div>`,
  ];

  sidebarAgents.innerHTML = [
    ...agents.map(a => `
      <div class="sidebar-agent" id="sa-${a.id}" style="--agent-color: ${a.color}">
        <span>${a.emoji}</span><span style="color: ${a.color}">${esc(a.name)}</span>
        <span class="agent-role-badge hidden" id="role-badge-${a.id}"></span>
      </div>`),
    ...extra,
  ].join('');
}

// ═══ SSE ═════════════════════════════════════════════════════════════════
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/session/${sessionId}/stream`);

  eventSource.addEventListener('init', e => {
    const data = JSON.parse(e.data);
    if (data.plan) plan = data.plan;
    if (data.phases) phases = data.phases;
    if (data.messages?.length) {
      messagesEl.innerHTML = '';
      data.messages.forEach(m => appendCompleteMessage(m));
    }
    renderSidebarProgress();
  });

  eventSource.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    appendCompleteMessage(msg);
    if (msg.type === 'critic') GameBridge.showCriticFlag(msg.content.includes('✅'));
  });

  eventSource.addEventListener('message_start', e => {
    const data = JSON.parse(e.data);
    const pr = pendingReasoning[data.agentId];
    if (pr && godViewEnabled) {
      const reasoningEl = document.createElement('details');
      reasoningEl.className = 'reasoning-block';
      reasoningEl.style.borderLeftColor = pr.color || '#666';
      reasoningEl.innerHTML = `<summary>🧠 ${esc(pr.agentName)}'s private reasoning</summary><div class="reasoning-content">${renderMarkdown(pr.reasoning)}</div>`;
      messagesEl.appendChild(reasoningEl);
      delete pendingReasoning[data.agentId];
    }
    const el = createMessageEl(data);
    messagesEl.appendChild(el);
    streamingMessages[data.id] = {
      el, content: '', bodyEl: el.querySelector('.message-body'),
      isSummary: data.type === 'summary', agentId: data.agentId, color: data.color,
    };
    showTyping(false);
    scrollToBottom();
  });

  eventSource.addEventListener('message_chunk', e => {
    const { id, chunk } = JSON.parse(e.data);
    const s = streamingMessages[id];
    if (!s) return;
    s.content += chunk;
    if (!s.rafPending) {
      s.rafPending = true;
      requestAnimationFrame(() => {
        s.bodyEl.innerHTML = renderMarkdown(s.content);
        s.rafPending = false;
        scrollToBottom();
      });
    }
    if (s.agentId) GameBridge.showBubble(s.agentId, s.content, s.color);
  });

  eventSource.addEventListener('message_end', e => {
    const { id } = JSON.parse(e.data);
    const s = streamingMessages[id];
    if (s) {
      s.bodyEl.innerHTML = renderMarkdown(s.content);
      if (s.isSummary) { lastSummaryContent = s.content; appendDownloadBar(s.el); }
      const agent = agents.find(a => a.id === s.agentId);
      if (agent) addHudLog(agent.name, agent.color, s.content);
      delete streamingMessages[id];
    }
    scrollToBottom();
    GameBridge.hideBubble();
  });

  eventSource.addEventListener('thinking', e => {
    const { agentId, agentName } = JSON.parse(e.data);
    document.querySelectorAll('.sidebar-agent').forEach(el => el.classList.remove('speaking', 'thinking'));
    const saEl = document.getElementById(`sa-${agentId}`);
    if (saEl) saEl.classList.add('thinking');
    showTyping(true, agentName, 'thinking');
    GameBridge.setThinking(agentId);
    renderHudAgents(null);
  });

  eventSource.addEventListener('researching', e => {
    const { agentId, agentName } = JSON.parse(e.data);
    document.querySelectorAll('.sidebar-agent').forEach(el => el.classList.remove('speaking', 'thinking'));
    const saEl = document.getElementById(`sa-${agentId}`);
    if (saEl) saEl.classList.add('thinking');
    showTyping(true, agentName, 'searching');
    GameBridge.setThinking(agentId);
    GameBridge.showBubble(agentId, '🔍 Searching the web...', null);

    const toolEl = document.createElement('div');
    toolEl.className = 'tool-call';
    toolEl.id = `tool-${agentId}`;
    toolEl.innerHTML = `
      <div class="tool-call-header">
        <span class="tool-call-icon">⚡</span><span class="tool-call-label">Tool Call</span>
        <span class="tool-call-fn">web_search</span>
        <span class="tool-call-agent" style="color: ${agents.find(a => a.id === agentId)?.color || '#aaa'}">${esc(agentName)}</span>
        <span class="tool-call-status loading">searching…</span>
      </div><div class="tool-call-body"><div class="tool-call-spinner"></div></div>`;
    messagesEl.appendChild(toolEl);
    scrollToBottom();
  });

  eventSource.addEventListener('research', e => {
    const { agentId, query, content, citations } = JSON.parse(e.data);
    const toolEl = document.getElementById(`tool-${agentId}`);
    if (!toolEl) return;
    const statusEl = toolEl.querySelector('.tool-call-status');
    if (statusEl) { statusEl.textContent = `${citations.length} sources`; statusEl.classList.remove('loading'); statusEl.classList.add('done'); }
    const citationLinks = (citations || []).map((c, i) => `<a href="${esc(c)}" target="_blank">[${i + 1}] ${esc(c)}</a>`).join('');
    const bodyEl = toolEl.querySelector('.tool-call-body');
    if (bodyEl) bodyEl.innerHTML = `<details class="tool-call-details" open><summary>Query & Results</summary><div class="tool-call-query">${esc(query)}</div><div class="tool-call-result">${renderMarkdown(content)}</div>${citationLinks ? `<div class="tool-call-citations">${citationLinks}</div>` : ''}</details>`;
    scrollToBottom();
  });

  eventSource.addEventListener('reasoning', e => {
    const { agentId, agentName, reasoning, color, emoji } = JSON.parse(e.data);
    pendingReasoning[agentId] = { agentName, reasoning, color, emoji };
    const excerpt = reasoning.length > 120 ? reasoning.slice(0, 117) + '...' : reasoning;
    GameBridge.showBubble(agentId, '🧠 ' + excerpt, color);
  });

  eventSource.addEventListener('speaking', e => {
    const { agentId, agentName } = JSON.parse(e.data);
    document.querySelectorAll('.sidebar-agent').forEach(el => el.classList.remove('speaking', 'thinking'));
    const saEl = document.getElementById(`sa-${agentId}`);
    if (saEl) saEl.classList.add('speaking');
    showTyping(true, agentName, 'speaking');
    GameBridge.setSpeaking(agentId);
    agentSpeakCounts[agentId] = (agentSpeakCounts[agentId] || 0) + 1;
    renderHudAgents(agentId);
  });

  eventSource.addEventListener('subtopic_start', e => {
    const { index, subTopic } = JSON.parse(e.data);
    if (plan) { plan.subTopics[index] = subTopic; renderSidebarProgress(); renderHudProgress(); }
    GameBridge.setSubtopic(subTopic.title);
  });

  eventSource.addEventListener('subtopic_complete', e => {
    const { index, subTopic } = JSON.parse(e.data);
    if (plan) { plan.subTopics[index] = subTopic; renderSidebarProgress(); renderHudProgress(); }
  });

  // ── Werewolf-specific events ──

  eventSource.addEventListener('phase_start', e => {
    const { phase } = JSON.parse(e.data);
    // Update phases list
    const existing = phases.find(p => p.id === phase.id);
    if (existing) Object.assign(existing, phase);
    else phases.push(phase);
    renderSidebarProgress();
    renderHudProgress();
    updatePhaseIndicator(phase);
    GameBridge.setSubtopic(phase.label);
  });

  eventSource.addEventListener('night_resolution', e => {
    const data = JSON.parse(e.data);
    if (godViewEnabled) {
      const el = document.createElement('details');
      el.className = 'reasoning-block night-events';
      el.style.borderLeftColor = '#8b5cf6';
      el.innerHTML = `<summary>🌙 Night Events (God View)</summary>
        <div class="reasoning-content">${data.events.map(ev => `<p>${ev}</p>`).join('')}</div>`;
      messagesEl.appendChild(el);
      scrollToBottom();
    }
  });

  eventSource.addEventListener('vote_result', e => {
    const { votes, tally, eliminated, tied } = JSON.parse(e.data);
    ctx_broadcast_vote(votes, tally, eliminated, tied);
  });

  eventSource.addEventListener('elimination', e => {
    const { agentId, role, roleEmoji, roleName } = JSON.parse(e.data);
    // Mark agent as eliminated in sidebar
    const saEl = document.getElementById(`sa-${agentId}`);
    if (saEl) { saEl.classList.add('eliminated'); saEl.style.opacity = '0.4'; }
    // Show role badge
    const badge = document.getElementById(`role-badge-${agentId}`);
    if (badge) { badge.textContent = `${roleEmoji} ${roleName}`; badge.classList.remove('hidden'); }
    GameBridge.eliminateAgent?.(agentId);
  });

  eventSource.addEventListener('role_reveal', e => {
    const { agentId, role, roleEmoji } = JSON.parse(e.data);
    const badge = document.getElementById(`role-badge-${agentId}`);
    if (badge) { badge.textContent = `${roleEmoji}`; badge.classList.remove('hidden'); }
  });

  eventSource.addEventListener('critic_flag', e => {
    const { approved } = JSON.parse(e.data);
    GameBridge.showCriticFlag(approved);
  });

  eventSource.addEventListener('status', e => {
    const { status } = JSON.parse(e.data);
    handleStatusChange(status);
  });

  eventSource.addEventListener('error', () => {});
}

function ctx_broadcast_vote(votes, tally, eliminated, tied) {
  // Already handled by message from GM, this is extra UI if needed
}

function updatePhaseIndicator(phase) {
  if (!phaseIndicator) return;
  if (currentMode !== 'werewolf') { phaseIndicator.classList.add('hidden'); return; }
  phaseIndicator.classList.remove('hidden');
  const isNight = phase.type === 'night';
  phaseIndicator.className = `phase-indicator ${isNight ? 'night' : 'day'}`;
  phaseIndicator.textContent = phase.label;
}

function handleStatusChange(status) {
  statusDisplay.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  document.querySelectorAll('.sidebar-agent').forEach(el => el.classList.remove('speaking'));
  showTyping(false);
  GameBridge.stopAll();

  if (status === 'paused') {
    pauseBtn.classList.add('hidden');
    injectContainer.classList.remove('hidden');
    injectInput.focus();
  } else if (status === 'running') {
    pauseBtn.classList.remove('hidden');
    injectContainer.classList.add('hidden');
  } else if (status === 'completed') {
    completeTopic.textContent = topicDisplay.textContent;
    summaryContent.innerHTML = lastSummaryContent ? renderMarkdown(lastSummaryContent) : '<p>Session completed.</p>';
    if (plan?.conflicts?.length) {
      conflictsSection.classList.remove('hidden');
      conflictsContent.innerHTML = plan.conflicts.map(c => `<p>• ${esc(c)}</p>`).join('');
    }
    showPhase('complete');
    if (eventSource) eventSource.close();
  }
}

// ═══ Message rendering ═══════════════════════════════════════════════════
function getTypeClass(type) {
  if (type === 'user') return 'user';
  if (type === 'agent') return 'agent';
  if (type === 'planner') return 'planner';
  if (type === 'critic') return 'critic';
  if (type === 'summary') return 'summary';
  if (type === 'gm') return 'gm';
  return 'system';
}

function createMessageEl(data) {
  const div = document.createElement('div');
  div.className = `message ${getTypeClass(data.type)}`;
  div.id = `msg-${data.id}`;
  if (data.type === 'user') {
    div.innerHTML = `<div class="message-header"><span class="message-name">You</span></div><div class="message-body"></div>`;
  } else {
    div.innerHTML = `<div class="message-header">
      ${data.emoji ? `<span class="message-emoji">${data.emoji}</span>` : ''}
      <span class="message-name" style="color: ${data.color || 'var(--text)'}">${esc(data.agentName)}</span>
    </div><div class="message-body"></div>`;
    div.style.setProperty('--agent-color', data.color || 'var(--text-dim)');
  }
  return div;
}

function appendCompleteMessage(msg) {
  const el = createMessageEl(msg);
  el.querySelector('.message-body').innerHTML = renderMarkdown(msg.content);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function showTyping(show, name, state) {
  if (show) {
    typingName.textContent = name || 'Agent';
    const label = typingIndicator.querySelector('#typing-label');
    if (label) {
      if (state === 'searching') label.textContent = 'is searching the web…';
      else if (state === 'thinking') label.textContent = 'is reasoning privately…';
      else label.textContent = 'is speaking…';
    }
    typingIndicator.classList.remove('hidden');
  } else {
    typingIndicator.classList.add('hidden');
  }
}

let autoFollow = true;
function scrollToBottom() {
  if (!autoFollow) return;
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
}

function updateFollowBtn() {
  let btn = document.getElementById('follow-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'follow-btn';
    btn.className = 'btn follow-btn';
    btn.textContent = '↓ Follow';
    btn.addEventListener('click', () => { autoFollow = true; btn.classList.add('hidden'); messagesEl.scrollTop = messagesEl.scrollHeight; });
    messagesEl.parentElement.appendChild(btn);
  }
  btn.classList.toggle('hidden', autoFollow);
}

messagesEl.addEventListener('scroll', () => {
  const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  if (atBottom && !autoFollow) { autoFollow = true; updateFollowBtn(); }
  else if (!atBottom && autoFollow) { autoFollow = false; updateFollowBtn(); }
});

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') return marked.parse(text || '', { breaks: true });
  return (text || '').replace(/\n/g, '<br>');
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ═══ Controls ════════════════════════════════════════════════════════════
async function pauseSession() {
  try { await api('POST', `/session/${sessionId}/pause`); }
  catch (err) { alert('Pause failed: ' + err.message); }
}

async function resumeSession() {
  const msg = injectInput.value.trim();
  if (msg) {
    try { await api('POST', `/session/${sessionId}/inject`, { message: msg }); injectInput.value = ''; }
    catch (err) { alert('Inject failed: ' + err.message); }
  }
  try { await api('POST', `/session/${sessionId}/resume`); }
  catch (err) { alert('Resume failed: ' + err.message); }
}

async function injectMessage() {
  const msg = injectInput.value.trim();
  if (!msg) return;
  try { await api('POST', `/session/${sessionId}/inject`, { message: msg }); injectInput.value = ''; }
  catch (err) { alert('Send failed: ' + err.message); }
}

function exportMarkdown() {
  let md = `# ${currentMode === 'werewolf' ? 'Werewolf Game' : 'Research: ' + topicDisplay.textContent}\n\n`;
  if (plan) {
    md += `## Discussion Plan\n`;
    plan.subTopics.forEach((st, i) => { md += `${i + 1}. **${st.title}** — ${st.goal}\n`; });
    md += `\n## Panel\n`;
  }
  agents.forEach(a => { md += `- ${a.emoji} **${a.name}** — ${a.role}\n`; });
  md += `\n---\n\n`;

  fetch(`/api/session/${sessionId}`)
    .then(r => r.json())
    .then(data => {
      data.messages.forEach(m => {
        if (m.type === 'system') md += `\n${m.content}\n\n`;
        else if (m.type === 'planner' || m.type === 'gm') md += `> **${m.agentName}:** ${m.content}\n\n`;
        else if (m.type === 'critic') md += `> **🔍 Critic:** ${m.content}\n\n`;
        else if (m.type === 'user') md += `> **You:** ${m.content}\n\n`;
        else if (m.type === 'agent') md += `### ${m.emoji || ''} ${m.agentName}\n\n${m.content}\n\n---\n\n`;
        else if (m.type === 'summary') md += `\n## Final Report\n\n${m.content}\n`;
      });
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `roundtable-${sessionId}.md`; a.click();
      URL.revokeObjectURL(url);
    });
}

function appendDownloadBar(afterEl) {
  const bar = document.createElement('div');
  bar.className = 'download-bar';
  bar.innerHTML = `<span class="download-bar-label">🏁 Session complete</span>
    <button class="btn download-bar-btn" onclick="exportMarkdown()">📥 Download Report</button>
    <button class="btn download-bar-btn secondary" onclick="newSession()">🎙️ New Session</button>`;
  afterEl.after(bar);
}

function newSession() {
  sessionId = null; agents = []; plan = null; phases = [];
  streamingMessages = {}; lastSummaryContent = '';
  pendingReasoning = {};
  if (eventSource) eventSource.close();
  messagesEl.innerHTML = '';
  planPanel.classList.add('hidden');
  conflictsSection.classList.add('hidden');
  godViewToggle.classList.add('hidden');
  phaseIndicator?.classList.add('hidden');
  GameBridge.destroy();
  agentSpeakCounts = {};
  showPhase('discussion');
  setupOverlay?.classList.remove('hidden');
  loadModes();
  initGameOnLoad();
}

function renderHudProgress() {
  if (!hudProgress) return;
  if (currentMode === 'discussion' && plan) {
    hudProgress.innerHTML = plan.subTopics.map((st, i) => {
      const cls = st.status === 'completed' ? 'done' : st.status !== 'pending' ? 'active' : '';
      return `<div class="hud-step ${cls}"><span class="hud-step-num">${i + 1}</span><span class="hud-step-title">${esc(st.title)}</span></div>`;
    }).join('');
  } else {
    hudProgress.innerHTML = phases.map((p, i) => {
      const cls = p.status === 'resolved' ? 'done' : p.status === 'active' ? 'active' : '';
      return `<div class="hud-step ${cls}"><span class="hud-step-num">${i + 1}</span><span class="hud-step-title">${esc(p.label)}</span></div>`;
    }).join('');
  }
}

function renderHudAgents(speakingId) {
  if (!hudAgents) return;
  const extra = currentMode === 'discussion'
    ? [{ id: 'critic', emoji: '🔍', name: 'Critic', color: '#4ECDC4' }, { id: 'planner', emoji: '📐', name: 'Host', color: '#FFB347' }]
    : [{ id: 'gm', emoji: '🎭', name: 'GM', color: '#FFD700' }];
  const allAgents = [...agents.map(a => ({ id: a.id, emoji: a.emoji, name: a.name, color: a.color })), ...extra];
  hudAgents.innerHTML = allAgents.map(a => {
    const count = agentSpeakCounts[a.id] || 0;
    const speaking = a.id === speakingId ? 'speaking' : '';
    return `<div class="hud-agent ${speaking}" style="--agent-color: ${a.color}">
      <span>${a.emoji}</span><span style="color:${a.color}">${esc(a.name)}</span>
      ${count ? `<span class="hud-count">${count}</span>` : ''}</div>`;
  }).join('');
}

function addHudLog(name, color, text) {
  if (!hudLog) return;
  const entry = document.createElement('div');
  entry.className = 'hud-log-entry';
  const preview = text.length > 100 ? text.slice(0, 97) + '...' : text;
  entry.innerHTML = `<span class="hud-log-name" style="color:${color}">${esc(name)}:</span> ${esc(preview)}`;
  hudLog.appendChild(entry);
  hudLog.scrollTop = hudLog.scrollHeight;
}

// ═══ Events ══════════════════════════════════════════════════════════════
generateBtn.addEventListener('click', generatePlan);
regenerateBtn.addEventListener('click', () => { planPanel.classList.add('hidden'); generatePlan(); });
startBtn.addEventListener('click', startSession);
pauseBtn.addEventListener('click', pauseSession);
resumeBtn.addEventListener('click', resumeSession);
injectBtn.addEventListener('click', injectMessage);
injectInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); injectMessage(); } });
exportBtn.addEventListener('click', exportMarkdown);
newBtn.addEventListener('click', newSession);

if (godViewCheckbox) {
  godViewCheckbox.addEventListener('change', () => {
    godViewEnabled = godViewCheckbox.checked;
    document.querySelectorAll('.reasoning-block, .night-events').forEach(el => {
      el.style.display = godViewEnabled ? '' : 'none';
    });
  });
}

// Keyboard shortcut: Cmd+Enter to generate
configForm.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); generatePlan(); }
});

// ═══ Init ════════════════════════════════════════════════════════════════
initGameOnLoad();
loadModes();
