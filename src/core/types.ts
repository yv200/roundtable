import type { Response } from 'express';

// ── Config field for dynamic form generation ────────────────────────────

export interface ConfigField {
  key: string;
  type: 'text' | 'number' | 'select' | 'toggle' | 'range';
  label: string;
  required: boolean;
  default?: any;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  hint?: string;
}

// ── Agent ───────────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  gender: 'male' | 'female';
  role: string;
  perspective: string;
  speakingStyle: string;
  color: string;
  emoji: string;
}

// ── Messages ────────────────────────────────────────────────────────────

export type MessageRole = 'agent' | 'user' | 'planner' | 'critic' | 'system' | 'summary' | 'gm';

export interface Message {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
  type: MessageRole;
  phaseId?: string;
  /** @deprecated use phaseId — kept for discussion-mode backward compat */
  subTopicId?: string;
  color?: string;
  emoji?: string;
  visibility?: 'public' | 'private' | 'team';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Phase ───────────────────────────────────────────────────────────────

export interface Phase {
  id: string;
  type: string;          // 'subtopic' | 'synthesis' | 'day' | 'night' | 'vote' | 'setup'
  label: string;
  status: 'pending' | 'active' | 'resolved';
  metadata: Record<string, any>;
}

// ── Turn ────────────────────────────────────────────────────────────────

export interface TurnAction {
  agentId: string;
  type: 'reason' | 'speak' | 'vote' | 'ability' | 'announce';
  visibility: 'public' | 'private' | 'team';
  prompt?: string;
  metadata?: Record<string, any>;
}

// ── Phase result ────────────────────────────────────────────────────────

export interface GameEvent {
  type: string;           // 'elimination' | 'ability_result' | 'vote_result' | 'role_reveal' …
  agentId?: string;
  targetId?: string;
  data: Record<string, any>;
  visibility: 'public' | 'private' | 'team';
  message: string;
}

export interface PhaseResult {
  summary: string;
  events: GameEvent[];
  nextPhaseHint?: string;
}

// ── Session ─────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  mode: string;                      // 'discussion' | 'werewolf'
  config: Record<string, any>;
  agents: AgentConfig[];
  phases: Phase[];
  currentPhaseIndex: number;
  messages: Message[];
  status: 'setup' | 'running' | 'paused' | 'completed';
  createdAt: number;
  sseClients: Set<Response>;
  agentReasoning: Record<string, string[]>;
  privateState: Map<string, any>;    // mode-specific hidden state
  eliminatedAgents: string[];
}

// ── Engine context (utilities passed to mode methods) ───────────────────

export interface EngineContext {
  addMsg(
    session: Session, type: MessageRole, name: string, content: string,
    phaseId?: string,
    extra?: { color?: string; emoji?: string; agentId?: string },
  ): Message;

  streamMsg(
    session: Session, type: MessageRole, name: string,
    gen: AsyncGenerator<string>, phaseId?: string,
    extra?: { color?: string; emoji?: string; agentId?: string },
  ): Promise<string>;

  broadcast(session: Session, event: string, data: unknown): void;
  sleep(ms: number): Promise<void>;
}

// ── Game mode ───────────────────────────────────────────────────────────

export interface GameMode {
  id: string;

  setup(config: Record<string, any>): Promise<{
    agents: AgentConfig[];
    phases: Phase[];
    privateState: Map<string, any>;
  }>;

  getNextPhase(session: Session): Phase | null;
  isGameOver(session: Session): { over: boolean; result?: string };

  getTurnOrder(session: Session, phase: Phase): TurnAction[];
  getVisibleMessages(session: Session, agentId: string): Message[];

  resolvePhase(session: Session, phase: Phase, ctx: EngineContext): Promise<PhaseResult>;

  getSystemPrompt(agent: AgentConfig, session: Session, phase: Phase, turn: TurnAction): string;
  getActionPrompt(agent: AgentConfig, session: Session, phase: Phase, turn: TurnAction): string;

  /** Override to return a full ChatMessage[] — takes priority over getSystemPrompt+getActionPrompt */
  getPromptMessages?(agent: AgentConfig, session: Session, phase: Phase, turn: TurnAction): ChatMessage[];

  /** Optional: called before each turn (e.g. web research) */
  prepareTurn?(session: Session, phase: Phase, turn: TurnAction, ctx: EngineContext): Promise<void>;
}

// ── Mode manifest ───────────────────────────────────────────────────────

export interface ModeManifest {
  id: string;
  name: string;
  description: string;
  icon: string;
  configSchema: ConfigField[];
  create(config: Record<string, any>): GameMode;
}

// ── Language helpers ─────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  zh: 'Chinese (中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
};

/**
 * Returns a prompt instruction for output language.
 * Append to any system prompt. Returns '' for 'auto' or unknown values.
 */
export function getLanguageInstruction(config: Record<string, any>): string {
  const lang = config?.language;
  if (!lang || lang === 'auto') return '';
  const name = LANG_NAMES[lang] || lang;
  return `\n\nIMPORTANT: You MUST write ALL your output in ${name}. Do not switch languages.`;
}
