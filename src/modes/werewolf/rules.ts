/**
 * Werewolf Rules — Session-based helpers
 *
 * These functions operate on Session for backward compatibility with strategies.ts.
 * For GameState-based operations, see state.ts and hooks.ts.
 */

import type { Session } from '../../core/types.js';
import { ROLES, type RoleId, type Team } from './roles.js';
import { parseJSONResponse } from '../../core/llm.js';

// ── State helpers (Session-based — used by strategies.ts) ────────────────

export function getAgentRole(session: Session, agentId: string): RoleId {
  return session.privateState.get(`role-${agentId}`) || 'villager';
}

export function getAgentTeam(session: Session, agentId: string): Team {
  return ROLES[getAgentRole(session, agentId)].team;
}

export function isAlive(session: Session, agentId: string): boolean {
  return !session.eliminatedAgents.includes(agentId);
}

export function getAliveAgents(session: Session): string[] {
  return session.agents.filter(a => isAlive(session, a.id)).map(a => a.id);
}

export function getWolves(session: Session): string[] {
  return session.agents
    .filter(a => getAgentRole(session, a.id) === 'werewolf' && isAlive(session, a.id))
    .map(a => a.id);
}

export function getAliveByRole(session: Session, role: RoleId): string[] {
  return session.agents
    .filter(a => getAgentRole(session, a.id) === role && isAlive(session, a.id))
    .map(a => a.id);
}

export function agentName(session: Session, agentId: string): string {
  return session.agents.find(a => a.id === agentId)?.name || agentId;
}

// ── JSON parsing (kept for fallback compatibility) ───────────────────────

export function parseNightAction(raw: string): Record<string, any> {
  try {
    return parseJSONResponse(raw);
  } catch {
    const actionMatch = raw.match(/"action"\s*:\s*"(\w+)"/);
    const targetMatch = raw.match(/"target"\s*:\s*"([^"]+)"/);
    return {
      action: actionMatch?.[1] || 'pass',
      target: targetMatch?.[1] || null,
    };
  }
}

// ── Night action resolution (legacy — now in hooks.ts resolveNightActions) ──

export interface NightActions {
  guardTarget: string | null;
  wolfTarget: string | null;
  witchSave: boolean;
  witchPoisonTarget: string | null;
  seerTarget: string | null;
}

export function resolveNight(session: Session, actions: NightActions): {
  killed: string[];
  saved: string[];
  protected: string | null;
  seerResult: { target: string; isWolf: boolean } | null;
  events: string[];
} {
  const events: string[] = [];
  const killed: string[] = [];
  const saved: string[] = [];
  const protectedAgent = actions.guardTarget;

  if (protectedAgent) {
    events.push(`🛡️ Guard protected ${agentName(session, protectedAgent)}.`);
  }

  if (actions.wolfTarget) {
    const wolfTargetName = agentName(session, actions.wolfTarget);
    if (actions.wolfTarget === protectedAgent) {
      events.push(`🐺 Wolves targeted ${wolfTargetName}, but they were protected!`);
      saved.push(actions.wolfTarget);
    } else if (actions.witchSave) {
      events.push(`🐺 Wolves targeted ${wolfTargetName}, but the witch saved them!`);
      saved.push(actions.wolfTarget);
    } else {
      events.push(`🐺 Wolves killed ${wolfTargetName}.`);
      killed.push(actions.wolfTarget);
    }
  }

  if (actions.witchPoisonTarget) {
    const poisonName = agentName(session, actions.witchPoisonTarget);
    if (actions.witchPoisonTarget === protectedAgent) {
      events.push(`🧪 Witch poisoned ${poisonName}, but they were protected!`);
    } else {
      events.push(`🧪 Witch poisoned ${poisonName}.`);
      if (!killed.includes(actions.witchPoisonTarget)) {
        killed.push(actions.witchPoisonTarget);
      }
    }
  }

  let seerResult: { target: string; isWolf: boolean } | null = null;
  if (actions.seerTarget) {
    const seerIsWolf = getAgentRole(session, actions.seerTarget) === 'werewolf';
    seerResult = { target: actions.seerTarget, isWolf: seerIsWolf };
    events.push(`🔮 Seer checked ${agentName(session, actions.seerTarget)}: ${seerIsWolf ? '🐺 WOLF' : '✅ Good'}.`);
  }

  return { killed, saved, protected: protectedAgent, seerResult, events };
}

// ── Vote resolution (legacy — now in hooks.ts resolveVoteActions) ────────

export function tallyVotes(
  votes: Record<string, string>,
  session: Session,
): { eliminated: string | null; tally: Record<string, number>; tied: boolean } {
  const tally: Record<string, number> = {};

  for (const [voterId, targetId] of Object.entries(votes)) {
    if (!isAlive(session, voterId)) continue;
    if (session.privateState.get(`no-vote-${voterId}`)) continue;
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  const maxVotes = Math.max(...Object.values(tally), 0);
  if (maxVotes === 0) return { eliminated: null, tally, tied: false };

  const topCandidates = Object.entries(tally).filter(([_, v]) => v === maxVotes).map(([id]) => id);

  if (topCandidates.length === 1) {
    return { eliminated: topCandidates[0], tally, tied: false };
  }

  return { eliminated: null, tally, tied: true };
}

// ── Win condition (legacy — now in hooks.ts checkWinConditionHook) ───────

export function checkWinCondition(session: Session): { over: boolean; result?: string; winner?: Team } {
  const aliveWolves = getWolves(session).length;
  const aliveVillagers = getAliveAgents(session).length - aliveWolves;

  if (aliveWolves === 0) {
    return { over: true, result: '🎉 All werewolves eliminated! Village wins!', winner: 'village' };
  }

  if (aliveWolves >= aliveVillagers) {
    return { over: true, result: '🐺 Werewolves outnumber villagers! Wolves win!', winner: 'wolf' };
  }

  return { over: false };
}

// ── Hunter death trigger (legacy — now handled by triggerHunterShootHook) ──

export function isHunterDying(session: Session, killedIds: string[]): string | null {
  for (const id of killedIds) {
    if (getAgentRole(session, id) === 'hunter' && isAlive(session, id)) {
      return id;
    }
  }
  return null;
}
