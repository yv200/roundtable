import type { ChatMessage, Message, Session } from '../../core/types.js';
import { getLanguageInstruction } from '../../core/types.js';
import { chatCompletion, parseJSONResponse } from '../../core/llm.js';

export interface CritiqueTarget {
  agentId: string;
  issue: string;
  request: string;
}

export async function critique(
  subTopicData: { title: string; goal: string; critiqueRounds: number },
  messages: Message[],
  session: Session,
  phaseId: string,
): Promise<{ approved: boolean; feedback: string; targets: CritiqueTarget[] }> {
  const agentList = session.agents.map(a => `${a.id}="${a.name}" (${a.role})`).join(', ');

  const recentDiscussion = messages
    .filter(m => m.phaseId === phaseId && (m.type === 'agent' || m.type === 'user'))
    .slice(-session.agents.length * 2)
    .map(m => `[${m.agentName}]: ${m.content}`)
    .join('\n\n');

  const system = `You are a brutally honest discussion critic. You are the quality firewall — nothing sloppy gets past you. Your job is NOT to be polite. Your job is to make the discussion BETTER.

Sub-topic: ${subTopicData.title}
Goal: ${subTopicData.goal}
Agents: ${agentList}
Critique round: ${subTopicData.critiqueRounds + 1}

Evaluate the discussion against these criteria (in order of severity):

1. **ECHO CHAMBER** (most common, catch it aggressively):
   - Are agents just restating each other's points in different words?
   - Is everyone agreeing? That's suspicious. Real experts disagree.
   - Did anyone challenge a claim or offer a genuinely different perspective?

2. **EMPTY CLAIMS**:
   - Claims without specific evidence, data, or concrete examples
   - "显著提升" / "大幅降低" without numbers = empty claim

3. **WEAK CONCLUSIONS**:
   - "各有优劣" / "需要综合考虑" without specifying conditions
   - Generic advice anyone could give without expertise

4. **LOGICAL GAPS**: Non-sequiturs, missing reasoning steps, contradictions

5. **MISSED DIMENSIONS**: Important angles nobody raised

When targeting agents:
- Be BLUNT about what's wrong
- Be SPECIFIC about what you want

${subTopicData.critiqueRounds >= 2 ? 'NOTE: This is critique round ' + (subTopicData.critiqueRounds + 1) + '. Be more lenient — approve if core points are addressed.' : ''}

Respond in strict JSON:
{
  "approved": true/false,
  "feedback": "Blunt 1-2 sentence verdict.",
  "targets": [
    {
      "agentId": "agent-id or agent name",
      "issue": "Specific problem",
      "request": "Exactly what they need to fix"
    }
  ]
}

If approved, targets should be empty.${getLanguageInstruction(session.config)}`;

  const raw = await chatCompletion(
    [{ role: 'system', content: system }, { role: 'user', content: `Discussion to review:\n${recentDiscussion}` }],
    { temperature: 0.5 },
  );

  return parseJSONResponse(raw);
}
