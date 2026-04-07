import type {
  GameMode, AgentConfig, Session, Phase, TurnAction, ChatMessage,
  PhaseResult, EngineContext, Message,
} from '../../core/types.js';
import { getLanguageInstruction } from '../../core/types.js';
import { chatCompletion, streamChatCompletion } from '../../core/llm.js';
import { createPlan, introduceSubTopic, reviewSubTopic, synthesizeFinal, checkConflicts } from './planner.js';
import { critique } from './critic.js';
import { agentResearch, searchEnabled, type ResearchResult } from './research.js';

const MAX_CRITIQUE_ROUNDS = 3;
const MAX_DISCUSSION_ROUNDS = 2;

/** Helper to treat Phase.metadata as subtopic data */
function stMeta(phase: Phase): { title: string; goal: string; summary: string; critiqueRounds: number; discussionRounds: number; index: number; [k: string]: any } {
  return phase.metadata as any;
}

// ── Research helpers ─────────────────────────────────────────────────────

function formatResearch(research: ResearchResult | null): string {
  if (!research) return '';
  const citationList = research.citations.length
    ? '\nSources:\n' + research.citations.map((c, i) => `[${i + 1}] ${c}`).join('\n')
    : '';
  return `\n\n--- WEB RESEARCH (use this data to support your arguments) ---\n${research.content}${citationList}\n--- END RESEARCH ---`;
}

// ── Discussion Mode Implementation ───────────────────────────────────────

export class DiscussionMode implements GameMode {
  id = 'discussion';

  async setup(config: Record<string, any>) {
    const { topic, agentPreference } = config;
    const { agents, plan, phases } = await createPlan(topic, agentPreference, config);
    const privateState = new Map<string, any>();
    privateState.set('plan', plan);
    return { agents, phases, privateState };
  }

  getNextPhase(session: Session): Phase | null {
    const active = session.phases.find(p => p.status === 'active');
    if (active) return active;
    return session.phases.find(p => p.status === 'pending') || null;
  }

  isGameOver(session: Session): { over: boolean; result?: string } {
    const allResolved = session.phases.every(p => p.status === 'resolved');
    if (allResolved) return { over: true, result: 'Discussion completed.' };
    return { over: false };
  }

  getTurnOrder(session: Session, phase: Phase): TurnAction[] {
    if (phase.type === 'synthesis') {
      // Synthesis phase has no agent turns — handled entirely in resolvePhase
      return [];
    }

    // Subtopic phase: planner intro + agent reason/speak pairs
    const turns: TurnAction[] = [];

    // Mark in metadata that we need a planner intro
    turns.push({
      agentId: 'planner',
      type: 'announce',
      visibility: 'public',
      metadata: { needsGeneration: true, name: '📐 Host', msgType: 'planner', color: '#FFB347' },
    });

    // Subtopic system announcement
    const idx = phase.metadata.index;
    const total = session.phases.filter(p => p.type === 'subtopic').length;
    turns.push({
      agentId: 'system',
      type: 'announce',
      visibility: 'public',
      metadata: {
        content: `📋 **Sub-topic ${idx + 1}/${total}: ${phase.metadata.title}**\n\n*Goal: ${phase.metadata.goal}*`,
        name: 'System', msgType: 'system',
      },
    });

    // Each agent: reason then speak
    for (let a = 0; a < session.agents.length; a++) {
      const agent = session.agents[a];
      turns.push({
        agentId: agent.id,
        type: 'reason',
        visibility: 'private',
        metadata: { isFirst: a === 0, round: 0 },
      });
      turns.push({
        agentId: agent.id,
        type: 'speak',
        visibility: 'public',
        metadata: { round: 0 },
      });
    }

    return turns;
  }

  getVisibleMessages(session: Session, _agentId: string): Message[] {
    // In discussion mode, all non-private messages are visible
    return session.messages.filter(m => m.visibility !== 'private');
  }

  // ── Prompt generation ──────────────────────────────────────────────────

  getSystemPrompt(agent: AgentConfig, session: Session, phase: Phase, turn: TurnAction): string {
    // This is a fallback; we use getPromptMessages for full control
    return `You are ${agent.name}. Role: ${agent.role}. Perspective: ${agent.perspective}.`;
  }

  getActionPrompt(agent: AgentConfig, session: Session, phase: Phase, turn: TurnAction): string {
    return `Respond about: ${phase.metadata.title} — ${phase.metadata.goal}`;
  }

  getPromptMessages(agent: AgentConfig, session: Session, phase: Phase, turn: TurnAction): ChatMessage[] {
    const research: ResearchResult | null = session.privateState.get(`research-${agent.id}-${phase.id}`) || null;

    if (turn.type === 'reason') {
      return this._buildReasoningMessages(agent, session, phase, turn, research);
    }
    if (turn.type === 'speak') {
      return this._buildSpeakingMessages(agent, session, phase, turn, research);
    }
    return [
      { role: 'system', content: this.getSystemPrompt(agent, session, phase, turn) },
      { role: 'user', content: this.getActionPrompt(agent, session, phase, turn) },
    ];
  }

  // ── Pre-turn hook (research) ───────────────────────────────────────────

  async prepareTurn(session: Session, phase: Phase, turn: TurnAction, ctx: EngineContext): Promise<void> {
    // Generate planner introduction for announce turns
    if (turn.type === 'announce' && turn.metadata?.needsGeneration) {
      // Broadcast subtopic_start for backward compat
      const st = stMeta(phase);
      ctx.broadcast(session, 'subtopic_start', { index: st.index, subTopic: st });

      try {
        const intro = await introduceSubTopic(st, session);
        turn.metadata!.content = intro;
      } catch (err: any) {
        turn.metadata!.content = `Introduction: ${phase.metadata.goal}`;
      }
      return;
    }

    // Research before reasoning turns
    if (turn.type === 'reason' && searchEnabled()) {
      const agent = session.agents.find(a => a.id === turn.agentId);
      if (!agent) return;

      console.log(`[${agent.name}] researching...`);
      ctx.broadcast(session, 'researching', { agentId: agent.id, agentName: agent.name });

      const research = await agentResearch(agent, stMeta(phase), session.config.topic);
      if (research) {
        console.log(`[${agent.name}] research done (${research.citations.length} citations)`);
        ctx.broadcast(session, 'research', {
          agentId: agent.id, agentName: agent.name,
          query: research.query, content: research.content,
          citations: research.citations, color: agent.color,
        });
        session.privateState.set(`research-${agent.id}-${phase.id}`, research);
      }
    }
  }

  // ── Phase resolution (critique loop + planner review) ──────────────────

  async resolvePhase(session: Session, phase: Phase, ctx: EngineContext): Promise<PhaseResult> {
    if (phase.type === 'synthesis') {
      return this._resolveSynthesis(session, phase, ctx);
    }
    return this._resolveSubtopic(session, phase, ctx);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private async _resolveSubtopic(session: Session, phase: Phase, ctx: EngineContext): Promise<PhaseResult> {
    const stData = stMeta(phase);

    // Critique loop
    let approved = false;
    for (let round = 0; round < MAX_DISCUSSION_ROUNDS && !approved; round++) {
      if (session.status !== 'running') break;
      stData.discussionRounds = (stData.discussionRounds || 0) + 1;

      // If this isn't the first round, agents speak again
      if (round > 0) {
        for (const agent of session.agents) {
          if (session.status !== 'running') break;

          // Research
          if (searchEnabled()) {
            ctx.broadcast(session, 'researching', { agentId: agent.id, agentName: agent.name });
            const research = await agentResearch(agent, stData, session.config.topic);
            if (research) {
              ctx.broadcast(session, 'research', {
                agentId: agent.id, agentName: agent.name,
                query: research.query, content: research.content,
                citations: research.citations, color: agent.color,
              });
              session.privateState.set(`research-${agent.id}-${phase.id}`, research);
            }
          }

          // Reasoning
          ctx.broadcast(session, 'thinking', { agentId: agent.id, agentName: agent.name });
          const reasonMsgs = this._buildReasoningMessages(
            agent, session, phase,
            { agentId: agent.id, type: 'reason', visibility: 'private', metadata: { isFirst: false, round } },
            session.privateState.get(`research-${agent.id}-${phase.id}`) || null,
          );
          const reasoning = await chatCompletion(reasonMsgs, { temperature: 0.7 });
          if (!session.agentReasoning[agent.id]) session.agentReasoning[agent.id] = [];
          session.agentReasoning[agent.id].push(reasoning);
          ctx.broadcast(session, 'reasoning', {
            agentId: agent.id, agentName: agent.name,
            reasoning, color: agent.color, emoji: agent.emoji,
            phaseId: phase.id,
          });

          if (session.status !== 'running') break;

          // Speaking
          ctx.broadcast(session, 'speaking', { agentId: agent.id, agentName: agent.name });
          const speakMsgs = this._buildSpeakingMessages(
            agent, session, phase,
            { agentId: agent.id, type: 'speak', visibility: 'public', metadata: { round } },
            session.privateState.get(`research-${agent.id}-${phase.id}`) || null,
          );
          await ctx.streamMsg(
            session, 'agent', agent.name, streamChatCompletion(speakMsgs),
            phase.id, { color: agent.color, emoji: agent.emoji, agentId: agent.id },
          );
          await ctx.sleep(300);
        }
      }

      if (session.status !== 'running') break;

      // Critic reviews
      ctx.broadcast(session, 'speaking', { agentId: 'critic', agentName: '🔍 Critic' });

      try {
        const result = await critique(
          { title: stData.title, goal: stData.goal, critiqueRounds: stData.critiqueRounds || 0 },
          session.messages, session, phase.id,
        );
        stData.critiqueRounds = (stData.critiqueRounds || 0) + 1;

        if (result.approved) {
          ctx.addMsg(session, 'critic', '🔍 Critic',
            `✅ **Approved.** ${result.feedback}`, phase.id, { color: '#4ECDC4' });
          approved = true;
          // Broadcast critic flag
          ctx.broadcast(session, 'critic_flag', { approved: true });
        } else {
          ctx.addMsg(session, 'critic', '🔍 Critic',
            `⚠️ **Issues found.** ${result.feedback}`, phase.id, { color: '#FF6B6B' });
          ctx.broadcast(session, 'critic_flag', { approved: false });

          // Targeted agents respond to critique
          if (result.targets?.length && stData.critiqueRounds < MAX_CRITIQUE_ROUNDS) {
            for (const target of result.targets) {
              if (session.status !== 'running') break;

              const agent = session.agents.find(a =>
                a.id === target.agentId || a.name === target.agentId ||
                a.name.toLowerCase() === target.agentId?.toLowerCase()
              ) || session.agents[0];

              // Private reasoning about critique
              ctx.broadcast(session, 'thinking', { agentId: agent.id, agentName: agent.name });
              const critiqueReasoning = await this._getCritiqueReasoning(agent, session, phase, target.issue, target.request);
              if (!session.agentReasoning[agent.id]) session.agentReasoning[agent.id] = [];
              session.agentReasoning[agent.id].push(critiqueReasoning);
              ctx.broadcast(session, 'reasoning', {
                agentId: agent.id, agentName: agent.name,
                reasoning: critiqueReasoning, color: agent.color, emoji: agent.emoji,
                phaseId: phase.id,
              });

              if (session.status !== 'running') break;

              // Public response
              ctx.broadcast(session, 'speaking', { agentId: agent.id, agentName: agent.name });
              await ctx.streamMsg(
                session, 'agent', agent.name,
                this._getCritiqueResponseStream(agent, session, phase, target.issue, target.request, critiqueReasoning),
                phase.id, { color: agent.color, emoji: agent.emoji, agentId: agent.id },
              );
              await ctx.sleep(300);
            }
          } else {
            approved = true; // Max rounds reached
          }
        }
      } catch (err: any) {
        console.error('Critic error:', err);
        ctx.addMsg(session, 'critic', '🔍 Critic',
          `⚠️ Review skipped: ${err.message}`, phase.id, { color: '#FF6B6B' });
        approved = true;
      }
    }

    // Planner review
    if (session.status === 'running') {
      try {
        const review = await reviewSubTopic(stData, session.messages, phase.id);
        stData.summary = review.summary;

        if (review.complete) {
          ctx.addMsg(session, 'planner', '📐 Host',
            `✅ **Sub-topic completed: ${stData.title}**\n\n**Summary:** ${review.summary}`,
            phase.id, { color: '#FFB347' });
        } else {
          ctx.addMsg(session, 'planner', '📐 Host',
            `📝 **Sub-topic wrapped: ${stData.title}**\n\n**Summary:** ${review.summary}\n\n*Note: ${review.feedback}*`,
            phase.id, { color: '#FFB347' });
        }
      } catch (err: any) {
        stData.summary = `Discussion on "${stData.title}" completed.`;
        ctx.addMsg(session, 'planner', '📐 Host',
          `📝 **Sub-topic wrapped: ${stData.title}**`, phase.id, { color: '#FFB347' });
      }
    }

    // Broadcast subtopic_complete for backward compat
    const idx = phase.metadata.index;
    ctx.broadcast(session, 'subtopic_complete', { index: idx, subTopic: stData });

    // Update plan in privateState
    const plan = session.privateState.get('plan');
    if (plan && plan.subTopics[idx]) {
      plan.subTopics[idx].status = 'completed';
      plan.subTopics[idx].summary = stData.summary;
      plan.currentIndex = idx + 1;
    }

    return { summary: stData.summary || '', events: [] };
  }

  private async _resolveSynthesis(session: Session, phase: Phase, ctx: EngineContext): Promise<PhaseResult> {
    ctx.addMsg(session, 'system', 'System',
      '🏁 **All sub-topics completed. Generating final synthesis...**', phase.id);

    const content = await ctx.streamMsg(
      session, 'summary', '📝 Final Report',
      synthesizeFinal(session), phase.id, { color: '#FFD700' },
    );

    const plan = session.privateState.get('plan');
    if (plan) plan.finalSynthesis = content;

    // Conflict check
    if (session.status === 'running') {
      try {
        const conflictResult = await checkConflicts(content);
        if (conflictResult.hasConflicts && conflictResult.conflicts.length > 0) {
          if (plan) plan.conflicts = conflictResult.conflicts;
          const conflictText = conflictResult.conflicts.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n');
          ctx.addMsg(session, 'planner', '📐 Host',
            `⚠️ **Conflicts detected in synthesis:**\n${conflictText}\n\n*These should be addressed in future iterations.*`,
            phase.id, { color: '#FFB347' });
        }
      } catch (err: any) {
        console.error('Conflict check error:', err);
      }
    }

    return { summary: content, events: [] };
  }

  // ── Prompt builders ────────────────────────────────────────────────────

  private _buildReasoningMessages(
    agent: AgentConfig, session: Session, phase: Phase,
    turn: TurnAction, research: ResearchResult | null,
  ): ChatMessage[] {
    const stData = phase.metadata;
    const isFirst = turn.metadata?.isFirst;

    const publicStatements = session.messages
      .filter(m => m.phaseId === phase.id && (m.type === 'agent' || m.type === 'critic' || m.type === 'planner'))
      .slice(-12)
      .map(m => `[${m.agentName}]: ${m.content}`)
      .join('\n\n');

    const ownPrevReasoning = (session.agentReasoning[agent.id] || []).slice(-2).join('\n---\n');

    const previousSummaries = session.phases
      .filter(p => p.type === 'subtopic' && p.status === 'resolved')
      .map(p => `【${p.metadata.title}】${p.metadata.summary}`)
      .join('\n');

    // Build prompt for current position
    let prompt: string;
    if (isFirst) {
      prompt = `You're first to speak on this sub-topic. Take a clear position on: ${stData.goal}\nDon't try to cover everything — pick the angle that matters most from YOUR perspective and argue it.`;
    } else {
      const recentAgentMsgs = session.messages
        .filter(m => m.phaseId === phase.id && m.type === 'agent' && m.agentId !== agent.id)
        .slice(-3);

      if (recentAgentMsgs.length > 0) {
        const recentPoints = recentAgentMsgs
          .map(m => `${m.agentName}: "${m.content.slice(0, 120)}..."`)
          .join('\n');
        prompt = `Here's what others just said:\n${recentPoints}\n\nRespond to their points directly. Where do you agree? Where are they wrong?`;
      } else {
        prompt = `Share your perspective on: ${stData.goal}. Take a clear stance.`;
      }
    }

    const langInst = getLanguageInstruction(session.config);
    const system = `You are ${agent.name}, preparing your thoughts PRIVATELY before speaking publicly.
Role: ${agent.role}
Perspective: ${agent.perspective}

Current sub-topic: ${stData.title}
Goal: ${stData.goal}
${previousSummaries ? `\nPrevious sub-topic conclusions:\n${previousSummaries}\n` : ''}
This is your PRIVATE reasoning space. No one else will see this. Be brutally honest.
${research ? `\nYou have web research available — USE IT. Cite specific data, numbers, and sources.` : ''}
Analyze the discussion and plan your response:
1. What are the strongest points others made?
2. Where are the weak spots or things you disagree with?
3. What's YOUR unique angle that hasn't been covered?
4. What specific claim will you challenge?${research ? '\n5. What data from your research supports your position?' : ''}

Think critically. Acknowledge where you might be wrong.${langInst}`;

    const msgs: ChatMessage[] = [{ role: 'system', content: system }];
    if (ownPrevReasoning) {
      msgs.push({ role: 'user', content: `Your earlier private notes:\n${ownPrevReasoning}` });
    }
    if (publicStatements) {
      msgs.push({ role: 'user', content: `Public discussion so far:\n${publicStatements}` });
    }
    const researchBlock = formatResearch(research);
    msgs.push({ role: 'user', content: `Moderator's direction for you: ${prompt}${researchBlock}\n\nWrite your private analysis now.` });

    return msgs;
  }

  private _buildSpeakingMessages(
    agent: AgentConfig, session: Session, phase: Phase,
    turn: TurnAction, research: ResearchResult | null,
  ): ChatMessage[] {
    const stData = phase.metadata;

    const publicStatements = session.messages
      .filter(m => m.phaseId === phase.id && (m.type === 'agent' || m.type === 'critic' || m.type === 'planner'))
      .slice(-10)
      .map(m => `[${m.agentName}]: ${m.content}`)
      .join('\n\n');

    const previousSummaries = session.phases
      .filter(p => p.type === 'subtopic' && p.status === 'resolved')
      .map(p => `【${p.metadata.title}】${p.metadata.summary}`)
      .join('\n');

    const latestReasoning = (session.agentReasoning[agent.id] || []).slice(-1)[0] || '';

    const system = `You are ${agent.name}, speaking publicly in a roundtable discussion.
Role: ${agent.role}
Perspective: ${agent.perspective}
${agent.speakingStyle ? `\nYOUR SPEAKING STYLE: ${agent.speakingStyle}\nThis is your voice — own it. Do NOT sound like a generic AI assistant.\n` : ''}
Current sub-topic: ${stData.title}
Goal: ${stData.goal}
${previousSummaries ? `\nPrevious conclusions:\n${previousSummaries}\n` : ''}
You've already done your private analysis (shown below). Now write your PUBLIC statement.

RULES:
1. ENGAGE with specific points others made. Name them, quote them, respond to them.
2. CHALLENGE ideas you disagree with. Be honest, not polite.
3. Don't start with "感谢" or "谢谢". Just dive in.
4. Have a CLEAR POSITION. Defend it.
5. 2-3 paragraphs. Conversation, not lecture.
6. Do NOT reveal that you had a private reasoning step.
${research ? '7. CITE DATA from your research. Use [1], [2] etc.' : ''}
AVOID: "首先...其次...总之" every time. Vary your format.${getLanguageInstruction(session.config)}`;

    const msgs: ChatMessage[] = [{ role: 'system', content: system }];
    if (publicStatements) {
      msgs.push({ role: 'user', content: `Public discussion so far:\n${publicStatements}` });
    }
    msgs.push({
      role: 'user',
      content: `[Your private analysis — for your eyes only]\n${latestReasoning}`,
    });
    const researchBlock = formatResearch(research);
    msgs.push({ role: 'user', content: `Now write your public statement.${researchBlock}` });

    return msgs;
  }

  private async _getCritiqueReasoning(
    agent: AgentConfig, session: Session, phase: Phase,
    issue: string, request: string,
  ): Promise<string> {
    const publicStatements = session.messages
      .filter(m => m.phaseId === phase.id && (m.type === 'agent' || m.type === 'critic'))
      .slice(-8)
      .map(m => `[${m.agentName}]: ${m.content}`)
      .join('\n\n');

    const system = `You are ${agent.name}, privately analyzing criticism of your argument.
Role: ${agent.role}
Perspective: ${agent.perspective}

PRIVATE ANALYSIS — be honest with yourself:
1. Is the critic right? Where specifically?
2. Where is the critic wrong or missing context?
3. What evidence or reasoning can you use to respond?
4. Should you concede, partially agree, or push back?${getLanguageInstruction(session.config)}`;

    const msgs: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: `Discussion:\n${publicStatements}\n\n---\nCritic's issue: ${issue}\nCritic's request: ${request}\n\nAnalyze privately.` },
    ];

    return chatCompletion(msgs, { temperature: 0.7 });
  }

  private _getCritiqueResponseStream(
    agent: AgentConfig, session: Session, phase: Phase,
    issue: string, request: string, reasoning: string,
  ): AsyncGenerator<string> {
    const publicStatements = session.messages
      .filter(m => m.phaseId === phase.id && (m.type === 'agent' || m.type === 'critic'))
      .slice(-8)
      .map(m => `[${m.agentName}]: ${m.content}`)
      .join('\n\n');

    const system = `You are ${agent.name}.
Role: ${agent.role}
Perspective: ${agent.perspective}
${agent.speakingStyle ? `\nYOUR SPEAKING STYLE: ${agent.speakingStyle}\nStay in character.\n` : ''}
The critic challenged your argument. Respond publicly based on your private analysis.

RULES:
1. If you were wrong, own it. If you disagree, push back with evidence.
2. Be specific — cite data, examples, or reasoning.
3. Keep it concise — 1-2 focused paragraphs.
4. Don't reveal your private reasoning process.${getLanguageInstruction(session.config)}`;

    const msgs: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: `Discussion:\n${publicStatements}\n\n---\nCritic's issue: ${issue}\nCritic's request: ${request}` },
      { role: 'user', content: `[Your private analysis]\n${reasoning}\n\nNow write your public response.` },
    ];

    return streamChatCompletion(msgs);
  }
}
