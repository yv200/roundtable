import 'dotenv/config';
import { createApp } from './core/server.js';
import { registerMode } from './core/registry.js';
import { discussionManifest } from './modes/discussion/manifest.js';
import { werewolfManifest } from './modes/werewolf/manifest.js';

// ── Register modes ───────────────────────────────────────────────────────

registerMode(discussionManifest);
registerMode(werewolfManifest);

// ── Start ────────────────────────────────────────────────────────────────

const app = createApp();
const PORT = parseInt(process.env.PORT || '3210');
app.listen(PORT, () => console.log(`\n🎙️  Roundtable v2 running at http://localhost:${PORT}\n`));
