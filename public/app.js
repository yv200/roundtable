// ═══ State ═══════════════════════════════════════════════════════════════
let sessionId = null;
let agents = [];
let plan = null;
let eventSource = null;
let streamingMessages = {};
let lastSummaryContent = '';
let currentView = 'game';

// ═══ DOM refs ════════════════════════════════════════════════════════════
const $ = s => document.querySelector(s);
const phases = { setup: $('#setup'), discussion: $('#discussion'), complete: $('#complete') };

const topicInput = $('#topic-input');
const prefInput = $('#pref-input');
const generateBtn = $('#generate-btn');
const regenerateBtn = $('#regenerate-btn');
const planPanel = $('#plan-panel');
const planSubtopics = $('#plan-subtopics');
const agentCards = $('#agent-cards');
const startBtn = $('#start-btn');
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
const discussionLayout = $('.discussion-layout');
const hudProgress = $('#hud-progress');
const hudAgents = $('#hud-agents');
const hudLog = $('#hud-log');
let agentSpeakCounts = {};
let pendingReasoning = {};

// ═══ Phase ═══════════════════════════════════════════════════════════════
const setupOverlay = $('#setup-overlay');

function showPhase(name) {
  Object.values(phases).forEach(p => p.classList.remove('active'));
  phases[name].classList.add('active');
}

// Init game immediately on load
function initGameOnLoad() {
  currentView = 'game';
  const layout = $('.discussion-layout');
  if (layout) {
    layout.classList.remove('classic-view');
    layout.classList.add('game-view');
  }
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

// ═══ Generate plan ═══════════════════════════════════════════════════════
async function generatePlan() {
  const topic = topicInput.value.trim();
  if (!topic) { topicInput.focus(); return; }

  generateBtn.disabled = true;
  generateBtn.querySelector('.btn-text').classList.add('hidden');
  generateBtn.querySelector('.btn-loading').classList.remove('hidden');

  // Host thinking animation while planning
  GameBridge.setSpeaking('planner');

  try {
    const data = await api('POST', '/session', {
      topic,
      agentPreference: prefInput.value.trim() || undefined,
    });
    sessionId = data.id;
    agents = data.agents;
    plan = data.plan;
    renderPlanPreview();
    planPanel.classList.remove('hidden');
  } catch (err) {
    alert('Failed to generate plan: ' + err.message);
  } finally {
    generateBtn.disabled = false;
    generateBtn.querySelector('.btn-text').classList.remove('hidden');
    generateBtn.querySelector('.btn-loading').classList.add('hidden');
    GameBridge.stopAll();
  }
}

function renderPlanPreview() {
  planSubtopics.innerHTML = plan.subTopics.map((st, i) => `
    <div class="plan-st">
      <div class="plan-st-title">${i + 1}. ${esc(st.title)}</div>
      <div class="plan-st-goal">${esc(st.goal)}</div>
    </div>
  `).join('');

  agentCards.innerHTML = agents.map(a => `
    <div class="agent-card" style="--agent-color: ${a.color}">
      <div class="agent-emoji">${a.emoji}</div>
      <div class="agent-info">
        <div class="agent-name" style="color: ${a.color}">${esc(a.name)}</div>
        <div class="agent-role">${esc(a.role)}</div>
        <div class="agent-perspective">${esc(a.perspective)}</div>
      </div>
    </div>
  `).join('');
}

// ═══ Start ═══════════════════════════════════════════════════════════════
async function startDiscussion() {
  if (!sessionId) return;
  topicDisplay.textContent = topicInput.value.trim();
  renderSidebarProgress();
  renderSidebarAgents();

  // Hide setup overlay with fade
  if (setupOverlay) setupOverlay.classList.add('hidden');

  // Host writes topic on blackboard
  GameBridge.setTopic(topicInput.value.trim());
  if (plan?.subTopics?.[0]) {
    GameBridge.setSubtopic(plan.subTopics[0].title);
  }

  // Agents enter one by one
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
  if (!plan) return;
  sidebarProgress.innerHTML = plan.subTopics.map((st, i) => {
    const cls = st.status === 'completed' ? 'completed' : st.status !== 'pending' ? 'active' : 'pending';
    const icon = st.status === 'completed' ? '✅' : st.status !== 'pending' ? '▶' : '○';
    return `<div class="progress-item ${cls}" id="prog-${st.id}">
      <span class="progress-icon">${icon}</span>
      <span>${esc(st.title)}</span>
    </div>`;
  }).join('');
}

function renderSidebarAgents() {
  sidebarAgents.innerHTML = [
    ...agents.map(a => `
      <div class="sidebar-agent" id="sa-${a.id}" style="--agent-color: ${a.color}">
        <span>${a.emoji}</span>
        <span style="color: ${a.color}">${esc(a.name)}</span>
      </div>
    `),
    `<div class="sidebar-agent" id="sa-critic" style="--agent-color: #4ECDC4">
      <span>🔍</span><span style="color: #4ECDC4">Critic</span>
    </div>`,
    `<div class="sidebar-agent" id="sa-planner" style="--agent-color: #FFB347">
      <span>📐</span><span style="color: #FFB347">Host</span>
    </div>`,
  ].join('');
}

// ═══ SSE ═════════════════════════════════════════════════════════════════
function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/session/${sessionId}/stream`);

  eventSource.addEventListener('init', e => {
    const data = JSON.parse(e.data);
    if (data.plan) plan = data.plan;
    if (data.messages?.length) {
      messagesEl.innerHTML = '';
      data.messages.forEach(m => appendCompleteMessage(m));
    }
    renderSidebarProgress();
  });

  eventSource.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    appendCompleteMessage(msg);
    if (msg.type === 'critic') {
      GameBridge.showCriticFlag(msg.content.includes('✅'));
    }
  });

  eventSource.addEventListener('message_start', e => {
    const data = JSON.parse(e.data);

    // Insert reasoning collapsible if we have pending reasoning for this agent
    const pr = pendingReasoning[data.agentId];
    if (pr) {
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
      isSummary: data.type === 'summary',
      agentId: data.agentId,
      color: data.color,
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
    if (s.agentId) {
      GameBridge.showBubble(s.agentId, s.content, s.color);
    }
  });

  eventSource.addEventListener('message_end', e => {
    const { id } = JSON.parse(e.data);
    const s = streamingMessages[id];
    if (s) {
      s.bodyEl.innerHTML = renderMarkdown(s.content);
      if (s.isSummary) lastSummaryContent = s.content;
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
    showTyping(true, agentName, true);
    GameBridge.setThinking(agentId);
    renderHudAgents(null);
  });

  eventSource.addEventListener('reasoning', e => {
    const { agentId, agentName, reasoning, color, emoji } = JSON.parse(e.data);
    // Store reasoning to attach to the next message from this agent
    pendingReasoning[agentId] = { agentName, reasoning, color, emoji };
    // Show excerpt in game bubble
    const excerpt = reasoning.length > 120 ? reasoning.slice(0, 117) + '...' : reasoning;
    GameBridge.showBubble(agentId, '🧠 ' + excerpt, color);
  });

  eventSource.addEventListener('speaking', e => {
    const { agentId, agentName } = JSON.parse(e.data);
    document.querySelectorAll('.sidebar-agent').forEach(el => el.classList.remove('speaking', 'thinking'));
    const saEl = document.getElementById(`sa-${agentId}`);
    if (saEl) saEl.classList.add('speaking');
    showTyping(true, agentName, false);
    GameBridge.setSpeaking(agentId);
    agentSpeakCounts[agentId] = (agentSpeakCounts[agentId] || 0) + 1;
    renderHudAgents(agentId);
  });

  eventSource.addEventListener('subtopic_start', e => {
    const { index, subTopic } = JSON.parse(e.data);
    if (plan) {
      plan.subTopics[index] = subTopic;
      renderSidebarProgress();
      renderHudProgress();
    }
    GameBridge.setSubtopic(subTopic.title);
  });

  eventSource.addEventListener('subtopic_complete', e => {
    const { index, subTopic } = JSON.parse(e.data);
    if (plan) {
      plan.subTopics[index] = subTopic;
      renderSidebarProgress();
      renderHudProgress();
    }
  });

  eventSource.addEventListener('status', e => {
    const { status } = JSON.parse(e.data);
    handleStatusChange(status);
  });

  eventSource.addEventListener('error', () => {});
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
    summaryContent.innerHTML = lastSummaryContent
      ? renderMarkdown(lastSummaryContent)
      : '<p>No summary available.</p>';

    // Show conflicts if any
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
  return 'system';
}

function createMessageEl(data) {
  const div = document.createElement('div');
  div.className = `message ${getTypeClass(data.type)}`;
  div.id = `msg-${data.id}`;

  if (data.type === 'user') {
    div.innerHTML = `
      <div class="message-header"><span class="message-name">You</span></div>
      <div class="message-body"></div>`;
  } else {
    div.innerHTML = `
      <div class="message-header">
        ${data.emoji ? `<span class="message-emoji">${data.emoji}</span>` : ''}
        <span class="message-name" style="color: ${data.color || 'var(--text)'}">${esc(data.agentName)}</span>
      </div>
      <div class="message-body"></div>`;
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

function showTyping(show, name, isThinking) {
  if (show) {
    typingName.textContent = name || 'Agent';
    const label = typingIndicator.querySelector('#typing-label');
    if (label) {
      label.textContent = isThinking ? 'is reasoning privately…' : 'is speaking…';
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
    btn.addEventListener('click', () => {
      autoFollow = true;
      btn.classList.add('hidden');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
    messagesEl.parentElement.appendChild(btn);
  }
  if (autoFollow) {
    btn.classList.add('hidden');
  } else {
    btn.classList.remove('hidden');
  }
}

// Detect user scroll
messagesEl.addEventListener('scroll', () => {
  const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  if (atBottom && !autoFollow) {
    autoFollow = true;
    updateFollowBtn();
  } else if (!atBottom && autoFollow) {
    autoFollow = false;
    updateFollowBtn();
  }
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
async function pauseDiscussion() {
  try { await api('POST', `/session/${sessionId}/pause`); }
  catch (err) { alert('Pause failed: ' + err.message); }
}

async function resumeDiscussion() {
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
  let md = `# Research: ${topicDisplay.textContent}\n\n`;
  if (plan) {
    md += `## Discussion Plan\n`;
    plan.subTopics.forEach((st, i) => { md += `${i + 1}. **${st.title}** — ${st.goal}\n`; });
    md += `\n## Panel\n`;
    agents.forEach(a => { md += `- ${a.emoji} **${a.name}** — ${a.role}\n`; });
    md += `\n---\n\n`;
  }
  fetch(`/api/session/${sessionId}`)
    .then(r => r.json())
    .then(data => {
      let currentSt = '';
      data.messages.forEach(m => {
        if (m.type === 'system' && m.content.includes('Sub-topic')) {
          md += `\n${m.content}\n\n`;
          currentSt = m.content;
        } else if (m.type === 'planner') {
          md += `> **📐 Host:** ${m.content}\n\n`;
        } else if (m.type === 'critic') {
          md += `> **🔍 Critic:** ${m.content}\n\n`;
        } else if (m.type === 'user') {
          md += `> **You:** ${m.content}\n\n`;
        } else if (m.type === 'agent') {
          md += `### ${m.emoji || ''} ${m.agentName}\n\n${m.content}\n\n---\n\n`;
        } else if (m.type === 'summary') {
          md += `\n## Final Report\n\n${m.content}\n`;
        }
      });
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `roundtable-${sessionId}.md`; a.click();
      URL.revokeObjectURL(url);
    });
}

function newDiscussion() {
  sessionId = null; agents = []; plan = null;
  streamingMessages = {}; lastSummaryContent = '';
  if (eventSource) eventSource.close();
  messagesEl.innerHTML = '';
  topicInput.value = ''; prefInput.value = '';
  planPanel.classList.add('hidden');
  conflictsSection.classList.add('hidden');
  GameBridge.destroy();
  agentSpeakCounts = {};
  showPhase('setup');
}

function renderHudProgress() {
  if (!plan || !hudProgress) return;
  hudProgress.innerHTML = plan.subTopics.map((st, i) => {
    const cls = st.status === 'completed' ? 'done' : st.status !== 'pending' ? 'active' : '';
    return `<div class="hud-step ${cls}"><span class="hud-step-num">${i + 1}</span><span class="hud-step-title">${esc(st.title)}</span></div>`;
  }).join('');
}

function renderHudAgents(speakingId) {
  if (!hudAgents) return;
  const allAgents = [
    ...agents.map(a => ({ id: a.id, emoji: a.emoji, name: a.name, color: a.color })),
    { id: 'critic', emoji: '🔍', name: 'Critic', color: '#4ECDC4' },
    { id: 'planner', emoji: '📐', name: 'Host', color: '#FFB347' },
  ];
  hudAgents.innerHTML = allAgents.map(a => {
    const count = agentSpeakCounts[a.id] || 0;
    const speaking = a.id === speakingId ? 'speaking' : '';
    return `<div class="hud-agent ${speaking}" style="--agent-color: ${a.color}">
      <span>${a.emoji}</span><span style="color:${a.color}">${esc(a.name)}</span>
      ${count ? `<span class="hud-count">${count}</span>` : ''}
    </div>`;
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
startBtn.addEventListener('click', startDiscussion);
pauseBtn.addEventListener('click', pauseDiscussion);
resumeBtn.addEventListener('click', resumeDiscussion);
injectBtn.addEventListener('click', injectMessage);
injectInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); injectMessage(); } });
exportBtn.addEventListener('click', exportMarkdown);
newBtn.addEventListener('click', newDiscussion);
topicInput.addEventListener('keydown', e => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); generatePlan(); } });

// View toggle removed — game view only

// ═══ Preview Mode ════════════════════════════════════════════════════════
if (new URLSearchParams(location.search).has('preview')) {
  const mockAgents = [
    { id: 'a1', name: 'Alice', role: 'Economist', perspective: 'Market dynamics', speakingStyle: 'analytical', color: '#FF6B6B', emoji: '📊' },
    { id: 'a2', name: 'Bob', role: 'Technologist', perspective: 'Engineering lens', speakingStyle: 'technical', color: '#6C63FF', emoji: '💻' },
    { id: 'a3', name: 'Carol', role: 'Ethicist', perspective: 'Moral implications', speakingStyle: 'thoughtful', color: '#4ECDC4', emoji: '⚖️' },
    { id: 'a4', name: 'Dave', role: 'Skeptic', perspective: 'Devil\'s advocate', speakingStyle: 'challenging', color: '#FFD93D', emoji: '🤔' },
  ];
  agents = mockAgents;
  plan = {
    subTopics: [
      { id: 'st1', title: 'Economic Impact of AI Automation on Global Labor Markets and Workforce Displacement Patterns', goal: 'Analyze job displacement vs creation', dependsOn: [], status: 'discussing', summary: '', critiqueRounds: 0, discussionRounds: 0 },
      { id: 'st2', title: 'Ethical Boundaries', goal: 'Where should we draw the line?', dependsOn: ['st1'], status: 'pending', summary: '', critiqueRounds: 0, discussionRounds: 0 },
      { id: 'st3', title: 'Regulation Framework', goal: 'Global policy proposals', dependsOn: ['st1', 'st2'], status: 'pending', summary: '', critiqueRounds: 0, discussionRounds: 0 },
    ],
    currentIndex: 0, finalSynthesis: '', conflicts: [],
  };

  topicDisplay.textContent = 'The Future of AI — Economic, Ethical & Policy Perspectives';
  renderSidebarProgress();
  renderSidebarAgents();

  // Hide setup overlay for preview
  if (setupOverlay) setupOverlay.classList.add('hidden');

  // Game already initialized by initGameOnLoad, just setup agents
  setTimeout(() => {
    GameBridge.setupAgents(mockAgents);
    GameBridge.setTopic('The Future of AI');
    GameBridge.setSubtopic('Economic Impact of AI Automation');
  }, 500);
  agentSpeakCounts = {};
  renderHudProgress();
  renderHudAgents(null);
  hudLog.innerHTML = '';

  const mockLines = [
    { agentId: 'a1', agentName: 'Alice', color: '#FF6B6B', emoji: '📊',
      text: 'From an economic perspective, AI automation presents a classic creative destruction cycle. Historical data from the first three industrial revolutions shows a consistent pattern: massive short-term job displacement followed by the emergence of entirely new industries and occupations within 10-15 years. However, the current wave differs in its velocity — McKinsey estimates that up to 375 million workers globally may need to switch occupational categories by 2030. The key question is not whether new jobs will emerge, but whether our retraining infrastructure can keep pace with the rate of displacement.' },
    { agentId: 'a2', agentName: 'Bob', color: '#6C63FF', emoji: '💻',
      text: 'I agree with Alice on the historical pattern, but the pace of AI adoption is fundamentally different from previous revolutions. We are not just automating physical labor — we are automating cognitive tasks: writing, analysis, coding, even creative work. GPT-class models can already outperform median-skill workers on many knowledge tasks. The displacement curve is exponential, not linear. Furthermore, unlike the industrial revolution, AI reduces the marginal cost of cognitive labor to near zero. Companies can now scale expertise without scaling headcount. The economic implications of this are profound and unprecedented.' },
    { agentId: 'a3', agentName: 'Carol', color: '#4ECDC4', emoji: '⚖️',
      text: 'The question is not just about economics — it is about human dignity and purpose. Even if new jobs emerge within a decade, the transition period causes real suffering to real families. We have an ethical obligation to consider the distributive justice implications. Who bears the cost of this transition? Historically, it has been the most vulnerable workers. A utilitarian calculus that says "net jobs increase in 15 years" ignores the concentrated harm done to displaced communities. We need ethical guardrails: universal basic income experiments, mandatory transition funds, and corporate responsibility frameworks.' },
    { agentId: 'a4', agentName: 'Dave', color: '#FFD93D', emoji: '🤔',
      text: 'Are we being too optimistic? Every technological revolution has its cheerleaders who promise that "this time, new jobs will appear." But what if this time is genuinely different? AI can learn, adapt, and improve continuously — unlike a steam engine or assembly line. The jobs that "emerge" may require skills that most displaced workers cannot realistically acquire. A 55-year-old truck driver is not going to become a machine learning engineer. I think we need to seriously consider the possibility that structural unemployment could become a permanent feature of AI-driven economies, not just a transitional phase.' },
  ];

  function simulateStream(lineIdx) {
    if (lineIdx >= mockLines.length) {
      setTimeout(() => {
        GameBridge.stopAll();
        const approved = true;
        GameBridge.showCriticFlag(approved);
        appendCompleteMessage({ id: 'crit1', agentId: 'critic', agentName: '🔍 Critic', type: 'critic',
          content: '✅ **Approved.** All four perspectives provide substantive, well-reasoned positions. Good tension between optimists and skeptics.' });
        addHudLog('Critic', '#4ECDC4', '✅ Approved — Good tension between optimists and skeptics.');
      }, 1500);
      return;
    }

    const line = mockLines[lineIdx];
    const thinkDuration = 2000 + Math.random() * 1000;

    const saEl = document.getElementById(`sa-${line.agentId}`);
    document.querySelectorAll('.sidebar-agent').forEach(el => el.classList.remove('speaking', 'thinking'));
    if (saEl) saEl.classList.add('thinking');
    showTyping(true, line.agentName, true);
    GameBridge.setThinking(line.agentId);
    renderHudAgents(null);

    setTimeout(() => {
      document.querySelectorAll('.sidebar-agent').forEach(el => el.classList.remove('speaking', 'thinking'));
      if (saEl) saEl.classList.add('speaking');
      showTyping(true, line.agentName, false);
      GameBridge.setSpeaking(line.agentId);
      agentSpeakCounts[line.agentId] = (agentSpeakCounts[line.agentId] || 0) + 1;
      renderHudAgents(line.agentId);

      const msgId = 'mock-' + lineIdx;
      const el = createMessageEl({ id: msgId, agentId: line.agentId, agentName: line.agentName, type: 'agent', color: line.color, emoji: line.emoji });
      messagesEl.appendChild(el);
      const bodyEl = el.querySelector('.message-body');

      const words = line.text.split(' ');
      let content = '';
      let wordIdx = 0;
      const chunkInterval = setInterval(() => {
        if (wordIdx >= words.length) {
          clearInterval(chunkInterval);
          bodyEl.innerHTML = renderMarkdown(content);
          scrollToBottom();
          GameBridge.hideBubble();
          addHudLog(line.agentName, line.color, content);
          setTimeout(() => simulateStream(lineIdx + 1), 800);
          return;
        }
        const chunkSize = 1 + Math.floor(Math.random() * 3);
        const chunk = words.slice(wordIdx, wordIdx + chunkSize).join(' ') + ' ';
        wordIdx += chunkSize;
        content += chunk;
        bodyEl.innerHTML = renderMarkdown(content);
        scrollToBottom();
        GameBridge.showBubble(line.agentId, content, line.color);
      }, 60 + Math.random() * 40);
    }, thinkDuration);
  }

  setTimeout(() => {
    appendCompleteMessage({ id: 'sys1', agentId: 'system', agentName: 'System', type: 'system',
      content: '📋 **Sub-topic 1/3: Economic Impact of AI Automation**\n\n*Goal: Analyze job displacement vs creation*' });
    setTimeout(() => simulateStream(0), 500);
  }, 1000);
}

// ═══ Init game on page load ══════════════════════════════════════════════
initGameOnLoad();
