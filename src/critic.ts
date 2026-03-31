import type { ChatMessage, Message, Session, SubTopic } from './types.js';
import { chatCompletion, parseJSONResponse } from './llm.js';

// ── Critique a round of discussion ───────────────────────────────────────

export async function critique(
  subTopic: SubTopic,
  messages: Message[],
  session: Session,
): Promise<{ approved: boolean; feedback: string; targets: CritiqueTarget[] }> {
  const agentList = session.agents.map(a => `${a.id}="${a.name}" (${a.role})`).join(', ');

  const recentDiscussion = messages
    .filter(m => m.subTopicId === subTopic.id && (m.type === 'agent' || m.type === 'user'))
    .slice(-session.agents.length * 2) // last 2 rounds worth
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  const system = `You are a brutally honest discussion critic. You are the quality firewall — nothing sloppy gets past you. Your job is NOT to be polite. Your job is to make the discussion BETTER.

Sub-topic: ${subTopic.title}
Goal: ${subTopic.goal}
Agents: ${agentList}
Critique round: ${subTopic.critiqueRounds + 1}

Evaluate the discussion against these criteria (in order of severity):

1. **ECHO CHAMBER** (most common, catch it aggressively):
   - Are agents just restating each other's points in different words?
   - Is everyone agreeing? That's suspicious. Real experts disagree.
   - Did anyone challenge a claim or offer a genuinely different perspective?
   - "感谢XX的精彩分享" followed by the same point = echo chamber. Call it out.

2. **EMPTY CLAIMS**:
   - Claims without specific evidence, data, or concrete examples
   - Namedropping companies without explaining what they actually did or what the results were
   - "显著提升" / "大幅降低" without numbers = empty claim

3. **WEAK CONCLUSIONS**:
   - "各有优劣" / "需要综合考虑" without specifying conditions
   - Generic advice anyone could give without expertise
   - No actionable takeaway

4. **LOGICAL GAPS**: Non-sequiturs, missing reasoning steps, contradictions

5. **MISSED DIMENSIONS**: Important angles nobody raised

When targeting agents:
- Be BLUNT about what's wrong: "你说了'显著提升效率'但没给任何数据，这在讨论中等于没说"
- Be SPECIFIC about what you want: "给出至少一个真实案例的具体数字（成本降低X%、效率提升X倍）"
- If everyone agreed too easily, pick the agent whose perspective SHOULD have led to disagreement and ask them to actually challenge the others

${subTopic.critiqueRounds >= 2 ? 'NOTE: This is critique round ' + (subTopic.critiqueRounds + 1) + '. Be more lenient — approve if core points are addressed.' : ''}

Respond in strict JSON:
{
  "approved": true/false,
  "feedback": "Blunt 1-2 sentence verdict. Don't sugarcoat.",
  "targets": [
    {
      "agentId": "agent-id or agent name",
      "issue": "Specific problem, directly stated",
      "request": "Exactly what they need to fix, no vague 'go deeper'"
    }
  ]
}

If approved, targets should be empty. Only approve if the discussion genuinely addressed the sub-topic goal with substance.`;

  const raw = await chatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: `Discussion to review:\n${recentDiscussion}` }],
    { temperature: 0.5 },
  );

  return parseJSONResponse(raw);
}

export interface CritiqueTarget {
  agentId: string;
  issue: string;
  request: string;
}
