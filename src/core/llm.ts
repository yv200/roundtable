import { streamText, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ChatMessage } from './types.js';

const BASE_URL = () => process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const API_KEY = () => process.env.LLM_API_KEY || '';
const MODEL_ID = () => process.env.LLM_MODEL || 'gpt-4o';

function isAnthropicModel(): boolean {
  return /claude/i.test(MODEL_ID());
}

function getModel(): LanguageModel {
  if (isAnthropicModel()) {
    const anthropic = createAnthropic({
      baseURL: BASE_URL(),
      apiKey: API_KEY(),
    });
    return anthropic(MODEL_ID());
  } else {
    const openai = createOpenAI({
      baseURL: BASE_URL(),
      apiKey: API_KEY(),
    });
    return openai(MODEL_ID());
  }
}

/** Strip markdown code fences and parse JSON robustly */
export function parseJSONResponse(text: string): any {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  return JSON.parse(cleaned);
}

/** Non-streaming: internally streams to avoid proxy timeouts, returns full text */
export async function chatCompletion(
  messages: ChatMessage[],
  options?: { temperature?: number },
): Promise<string> {
  const { text } = await streamText({
    model: getModel(),
    messages,
    temperature: options?.temperature ?? 0.7,
  });
  return text;
}

/** Streaming completion — yields text chunks */
export async function* streamChatCompletion(
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const result = streamText({
    model: getModel(),
    messages,
    temperature: 0.7,
  });
  for await (const chunk of result.textStream) {
    yield chunk;
  }
}
