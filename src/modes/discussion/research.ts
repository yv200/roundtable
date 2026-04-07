import type { AgentConfig } from '../../core/types.js';

export interface ResearchResult {
  query: string;
  content: string;
  citations: string[];
}

const SEARCH_BASE_URL = () => process.env.SEARCH_BASE_URL || '';
const SEARCH_API_KEY = () => process.env.SEARCH_API_KEY || '';
const SEARCH_MODEL = () => process.env.SEARCH_MODEL || 'sonar-pro';

export function searchEnabled(): boolean {
  return !!(SEARCH_BASE_URL() && SEARCH_API_KEY());
}

export async function webSearch(query: string): Promise<ResearchResult> {
  const baseUrl = SEARCH_BASE_URL().replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SEARCH_API_KEY()}`,
    },
    body: JSON.stringify({
      model: SEARCH_MODEL(),
      messages: [
        {
          role: 'system',
          content: 'You are a research assistant. Provide factual, data-rich answers with specific numbers, dates, and sources. Be concise but thorough. Focus on recent and authoritative information.',
        },
        { role: 'user', content: query },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Search API error ${res.status}: ${body}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content || '';
  const citations: string[] = data.citations || [];

  return { query, content, citations };
}

export async function agentResearch(
  agent: AgentConfig,
  subTopicData: { title: string; goal: string },
  topic: string,
): Promise<ResearchResult | null> {
  if (!searchEnabled()) return null;

  const query = `${subTopicData.title} — ${subTopicData.goal}\n\nFocus: ${agent.role} perspective (${agent.perspective}).\nBroader topic: ${topic}`;

  try {
    return await webSearch(query);
  } catch (err: any) {
    console.error(`[Research] Search failed for ${agent.name}:`, err.message);
    return null;
  }
}
