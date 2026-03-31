# 🎙️ Roundtable

Multi-agent roundtable discussion & research tool.

Multiple AI agents with distinct perspectives discuss a topic in rounds, moderated by an orchestrator that decides the flow. You watch in real-time and can pause to inject your own thoughts.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your LLM config

npm install
npm run dev
```

Open http://localhost:3210

## How It Works

1. **Enter a topic** — describe what the agents should discuss
2. **Panel generation** — orchestrator creates 3-5 agents with diverse perspectives
3. **Discussion** — agents take turns, orchestrator manages rounds and decides when to conclude
4. **Pause & inject** — pause anytime to add your thoughts, agents will factor them in
5. **Summary** — comprehensive report synthesizing all perspectives

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_BASE_URL` | OpenAI-compatible API endpoint | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API key | — |
| `LLM_MODEL` | Model to use | `gpt-4o` |
| `PORT` | Server port | `3210` |

## Architecture

```
User → Web UI → Express Server → Orchestrator → LLM API
                     ↕ SSE
              Real-time streaming
```

- **Orchestrator**: Decides who speaks next, when to start new rounds, when to conclude
- **Agents**: Each has a unique system prompt with their role/perspective
- **SSE**: Server-Sent Events for real-time message streaming
- **In-memory**: Sessions stored in memory (MVP, no persistence)

## Tech Stack

- Backend: Node.js + Express + TypeScript (via tsx)
- Frontend: Vanilla JS + CSS (no framework)
- LLM: Any OpenAI-compatible API
