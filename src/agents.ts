import type { AgentConfig, ChatMessage, Message, Session, SubTopic } from './types.js';
import type { ResearchResult } from './research.js';
import { chatCompletion, streamChatCompletion } from './llm.js';

function formatResearch(research: ResearchResult | null): string {
  if (!research) return '';
  const citationList = research.citations.length
    ? '\nSources:\n' + research.citations.map((c, i) => `[${i + 1}] ${c}`).join('\n')
    : '';
  return `\n\n--- WEB RESEARCH (use this data to support your arguments) ---\n${research.content}${citationList}\n--- END RESEARCH ---`;
}

// ── Private reasoning (not shared with other agents) ─────────────────────

export async function getAgentReasoning(
  agent: AgentConfig,
  session: Session,
  subTopic: SubTopic,
  prompt: string,
  research: ResearchResult | null = null,
): Promise<string> {
  // ISOLATION: Only public statements — no other agents' system prompts or reasoning
  const publicStatements = session.messages
    .filter(m => m.subTopicId === subTopic.id && (m.type === 'agent' || m.type === 'critic' || m.type === 'planner'))
    .slice(-12)
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  // This agent's OWN previous reasoning (others can't see this)
  const ownPrevReasoning = (session.agentReasoning[agent.id] || []).slice(-2).join('\n---\n');

  const previousSummaries = session.plan!.subTopics
    .filter(st => st.status === 'completed')
    .map(st => `【${st.title}】${st.summary}`)
    .join('\n');

  const system = `You are ${agent.name}, preparing your thoughts PRIVATELY before speaking publicly.
Role: ${agent.role}
Perspective: ${agent.perspective}

Current sub-topic: ${subTopic.title}
Goal: ${subTopic.goal}
${previousSummaries ? `\nPrevious sub-topic conclusions:\n${previousSummaries}\n` : ''}
This is your PRIVATE reasoning space. No one else will see this. Be brutally honest.
${research ? `\nYou have web research available — USE IT. Cite specific data, numbers, and sources to build stronger arguments. Reference sources as [1], [2] etc.` : ''}
Analyze the discussion and plan your response:
1. **What are the strongest points others made?** Be specific — who said what.
2. **Where are the weak spots or things you disagree with?** Why exactly?
3. **What's YOUR unique angle that hasn't been covered?** Don't repeat existing points.
4. **What specific claim will you challenge, and with what evidence/logic?**${research ? '\n5. **What data from your research supports your position?** Cite specifics.' : ''}
${research ? '6' : '5'}. **What's your core position?** One sentence.
${research ? '7' : '6'}. **How will you express this in your personal style?** Plan your delivery.

Think critically. Acknowledge where you might be wrong. Identify the most interesting tension or gap in the discussion so far.`;

  const msgs: ChatMessage[] = [
    { role: 'system', content: system },
  ];

  if (ownPrevReasoning) {
    msgs.push({ role: 'user', content: `Your earlier private notes:\n${ownPrevReasoning}` });
  }

  if (publicStatements) {
    msgs.push({ role: 'user', content: `Public discussion so far:\n${publicStatements}` });
  }

  const researchBlock = formatResearch(research);
  msgs.push({ role: 'user', content: `Moderator's direction for you: ${prompt}${researchBlock}\n\nWrite your private analysis now.` });

  return chatCompletion(msgs, { temperature: 0.7 });
}

// ── Public agent response (streaming) ────────────────────────────────────

export function getAgentResponse(
  agent: AgentConfig,
  session: Session,
  subTopic: SubTopic,
  prompt: string,
  reasoning: string,
  research: ResearchResult | null = null,
): AsyncGenerator<string> {
  // ISOLATION: Only public statements from others — no system prompts, no private reasoning
  const publicStatements = session.messages
    .filter(m => m.subTopicId === subTopic.id && (m.type === 'agent' || m.type === 'critic' || m.type === 'planner'))
    .slice(-10)
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  const previousSummaries = session.plan!.subTopics
    .filter(st => st.status === 'completed')
    .map(st => `【${st.title}】${st.summary}`)
    .join('\n');

  const system = `You are ${agent.name}, speaking publicly in a roundtable discussion.
Role: ${agent.role}
Perspective: ${agent.perspective}
${agent.speakingStyle ? `\nYOUR SPEAKING STYLE: ${agent.speakingStyle}\nThis is your voice — own it. Do NOT sound like a generic AI assistant.\n` : ''}
Current sub-topic: ${subTopic.title}
Goal: ${subTopic.goal}
${previousSummaries ? `\nPrevious conclusions:\n${previousSummaries}\n` : ''}
You've already done your private analysis (shown below). Now write your PUBLIC statement.

RULES:
1. ENGAGE with specific points others made. Name them, quote them, respond to them.
2. CHALLENGE ideas you disagree with. Be honest, not polite.
3. Don't start with "感谢" or "谢谢". Just dive in.
4. Have a CLEAR POSITION. Defend it.
5. 2-3 paragraphs. Conversation, not lecture.
6. Do NOT reveal that you had a private reasoning step. Just present your arguments naturally.
${research ? '7. CITE DATA from your research. Use [1], [2] etc. to reference sources. Back claims with real numbers.' : ''}
AVOID: "首先...其次...总之" every time. Vary your format.`;

  const msgs: ChatMessage[] = [
    { role: 'system', content: system },
  ];

  if (publicStatements) {
    msgs.push({ role: 'user', content: `Public discussion so far:\n${publicStatements}` });
  }

  msgs.push({
    role: 'user',
    content: `[Your private analysis — for your eyes only, do not quote or reference this directly]\n${reasoning}`,
  });

  const researchBlock = formatResearch(research);
  msgs.push({ role: 'user', content: `Now write your public statement.${researchBlock}` });

  return streamChatCompletion(msgs);
}

// ── Agent response to critic (with reasoning) ────────────────────────────

export async function getAgentCritiqueReasoning(
  agent: AgentConfig,
  session: Session,
  subTopic: SubTopic,
  issue: string,
  request: string,
): Promise<string> {
  const publicStatements = session.messages
    .filter(m => m.subTopicId === subTopic.id && (m.type === 'agent' || m.type === 'critic'))
    .slice(-8)
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  const system = `You are ${agent.name}, privately analyzing criticism of your argument.
Role: ${agent.role}
Perspective: ${agent.perspective}

PRIVATE ANALYSIS — be honest with yourself:
1. Is the critic right? Where specifically?
2. Where is the critic wrong or missing context?
3. What evidence or reasoning can you use to respond?
4. Should you concede, partially agree, or push back? Why?
5. Can you use other agents' points to strengthen your response?`;

  const msgs: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Discussion:\n${publicStatements}\n\n---\nCritic's issue: ${issue}\nCritic's request: ${request}\n\nAnalyze privately.` },
  ];

  return chatCompletion(msgs, { temperature: 0.7 });
}

export function getAgentCritiqueResponse(
  agent: AgentConfig,
  session: Session,
  subTopic: SubTopic,
  issue: string,
  request: string,
  reasoning: string,
): AsyncGenerator<string> {
  const publicStatements = session.messages
    .filter(m => m.subTopicId === subTopic.id && (m.type === 'agent' || m.type === 'critic'))
    .slice(-8)
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  const system = `You are ${agent.name}.
Role: ${agent.role}
Perspective: ${agent.perspective}
${agent.speakingStyle ? `\nYOUR SPEAKING STYLE: ${agent.speakingStyle}\nStay in character.\n` : ''}
The critic challenged your argument. Respond publicly based on your private analysis.

RULES:
1. If you were wrong, own it clearly. If you disagree, push back with evidence.
2. Be specific — cite data, examples, or reasoning. No hand-waving.
3. Keep it concise — 1-2 focused paragraphs.
4. Don't reveal your private reasoning process.`;

  const msgs: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Discussion:\n${publicStatements}\n\n---\nCritic's issue: ${issue}\nCritic's request: ${request}` },
    { role: 'user', content: `[Your private analysis]\n${reasoning}\n\nNow write your public response.` },
  ];

  return streamChatCompletion(msgs);
}
