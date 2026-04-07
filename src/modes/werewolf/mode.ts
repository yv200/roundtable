import type {
  GameMode, AgentConfig, Session, Phase, TurnAction, ChatMessage,
  PhaseResult, EngineContext, Message,
  GameEvent as CoreGameEvent,
} from '../../core/types.js';
import { getLanguageInstruction } from '../../core/types.js';
import { chatCompletion, parseJSONResponse } from '../../core/llm.js';
import { ROLES, PRESETS, shuffle, type RoleId } from './roles.js';
import {
  getAgentRole, getAgentTeam, isAlive,
  getAliveAgents as getAliveAgentIds,
  getWolves as getWolfIds,
  getAliveByRole as getAliveByRoleIds,
  agentName,
} from './rules.js';
import { getStrategyPrompt } from './strategies.js';

// ── New architecture imports ──────────────────────────────────────────────

import type { GameState, PlayerState, WerewolfGameEvent } from './state.js';
import {
  createInitialGameState, createNightActions,
  getPlayer, getAlivePlayers, getAliveWolves, getAliveByRole,
  getPlayerName, setPlayerDead,
  getGameState, saveGameState, syncToSession,
} from './state.js';
import type { ToolContext, ToolResult, GameTool } from './tools.js';
import {
  getNightToolsForRole, resolveWolfTarget,
  killTool, checkTool, protectTool, saveTool, poisonTool, passTool,
  voteTool, shootTool,
} from './tools.js';
import type { HookContext } from './hooks.js';
import {
  builtinHooks, runHooks,
  resolveNightActions, resolveVoteActions,
} from './hooks.js';

// ── Vercel AI SDK tool calling ────────────────────────────────────────────

import { generateText, tool, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

// ── Constants ─────────────────────────────────────────────────────────────

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F8B500', '#FF8C94', '#91D8E4'];
const EMOJIS = ['🗡️', '🌸', '🎭', '🔥', '🌊', '🎪', '🍷', '⭐', '🎲', '🦊'];

/** Append language instruction */
function withLang(prompt: string, session: Session): string {
  return prompt + getLanguageInstruction(session.config);
}

// ── LLM model creation (duplicated from core/llm.ts since we can't modify it) ──

function getModel(): LanguageModel {
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.LLM_API_KEY || '';
  const modelId = process.env.LLM_MODEL || 'gpt-4o';

  if (/claude/i.test(modelId)) {
    const anthropic = createAnthropic({ baseURL: baseUrl, apiKey });
    return anthropic(modelId);
  } else {
    const openai = createOpenAI({ baseURL: baseUrl, apiKey });
    return openai(modelId);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  WEREWOLF MODE
// ══════════════════════════════════════════════════════════════════════════

export class WerewolfMode implements GameMode {
  id = 'werewolf';

  // ── Setup ──────────────────────────────────────────────────────────────

  async setup(config: Record<string, any>) {
    const preset = config.preset || 'standard';
    const theme = config.theme || 'medieval village';
    const presetConfig = PRESETS[preset];
    if (!presetConfig) throw new Error(`Unknown preset: ${preset}`);

    const playerCount = presetConfig.playerCount;
    const roles = [...presetConfig.roles] as RoleId[];

    // Generate personas via LLM
    const personas = await this._generatePersonas(theme, playerCount, config);

    // Shuffle roles and assign
    const shuffledRoles = shuffle(roles);
    const agents: AgentConfig[] = personas.map((p, i) => ({
      id: `agent-${i}`,
      name: p.name,
      gender: p.gender as 'male' | 'female',
      role: p.publicRole,
      perspective: p.personality,
      speakingStyle: p.speakingStyle,
      color: COLORS[i % COLORS.length],
      emoji: EMOJIS[i % EMOJIS.length],
    }));

    // Build role assignment map
    const roleAssignments: Record<string, RoleId> = {};
    shuffledRoles.forEach((role, i) => {
      roleAssignments[agents[i].id] = role;
    });

    // Create GameState
    const gameState = createInitialGameState(
      agents.map(a => ({ id: a.id, name: a.name })),
      roleAssignments,
    );

    // Set up privateState (backward compat + GameState)
    const privateState = new Map<string, any>();
    privateState.set('gameState', gameState);

    // Sync backward-compat keys for strategies.ts
    for (const [agentId, role] of Object.entries(roleAssignments)) {
      privateState.set(`role-${agentId}`, role);
    }
    privateState.set('witch-save-used', false);
    privateState.set('witch-poison-used', false);
    privateState.set('guard-last-protected', null);
    privateState.set('round', 0);
    privateState.set('seer-checks', []);
    privateState.set('night-deaths', []);

    const phases: Phase[] = [
      {
        id: 'setup',
        type: 'setup',
        label: '🎭 Role Assignment',
        status: 'pending',
        metadata: {},
      },
    ];

    // ── Debug: print game setup ──
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║     🐺 WEREWOLF GAME INITIALIZED 🐺      ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║ Preset: ${preset} | Theme: ${theme}`);
    console.log(`║ Players: ${playerCount} | Roles: ${roles.join(', ')}`);
    console.log('╠══════════════════════════════════════════╣');
    console.log('║ PLAYERS & ROLES:');
    for (const agent of agents) {
      const role = roleAssignments[agent.id];
      const roleInfo = ROLES[role];
      const tools = roleInfo.hasNightAction
        ? getNightToolsForRole(role).map(t => t.name).join(', ')
        : '(no night tools)';
      console.log(`║  ${agent.emoji} ${agent.name.padEnd(20)} | ${roleInfo.emoji} ${roleInfo.nameZh.padEnd(6)}(${role.padEnd(10)}) | team: ${roleInfo.team.padEnd(7)} | tools: ${tools}`);
    }
    console.log('╠══════════════════════════════════════════╣');
    console.log('║ ALL AVAILABLE TOOLS:');
    const allToolNames = new Set<string>();
    for (const role of Object.keys(ROLES) as RoleId[]) {
      for (const t of getNightToolsForRole(role)) allToolNames.add(`${t.name} (${role})`);
    }
    allToolNames.forEach(t => console.log(`║  🔧 ${t}`));
    console.log('║  🔧 vote (all alive, day phase)');
    console.log('╚══════════════════════════════════════════╝\n');

    return { agents, phases, privateState };
  }

  // ── Phase management ───────────────────────────────────────────────────

  getNextPhase(session: Session): Phase | null {
    const active = session.phases.find(p => p.status === 'active');
    if (active) return active;

    const pending = session.phases.find(p => p.status === 'pending');
    if (pending) return pending;

    const lastResolved = [...session.phases].reverse().find(p => p.status === 'resolved');
    if (!lastResolved) return null;

    const state = getGameState(session);
    let newPhase: Phase | null = null;

    if (lastResolved.type === 'setup') {
      const round = 1;
      if (state) { state.round = round; state.phase = 'night'; saveGameState(session, state); }
      session.privateState.set('round', round);
      newPhase = {
        id: `night-${round}`, type: 'night',
        label: `Night ${round} 🌙`, status: 'pending',
        metadata: { round },
      };
    } else if (lastResolved.type === 'night') {
      const round = lastResolved.metadata.round;
      if (state) { state.phase = 'day_announce'; saveGameState(session, state); }
      newPhase = {
        id: `day-${round}`, type: 'day',
        label: `Day ${round} ☀️`, status: 'pending',
        metadata: { round },
      };
    } else if (lastResolved.type === 'day') {
      const round = lastResolved.metadata.round + 1;
      if (state) {
        state.round = round;
        state.phase = 'night';
        state.nightActions = createNightActions();
        state.voteActions = {};
        saveGameState(session, state);
      }
      session.privateState.set('round', round);
      newPhase = {
        id: `night-${round}`, type: 'night',
        label: `Night ${round} 🌙`, status: 'pending',
        metadata: { round },
      };
    }

    if (newPhase) {
      session.phases.push(newPhase);
      return newPhase;
    }
    return null;
  }

  isGameOver(session: Session): { over: boolean; result?: string } {
    const state = getGameState(session);
    if (state?.phase === 'game_over' && state.winner) {
      const result = state.winner === 'wolf'
        ? '🐺 Werewolves outnumber villagers! Wolves win!'
        : '🎉 All werewolves eliminated! Village wins!';
      return { over: true, result };
    }
    // Fallback: check via rules (backward compat)
    const aliveWolves = getWolfIds(session).length;
    const aliveTotal = getAliveAgentIds(session).length;
    const aliveVillagers = aliveTotal - aliveWolves;
    if (aliveWolves === 0) return { over: true, result: '🎉 All werewolves eliminated! Village wins!' };
    if (aliveWolves >= aliveVillagers) return { over: true, result: '🐺 Werewolves outnumber villagers! Wolves win!' };
    return { over: false };
  }

  // ── Turn order ─────────────────────────────────────────────────────────

  getTurnOrder(session: Session, phase: Phase): TurnAction[] {
    switch (phase.type) {
      case 'setup': return this._setupTurns(session);
      case 'night': return this._nightTurns(session, phase);
      case 'day': return this._dayTurns(session, phase);
      default: return [];
    }
  }

  // ── Visibility ─────────────────────────────────────────────────────────

  getVisibleMessages(session: Session, agentId: string): Message[] {
    const agentTeam = getAgentTeam(session, agentId);
    return session.messages.filter(m => {
      if (!m.visibility || m.visibility === 'public') return true;
      if (m.visibility === 'private') return m.agentId === agentId;
      if (m.visibility === 'team') {
        if (agentTeam === 'wolf') {
          const msgAgentTeam = getAgentTeam(session, m.agentId);
          return msgAgentTeam === 'wolf';
        }
        return false;
      }
      return true;
    });
  }

  // ── Prompts (basic — overridden by getPromptMessages for most turns) ──

  getSystemPrompt(agent: AgentConfig, session: Session, _phase: Phase, _turn: TurnAction): string {
    const role = getAgentRole(session, agent.id);
    const roleInfo = ROLES[role];
    return withLang(
      `You are ${agent.name} in a Werewolf game. Your secret role: ${roleInfo.nameZh}(${roleInfo.name}).
Personality: ${agent.perspective}
Speaking style: ${agent.speakingStyle}`,
      session,
    );
  }

  getActionPrompt(_agent: AgentConfig, _session: Session, _phase: Phase, turn: TurnAction): string {
    return turn.prompt || 'Take your action.';
  }

  getPromptMessages(agent: AgentConfig, session: Session, phase: Phase, turn: TurnAction): ChatMessage[] {
    const role = getAgentRole(session, agent.id);

    // Night ability prompts handled by prepareTurn (tool calling) — shouldn't reach here
    // but keep as fallback
    if (phase.type === 'night' && turn.type === 'ability') {
      return this._buildNightAbilityPrompt(agent, session, phase, role);
    }

    if (phase.type === 'night' && turn.type === 'reason' && role === 'werewolf') {
      return this._buildWolfNightReasoningPrompt(agent, session, phase);
    }

    if (phase.type === 'day' && turn.type === 'reason') {
      return this._buildDayReasoningPrompt(agent, session, phase, role);
    }

    if (phase.type === 'day' && turn.type === 'speak') {
      return this._buildDaySpeakingPrompt(agent, session, phase, role, turn);
    }

    // Vote prompts handled by prepareTurn (tool calling) — shouldn't reach here
    if (phase.type === 'day' && turn.type === 'vote') {
      return this._buildVotePrompt(agent, session, phase, role);
    }

    return [
      { role: 'system', content: this.getSystemPrompt(agent, session, phase, turn) },
      { role: 'user', content: this.getActionPrompt(agent, session, phase, turn) },
    ];
  }

  // ── prepareTurn — tool calling for abilities and votes ─────────────────

  async prepareTurn(session: Session, phase: Phase, turn: TurnAction, ctx: EngineContext): Promise<void> {
    // Night abilities → Vercel AI SDK tool calling
    if (phase.type === 'night' && turn.type === 'ability') {
      await this._handleNightAbilityToolCall(session, phase, turn, ctx);
      return;
    }

    // Day votes → Vercel AI SDK tool calling
    if (phase.type === 'day' && turn.type === 'vote') {
      await this._handleVoteToolCall(session, phase, turn, ctx);
      return;
    }
  }

  // ── Phase resolution ───────────────────────────────────────────────────

  async resolvePhase(session: Session, phase: Phase, ctx: EngineContext): Promise<PhaseResult> {
    switch (phase.type) {
      case 'setup': return this._resolveSetup(session, phase, ctx);
      case 'night': return this._resolveNight(session, phase, ctx);
      case 'day': return this._resolveDay(session, phase, ctx);
      default: return { summary: '', events: [] };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TURN ORDER BUILDERS
  // ══════════════════════════════════════════════════════════════════════════

  private _setupTurns(session: Session): TurnAction[] {
    return [{
      agentId: 'gm',
      type: 'announce',
      visibility: 'public',
      metadata: {
        content: `🎭 **Werewolf — A Game of Deception**\n\n${session.agents.length} players have gathered. Roles have been assigned in secret.\n\n*Night falls... the game begins.*`,
        name: '🎭 Game Master', msgType: 'gm', color: '#FFD700', agentId: 'gm',
      },
    }];
  }

  private _nightTurns(session: Session, phase: Phase): TurnAction[] {
    const turns: TurnAction[] = [];
    const round = phase.metadata.round;
    const state = getGameState(session);

    // Night announcement
    turns.push({
      agentId: 'gm', type: 'announce', visibility: 'public',
      metadata: {
        content: `🌙 **Night ${round}** — Everyone closes their eyes...`,
        name: '🎭 Game Master', msgType: 'gm', color: '#FFD700', agentId: 'gm',
      },
    });

    // Guard (if alive)
    const guards = state ? getAliveByRole(state, 'guard') : [];
    for (const guard of guards) {
      turns.push({ agentId: guard.id, type: 'ability', visibility: 'private', metadata: { role: 'guard' } });
    }

    // Wolves: each independently votes on a target (no discussion, like real rules)
    const wolves = state ? getAliveWolves(state) : [];
    for (const wolf of wolves) {
      turns.push({ agentId: wolf.id, type: 'ability', visibility: 'team', metadata: { role: 'werewolf' } });
    }

    // Witch (if alive and has potions)
    const witches = state ? getAliveByRole(state, 'witch') : [];
    for (const witch of witches) {
      if (!witch.attributes.saveUsed || !witch.attributes.poisonUsed) {
        turns.push({ agentId: witch.id, type: 'ability', visibility: 'private', metadata: { role: 'witch' } });
      }
    }

    // Seer (if alive)
    const seers = state ? getAliveByRole(state, 'seer') : [];
    for (const seer of seers) {
      turns.push({ agentId: seer.id, type: 'ability', visibility: 'private', metadata: { role: 'seer' } });
    }

    return turns;
  }

  private _dayTurns(session: Session, phase: Phase): TurnAction[] {
    const turns: TurnAction[] = [];
    const round = phase.metadata.round;
    const state = getGameState(session);

    // Night death announcement
    const nightDeaths: string[] = session.privateState.get('night-deaths') || [];
    let deathAnnouncement: string;
    if (nightDeaths.length === 0) {
      deathAnnouncement = `☀️ **Day ${round}** — Dawn breaks. It was a peaceful night. No one died.`;
    } else {
      const names = nightDeaths.map((id: string) => `**${agentName(session, id)}**`).join(', ');
      deathAnnouncement = `☀️ **Day ${round}** — Dawn breaks. Last night, ${names} did not survive. 💀`;
    }
    turns.push({
      agentId: 'gm', type: 'announce', visibility: 'public',
      metadata: {
        content: deathAnnouncement,
        name: '🎭 Game Master', msgType: 'gm', color: '#FFD700', agentId: 'gm',
      },
    });

    // Last words for eligible deaths (first-night or pending from hooks)
    const pendingLastWords = state?.pendingLastWords || [];
    for (const deadId of pendingLastWords) {
      turns.push({
        agentId: deadId, type: 'speak', visibility: 'public',
        metadata: { phase: 'day', lastWords: true },
      });
    }
    // Clear pending after scheduling turns
    if (state) {
      state.pendingLastWords = [];
      saveGameState(session, state);
    }

    // Each alive player: reason + speak
    const alive = getAliveAgentIds(session);
    for (const agentId of alive) {
      turns.push({ agentId, type: 'reason', visibility: 'private', metadata: { phase: 'day' } });
      turns.push({ agentId, type: 'speak', visibility: 'public', metadata: { phase: 'day' } });
    }

    // Vote announcement
    turns.push({
      agentId: 'gm', type: 'announce', visibility: 'public',
      metadata: {
        content: '🗳️ **Voting time!** Each player must vote for who they think should be eliminated.',
        name: '🎭 Game Master', msgType: 'gm', color: '#FFD700', agentId: 'gm',
      },
    });

    // Each alive player votes (handled by prepareTurn → tool calling)
    for (const agentId of alive) {
      turns.push({ agentId, type: 'vote', visibility: 'public', metadata: {} });
    }

    return turns;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TOOL CALLING (prepareTurn handlers)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Handle night ability via Vercel AI SDK tool calling.
   * After execution, converts the turn to 'announce' to skip redundant LLM call.
   */
  private async _handleNightAbilityToolCall(
    session: Session, phase: Phase, turn: TurnAction, ctx: EngineContext,
  ): Promise<void> {
    const state = getGameState(session);
    if (!state) return;

    const agent = session.agents.find(a => a.id === turn.agentId);
    if (!agent) return;

    const player = getPlayer(state, turn.agentId);
    if (!player) return;

    const role = player.role;
    if (!ROLES[role].hasNightAction) return;

    // Build prompt messages for the LLM
    const messages = this._buildNightAbilityPrompt(agent, session, phase, role);

    // Build AI SDK tools from game tools
    const gameTools = getNightToolsForRole(role);
    const aiTools = this._buildAITools(gameTools, state, player);

    try {
      console.log(`[${agent.name}] Night ability: calling tools for ${role}. Available: [${Object.keys(aiTools).join(', ')}]`);
      const result = await generateText({
        model: getModel(),
        messages,
        tools: aiTools,
        toolChoice: 'required',
        stopWhen: stepCountIs(1),  // One action per night turn — call tool once then stop
      });
      // Log each tool call with details
      for (const step of (result.steps || [])) {
        for (const tc of (step.toolCalls || [])) {
          const tcAny = tc as any;
          const toolName = tcAny.toolName || tcAny.name || '?';
          const toolArgs = tcAny.args || tcAny.input || tcAny.arguments || {};
          const toolResult = (step.toolResults || []).find((r: any) => r.toolCallId === tc.toolCallId);
          const resultData = (toolResult as any)?.result || (toolResult as any)?.output || '?';
          console.log(`  → ${agent.name} called: ${toolName}(${JSON.stringify(toolArgs)}) → ${JSON.stringify(resultData)}`);
        }
      }
      console.log(`[${agent.name}] Done. Steps: ${result.steps?.length || 0}`);

      // Tool execution already mutated state via closures
      saveGameState(session, state);
      syncToSession(state, session);
    } catch (err: any) {
      console.error(`[${agent.name}] Tool calling failed:`, err.message);
      console.error(`[${agent.name}] Falling back to JSON-based approach...`);
      try {
        await this._handleNightAbilityFallback(session, state, agent, phase, role, messages);
        console.log(`[${agent.name}] Fallback succeeded.`);
      } catch (fallbackErr: any) {
        console.error(`[${agent.name}] Fallback also failed:`, fallbackErr.message);
        // Default: wolf kills random non-wolf; others pass
        if (role === 'werewolf') {
          const nonWolves = getAlivePlayers(state).filter(p => p.team !== 'wolf');
          if (nonWolves.length > 0) {
            const randomTarget = nonWolves[Math.floor(Math.random() * nonWolves.length)];
            state.nightActions.wolfVotes[agent.id] = randomTarget.id;
            console.log(`[${agent.name}] Emergency fallback: random kill → ${randomTarget.name}`);
            saveGameState(session, state);
            syncToSession(state, session);
          }
        }
      }
    }

    // Convert turn to announce → skip engine's executeStructured call
    // In spectator mode, show the actual action detail
    const spectator = session.config.spectatorMode !== false;
    let announceContent = this._getNightActionAnnounce(role, agent.name);

    if (spectator) {
      const actionDetail = this._getNightActionDetail(role, state, agent);
      if (actionDetail) announceContent += `\n> ${actionDetail}`;
    }

    (turn as any).type = 'announce';
    turn.metadata = {
      ...turn.metadata,
      content: announceContent,
      name: '🎭 Game Master',
      msgType: 'system',
      color: '#FFD700',
      agentId: 'gm',
    };
  }

  /**
   * Handle day vote via Vercel AI SDK tool calling.
   */
  private async _handleVoteToolCall(
    session: Session, phase: Phase, turn: TurnAction, ctx: EngineContext,
  ): Promise<void> {
    const state = getGameState(session);
    if (!state) return;

    const agent = session.agents.find(a => a.id === turn.agentId);
    if (!agent) return;

    const player = getPlayer(state, turn.agentId);
    if (!player || !player.alive) return;

    const role = player.role;
    const messages = this._buildVotePrompt(agent, session, phase, role);

    // Build vote tool for AI SDK
    const aiTools = this._buildAITools([voteTool], state, player);

    let votedFor: string | undefined;

    try {
      const result = await generateText({
        model: getModel(),
        messages,
        tools: aiTools,
        toolChoice: 'required',
        stopWhen: stepCountIs(1),  // One action per turn
      });

      // Extract who was voted for from tool results
      for (const step of result.steps) {
        for (const tc of step.toolCalls) {
          if (tc.toolName === 'vote') {
            votedFor = (tc as any).input?.target;
          }
        }
      }

      saveGameState(session, state);
      syncToSession(state, session);
    } catch (err: any) {
      console.error(`[${agent.name}] Vote tool calling failed, using fallback:`, err.message);
      // Fallback: JSON-based
      votedFor = await this._handleVoteFallback(session, state, agent, phase, role, messages);
    }

    // Convert turn to announce with vote result
    const targetName = votedFor ? agentName(session, votedFor) : '(abstain)';
    (turn as any).type = 'announce';
    turn.metadata = {
      ...turn.metadata,
      content: `🗳️ **${agent.name}** votes for **${targetName}**`,
      name: agent.name,
      msgType: 'agent',
      color: agent.color,
      emoji: agent.emoji,
      agentId: agent.id,
    };
  }

  // ── Build AI SDK tools from GameTool definitions ───────────────────────

  private _buildAITools(
    gameTools: GameTool[],
    state: GameState,
    player: PlayerState,
  ): ToolSet {
    const aiTools: ToolSet = {};

    for (const gt of gameTools) {
      // Build Zod schema from tool parameters
      const schemaObj: Record<string, z.ZodType> = {};
      for (const [key, param] of Object.entries(gt.parameters)) {
        schemaObj[key] = z.string().describe(param.description);
      }

      const schema = Object.keys(schemaObj).length > 0
        ? z.object(schemaObj)
        : z.object({});

      const gtRef = gt; // closure capture
      if (Object.keys(schemaObj).length > 0) {
        // Tool with parameters (target-based actions)
        aiTools[gt.name] = tool({
          description: gt.description,
          inputSchema: z.object({ target: z.string().describe('Target player ID') }),
          execute: async ({ target: targetId }) => {
            const target = targetId ? getPlayer(state, targetId) : undefined;
            const toolCtx: ToolContext = { state, player, targetId, target };
            const validation = gtRef.validate(toolCtx);
            if (validation) return { success: false as const, error: validation };
            return gtRef.execute(toolCtx);
          },
        });
      } else {
        // Tool without parameters (pass, save, etc.)
        aiTools[gt.name] = tool({
          description: gt.description,
          inputSchema: z.object({}),
          execute: async () => {
            const toolCtx: ToolContext = { state, player };
            const validation = gtRef.validate(toolCtx);
            if (validation) return { success: false as const, error: validation };
            return gtRef.execute(toolCtx);
          },
        });
      }
    }

    return aiTools;
  }

  // ── Fallback: JSON-based night action (when tool calling fails) ────────

  private async _handleNightAbilityFallback(
    session: Session, state: GameState, agent: AgentConfig,
    phase: Phase, role: RoleId, messages: ChatMessage[],
  ): Promise<void> {
    const raw = await chatCompletion(messages, { temperature: 0.3 });
    const parsed = this._parseAction(raw);
    const player = getPlayer(state, agent.id);
    if (!player) return;

    const action = parsed.action || 'pass';
    const targetId = parsed.target;
    const target = targetId ? getPlayer(state, targetId) : undefined;
    const toolCtx: ToolContext = { state, player, targetId, target };

    // Map action to tool and execute
    const toolMap: Record<string, GameTool> = {
      kill: killTool, check: checkTool, protect: protectTool,
      save: saveTool, poison: poisonTool, pass: passTool,
    };

    const gameTool = toolMap[action];
    if (gameTool) {
      const validation = gameTool.validate(toolCtx);
      if (!validation) {
        gameTool.execute(toolCtx);
      } else {
        console.warn(`[${agent.name}] Fallback action "${action}" validation failed: ${validation}`);
      }
    }

    saveGameState(session, state);
    syncToSession(state, session);
  }

  // ── Fallback: JSON-based vote ──────────────────────────────────────────

  private async _handleVoteFallback(
    session: Session, state: GameState, agent: AgentConfig,
    phase: Phase, role: RoleId, messages: ChatMessage[],
  ): Promise<string | undefined> {
    const raw = await chatCompletion(messages, { temperature: 0.3 });
    const parsed = this._parseAction(raw);
    const targetId = parsed.vote || parsed.target;
    const player = getPlayer(state, agent.id);
    if (!player || !targetId) return undefined;

    const target = getPlayer(state, targetId);
    const toolCtx: ToolContext = { state, player, targetId, target };

    const validation = voteTool.validate(toolCtx);
    if (!validation) {
      voteTool.execute(toolCtx);
      saveGameState(session, state);
      syncToSession(state, session);
      return targetId;
    }

    console.warn(`[${agent.name}] Vote validation failed: ${validation}`);
    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PHASE RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  private async _resolveSetup(_session: Session, _phase: Phase, _ctx: EngineContext): Promise<PhaseResult> {
    return { summary: 'Roles assigned. Game begins.', events: [] };
  }

  private async _resolveNight(session: Session, phase: Phase, ctx: EngineContext): Promise<PhaseResult> {
    const state = getGameState(session);
    if (!state) return { summary: 'No state.', events: [] };

    const events: CoreGameEvent[] = [];

    // Night actions were already applied via tool calling in prepareTurn.
    // Now resolve conflicts (guard vs wolf, witch save/poison).
    const resolution = resolveNightActions(state);

    // Apply deaths and run hooks
    const nightDeaths: string[] = [];
    for (const { id, cause } of resolution.killed) {
      setPlayerDead(state, id, cause, state.round);
      nightDeaths.push(id);

      events.push({
        type: 'elimination',
        agentId: id,
        data: { reason: cause },
        visibility: 'public',
        message: `${getPlayerName(state, id)} was killed during the night.`,
      });

      // Run onDeath hooks
      const deathEvent: WerewolfGameEvent = {
        round: state.round,
        phase: 'night',
        type: 'kill',
        target: id,
        data: { cause },
        message: `${getPlayerName(state, id)} died during the night.`,
      };
      state.history.push(deathEvent);

      const hookCtx: HookContext = { state, event: deathEvent, engineCtx: ctx, session, phase };
      const hookResult = runHooks('onDeath', hookCtx);

      if (hookResult.gameOver) {
        this._announceWinner(session, state, phase, ctx);
        session.privateState.set('night-deaths', nightDeaths);
        saveGameState(session, state);
        syncToSession(state, session);
        return { summary: resolution.events.join(' '), events };
      }

      // Process triggered actions
      if (hookResult.triggerActions) {
        for (const action of hookResult.triggerActions) {
          if (action.tool === 'last_words') {
            state.pendingLastWords.push(action.actor);
          }
          if (action.tool === 'shoot') {
            const gameOver = await this._resolveHunterDeath(
              session, state, action.actor, phase, ctx, events,
            );
            if (gameOver) {
              session.privateState.set('night-deaths', nightDeaths);
              saveGameState(session, state);
              syncToSession(state, session);
              return { summary: resolution.events.join(' '), events };
            }
          }
        }
      }
    }

    // Store for day announcement
    session.privateState.set('night-deaths', nightDeaths);

    // Reset night actions for next night
    state.nightActions = createNightActions();

    // Reset guard's isProtectedTonight
    for (const p of state.players) {
      p.attributes.isProtectedTonight = false;
    }

    // Broadcast resolution for spectators (god view)
    ctx.broadcast(session, 'night_resolution', {
      events: resolution.events,
      killed: nightDeaths.map(id => ({ id, name: getPlayerName(state, id) })),
      saved: resolution.saved.map(id => ({ id, name: getPlayerName(state, id) })),
    });

    saveGameState(session, state);
    syncToSession(state, session);
    return { summary: resolution.events.join(' '), events };
  }

  private async _resolveDay(session: Session, phase: Phase, ctx: EngineContext): Promise<PhaseResult> {
    const state = getGameState(session);
    if (!state) return { summary: 'No state.', events: [] };

    const events: CoreGameEvent[] = [];

    // Vote actions were already stored via tool calling in prepareTurn.
    const { eliminated, tally, tied } = resolveVoteActions(state);

    // Build vote summary
    const voteDetails: Array<{ voter: string; target: string }> = [];
    for (const [voterId, targetId] of Object.entries(state.voteActions)) {
      voteDetails.push({
        voter: agentName(session, voterId),
        target: agentName(session, targetId),
      });
    }

    const voteText = voteDetails.map(v => `• **${v.voter}** → ${v.target}`).join('\n');
    const tallyText = Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => `${agentName(session, id)}: ${count} votes`)
      .join(', ');

    ctx.addMsg(session, 'gm', '🎭 Game Master',
      `🗳️ **Vote Results:**\n${voteText}\n\n📊 **Tally:** ${tallyText}`,
      phase.id, { color: '#FFD700', agentId: 'gm' });

    ctx.broadcast(session, 'vote_result', { votes: voteDetails, tally, eliminated, tied });

    if (tied) {
      ctx.addMsg(session, 'gm', '🎭 Game Master',
        '⚖️ **Tie! No one is eliminated.**',
        phase.id, { color: '#FFD700', agentId: 'gm' });
    } else if (eliminated) {
      const eliminatedPlayer = getPlayer(state, eliminated);
      const eliminatedRole = eliminatedPlayer?.role || getAgentRole(session, eliminated);
      const eliminatedName = agentName(session, eliminated);

      // Fool check
      if (eliminatedRole === 'fool' && !session.privateState.get(`fool-revealed-${eliminated}`)) {
        session.privateState.set(`fool-revealed-${eliminated}`, true);
        session.privateState.set(`no-vote-${eliminated}`, true);
        ctx.addMsg(session, 'gm', '🎭 Game Master',
          `🤡 **${eliminatedName}** reveals they are the **Fool**! They survive but lose voting rights.`,
          phase.id, { color: '#FFD700', agentId: 'gm' });
        ctx.broadcast(session, 'role_reveal', {
          agentId: eliminated, role: 'fool', roleEmoji: '🤡',
        });
      } else {
        // Last words before elimination
        await this._resolveLastWords(session, state, eliminated, phase, ctx);

        // Apply death
        setPlayerDead(state, eliminated, 'vote', state.round);

        events.push({
          type: 'elimination',
          agentId: eliminated,
          data: { reason: 'vote' },
          visibility: 'public',
          message: `${eliminatedName} was voted out.`,
        });

        ctx.addMsg(session, 'gm', '🎭 Game Master',
          `💀 **${eliminatedName}** has been eliminated by vote. Their role was: **${ROLES[eliminatedRole].emoji} ${ROLES[eliminatedRole].nameZh}**`,
          phase.id, { color: '#FFD700', agentId: 'gm' });

        ctx.broadcast(session, 'elimination', {
          agentId: eliminated, role: eliminatedRole,
          roleEmoji: ROLES[eliminatedRole].emoji,
          roleName: ROLES[eliminatedRole].nameZh,
        });

        // Run onDeath hooks
        const deathEvent: WerewolfGameEvent = {
          round: state.round,
          phase: 'day_vote',
          type: 'elimination',
          target: eliminated,
          data: { cause: 'vote' },
          message: `${eliminatedName} was voted out.`,
        };
        state.history.push(deathEvent);

        const hookCtx: HookContext = { state, event: deathEvent, engineCtx: ctx, session, phase };
        const hookResult = runHooks('onDeath', hookCtx);

        if (hookResult.gameOver) {
          this._announceWinner(session, state, phase, ctx);
          saveGameState(session, state);
          syncToSession(state, session);
          return { summary: `${eliminatedName} eliminated. Game over.`, events };
        }

        // Process triggered actions (hunter shoot, etc.)
        if (hookResult.triggerActions) {
          for (const action of hookResult.triggerActions) {
            if (action.tool === 'shoot') {
              const gameOver = await this._resolveHunterDeath(
                session, state, action.actor, phase, ctx, events,
              );
              if (gameOver) {
                saveGameState(session, state);
                syncToSession(state, session);
                return { summary: `${eliminatedName} eliminated. Hunter shot. Game over.`, events };
              }
            }
            // Last words for vote deaths are handled above before death
          }
        }
      }
    }

    // Clear vote actions
    state.voteActions = {};

    saveGameState(session, state);
    syncToSession(state, session);

    return {
      summary: eliminated ? `${agentName(session, eliminated)} eliminated.` : 'No one eliminated.',
      events,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  DEATH RESOLUTION HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private _announceWinner(session: Session, state: GameState, phase: Phase, ctx: EngineContext): void {
    const result = state.winner === 'wolf'
      ? '🐺 Werewolves outnumber villagers! Wolves win!'
      : '🎉 All werewolves eliminated! Village wins!';
    ctx.addMsg(session, 'system', 'System', `🏁 ${result}`, phase.id);
    session.status = 'completed';
    ctx.broadcast(session, 'status', { status: 'completed' });
  }

  private async _resolveLastWords(
    session: Session, state: GameState, agentId: string,
    phase: Phase, ctx: EngineContext,
  ): Promise<void> {
    const agent = session.agents.find(a => a.id === agentId);
    if (!agent) return;
    const role = getAgentRole(session, agentId);

    ctx.addMsg(session, 'gm', '🎭 Game Master',
      `📜 **${agent.name}** may speak their last words (遗言).`,
      phase.id, { color: '#FFD700', agentId: 'gm' });

    const turn: TurnAction = {
      agentId, type: 'speak', visibility: 'public',
      metadata: { phase: 'day', lastWords: true, voteElimination: true },
    };
    const msgs = this._buildDaySpeakingPrompt(agent, session, phase, role, turn);
    const lastWords = await chatCompletion(msgs, { temperature: 0.7 });

    ctx.addMsg(session, 'agent', agent.name, lastWords, phase.id, {
      color: agent.color, emoji: agent.emoji, agentId: agent.id,
    });

    // Mark last words delivered
    const player = getPlayer(state, agentId);
    if (player) player.attributes.hadLastWords = true;

    ctx.broadcast(session, 'last_words', { agentId: agent.id, agentName: agent.name });
  }

  /**
   * Resolve hunter death: ask LLM who to shoot via tool calling.
   * Returns true if game is over after the shot.
   */
  private async _resolveHunterDeath(
    session: Session, state: GameState, hunterId: string,
    phase: Phase, ctx: EngineContext, events: CoreGameEvent[],
  ): Promise<boolean> {
    const hunter = session.agents.find(a => a.id === hunterId);
    if (!hunter) return false;

    const hunterPlayer = getPlayer(state, hunterId);
    if (!hunterPlayer || hunterPlayer.attributes.canShoot === false) return false;

    ctx.addMsg(session, 'gm', '🎭 Game Master',
      `🏹 **${hunter.name}** is the Hunter! They can take someone with them.`,
      phase.id, { color: '#FFD700', agentId: 'gm' });

    const alive = getAlivePlayers(state).filter(p => p.id !== hunterId);
    const aliveList = alive.map(p => `${p.id} (${p.name})`).join(', ');

    // Try tool calling first
    let shotTargetId: string | undefined;

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are ${hunter.name}, the Hunter. You are dying. You can take one player with you by shooting them. Choose wisely based on who you suspect is a werewolf.\n\nAlive players: ${aliveList}`,
      },
      { role: 'user', content: 'Who do you shoot?' },
    ];

    try {
      const aiTools = this._buildAITools([shootTool], state, hunterPlayer);
      const result = await generateText({
        model: getModel(),
        messages,
        tools: aiTools,
        toolChoice: 'required',
        stopWhen: stepCountIs(1),  // One action per turn
      });

      for (const step of result.steps) {
        for (const tc of step.toolCalls) {
          if (tc.toolName === 'shoot' && (tc as any).input.target) {
            shotTargetId = (tc as any).input.target;
          }
        }
      }
    } catch (err: any) {
      console.error(`[${hunter.name}] Hunter shot tool calling failed:`, err.message);
      // Fallback
      const raw = await chatCompletion(messages, { temperature: 0.3 });
      const parsed = this._parseAction(raw);
      if (parsed.target && alive.some(p => p.id === parsed.target)) {
        shotTargetId = parsed.target;
      }
    }

    if (shotTargetId) {
      const shotTarget = getPlayer(state, shotTargetId);
      if (shotTarget && shotTarget.alive) {
        setPlayerDead(state, shotTargetId, 'hunter', state.round);

        const targetRole = shotTarget.role;
        const targetName = shotTarget.name;

        events.push({
          type: 'elimination',
          agentId: shotTargetId,
          data: { reason: 'hunter' },
          visibility: 'public',
          message: `${targetName} was shot by the Hunter.`,
        });

        ctx.addMsg(session, 'gm', '🎭 Game Master',
          `🏹💥 **${hunter.name}** shoots **${targetName}**! They were a **${ROLES[targetRole].emoji} ${ROLES[targetRole].nameZh}**.`,
          phase.id, { color: '#FFD700', agentId: 'gm' });

        ctx.broadcast(session, 'elimination', {
          agentId: shotTargetId, role: targetRole,
          roleEmoji: ROLES[targetRole].emoji,
          roleName: ROLES[targetRole].nameZh,
          reason: 'hunter_shot',
        });

        // Run onDeath hooks for the shot target (recursive chain, depth-limited)
        const deathEvent: WerewolfGameEvent = {
          round: state.round,
          phase: state.phase,
          type: 'shoot',
          actor: hunterId,
          target: shotTargetId,
          data: { cause: 'hunter' },
          message: `${targetName} was shot by ${hunter.name}.`,
        };
        state.history.push(deathEvent);

        const hookCtx: HookContext = { state, event: deathEvent, engineCtx: ctx, session, phase };
        const hookResult = runHooks('onDeath', hookCtx);

        if (hookResult.gameOver) {
          this._announceWinner(session, state, phase, ctx);
          saveGameState(session, state);
          syncToSession(state, session);
          return true;
        }
      }
    }

    saveGameState(session, state);
    syncToSession(state, session);
    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PROMPT BUILDERS
  // ══════════════════════════════════════════════════════════════════════════

  private _buildNightAbilityPrompt(
    agent: AgentConfig, session: Session, phase: Phase, role: RoleId,
  ): ChatMessage[] {
    const state = getGameState(session);
    const alive = getAliveAgentIds(session).filter(id => id !== agent.id);
    const aliveList = alive.map(id => `${id} (${agentName(session, id)})`).join(', ');

    switch (role) {
      case 'guard': {
        const guardPlayer = state ? getPlayer(state, agent.id) : undefined;
        const lastProtected = guardPlayer?.attributes.lastProtected;
        const lastStr = lastProtected
          ? ` You CANNOT protect ${agentName(session, lastProtected)} again (protected last night).`
          : '';
        return [
          {
            role: 'system',
            content: withLang(`You are ${agent.name}, the Guard (守卫). Choose one alive player to protect tonight. They will survive a werewolf attack.${lastStr}\n\nAlive players: ${aliveList}\n\nUse the "protect" tool to protect someone, or "pass" to skip.`, session),
          },
          { role: 'user', content: 'Who do you protect tonight?' },
        ];
      }

      case 'werewolf': {
        const wolves = getWolfIds(session);
        const nonWolves = alive.filter(id => !wolves.includes(id));
        const nonWolfList = nonWolves.map(id => `${id} (${agentName(session, id)})`).join(', ');

        // Day discussion context for strategic targeting
        const recentDay = session.messages
          .filter(m => m.type === 'agent' && m.phaseId?.startsWith('day'))
          .slice(-6)
          .map(m => `[${m.agentName}]: ${m.content.slice(0, 150)}`)
          .join('\n');
        const dayCtx = recentDay ? `\nRecent day discussion (use this to pick your target strategically):\n${recentDay}\n` : '';

        return [
          {
            role: 'system',
            content: withLang(`You are ${agent.name}, a Werewolf (狼人). It's night — you cannot talk, only point at who to kill. Pick one villager to eliminate.${dayCtx}\nAlive non-wolf players: ${nonWolfList}\n\nUse the "kill" tool to choose your target.`, session),
          },
          { role: 'user', content: 'Point at who you want to kill tonight.' },
        ];
      }

      case 'witch': {
        const witchPlayer = state ? getPlayer(state, agent.id) : undefined;
        const saveUsed = witchPlayer?.attributes.saveUsed ?? session.privateState.get('witch-save-used');
        const poisonUsed = witchPlayer?.attributes.poisonUsed ?? session.privateState.get('witch-poison-used');

        let wolfVictim = 'unknown';
        if (state) {
          const wolfTarget = resolveWolfTarget(state);
          if (wolfTarget) wolfVictim = `${wolfTarget} (${getPlayerName(state, wolfTarget)})`;
        }

        const options: string[] = [];
        if (!saveUsed) options.push('Use the "save" tool to rescue the wolf victim');
        if (!poisonUsed) options.push('Use the "poison" tool to kill someone');
        options.push('Use the "pass" tool to do nothing');

        return [
          {
            role: 'system',
            content: withLang(`You are ${agent.name}, the Witch (女巫). Tonight the wolves attacked: ${wolfVictim}.\n\nAvailable actions:\n${options.map(o => `• ${o}`).join('\n')}\n\nSave potion: ${!saveUsed ? 'AVAILABLE' : 'USED'}\nPoison potion: ${!poisonUsed ? 'AVAILABLE' : 'USED'}\n\nAlive players: ${aliveList}`, session),
          },
          { role: 'user', content: 'What do you do tonight?' },
        ];
      }

      case 'seer': {
        const seerPlayer = state ? getPlayer(state, agent.id) : undefined;
        const prevChecks = seerPlayer?.attributes.checkResults || session.privateState.get('seer-checks') || [];
        const checkHistory = prevChecks.length > 0
          ? `\nPrevious checks: ${prevChecks.map((c: any) => `${agentName(session, c.target)} = ${c.isWolf ? '🐺 WOLF' : '✅ Good'}`).join(', ')}`
          : '';

        // Filter out already checked players
        const checkedIds = prevChecks.map((c: any) => c.target);
        const uncheckedAlive = alive.filter(id => !checkedIds.includes(id));
        const uncheckedList = uncheckedAlive.map(id => `${id} (${agentName(session, id)})`).join(', ');

        // Day discussion hints — who was suspicious?
        const recentSuspicions = session.messages
          .filter(m => m.type === 'agent' && m.phaseId?.startsWith('day'))
          .slice(-10)
          .map(m => m.content)
          .join(' ');

        let strategyHint = '';
        if (prevChecks.length === 0) {
          strategyHint = '\n\nSTRATEGY: This is your first check. Choose someone you find suspicious or someone in a key position (active speaker, quiet lurker). Your check result will be crucial for Day 1.';
        } else {
          strategyHint = '\n\nSTRATEGY: Choose someone you have NOT checked yet. Prioritize: (1) players who were suspicious during the day, (2) players who defended a confirmed wolf, (3) quiet/lurking players. Do NOT waste your check on someone already verified.';
        }

        return [
          {
            role: 'system',
            content: withLang(`You are ${agent.name}, the Seer (预言家). Choose one player to check their identity.${checkHistory}${strategyHint}\n\nPlayers you have NOT checked yet: ${uncheckedList}\n\nUse the "check" tool to check someone's identity.`, session),
          },
          { role: 'user', content: 'Who do you check tonight? Choose from unchecked players.' },
        ];
      }

      default:
        return [
          { role: 'system', content: `You are ${agent.name}. You have no night action. Wait for dawn.` },
          { role: 'user', content: 'Night passes...' },
        ];
    }
  }

  private _buildWolfNightReasoningPrompt(
    agent: AgentConfig, session: Session, _phase: Phase,
  ): ChatMessage[] {
    const wolves = getWolfIds(session);
    const teammates = wolves.filter(id => id !== agent.id).map(id => agentName(session, id));
    const alive = getAliveAgentIds(session).filter(id => !wolves.includes(id));
    const aliveList = alive.map(id => `${id} (${agentName(session, id)})`).join(', ');

    const previousEvents = session.messages
      .filter(m => m.type === 'gm' || m.type === 'agent')
      .slice(-10)
      .map(m => `[${m.agentName}]: ${m.content.slice(0, 500)}`)
      .join('\n');

    return [
      {
        role: 'system',
        content: `You are ${agent.name}, a Werewolf (狼人). This is your PRIVATE wolf team discussion.
Teammates: ${teammates.join(', ') || 'none (lone wolf)'}
Personality: ${agent.perspective}

Analyze the situation:
1. Who is the biggest threat among villagers? (Seer? Active accusers?)
2. Who would be a strategic kill to weaken the village?
3. Who might the village suspect if this person dies?
4. Coordinate with your team — think about who to target.

Recent game events:
${previousEvents || 'Game just started.'}

Alive non-wolves: ${aliveList}${getLanguageInstruction(session.config)}`,
      },
      { role: 'user', content: 'Discuss strategy with your wolf pack. Who should be targeted tonight?' },
    ];
  }

  private _buildDayReasoningPrompt(
    agent: AgentConfig, session: Session, phase: Phase, role: RoleId,
  ): ChatMessage[] {
    const roleInfo = ROLES[role];
    const isWolf = roleInfo.team === 'wolf';

    const visibleMsgs = this.getVisibleMessages(session, agent.id);
    const recentPublic = visibleMsgs
      .filter(m => m.type === 'agent' || m.type === 'gm')
      .slice(-12)
      .map(m => `[${m.agentName}]: ${m.content.slice(0, 500)}`)
      .join('\n');

    let secretKnowledge = '';
    if (role === 'seer') {
      const state = getGameState(session);
      const checks = state
        ? (getPlayer(state, agent.id)?.attributes.checkResults || [])
        : (session.privateState.get('seer-checks') || []);
      if (checks.length > 0) {
        secretKnowledge = `\nYour check results: ${checks.map((c: any) => `${agentName(session, c.target)} = ${c.isWolf ? '🐺 WOLF' : '✅ Good'}`).join(', ')}`;
      }
    } else if (isWolf) {
      const wolves = getWolfIds(session);
      secretKnowledge = `\nYour wolf teammates: ${wolves.filter(id => id !== agent.id).map(id => agentName(session, id)).join(', ') || 'none'}`;
    }

    const langInst = getLanguageInstruction(session.config);
    const dayNum = parseInt(phase.id.replace(/\D/g, '') || '1');
    const strategyGuide = getStrategyPrompt(agent, session, phase.id, role, dayNum);

    const system = isWolf
      ? `You are ${agent.name}, secretly a WEREWOLF. You must BLEND IN.
Personality: ${agent.perspective}
Speaking style: ${agent.speakingStyle}
${secretKnowledge}
${strategyGuide}

PRIVATE REASONING — Day ${dayNum} (no one sees this):
- Review any Seer claims and check results. How do they affect you?
- How can you redirect suspicion away from yourself and teammates?
- Should you fake-claim a role? If someone accused your team, how do you counter?
- Who is the biggest threat to your team? Can you steer the vote toward them?
- What would an innocent villager say in your position?${langInst}`
      : `You are ${agent.name}, a ${roleInfo.nameZh}(${roleInfo.name}).
Personality: ${agent.perspective}
Speaking style: ${agent.speakingStyle}
${secretKnowledge}
${strategyGuide}

PRIVATE REASONING — Day ${dayNum} (no one sees this):
- Has anyone claimed Seer? What did they report? Is it credible?
- Are there counter-claims? Who is more believable and why?
- Based on available information, who is most likely a wolf?
- What is the optimal vote today? Follow information over intuition.
- What information should you share vs. keep private?${langInst}`;

    return [
      { role: 'system', content: system },
      { role: 'user', content: `Recent discussion:\n${recentPublic || '(day just started)'}\n\nAnalyze the situation privately. Plan your public statement.` },
    ];
  }

  private _buildDaySpeakingPrompt(
    agent: AgentConfig, session: Session, phase: Phase, role: RoleId, turn?: TurnAction,
  ): ChatMessage[] {
    const roleInfo = ROLES[role];
    const isWolf = roleInfo.team === 'wolf';
    const isLastWords = turn?.metadata?.lastWords === true;
    const latestReasoning = (session.agentReasoning[agent.id] || []).slice(-1)[0] || '';

    const visibleMsgs = this.getVisibleMessages(session, agent.id);
    const dayAgentMsgs = visibleMsgs.filter(m => m.phaseId === phase.id && m.type === 'agent');
    const speakOrder = dayAgentMsgs.length + 1; // how many agents spoke before me + 1
    const totalAlive = getAliveAgentIds(session).length;
    const recentPublic = visibleMsgs
      .filter(m => m.phaseId === phase.id && (m.type === 'agent' || m.type === 'gm'))
      .slice(-8)
      .map(m => `[${m.agentName}]: ${m.content.slice(0, 500)}`)
      .join('\n');

    const langInst2 = getLanguageInstruction(session.config);

    // ── Last Words (遗言) ──
    if (isLastWords) {
      const isVoteElimination = turn?.metadata?.voteElimination === true;
      const deathContext = isVoteElimination
        ? 'You were voted out by the village.'
        : 'You were killed during the night.';

      const state = getGameState(session);
      const seerChecks = state
        ? (getPlayer(state, agent.id)?.attributes.checkResults || [])
        : (session.privateState.get('seer-checks') || []);
      const seerInfo = role === 'seer' && seerChecks.length > 0
        ? `\nYour check results: ${seerChecks.map((c: any) => `${agentName(session, c.target)} = ${c.isWolf ? '🐺 WOLF' : '✅ Good'}`).join(', ')}`
        : '';

      const lastWordsSystem = isWolf
        ? `You are ${agent.name}. ${deathContext} This is your LAST WORDS (遗言) — your final chance to speak before leaving the game forever.
Personality: ${agent.perspective}
Speaking style: ${agent.speakingStyle}

You are a wolf, but you are now dead. You may choose to:
1. Continue your cover — claim a role, accuse someone, misdirect the village one last time.
2. Or say something cryptic/emotional in character without revealing wolf identity.
NEVER admit you are a wolf. Even in death, protect your teammates.
Keep it brief — 1 short paragraph.${langInst2}`
        : `You are ${agent.name}. ${deathContext} This is your LAST WORDS (遗言) — your final chance to speak before leaving the game forever.
Your role: ${roleInfo.nameZh}(${roleInfo.name})
Personality: ${agent.perspective}
Speaking style: ${agent.speakingStyle}
${seerInfo}

This is your most important moment. Use it wisely:
${role === 'seer' ? '- You are the SEER. Report ALL your check results NOW. This information can save the village even after your death.' : ''}
${role === 'witch' ? '- You are the WITCH. Share any night attack information you have.' : ''}
${role === 'hunter' ? '- You are the HUNTER. You will get to shoot someone — declare your target and reasoning.' : ''}
${role === 'guard' ? '- You are the GUARD. Share who you protected and any insights from your protection attempts.' : ''}
- Share any suspicions, observations, or information that could help the village.
- This is your LAST chance to speak. Make it count.
Keep it brief but impactful — 1 short paragraph.${langInst2}`;

      const msgs: ChatMessage[] = [{ role: 'system', content: lastWordsSystem }];
      if (recentPublic) {
        msgs.push({ role: 'user', content: `What has been said:\n${recentPublic}` });
      }
      msgs.push({ role: 'user', content: 'Speak your last words to the village.' });
      return msgs;
    }

    // ── Normal day speaking ──
    const system = isWolf
      ? `You are ${agent.name} in a Werewolf game, speaking publicly during the day.
You are SECRETLY a werewolf. You MUST sound like an innocent villager.
Personality: ${agent.perspective}
Speaking style: ${agent.speakingStyle}

RULES:
1. NEVER reveal you're a wolf. Everything you say must sound like a villager.
2. If someone claims Seer and accuses you/your teammate, counter their logic or fake-claim a role.
3. If no one is accusing you, blend in — analyze others, cast subtle suspicion on villagers.
4. Engage with what others said — agree, disagree, build alliances.
5. If you're fake-claiming Seer, be specific: state who you "checked" and the "result".
6. 1-2 paragraphs. Be natural. Stay in character.${langInst2}`
      : `You are ${agent.name} in a Werewolf game, speaking publicly during the day.
Your role: ${roleInfo.nameZh}(${roleInfo.name})
Personality: ${agent.perspective}
Speaking style: ${agent.speakingStyle}

RULES:
1. If you are the SEER: you MUST claim your identity and report check results. Say clearly "I am the Seer, I checked [name], they are [wolf/villager]." Do NOT hide your role — a hidden Seer is useless.
2. If someone claimed Seer, respond to their claim — do you believe them? Why or why not?
3. Share your analysis based on INFORMATION (claims, check results, voting patterns), not vibes.
4. Respond to what others have said — support allies, challenge suspects.
5. 1-2 paragraphs. Be natural. Stay in character.
6. Do NOT reveal your private reasoning process.${langInst2}`;

    const orderHint = speakOrder === 1
      ? `You are the FIRST to speak this round. No one has spoken yet — do not accuse others of "staying silent", they simply haven't had their turn.`
      : speakOrder <= 3
        ? `You are speaker #${speakOrder} of ${totalAlive}. Only ${speakOrder - 1} player(s) spoke before you — most haven't had their turn yet.`
        : `You are speaker #${speakOrder} of ${totalAlive}. You've heard from ${speakOrder - 1} players so far.`;

    const msgs: ChatMessage[] = [{ role: 'system', content: system }];
    if (recentPublic) {
      msgs.push({ role: 'user', content: `Discussion so far:\n${recentPublic}` });
    }
    msgs.push({ role: 'user', content: `[Speaking order: ${orderHint}]\n[Your private analysis]\n${latestReasoning}\n\nNow speak publicly.` });
    return msgs;
  }

  private _buildVotePrompt(
    agent: AgentConfig, session: Session, _phase: Phase, role: RoleId,
  ): ChatMessage[] {
    const isWolf = ROLES[role].team === 'wolf';
    const alive = getAliveAgentIds(session).filter(id => id !== agent.id);
    const aliveList = alive.map(id => `${id} (${agentName(session, id)})`).join(', ');
    const latestReasoning = (session.agentReasoning[agent.id] || []).slice(-1)[0] || '';

    const wolfGuard = isWolf
      ? ` Do NOT vote for your wolf teammates (${getWolfIds(session).filter(id => id !== agent.id).join(', ')}).`
      : '';

    return [
      {
        role: 'system',
        content: withLang(`You are ${agent.name}. Cast your vote based on your earlier analysis.${wolfGuard}\n\nUse the "vote" tool to cast your vote.\n\nAlive players: ${aliveList}`, session),
      },
      { role: 'user', content: `[Your private analysis]\n${latestReasoning}\n\nCast your vote now.` },
    ];
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UTILITY HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private _getNightActionDetail(role: RoleId, state: GameState, agent: AgentConfig): string | null {
    switch (role) {
      case 'werewolf': {
        const targetId = state.nightActions.wolfVotes[agent.id];
        if (!targetId) return '👀 chose to pass';
        const targetName = getPlayerName(state, targetId);
        return `🗡️ voted to kill **${targetName}**`;
      }
      case 'guard': {
        const targetId = state.nightActions.guardTarget;
        if (!targetId) return '👀 chose to pass';
        return `🛡️ protecting **${getPlayerName(state, targetId)}**`;
      }
      case 'seer': {
        const targetId = state.nightActions.seerTarget;
        if (!targetId) return null;
        const target = getPlayer(state, targetId);
        if (!target) return null;
        const isWolf = target.team === 'wolf';
        return `🔮 checked **${target.name}** → ${isWolf ? '🐺 WOLF' : '✅ Good'}`;
      }
      case 'witch': {
        const parts: string[] = [];
        if (state.nightActions.witchSave) parts.push('💊 used save potion');
        if (state.nightActions.witchPoisonTarget) {
          parts.push(`☠️ poisoned **${getPlayerName(state, state.nightActions.witchPoisonTarget)}**`);
        }
        return parts.length > 0 ? parts.join(', ') : '👀 did nothing';
      }
      default:
        return null;
    }
  }

  private _getNightActionAnnounce(role: RoleId, agentName: string): string {
    switch (role) {
      case 'guard': return `🛡️ *${agentName} (Guard) acts in the shadows...*`;
      case 'werewolf': return `🐺 *${agentName} (Werewolf) prowls the night...*`;
      case 'witch': return `🧪 *${agentName} (Witch) stirs her potions...*`;
      case 'seer': return `🔮 *${agentName} (Seer) gazes into the crystal ball...*`;
      default: return `*${agentName} waits through the night...*`;
    }
  }

  private _parseAction(raw: string): Record<string, any> {
    try {
      return parseJSONResponse(raw);
    } catch {
      const actionMatch = raw.match(/"action"\s*:\s*"(\w+)"/);
      const targetMatch = raw.match(/"target"\s*:\s*"([^"]+)"/);
      const voteMatch = raw.match(/"vote"\s*:\s*"([^"]+)"/);
      return {
        action: actionMatch?.[1] || 'pass',
        target: targetMatch?.[1] || null,
        vote: voteMatch?.[1] || null,
      };
    }
  }

  private _getSituationalStrategy(
    agent: AgentConfig, session: Session, phase: Phase, role: RoleId, dayNum: number,
  ): string {
    return getStrategyPrompt(agent, session, phase.id, role, dayNum);
  }

  // ── Persona generation ─────────────────────────────────────────────────

  private async _generatePersonas(theme: string, count: number, config?: Record<string, any>): Promise<Array<{
    name: string; gender: string; personality: string;
    speakingStyle: string; publicRole: string;
  }>> {
    const langInst = getLanguageInstruction(config || {});
    const characters: Array<{ name: string; gender: string; personality: string; speakingStyle: string; publicRole: string }> = [];

    const createCharacterTool = tool({
      description: 'Create a character for the Werewolf game. Call this tool once for EACH character you want to create.',
      inputSchema: z.object({
        name: z.string().describe('Memorable character name fitting the theme'),
        gender: z.enum(['male', 'female']).describe('Character gender'),
        personality: z.string().describe('Distinct personality in 2-3 sentences'),
        speakingStyle: z.string().describe('How they talk — tone, verbal habits, sentence structure. Be specific.'),
        publicRole: z.string().describe('Cover identity in the village, e.g. blacksmith, merchant, healer'),
      }),
      execute: async ({ name, gender, personality, speakingStyle, publicRole }) => {
        characters.push({ name, gender, personality, speakingStyle, publicRole });
        return { success: true, created: name, total: characters.length, remaining: count - characters.length };
      },
    });

    await generateText({
      model: getModel(),
      messages: [
        {
          role: 'system',
          content: `You are creating characters for a Werewolf social deduction game with the theme: "${theme}".

You must create exactly ${count} characters by calling the create_character tool ${count} times.

Make characters diverse: different ages, backgrounds, temperaments.
- Some naturally trusting, others suspicious
- Some diplomatic, some confrontational
- Some blunt and data-driven, some storytellers
- Give each a UNIQUE speaking style (tone, verbal habits, sentence structure)${langInst}`,
        },
        { role: 'user', content: `Create ${count} unique characters for theme: "${theme}". Call the create_character tool once for each character.` },
      ],
      tools: { create_character: createCharacterTool },
      stopWhen: stepCountIs(count + 2),
      temperature: 0.8,
    });

    if (characters.length < count) {
      throw new Error(`Only ${characters.length}/${count} characters were created. LLM did not call the tool enough times.`);
    }

    return characters.slice(0, count);
  }
}
