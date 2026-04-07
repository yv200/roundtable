import type { Session, Phase, TurnAction, GameMode, EngineContext, Message, MessageRole } from './types.js';
import { executeReasoning, executeSpeaking, executeStructured } from './agents.js';
import { randomUUID } from 'crypto';

// ── Helpers ──────────────────────────────────────────────────────────────

const sid = () => randomUUID().slice(0, 8);

function sendSSE(res: any, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Create engine context ────────────────────────────────────────────────

export function createEngineContext(): EngineContext {
  return {
    broadcast(session: Session, event: string, data: unknown) {
      for (const client of session.sseClients) sendSSE(client, event, data);
    },

    addMsg(
      session: Session, type: MessageRole, name: string, content: string,
      phaseId?: string,
      extra?: { color?: string; emoji?: string; agentId?: string },
    ): Message {
      const msg: Message = {
        id: sid(), agentId: extra?.agentId || type, agentName: name,
        content, timestamp: Date.now(), type,
        phaseId, subTopicId: phaseId,
        color: extra?.color, emoji: extra?.emoji,
      };
      session.messages.push(msg);
      for (const client of session.sseClients) sendSSE(client, 'message', msg);
      return msg;
    },

    async streamMsg(
      session: Session, type: MessageRole, name: string,
      gen: AsyncGenerator<string>, phaseId?: string,
      extra?: { color?: string; emoji?: string; agentId?: string },
    ): Promise<string> {
      const msgId = sid();
      const bcast = (ev: string, d: unknown) => {
        for (const client of session.sseClients) sendSSE(client, ev, d);
      };

      bcast('message_start', {
        id: msgId, agentId: extra?.agentId || type, agentName: name,
        type, color: extra?.color, emoji: extra?.emoji,
        phaseId, subTopicId: phaseId,
      });

      let content = '';
      try {
        for await (const chunk of gen) {
          content += chunk;
          bcast('message_chunk', { id: msgId, chunk });
          if (session.status === 'paused') break;
        }
      } catch (err: any) {
        content += `\n\n⚠️ Error: ${err.message}`;
      }

      bcast('message_end', { id: msgId });
      session.messages.push({
        id: msgId, agentId: extra?.agentId || type, agentName: name,
        content, timestamp: Date.now(), type,
        phaseId, subTopicId: phaseId,
        color: extra?.color, emoji: extra?.emoji,
      });

      return content;
    },

    sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); },
  };
}

// ── Execute a single turn ────────────────────────────────────────────────

async function executeTurn(
  session: Session, mode: GameMode, phase: Phase,
  turn: TurnAction, ctx: EngineContext,
): Promise<void> {
  const agent = session.agents.find(a => a.id === turn.agentId);

  switch (turn.type) {
    case 'announce': {
      const content = turn.metadata?.content || turn.prompt || '';
      const name = turn.metadata?.name || 'System';
      const msgType = (turn.metadata?.msgType as MessageRole) || 'system';
      ctx.addMsg(session, msgType, name, content, phase.id, {
        color: turn.metadata?.color,
        emoji: turn.metadata?.emoji,
        agentId: turn.metadata?.agentId || msgType,
      });
      break;
    }

    case 'reason': {
      if (!agent) break;
      console.log(`[${agent.name}] reasoning start...`);
      const reasoning = await executeReasoning(agent, session, mode, phase, turn, ctx);
      console.log(`[${agent.name}] reasoning done (${reasoning.length} chars)`);
      break;
    }

    case 'speak': {
      if (!agent) break;
      console.log(`[${agent.name}] speaking start...`);
      await executeSpeaking(agent, session, mode, phase, turn, ctx);
      await ctx.sleep(300);
      break;
    }

    case 'vote':
    case 'ability': {
      if (!agent) break;
      console.log(`[${agent.name}] ${turn.type} action...`);
      const result = await executeStructured(agent, session, mode, phase, turn, ctx);
      // Store result in phase metadata for resolvePhase to process
      if (!phase.metadata._turnResults) phase.metadata._turnResults = {};
      phase.metadata._turnResults[`${turn.type}-${agent.id}`] = result;
      break;
    }
  }
}

// ── Main session runner ──────────────────────────────────────────────────

export async function runSession(
  session: Session, mode: GameMode, ctx: EngineContext,
): Promise<void> {
  while (session.status === 'running') {
    const phase = mode.getNextPhase(session);
    if (!phase) break;

    // Mark phase as active (may already be active on resume)
    if (phase.status === 'pending') {
      phase.status = 'active';
      session.currentPhaseIndex = session.phases.indexOf(phase);
      ctx.broadcast(session, 'phase_start', { phase });
    }

    // Get and execute turns
    const turns = mode.getTurnOrder(session, phase);
    const startIdx = (phase.metadata._turnIndex as number) || 0;

    for (let i = startIdx; i < turns.length; i++) {
      if (session.status !== 'running') {
        phase.metadata._turnIndex = i;
        return;
      }

      // Optional pre-turn hook (e.g. research)
      if (mode.prepareTurn) {
        await mode.prepareTurn(session, phase, turns[i], ctx);
      }

      await executeTurn(session, mode, phase, turns[i], ctx);
      phase.metadata._turnIndex = i + 1;
    }

    if (session.status !== 'running') return;

    // Resolve phase
    const result = await mode.resolvePhase(session, phase, ctx);
    phase.status = 'resolved';
    delete phase.metadata._turnIndex;
    delete phase.metadata._turnResults;

    // Check game over
    const gameOver = mode.isGameOver(session);
    if (gameOver.over) {
      if (gameOver.result) {
        ctx.addMsg(session, 'system', 'System', `🏁 ${gameOver.result}`, phase.id);
      }
      session.status = 'completed';
      ctx.broadcast(session, 'status', { status: 'completed' });
      return;
    }

    await ctx.sleep(500);
  }

  // If loop exited normally (no more phases), complete
  if (session.status === 'running') {
    session.status = 'completed';
    ctx.broadcast(session, 'status', { status: 'completed' });
  }
}
