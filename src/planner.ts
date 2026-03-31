import type { AgentConfig, ChatMessage, DiscussionPlan, Message, Session, SubTopic } from './types.js';
import { chatCompletion, streamChatCompletion, parseJSONResponse } from './llm.js';

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F8B500'];
const EMOJIS = ['🔬', '💡', '⚖️', '🎯', '🌍', '🔮', '📊', '🧩'];

// ── Create full plan: agents + sub-topics ────────────────────────────────

export async function createPlan(
  topic: string,
  agentPreference?: string,
): Promise<{ agents: AgentConfig[]; plan: DiscussionPlan }> {
  const system = `You are a research discussion planner. Given a topic, you must:

1. Design 3-5 discussion panel members with DISTINCT perspectives
2. Break the topic into 3-6 sequential sub-topics that build on each other

Each agent MUST have a unique speaking style. Do NOT make them all sound like polite academics. Mix it up:
- Some are blunt and data-driven ("show me the numbers or I don't buy it")
- Some think in analogies and stories
- Some are skeptical and love poking holes
- Some are big-picture visionaries
- Some are pragmatic practitioners who care about "does it actually work?"

Also give agents built-in TENSIONS: at least 2 agents should have perspectives that naturally clash. For example, an innovation advocate vs. a risk manager; a cost optimizer vs. a quality purist.

Respond in strict JSON (no markdown fences):
{
  "agents": [
    {
      "name": "Display Name (short, memorable)",
      "role": "One-line role title",
      "perspective": "What unique angle this agent brings (1-2 sentences)",
      "speakingStyle": "How this agent communicates: tone, structure, verbal habits. Be specific. e.g. 'Blunt and numbers-obsessed. Opens with data, distrusts abstract claims. Often says things like 没有数据支撑的观点就是空谈. Uses short punchy sentences.' or 'Storyteller who thinks in analogies. Tends to say 这让我想起一个案例... Warm but will quietly dismantle weak arguments with pointed questions.'"
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

The sub-topics should progress from foundational understanding → analysis → synthesis → actionable conclusions.`;

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

  return {
    agents,
    plan: { subTopics, currentIndex: 0, finalSynthesis: '', conflicts: [] },
  };
}

// ── Introduce a sub-topic ────────────────────────────────────────────────

export async function introduceSubTopic(
  subTopic: SubTopic,
  session: Session,
): Promise<string> {
  const previousSummaries = session.plan!.subTopics
    .filter(st => st.status === 'completed')
    .map(st => `【${st.title}】${st.summary}`)
    .join('\n');

  const system = `You are the discussion planner/moderator. Introduce the next sub-topic to the panel.

Your introduction should:
1. Briefly state what this sub-topic is about and WHY it matters
2. Frame 1-2 specific questions the panel should address
3. If previous sub-topics have been discussed, connect this one to those findings
4. Keep it concise (2-3 short paragraphs)

Do NOT give your own opinion — just frame the discussion for others.`;

  const context = previousSummaries
    ? `Previous sub-topic conclusions:\n${previousSummaries}\n\n`
    : '';

  const user = `${context}Now introduce this sub-topic:\nTitle: ${subTopic.title}\nGoal: ${subTopic.goal}`;

  return chatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.5 },
  );
}

// ── Review sub-topic completion ──────────────────────────────────────────

export async function reviewSubTopic(
  subTopic: SubTopic,
  messages: Message[],
  session: Session,
): Promise<{ complete: boolean; summary: string; feedback: string }> {
  const discussion = messages
    .filter(m => m.subTopicId === subTopic.id && (m.type === 'agent' || m.type === 'critic'))
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  const system = `You are the discussion planner reviewing whether a sub-topic has been adequately discussed.

Sub-topic: ${subTopic.title}
Goal: ${subTopic.goal}

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
  const subTopicSummaries = session.plan!.subTopics
    .map(st => `### ${st.title}\n**Goal:** ${st.goal}\n**Conclusion:** ${st.summary}`)
    .join('\n\n');

  const agentList = session.agents.map(a => `${a.emoji} ${a.name} — ${a.role}`).join('\n');

  const system = `You are the discussion planner writing the final comprehensive research report.

Topic: ${session.topic}

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

Use markdown headers and bullet points. Be thorough but concise. Focus on INSIGHTS that emerged from the multi-perspective discussion, not just restating individual opinions.`;

  const msgs: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'Write the final synthesis report now.' },
  ];

  return streamChatCompletion(msgs);
}

// ── Conflict check ───────────────────────────────────────────────────────

export async function checkConflicts(
  synthesis: string,
  session: Session,
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
