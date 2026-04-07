/**
 * Werewolf Game Tools
 *
 * Each tool represents a player action with strict validation and execution.
 * Tools are used both for server-side validation and Vercel AI SDK tool calling.
 */

import type { GameState, PlayerState } from './state.js';
import { getPlayer, getAlivePlayers, getAliveWolves } from './state.js';
import type { RoleId } from './roles.js';

// ── Tool interfaces ──────────────────────────────────────────────────────

export interface ToolContext {
  state: GameState;
  player: PlayerState;
  targetId?: string;
  target?: PlayerState;
}

export interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, any>;
}

export interface ToolParam {
  type: 'string';
  description: string;
  required: boolean;
}

export interface GameTool {
  name: string;
  description: string;
  availableIn: string[];
  availableTo: RoleId[] | 'all';
  parameters: Record<string, ToolParam>;
  validate(ctx: ToolContext): string | null;    // null = valid, string = rejection reason
  execute(ctx: ToolContext): ToolResult;
}

// ── Helper: resolve wolf target from multi-wolf voting ───────────────────

export function resolveWolfTarget(state: GameState): string | undefined {
  const votes = state.nightActions.wolfVotes;
  const entries = Object.values(votes);
  if (entries.length === 0) return undefined;

  const tally: Record<string, number> = {};
  for (const target of entries) {
    tally[target] = (tally[target] || 0) + 1;
  }

  const maxVotes = Math.max(...Object.values(tally));
  const topTargets = Object.entries(tally)
    .filter(([_, v]) => v === maxVotes)
    .map(([id]) => id);

  // Tie → pick first (deterministic for replay)
  return topTargets[0];
}

// ══════════════════════════════════════════════════════════════════════════
//  NIGHT TOOLS
// ══════════════════════════════════════════════════════════════════════════

export const killTool: GameTool = {
  name: 'kill',
  description: 'Choose a player to kill tonight (wolf pack vote).',
  availableIn: ['night'],
  availableTo: ['werewolf'],
  parameters: {
    target: { type: 'string', description: 'ID of the player to kill', required: true },
  },
  validate(ctx) {
    if (!ctx.targetId) return 'Must specify a target.';
    const target = getPlayer(ctx.state, ctx.targetId);
    if (!target) return `Player ${ctx.targetId} not found.`;
    if (!target.alive) return `${target.name} is already dead.`;
    if (target.team === 'wolf') return 'Cannot kill a fellow wolf.';
    return null;
  },
  execute(ctx) {
    const target = getPlayer(ctx.state, ctx.targetId!)!;
    ctx.state.nightActions.wolfVotes[ctx.player.id] = ctx.targetId!;
    return {
      success: true,
      message: `You voted to kill ${target.name}.`,
      data: { target: ctx.targetId },
    };
  },
};

export const checkTool: GameTool = {
  name: 'check',
  description: "Check a player's identity (Seer ability).",
  availableIn: ['night'],
  availableTo: ['seer'],
  parameters: {
    target: { type: 'string', description: 'ID of the player to check', required: true },
  },
  validate(ctx) {
    if (!ctx.targetId) return 'Must specify a target.';
    const target = getPlayer(ctx.state, ctx.targetId);
    if (!target) return `Player ${ctx.targetId} not found.`;
    if (!target.alive) return `${target.name} is already dead.`;
    return null;
  },
  execute(ctx) {
    const target = getPlayer(ctx.state, ctx.targetId!)!;
    const isWolf = target.team === 'wolf';
    ctx.player.attributes.checkResults.push({ target: ctx.targetId!, isWolf });
    ctx.state.nightActions.seerTarget = ctx.targetId;
    return {
      success: true,
      message: `${target.name} is ${isWolf ? '🐺 a WEREWOLF!' : '✅ a good person.'}`,
      data: { target: ctx.targetId, isWolf },
    };
  },
};

export const protectTool: GameTool = {
  name: 'protect',
  description: 'Protect a player from werewolf attack tonight. Cannot protect the same player two nights in a row.',
  availableIn: ['night'],
  availableTo: ['guard'],
  parameters: {
    target: { type: 'string', description: 'ID of the player to protect', required: true },
  },
  validate(ctx) {
    if (!ctx.targetId) return 'Must specify a target.';
    const target = getPlayer(ctx.state, ctx.targetId);
    if (!target) return `Player ${ctx.targetId} not found.`;
    if (!target.alive) return `${target.name} is already dead.`;
    if (ctx.player.attributes.lastProtected === ctx.targetId) {
      return `Cannot protect ${target.name} again — you protected them last night.`;
    }
    return null;
  },
  execute(ctx) {
    const target = getPlayer(ctx.state, ctx.targetId!)!;
    ctx.state.nightActions.guardTarget = ctx.targetId;
    ctx.player.attributes.lastProtected = ctx.targetId;
    return {
      success: true,
      message: `You are protecting ${target.name} tonight.`,
      data: { target: ctx.targetId },
    };
  },
};

export const saveTool: GameTool = {
  name: 'save',
  description: 'Use your save potion to rescue the wolf victim. Can only be used once per game.',
  availableIn: ['night'],
  availableTo: ['witch'],
  parameters: {},
  validate(ctx) {
    if (ctx.player.attributes.saveUsed) return 'Save potion already used.';
    const wolfTarget = resolveWolfTarget(ctx.state);
    if (!wolfTarget) return 'No one was attacked tonight — nothing to save.';
    // Non-first-night: cannot self-save
    if (ctx.state.round > 1 && wolfTarget === ctx.player.id) {
      return 'Cannot save yourself after the first night.';
    }
    return null;
  },
  execute(ctx) {
    ctx.state.nightActions.witchSave = true;
    ctx.player.attributes.saveUsed = true;
    return { success: true, message: 'You used your save potion to rescue the victim.' };
  },
};

export const poisonTool: GameTool = {
  name: 'poison',
  description: 'Use your poison potion to kill a player. Can only be used once per game.',
  availableIn: ['night'],
  availableTo: ['witch'],
  parameters: {
    target: { type: 'string', description: 'ID of the player to poison', required: true },
  },
  validate(ctx) {
    if (ctx.player.attributes.poisonUsed) return 'Poison potion already used.';
    if (!ctx.targetId) return 'Must specify a target.';
    const target = getPlayer(ctx.state, ctx.targetId);
    if (!target) return `Player ${ctx.targetId} not found.`;
    if (!target.alive) return `${target.name} is already dead.`;
    return null;
  },
  execute(ctx) {
    ctx.state.nightActions.witchPoisonTarget = ctx.targetId;
    ctx.player.attributes.poisonUsed = true;
    const target = getPlayer(ctx.state, ctx.targetId!)!;
    return {
      success: true,
      message: `You poisoned ${target.name}.`,
      data: { target: ctx.targetId },
    };
  },
};

export const passTool: GameTool = {
  name: 'pass',
  description: 'Skip your action — do nothing this turn.',
  availableIn: ['night', 'day_vote'],
  availableTo: 'all',
  parameters: {},
  validate() { return null; },
  execute() { return { success: true, message: 'You chose to pass.' }; },
};

// ══════════════════════════════════════════════════════════════════════════
//  DAY TOOLS
// ══════════════════════════════════════════════════════════════════════════

export const voteTool: GameTool = {
  name: 'vote',
  description: 'Vote to eliminate a player.',
  availableIn: ['day_vote'],
  availableTo: 'all',
  parameters: {
    target: { type: 'string', description: 'ID of the player to vote for', required: true },
  },
  validate(ctx) {
    if (!ctx.targetId) return 'Must specify a target.';
    const target = getPlayer(ctx.state, ctx.targetId);
    if (!target) return `Player ${ctx.targetId} not found.`;
    if (!target.alive) return `${target.name} is already dead.`;
    if (ctx.targetId === ctx.player.id) return 'Cannot vote for yourself.';
    return null;
  },
  execute(ctx) {
    const target = getPlayer(ctx.state, ctx.targetId!)!;
    ctx.state.voteActions[ctx.player.id] = ctx.targetId!;
    return {
      success: true,
      message: `You voted to eliminate ${target.name}.`,
      data: { target: ctx.targetId },
    };
  },
};

export const shootTool: GameTool = {
  name: 'shoot',
  description: "Hunter's dying ability — shoot one player to take with you.",
  availableIn: ['day_last_words', 'night'],
  availableTo: ['hunter'],
  parameters: {
    target: { type: 'string', description: 'ID of the player to shoot', required: true },
  },
  validate(ctx) {
    if (!ctx.player.attributes.canShoot) return 'You cannot shoot (ability disabled by poison).';
    if (!ctx.targetId) return 'Must specify a target.';
    const target = getPlayer(ctx.state, ctx.targetId);
    if (!target) return `Player ${ctx.targetId} not found.`;
    if (!target.alive) return `${target.name} is already dead.`;
    return null;
  },
  execute(ctx) {
    const target = getPlayer(ctx.state, ctx.targetId!)!;
    return {
      success: true,
      message: `You shot ${target.name}!`,
      data: { target: ctx.targetId },
    };
  },
};

// ── Tool registry helpers ────────────────────────────────────────────────

const ALL_TOOLS: GameTool[] = [
  killTool, checkTool, protectTool, saveTool, poisonTool, passTool,
  voteTool, shootTool,
];

/** Get tools available to a role in a given phase */
export function getToolsForPhase(role: RoleId, phase: string): GameTool[] {
  return ALL_TOOLS.filter(t => {
    if (!t.availableIn.includes(phase)) return false;
    if (t.availableTo === 'all') return true;
    return (t.availableTo as RoleId[]).includes(role);
  });
}

/** Get night-phase tools for a specific role */
export function getNightToolsForRole(role: RoleId): GameTool[] {
  return getToolsForPhase(role, 'night');
}
