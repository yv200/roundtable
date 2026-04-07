import express from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Response as ExpressResponse } from 'express';
import type { Session } from './types.js';
import { getMode, getAllModes } from './registry.js';
import { createEngineContext, runSession } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  const sessions = new Map<string, Session>();
  const sid = () => randomUUID().slice(0, 8);
  const ctx = createEngineContext();

  const toJSON = (s: Session) => {
    const { sseClients, privateState, ...rest } = s as any;
    return rest;
  };

  // ── GET /api/modes ───────────────────────────────────────────────────

  app.get('/api/modes', (_req, res) => {
    const manifests = getAllModes().map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      icon: m.icon,
      configSchema: m.configSchema,
    }));
    res.json(manifests);
  });

  // ── POST /api/session ────────────────────────────────────────────────

  app.post('/api/session', async (req, res) => {
    // Backward compat: { topic } without mode → discussion
    const modeId = req.body.mode || 'discussion';
    let config = req.body.config || {};

    // Legacy discussion shorthand
    if (!req.body.mode && req.body.topic) {
      config = { topic: req.body.topic, agentPreference: req.body.agentPreference };
    }

    const manifest = getMode(modeId);
    if (!manifest) return res.status(400).json({ error: `Unknown mode: ${modeId}` });

    try {
      const mode = manifest.create(config);
      const result = await mode.setup(config);

      const session: Session = {
        id: sid(),
        mode: modeId,
        config,
        agents: result.agents,
        phases: result.phases,
        currentPhaseIndex: 0,
        messages: [],
        status: 'setup',
        createdAt: Date.now(),
        sseClients: new Set(),
        agentReasoning: {},
        privateState: result.privateState,
        eliminatedAgents: [],
      };
      sessions.set(session.id, session);

      // Return JSON-safe session data (+ backward compat fields)
      const json: any = toJSON(session);
      // Backward compat for discussion mode
      if (modeId === 'discussion') {
        json.topic = config.topic;
        const plan = result.privateState.get('plan');
        if (plan) json.plan = plan;
      }

      res.json(json);
    } catch (err: any) {
      console.error('Setup error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUT /api/session/:id/agents ──────────────────────────────────────

  app.put('/api/session/:id/agents', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    s.agents = req.body.agents;
    res.json({ agents: s.agents });
  });

  // ── GET /api/session/:id ─────────────────────────────────────────────

  app.get('/api/session/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    const json: any = toJSON(s);
    if (s.mode === 'discussion') {
      json.topic = s.config.topic;
      const plan = s.privateState.get('plan');
      if (plan) json.plan = plan;
    }
    res.json(json);
  });

  // ── GET /api/session/:id/stream ──────────────────────────────────────

  app.get('/api/session/:id/stream', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    s.sseClients.add(res);

    // Send init with backward-compat fields
    const initData: any = {
      mode: s.mode, config: s.config,
      agents: s.agents, phases: s.phases,
      messages: s.messages, status: s.status,
    };
    if (s.mode === 'discussion') {
      initData.topic = s.config.topic;
      const plan = s.privateState.get('plan');
      if (plan) initData.plan = plan;
    }
    res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);

    req.on('close', () => s.sseClients.delete(res));
  });

  // ── POST /api/session/:id/start ──────────────────────────────────────

  app.post('/api/session/:id/start', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.status === 'running') return res.status(400).json({ error: 'already running' });

    const manifest = getMode(s.mode);
    if (!manifest) return res.status(500).json({ error: 'mode not found' });

    s.status = 'running';
    ctx.broadcast(s, 'status', { status: 'running' });
    res.json({ status: 'running' });

    const mode = manifest.create(s.config);
    runSession(s, mode, ctx).catch(err => {
      console.error('Session error:', err);
      ctx.broadcast(s, 'error', { message: err.message });
    });
  });

  // ── POST /api/session/:id/pause ──────────────────────────────────────

  app.post('/api/session/:id/pause', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    s.status = 'paused';
    ctx.broadcast(s, 'status', { status: 'paused' });
    res.json({ status: 'paused' });
  });

  // ── POST /api/session/:id/resume ─────────────────────────────────────

  app.post('/api/session/:id/resume', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.status !== 'paused') return res.status(400).json({ error: 'not paused' });

    const manifest = getMode(s.mode);
    if (!manifest) return res.status(500).json({ error: 'mode not found' });

    s.status = 'running';
    ctx.broadcast(s, 'status', { status: 'running' });
    res.json({ status: 'running' });

    const mode = manifest.create(s.config);
    runSession(s, mode, ctx).catch(err => {
      console.error('Session error:', err);
      ctx.broadcast(s, 'error', { message: err.message });
    });
  });

  // ── POST /api/session/:id/inject ─────────────────────────────────────

  app.post('/api/session/:id/inject', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });

    const currentPhase = s.phases[s.currentPhaseIndex];
    const phaseId = currentPhase?.id;
    const msg = ctx.addMsg(s, 'user', 'You', req.body.message, phaseId);
    res.json(msg);
  });

  return app;
}
