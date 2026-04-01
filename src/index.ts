import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Response as ExpressResponse } from 'express';
import type { Session, Message, MessageRole, SubTopic } from './types.js';
import { createPlan, introduceSubTopic, reviewSubTopic, synthesizeFinal, checkConflicts } from './planner.js';
import { critique } from './critic.js';
import { getAgentReasoning, getAgentResponse, getAgentCritiqueReasoning, getAgentCritiqueResponse } from './agents.js';
import { agentResearch, searchEnabled } from './research.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Store ────────────────────────────────────────────────────────────────

const sessions = new Map<string, Session>();
const sid = () => randomUUID().slice(0, 8);
const toJSON = (s: Session) => { const { sseClients, ...rest } = s as any; return rest; };

// ── SSE ──────────────────────────────────────────────────────────────────

function sendSSE(res: ExpressResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(session: Session, event: string, data: unknown) {
  for (const client of session.sseClients) sendSSE(client, event, data);
}

// ── Routes ───────────────────────────────────────────────────────────────

app.post('/api/session', async (req, res) => {
  const { topic, agentPreference } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });

  try {
    const { agents, plan } = await createPlan(topic, agentPreference);
    const session: Session = {
      id: sid(), topic, agents, plan,
      messages: [], status: 'setup',
      createdAt: Date.now(), sseClients: new Set(),
      agentReasoning: {},
    };
    sessions.set(session.id, session);
    res.json(toJSON(session));
  } catch (err: any) {
    console.error('Plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/session/:id/agents', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  s.agents = req.body.agents;
  res.json({ agents: s.agents });
});

app.get('/api/session/:id/stream', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  s.sseClients.add(res);
  sendSSE(res, 'init', {
    topic: s.topic, agents: s.agents, plan: s.plan,
    messages: s.messages, status: s.status,
  });
  req.on('close', () => s.sseClients.delete(res));
});

app.post('/api/session/:id/start', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.status === 'running') return res.status(400).json({ error: 'already running' });
  s.status = 'running';
  broadcast(s, 'status', { status: 'running' });
  res.json({ status: 'running' });
  runDiscussion(s).catch(err => {
    console.error('Discussion error:', err);
    broadcast(s, 'error', { message: err.message });
  });
});

app.post('/api/session/:id/pause', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  s.status = 'paused';
  broadcast(s, 'status', { status: 'paused' });
  res.json({ status: 'paused' });
});

app.post('/api/session/:id/resume', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  if (s.status !== 'paused') return res.status(400).json({ error: 'not paused' });
  s.status = 'running';
  broadcast(s, 'status', { status: 'running' });
  res.json({ status: 'running' });
  runDiscussion(s).catch(err => {
    console.error('Discussion error:', err);
    broadcast(s, 'error', { message: err.message });
  });
});

app.post('/api/session/:id/inject', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const currentSt = s.plan?.subTopics[s.plan.currentIndex];
  const msg = addMsg(s, 'user', 'You', req.body.message, currentSt?.id);
  res.json(msg);
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(toJSON(s));
});

// ── Message helpers ──────────────────────────────────────────────────────

function addMsg(
  session: Session, type: MessageRole, name: string,
  content: string, subTopicId?: string,
  extra?: { color?: string; emoji?: string; agentId?: string },
): Message {
  const msg: Message = {
    id: sid(), agentId: extra?.agentId || type, agentName: name,
    content, timestamp: Date.now(), type,
    subTopicId, color: extra?.color, emoji: extra?.emoji,
  };
  session.messages.push(msg);
  broadcast(session, 'message', msg);
  return msg;
}

async function streamMsg(
  session: Session, type: MessageRole, name: string,
  gen: AsyncGenerator<string>, subTopicId?: string,
  extra?: { color?: string; emoji?: string; agentId?: string },
): Promise<string> {
  const msgId = sid();
  broadcast(session, 'message_start', {
    id: msgId, agentId: extra?.agentId || type, agentName: name,
    type, color: extra?.color, emoji: extra?.emoji, subTopicId,
  });

  let content = '';
  try {
    for await (const chunk of gen) {
      content += chunk;
      broadcast(session, 'message_chunk', { id: msgId, chunk });
      if (session.status === 'paused') break;
    }
  } catch (err: any) {
    content += `\n\n⚠️ Error: ${err.message}`;
  }

  broadcast(session, 'message_end', { id: msgId });
  session.messages.push({
    id: msgId, agentId: extra?.agentId || type, agentName: name,
    content, timestamp: Date.now(), type,
    subTopicId, color: extra?.color, emoji: extra?.emoji,
  });

  return content;
}

// ── Main discussion loop ─────────────────────────────────────────────────

async function runDiscussion(session: Session) {
  const plan = session.plan!;
  const MAX_CRITIQUE_ROUNDS = 3;
  const MAX_DISCUSSION_ROUNDS = 2;

  // Find where to resume (for pause/resume support)
  let startIdx = plan.currentIndex;
  while (startIdx < plan.subTopics.length && plan.subTopics[startIdx].status === 'completed') {
    startIdx++;
  }

  for (let i = startIdx; i < plan.subTopics.length; i++) {
    if (session.status !== 'running') return;
    plan.currentIndex = i;
    const st = plan.subTopics[i];

    // ── Announce sub-topic ──
    st.status = 'discussing';
    broadcast(session, 'subtopic_start', { index: i, subTopic: st });

    addMsg(session, 'system', 'System',
      `📋 **Sub-topic ${i + 1}/${plan.subTopics.length}: ${st.title}**\n\n*Goal: ${st.goal}*`,
      st.id);

    // Planner introduces
    try {
      const intro = await introduceSubTopic(st, session);
      addMsg(session, 'planner', '📐 Host', intro, st.id, { color: '#FFB347' });
    } catch (err: any) {
      addMsg(session, 'planner', '📐 Host', `Introduction: ${st.goal}`, st.id, { color: '#FFB347' });
    }

    // ── Discussion + Critique loop ──
    let approved = false;
    for (let round = 0; round < MAX_DISCUSSION_ROUNDS && !approved; round++) {
      st.discussionRounds++;
      if (session.status !== 'running') return;

      // Each agent: private reasoning → public statement
      for (let a = 0; a < session.agents.length; a++) {
        if (session.status !== 'running') return;
        const agent = session.agents[a];
        const isFirst = round === 0 && a === 0;

        let prompt: string;
        if (isFirst) {
          prompt = `You're first to speak on this sub-topic. Take a clear position on: ${st.goal}\nDon't try to cover everything — pick the angle that matters most from YOUR perspective and argue it.`;
        } else {
          const recentAgentMsgs = session.messages
            .filter(m => m.subTopicId === st.id && m.type === 'agent' && m.agentId !== agent.id)
            .slice(-3);

          if (recentAgentMsgs.length > 0) {
            const recentPoints = recentAgentMsgs
              .map(m => `${m.agentName}: "${m.content.slice(0, 120)}..."`)
              .join('\n');
            prompt = `Here's what others just said:\n${recentPoints}\n\nRespond to their points directly. Where do you agree? Where are they wrong or missing something? What would YOU do differently?`;
          } else {
            prompt = `Share your perspective on: ${st.goal}. Take a clear stance.`;
          }
        }

        // Step 0: Web research (if search is configured)
        let research = null;
        if (searchEnabled()) {
          console.log(`[${agent.name}] researching...`);
          broadcast(session, 'researching', { agentId: agent.id, agentName: agent.name });
          research = await agentResearch(agent, st, session.topic);
          if (research) {
            console.log(`[${agent.name}] research done (${research.citations.length} citations)`);
            broadcast(session, 'research', {
              agentId: agent.id, agentName: agent.name,
              query: research.query, content: research.content,
              citations: research.citations, color: agent.color,
            });
          }
        }

        // Step 1: Private reasoning (not visible to other agents)
        console.log(`[${agent.name}] reasoning start...`);
        broadcast(session, 'thinking', { agentId: agent.id, agentName: agent.name });
        const reasoning = await getAgentReasoning(agent, session, st, prompt, research);
        console.log(`[${agent.name}] reasoning done (${reasoning.length} chars)`);
        broadcast(session, 'reasoning', {
          agentId: agent.id, agentName: agent.name,
          reasoning, color: agent.color, emoji: agent.emoji,
          subTopicId: st.id,
        });
        if (!session.agentReasoning[agent.id]) session.agentReasoning[agent.id] = [];
        session.agentReasoning[agent.id].push(reasoning);

        if (session.status !== 'running') return;

        // Step 2: Public statement (streamed, informed by private reasoning)
        console.log(`[${agent.name}] speaking start...`);
        broadcast(session, 'speaking', { agentId: agent.id, agentName: agent.name });
        await streamMsg(session, 'agent', agent.name,
          getAgentResponse(agent, session, st, prompt, reasoning, research), st.id,
          { color: agent.color, emoji: agent.emoji, agentId: agent.id });
        await sleep(300);
      }

      // ── Critic reviews ──
      if (session.status !== 'running') return;
      st.status = 'under_review';
      broadcast(session, 'speaking', { agentId: 'critic', agentName: '🔍 Critic' });

      try {
        const result = await critique(st, session.messages, session);
        st.critiqueRounds++;

        if (result.approved) {
          addMsg(session, 'critic', '🔍 Critic',
            `✅ **Approved.** ${result.feedback}`, st.id, { color: '#4ECDC4' });
          approved = true;
        } else {
          addMsg(session, 'critic', '🔍 Critic',
            `⚠️ **Issues found.** ${result.feedback}`, st.id, { color: '#FF6B6B' });

          // Targeted agents respond to critique (with private reasoning first)
          if (result.targets?.length && st.critiqueRounds < MAX_CRITIQUE_ROUNDS) {
            for (const target of result.targets) {
              if (session.status !== 'running') return;
              // Find agent by id or name
              const agent = session.agents.find(a =>
                a.id === target.agentId || a.name === target.agentId ||
                a.name.toLowerCase() === target.agentId?.toLowerCase()
              ) || session.agents[0];

              // Private reasoning about the critique
              broadcast(session, 'thinking', { agentId: agent.id, agentName: agent.name });
              const critiqueReasoning = await getAgentCritiqueReasoning(
                agent, session, st, target.issue, target.request);
              if (!session.agentReasoning[agent.id]) session.agentReasoning[agent.id] = [];
              session.agentReasoning[agent.id].push(critiqueReasoning);
              broadcast(session, 'reasoning', {
                agentId: agent.id, agentName: agent.name,
                reasoning: critiqueReasoning, color: agent.color, emoji: agent.emoji,
                subTopicId: st.id,
              });

              if (session.status !== 'running') return;

              // Public response
              broadcast(session, 'speaking', { agentId: agent.id, agentName: agent.name });
              await streamMsg(session, 'agent', agent.name,
                getAgentCritiqueResponse(agent, session, st, target.issue, target.request, critiqueReasoning),
                st.id, { color: agent.color, emoji: agent.emoji, agentId: agent.id });
              await sleep(300);
            }
          } else {
            // Max critique rounds reached, move on
            approved = true;
          }
        }
      } catch (err: any) {
        console.error('Critic error:', err);
        addMsg(session, 'critic', '🔍 Critic',
          `⚠️ Review skipped: ${err.message}`, st.id, { color: '#FF6B6B' });
        approved = true;
      }

      st.status = 'discussing';
    }

    // ── Planner reviews completion ──
    if (session.status !== 'running') return;
    try {
      const review = await reviewSubTopic(st, session.messages, session);
      st.summary = review.summary;

      if (review.complete) {
        st.status = 'completed';
        addMsg(session, 'planner', '📐 Host',
          `✅ **Sub-topic completed: ${st.title}**\n\n**Summary:** ${review.summary}`,
          st.id, { color: '#FFB347' });
      } else {
        // Not fully complete but we move on (with note)
        st.status = 'completed';
        addMsg(session, 'planner', '📐 Host',
          `📝 **Sub-topic wrapped: ${st.title}**\n\n**Summary:** ${review.summary}\n\n*Note: ${review.feedback}*`,
          st.id, { color: '#FFB347' });
      }
    } catch (err: any) {
      st.status = 'completed';
      st.summary = `Discussion on "${st.title}" completed.`;
      addMsg(session, 'planner', '📐 Host',
        `📝 **Sub-topic wrapped: ${st.title}**`, st.id, { color: '#FFB347' });
    }

    broadcast(session, 'subtopic_complete', { index: i, subTopic: st });
    await sleep(500);
  }

  // ── Final synthesis ──
  if (session.status !== 'running') return;
  addMsg(session, 'system', 'System', '🏁 **All sub-topics completed. Generating final synthesis...**');

  const synthMsgId = sid();
  broadcast(session, 'message_start', {
    id: synthMsgId, agentId: 'summary', agentName: '📝 Final Report',
    type: 'summary', color: '#FFD700',
  });

  let synthContent = '';
  try {
    for await (const chunk of synthesizeFinal(session)) {
      synthContent += chunk;
      broadcast(session, 'message_chunk', { id: synthMsgId, chunk });
    }
  } catch (err: any) {
    synthContent += `\n\n⚠️ Synthesis error: ${err.message}`;
  }

  broadcast(session, 'message_end', { id: synthMsgId });
  session.messages.push({
    id: synthMsgId, agentId: 'summary', agentName: '📝 Final Report',
    content: synthContent, timestamp: Date.now(), type: 'summary',
  });
  plan.finalSynthesis = synthContent;
  console.log(`Synthesis generated: ${synthContent.length} chars`);

  // ── Conflict check ──
  if (session.status !== 'running') return;
  try {
    const conflictResult = await checkConflicts(synthContent, session);
    if (conflictResult.hasConflicts && conflictResult.conflicts.length > 0) {
      plan.conflicts = conflictResult.conflicts;
      const conflictText = conflictResult.conflicts.map((c, i) => `${i + 1}. ${c}`).join('\n');
      addMsg(session, 'planner', '📐 Host',
        `⚠️ **Conflicts detected in synthesis:**\n${conflictText}\n\n*These should be addressed in future iterations.*`,
        undefined, { color: '#FFB347' });
    }
  } catch (err: any) {
    console.error('Conflict check error:', err);
  }

  session.status = 'completed';
  broadcast(session, 'status', { status: 'completed' });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3210');
app.listen(PORT, () => console.log(`\n🎙️  Roundtable v2 running at http://localhost:${PORT}\n`));
