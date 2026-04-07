/**
 * Werewolf Game State Model
 *
 * Centralized state management for the werewolf game.
 * All game data lives here instead of scattered privateState keys.
 */

import type { RoleId, Team } from './roles.js';
import { ROLES } from './roles.js';
import type { Session } from '../../core/types.js';

// ── Player State ─────────────────────────────────────────────────────────

export interface PlayerState {
  id: string;
  name: string;
  alive: boolean;
  role: RoleId;
  team: Team;
  attributes: {
    // Guard
    lastProtected?: string;          // who was protected last night
    isProtectedTonight: boolean;
    // Witch
    saveUsed: boolean;
    poisonUsed: boolean;
    // Seer
    checkResults: Array<{ target: string; isWolf: boolean }>;
    // Hunter
    canShoot: boolean;               // false if poisoned by witch
    // Common
    deathRound?: number;
    deathCause?: 'wolf' | 'vote' | 'poison' | 'hunter';
    hadLastWords: boolean;
    votedOutOf?: number;             // which round was voted out
  };
}

// ── Night Actions ────────────────────────────────────────────────────────

export interface NightActions {
  wolfVotes: Record<string, string>; // wolfId → targetId (multi-wolf voting)
  wolfTarget?: string;               // resolved after tallying
  guardTarget?: string;
  seerTarget?: string;
  witchSave: boolean;
  witchPoisonTarget?: string;
}

// ── Game Events (werewolf-specific, not core GameEvent) ──────────────────

export interface WerewolfGameEvent {
  round: number;
  phase: string;
  type: string;     // 'kill' | 'check' | 'protect' | 'save' | 'poison' | 'shoot' | 'vote' | 'elimination' | 'last_words' | 'phase_change'
  actor?: string;
  target?: string;
  data: Record<string, any>;
  message: string;
}

// ── Game State ───────────────────────────────────────────────────────────

export type GamePhase =
  | 'setup' | 'night'
  | 'day_announce' | 'day_last_words' | 'day_discussion' | 'day_vote' | 'day_elimination'
  | 'game_over';

export interface GameState {
  players: PlayerState[];
  phase: GamePhase;
  round: number;
  nightActions: NightActions;
  voteActions: Record<string, string>;    // voterId → targetId
  history: WerewolfGameEvent[];
  winner?: 'wolf' | 'village';
  pendingLastWords: string[];              // playerIds awaiting last words
}

// ── Factory functions ────────────────────────────────────────────────────

export function createNightActions(): NightActions {
  return {
    wolfVotes: {},
    wolfTarget: undefined,
    guardTarget: undefined,
    seerTarget: undefined,
    witchSave: false,
    witchPoisonTarget: undefined,
  };
}

export function createInitialGameState(
  agents: Array<{ id: string; name: string }>,
  roleAssignments: Record<string, RoleId>,
): GameState {
  const players: PlayerState[] = agents.map(a => {
    const role = roleAssignments[a.id] || 'villager';
    return {
      id: a.id,
      name: a.name,
      alive: true,
      role,
      team: ROLES[role].team,
      attributes: {
        isProtectedTonight: false,
        saveUsed: false,
        poisonUsed: false,
        checkResults: [],
        canShoot: role === 'hunter',
        hadLastWords: false,
      },
    };
  });

  return {
    players,
    phase: 'setup',
    round: 0,
    nightActions: createNightActions(),
    voteActions: {},
    history: [],
    pendingLastWords: [],
  };
}

// ── Query helpers ────────────────────────────────────────────────────────

export function getPlayer(state: GameState, id: string): PlayerState | undefined {
  return state.players.find(p => p.id === id);
}

export function getAlivePlayers(state: GameState): PlayerState[] {
  return state.players.filter(p => p.alive);
}

export function getAliveWolves(state: GameState): PlayerState[] {
  return state.players.filter(p => p.alive && p.team === 'wolf');
}

export function getAliveVillagers(state: GameState): PlayerState[] {
  return state.players.filter(p => p.alive && p.team === 'village');
}

export function getAliveByRole(state: GameState, role: RoleId): PlayerState[] {
  return state.players.filter(p => p.alive && p.role === role);
}

export function getPlayerName(state: GameState, id: string): string {
  return state.players.find(p => p.id === id)?.name || id;
}

// ── Mutation helpers ─────────────────────────────────────────────────────

export function setPlayerDead(
  state: GameState,
  id: string,
  cause: 'wolf' | 'vote' | 'poison' | 'hunter',
  round: number,
): void {
  const player = getPlayer(state, id);
  if (!player || !player.alive) return;

  player.alive = false;
  player.attributes.deathRound = round;
  player.attributes.deathCause = cause;

  // Hunter poisoned by witch can't shoot
  if (cause === 'poison' && player.role === 'hunter') {
    player.attributes.canShoot = false;
  }

  if (cause === 'vote') {
    player.attributes.votedOutOf = round;
  }
}

// ── Session integration ──────────────────────────────────────────────────

const GAME_STATE_KEY = 'gameState';

export function getGameState(session: Session): GameState {
  return session.privateState.get(GAME_STATE_KEY) as GameState;
}

export function saveGameState(session: Session, state: GameState): void {
  session.privateState.set(GAME_STATE_KEY, state);
}

/**
 * Sync GameState → session.privateState for backward compat.
 * strategies.ts reads these keys directly, so we must keep them in sync.
 */
export function syncToSession(state: GameState, session: Session): void {
  // Role assignments
  for (const p of state.players) {
    session.privateState.set(`role-${p.id}`, p.role);
  }

  // Witch potions
  const witch = state.players.find(p => p.role === 'witch');
  if (witch) {
    session.privateState.set('witch-save-used', witch.attributes.saveUsed);
    session.privateState.set('witch-poison-used', witch.attributes.poisonUsed);
  }

  // Guard last protected
  const guard = state.players.find(p => p.role === 'guard');
  session.privateState.set('guard-last-protected', guard?.attributes.lastProtected ?? null);

  // Round
  session.privateState.set('round', state.round);

  // Seer checks
  const seer = state.players.find(p => p.role === 'seer');
  if (seer) {
    session.privateState.set('seer-checks', [...seer.attributes.checkResults]);
  }

  // Eliminated agents
  session.eliminatedAgents = state.players.filter(p => !p.alive).map(p => p.id);
}
