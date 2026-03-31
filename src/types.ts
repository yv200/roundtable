import type { Response } from 'express';

// ── Agent configs ────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  perspective: string;
  speakingStyle: string;        // How this agent communicates — tone, structure, habits
  color: string;
  emoji: string;
}

// ── Sub-topic planning ───────────────────────────────────────────────────

export interface SubTopic {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];          // ids of prerequisite sub-topics
  status: 'pending' | 'discussing' | 'under_review' | 'completed' | 'revisiting';
  summary: string;
  critiqueRounds: number;       // how many critique cycles so far
  discussionRounds: number;
}

export interface DiscussionPlan {
  subTopics: SubTopic[];
  currentIndex: number;
  finalSynthesis: string;
  conflicts: string[];
}

// ── Messages ─────────────────────────────────────────────────────────────

export type MessageRole = 'agent' | 'user' | 'planner' | 'critic' | 'system' | 'summary';

export interface Message {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  timestamp: number;
  type: MessageRole;
  subTopicId?: string;
  color?: string;
  emoji?: string;
}

// ── Session ──────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  topic: string;
  agents: AgentConfig[];
  plan: DiscussionPlan | null;
  messages: Message[];
  status: 'setup' | 'planning' | 'running' | 'paused' | 'completed';
  createdAt: number;
  sseClients: Set<Response>;
  /** Private reasoning per agent — only visible to the agent who produced it */
  agentReasoning: Record<string, string[]>;
}

// ── LLM ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
