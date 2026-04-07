import type { AgentConfig, ChatMessage, Session, Phase, TurnAction, GameMode, EngineContext } from './types.js';
import { chatCompletion, streamChatCompletion } from './llm.js';

// ── Build prompt messages ────────────────────────────────────────────────

function buildMessages(agent: AgentConfig, session: Session, mode: GameMode, phase: Phase, turn: TurnAction): ChatMessage[] {
  if (mode.getPromptMessages) {
    return mode.getPromptMessages(agent, session, phase, turn);
  }
  return [
    { role: 'system', content: mode.getSystemPrompt(agent, session, phase, turn) },
    { role: 'user', content: mode.getActionPrompt(agent, session, phase, turn) },
  ];
}

// ── Execute a reasoning turn (private, non-streamed) ─────────────────────

export async function executeReasoning(
  agent: AgentConfig, session: Session, mode: GameMode,
  phase: Phase, turn: TurnAction, ctx: EngineContext,
): Promise<string> {
  ctx.broadcast(session, 'thinking', { agentId: agent.id, agentName: agent.name });

  const msgs = buildMessages(agent, session, mode, phase, turn);
  const reasoning = await chatCompletion(msgs, { temperature: 0.7 });

  if (!session.agentReasoning[agent.id]) session.agentReasoning[agent.id] = [];
  session.agentReasoning[agent.id].push(reasoning);

  ctx.broadcast(session, 'reasoning', {
    agentId: agent.id, agentName: agent.name,
    reasoning, color: agent.color, emoji: agent.emoji,
    phaseId: phase.id,
  });

  return reasoning;
}

// ── Execute a speaking turn (public, streamed) ───────────────────────────

export async function executeSpeaking(
  agent: AgentConfig, session: Session, mode: GameMode,
  phase: Phase, turn: TurnAction, ctx: EngineContext,
): Promise<string> {
  ctx.broadcast(session, 'speaking', { agentId: agent.id, agentName: agent.name });

  const msgs = buildMessages(agent, session, mode, phase, turn);

  return ctx.streamMsg(
    session, 'agent', agent.name,
    streamChatCompletion(msgs), phase.id,
    { color: agent.color, emoji: agent.emoji, agentId: agent.id },
  );
}

// ── Execute a vote/ability turn (structured JSON output) ─────────────────

export async function executeStructured(
  agent: AgentConfig, session: Session, mode: GameMode,
  phase: Phase, turn: TurnAction, ctx: EngineContext,
): Promise<string> {
  const msgs = buildMessages(agent, session, mode, phase, turn);
  return chatCompletion(msgs, { temperature: 0.3 });
}
