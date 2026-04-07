import type { AgentConfig, ChatMessage, Message, Session, Phase } from '../../core/types.js';
import { getLanguageInstruction } from '../../core/types.js';
import { chatCompletion, streamChatCompletion, parseJSONResponse } from '../../core/llm.js';

// ── Discussion-specific types ────────────────────────────────────────────

export interface SubTopic {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  status: 'pending' | 'discussing' | 'under_review' | 'completed' | 'revisiting';
  summary: string;
  critiqueRounds: number;
  discussionRounds: number;
}

export interface DiscussionPlan {
  subTopics: SubTopic[];
  currentIndex: number;
  finalSynthesis: string;
  conflicts: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F8B500'];
const EMOJIS = ['🔬', '💡', '⚖️', '🎯', '🌍', '🔮', '📊', '🧩'];

// ── Create full plan: agents + sub-topics → Phases ───────────────────────

export async function createPlan(
  topic: string,
  agentPreference?: string,
  config?: Record<string, any>,
): Promise<{ agents: AgentConfig[]; plan: DiscussionPlan; phases: Phase[] }> {
  const langInst = getLanguageInstruction(config || {});
  const system = `You are a research discussion planner. Given a topic, you must:

1. Design 3-5 discussion panel members with DISTINCT perspectives
2. Break the topic into 3-6 sequential sub-topics that build on each other

Each agent MUST have a unique speaking style. Do NOT make them all sound like polite academics. Mix it up:
- Some are blunt and data-driven ("show me the numbers or I don't buy it")
- Some think in analogies and stories
- Some are skeptical and love poking holes
- Some are big-picture visionaries
- Some are pragmatic practitioners who care about "does it actually work?"

Also give agents built-in TENSIONS: at least 2 agents should have perspectives that naturally clash.

Respond in strict JSON (no markdown fences):
{
  "agents": [
    {
      "name": "Display Name (short, memorable)",
      "gender": "male or female — MUST match the name and identity of the character",
      "role": "One-line role title",
      "perspective": "What unique angle this agent brings (1-2 sentences)",
      "speakingStyle": "How this agent communicates: tone, structure, verbal habits. Be specific."
    }
  ],
  "subTopics": [
    {
      "title": "Sub-topic title",
      "goal": "Specific question or insight goal for this sub-topic",
      "dependsOn": []
    }
  ]
}

The sub-topics should progress from foundational understanding → analysis → synthesis → actionable conclusions.${langInst}`;

  const user = agentPreference
    ? `Topic: ${topic}\n\nPanel preferences: ${agentPreference}`
    : `Topic: ${topic}`;

  const raw = await chatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.7 },
  );

  const parsed = parseJSONResponse(raw);

  const agents: AgentConfig[] = parsed.agents.map((a: any, i: number) => ({
    id: `agent-${i}`,
    name: a.name,
    gender: a.gender === 'female' ? 'female' : 'male' as const,
    role: a.role,
    perspective: a.perspective,
    speakingStyle: a.speakingStyle || '',
    color: COLORS[i % COLORS.length],
    emoji: EMOJIS[i % EMOJIS.length],
  }));

  const subTopics: SubTopic[] = parsed.subTopics.map((st: any, i: number) => ({
    id: `st-${i}`,
    title: st.title,
    goal: st.goal,
    dependsOn: st.dependsOn || [],
    status: 'pending' as const,
    summary: '',
    critiqueRounds: 0,
    discussionRounds: 0,
  }));

  const plan: DiscussionPlan = {
    subTopics,
    currentIndex: 0,
    finalSynthesis: '',
    conflicts: [],
  };

  // Convert subTopics → Phases + synthesis phase
  const phases: Phase[] = subTopics.map((st, i) => ({
    id: st.id,
    type: 'subtopic',
    label: st.title,
    status: 'pending' as const,
    metadata: {
      index: i,
      title: st.title,
      goal: st.goal,
      summary: '',
      critiqueRounds: 0,
      discussionRounds: 0,
    },
  }));

  phases.push({
    id: 'synthesis',
    type: 'synthesis',
    label: 'Final Synthesis',
    status: 'pending',
    metadata: {},
  });

  return { agents, plan, phases };
}

// ── Introduce a sub-topic ────────────────────────────────────────────────

export async function introduceSubTopic(
  subTopicData: { title: string; goal: string },
  session: Session,
): Promise<string> {
  const previousSummaries = session.phases
    .filter(p => p.type === 'subtopic' && p.status === 'resolved')
    .map(p => `【${p.metadata.title}】${p.metadata.summary}`)
    .join('\n');

  const system = `You are the discussion planner/moderator. Introduce the next sub-topic to the panel.

Your introduction should:
1. Briefly state what this sub-topic is about and WHY it matters
2. Frame 1-2 specific questions the panel should address
3. If previous sub-topics have been discussed, connect this one to those findings
4. Keep it concise (2-3 short paragraphs)

Do NOT give your own opinion — just frame the discussion for others.${getLanguageInstruction(session.config)}`;

  const context = previousSummaries
    ? `Previous sub-topic conclusions:\n${previousSummaries}\n\n`
    : '';

  const user = `${context}Now introduce this sub-topic:\nTitle: ${subTopicData.title}\nGoal: ${subTopicData.goal}`;

  return chatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.5 },
  );
}

// ── Review sub-topic completion ──────────────────────────────────────────

export async function reviewSubTopic(
  subTopicData: { title: string; goal: string },
  messages: Message[],
  phaseId: string,
): Promise<{ complete: boolean; summary: string; feedback: string }> {
  const discussion = messages
    .filter(m => m.phaseId === phaseId && (m.type === 'agent' || m.type === 'critic'))
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  const system = `You are the discussion planner reviewing whether a sub-topic has been adequately discussed.

Sub-topic: ${subTopicData.title}
Goal: ${subTopicData.goal}

Evaluate:
1. Has the goal been addressed with sufficient depth?
2. Were multiple perspectives considered?
3. Are there actionable insights or clear conclusions?
4. Are there critical gaps that MUST be addressed before moving on?

Respond in strict JSON:
{
  "complete": true/false,
  "summary": "2-3 sentence distillation of the key conclusions reached (write this even if incomplete)",
  "feedback": "If incomplete: what specifically is missing. If complete: brief note on quality."
}`;

  const raw = await chatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: `Discussion so far:\n${discussion}` }],
    { temperature: 0.3 },
  );

  return parseJSONResponse(raw);
}

// ── Final synthesis ──────────────────────────────────────────────────────

export function synthesizeFinal(session: Session): AsyncGenerator<string> {
  const subTopicSummaries = session.phases
    .filter(p => p.type === 'subtopic')
    .map(p => `### ${p.metadata.title}\n**Goal:** ${p.metadata.goal}\n**Conclusion:** ${p.metadata.summary || 'N/A'}`)
    .join('\n\n');

  const agentList = session.agents.map(a => `${a.emoji} ${a.name} — ${a.role}`).join('\n');

  const system = `You are the discussion planner writing the final comprehensive research report.

Topic: ${session.config.topic}

Panel:
${agentList}

Sub-topic conclusions:
${subTopicSummaries}

Write a well-structured final report that:
1. Executive summary (2-3 sentences)
2. For each sub-topic: key findings and how they connect
3. Cross-cutting insights that emerged from combining perspectives
4. Areas of consensus vs remaining disagreements
5. Actionable recommendations with concrete next steps
6. Open questions for future exploration

Use markdown headers and bullet points. Be thorough but concise.${getLanguageInstruction(session.config)}`;

  const msgs: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'Write the final synthesis report now.' },
  ];

  return streamChatCompletion(msgs);
}

// ── Conflict check ───────────────────────────────────────────────────────

export async function checkConflicts(
  synthesis: string,
): Promise<{ hasConflicts: boolean; conflicts: string[] }> {
  const system = `You are reviewing a discussion synthesis for internal contradictions or unresolved conflicts.

Check for:
1. Contradictory recommendations across sub-topics
2. Conclusions that undermine each other
3. Important points raised but never resolved
4. Gaps between sub-topic conclusions and final recommendations

Respond in strict JSON:
{
  "hasConflicts": true/false,
  "conflicts": ["description of each conflict (empty array if none)"]
}`;

  const raw = await chatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: synthesis }],
    { temperature: 0.2 },
  );

  return parseJSONResponse(raw);
}
