/**
 * Werewolf Hook System
 *
 * Hooks react to game events (death, phase transitions, tool execution).
 * They are synchronous and chain-able — one hook's result can trigger further actions.
 */

import type { GameState, WerewolfGameEvent, PlayerState } from './state.js';
import {
  getPlayer, getAlivePlayers, getAliveWolves, getAliveVillagers,
  getPlayerName, setPlayerDead,
} from './state.js';
import { resolveWolfTarget } from './tools.js';
import type { EngineContext, Session, Phase } from '../../core/types.js';

// ── Hook types ───────────────────────────────────────────────────────────

export type HookType = 'onDeath' | 'onPhaseStart' | 'onPhaseEnd' | 'onToolExecuted';

export interface HookContext {
  state: GameState;
  event: WerewolfGameEvent;
  engineCtx: EngineContext;
  session: Session;
  phase: Phase;
}

export interface HookResult {
  triggerActions?: Array<{ tool: string; actor: string; target?: string }>;
  gameOver?: boolean;
}

export interface Hook {
  type: HookType;
  name: string;
  priority: number;     // lower = executes first
  handler: (ctx: HookContext) => HookResult;
}

// ══════════════════════════════════════════════════════════════════════════
//  BUILT-IN HOOKS
// ══════════════════════════════════════════════════════════════════════════

// ── onDeath → triggerLastWords (priority: 30) ────────────────────────────

const triggerLastWordsHook: Hook = {
  type: 'onDeath',
  name: 'triggerLastWords',
  priority: 30,
  handler(ctx) {
    const deadPlayer = ctx.event.target ? getPlayer(ctx.state, ctx.event.target) : undefined;
    if (!deadPlayer) return {};
    if (deadPlayer.attributes.hadLastWords) return {};

    const cause = deadPlayer.attributes.deathCause;
    const round = ctx.state.round;
    let hasLastWords = false;

    if (cause === 'vote') {
      // Vote elimination → always has last words
      hasLastWords = true;
    } else if (cause === 'wolf' || cause === 'poison') {
      // Night death → only first night has last words
      hasLastWords = round === 1;
    }
    // cause === 'hunter' → no last words

    if (hasLastWords) {
      return {
        triggerActions: [{ tool: 'last_words', actor: deadPlayer.id }],
      };
    }

    return {};
  },
};

// ── onDeath → triggerHunterShoot (priority: 50) ──────────────────────────

const triggerHunterShootHook: Hook = {
  type: 'onDeath',
  name: 'triggerHunterShoot',
  priority: 50,
  handler(ctx) {
    const deadPlayer = ctx.event.target ? getPlayer(ctx.state, ctx.event.target) : undefined;
    if (!deadPlayer) return {};
    if (deadPlayer.role !== 'hunter') return {};
    if (!deadPlayer.attributes.canShoot) return {};

    return {
      triggerActions: [{ tool: 'shoot', actor: deadPlayer.id }],
    };
  },
};

// ── onDeath → checkWinCondition (priority: 100) ─────────────────────────

const checkWinConditionHook: Hook = {
  type: 'onDeath',
  name: 'checkWinCondition',
  priority: 100,
  handler(ctx) {
    const wolves = getAliveWolves(ctx.state);
    const villagers = getAliveVillagers(ctx.state);

    if (wolves.length === 0) {
      ctx.state.winner = 'village';
      ctx.state.phase = 'game_over';
      return { gameOver: true };
    }

    if (wolves.length >= villagers.length) {
      ctx.state.winner = 'wolf';
      ctx.state.phase = 'game_over';
      return { gameOver: true };
    }

    return {};
  },
};

// ── All built-in hooks ───────────────────────────────────────────────────

export const builtinHooks: Hook[] = [
  triggerLastWordsHook,
  triggerHunterShootHook,
  checkWinConditionHook,
];

// ══════════════════════════════════════════════════════════════════════════
//  HOOK EXECUTION
// ══════════════════════════════════════════════════════════════════════════

/**
 * Run all hooks of a given type, sorted by priority (lower = first).
 * Returns combined results from all hooks.
 */
export function runHooks(
  hookType: HookType,
  ctx: HookContext,
  hooks: Hook[] = builtinHooks,
): HookResult {
  const relevant = hooks
    .filter(h => h.type === hookType)
    .sort((a, b) => a.priority - b.priority);

  const allActions: Array<{ tool: string; actor: string; target?: string }> = [];

  for (const hook of relevant) {
    const result = hook.handler(ctx);
    if (result.triggerActions) allActions.push(...result.triggerActions);
    if (result.gameOver) {
      return { gameOver: true, triggerActions: allActions };
    }
  }

  return {
    triggerActions: allActions.length > 0 ? allActions : undefined,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  PHASE RESOLUTION LOGIC
// ══════════════════════════════════════════════════════════════════════════

/**
 * Resolve night actions: guard vs wolf vs witch interactions.
 * Returns lists of killed/saved players + descriptive events.
 */
export function resolveNightActions(state: GameState): {
  killed: Array<{ id: string; cause: 'wolf' | 'poison' }>;
  saved: string[];
  seerResult: { target: string; isWolf: boolean } | null;
  events: string[];
} {
  const events: string[] = [];
  const killed: Array<{ id: string; cause: 'wolf' | 'poison' }> = [];
  const saved: string[] = [];

  // Resolve wolf target from multi-wolf votes
  const wolfTarget = resolveWolfTarget(state);
  state.nightActions.wolfTarget = wolfTarget;

  // Guard protection
  const guardTarget = state.nightActions.guardTarget;
  if (guardTarget) {
    events.push(`🛡️ Guard protected ${getPlayerName(state, guardTarget)}.`);
  }

  // Wolf kill
  if (wolfTarget) {
    const victimName = getPlayerName(state, wolfTarget);
    if (wolfTarget === guardTarget) {
      events.push(`🐺 Wolves targeted ${victimName}, but they were protected!`);
      saved.push(wolfTarget);
    } else if (state.nightActions.witchSave) {
      events.push(`🐺 Wolves targeted ${victimName}, but the witch saved them!`);
      saved.push(wolfTarget);
    } else {
      events.push(`🐺 Wolves killed ${victimName}.`);
      killed.push({ id: wolfTarget, cause: 'wolf' });
    }
  }

  // Witch poison
  if (state.nightActions.witchPoisonTarget) {
    const poisonTarget = state.nightActions.witchPoisonTarget;
    const poisonName = getPlayerName(state, poisonTarget);
    if (poisonTarget === guardTarget) {
      events.push(`🧪 Witch poisoned ${poisonName}, but they were protected!`);
    } else {
      events.push(`🧪 Witch poisoned ${poisonName}.`);
      if (!killed.some(k => k.id === poisonTarget)) {
        killed.push({ id: poisonTarget, cause: 'poison' });
      }
    }
  }

  // Seer check (already recorded in checkResults by the tool; just log event)
  let seerResult: { target: string; isWolf: boolean } | null = null;
  if (state.nightActions.seerTarget) {
    const seerTarget = state.nightActions.seerTarget;
    const target = getPlayer(state, seerTarget);
    if (target) {
      const isWolf = target.team === 'wolf';
      seerResult = { target: seerTarget, isWolf };
      events.push(`🔮 Seer checked ${target.name}: ${isWolf ? '🐺 WOLF' : '✅ Good'}.`);
    }
  }

  return { killed, saved, seerResult, events };
}

/**
 * Resolve vote actions: tally votes, determine elimination.
 */
export function resolveVoteActions(state: GameState): {
  eliminated: string | null;
  tally: Record<string, number>;
  tied: boolean;
} {
  const tally: Record<string, number> = {};

  for (const [voterId, targetId] of Object.entries(state.voteActions)) {
    const voter = getPlayer(state, voterId);
    if (!voter || !voter.alive) continue;
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  const maxVotes = Math.max(...Object.values(tally), 0);
  if (maxVotes === 0) return { eliminated: null, tally, tied: false };

  const topCandidates = Object.entries(tally)
    .filter(([_, v]) => v === maxVotes)
    .map(([id]) => id);

  if (topCandidates.length === 1) {
    return { eliminated: topCandidates[0], tally, tied: false };
  }

  // Tie → no one eliminated
  return { eliminated: null, tally, tied: true };
}
