import type { ModeManifest } from '../../core/types.js';
import { WerewolfMode } from './mode.js';

export const werewolfManifest: ModeManifest = {
  id: 'werewolf',
  name: 'Werewolf',
  description: 'AI 狼人杀 — Watch AI agents deceive, deduce, and eliminate each other.',
  icon: '🐺',
  configSchema: [
    {
      key: 'preset',
      type: 'select',
      label: 'Preset',
      required: true,
      default: 'standard',
      options: [
        { value: 'simple', label: 'Simple (6 players: 2🐺 + Seer + 3 Villagers)' },
        { value: 'standard', label: 'Standard (8 players: 2🐺 + Seer, Witch, Hunter + 3 Villagers)' },
        { value: 'chaos', label: 'Chaos (10 players: 3🐺 + Seer, Witch, Hunter, Guard, Fool + 2 Villagers)' },
      ],
      hint: 'Choose a role preset or customize below.',
    },
    {
      key: 'theme',
      type: 'text',
      label: 'Theme',
      required: false,
      default: 'Medieval village',
      hint: 'Setting for character generation (e.g. "cyberpunk city", "pirate ship", "ancient Chinese court")',
    },
    {
      key: 'spectatorMode',
      type: 'toggle',
      label: 'God View (Spectator Mode)',
      required: false,
      default: true,
      hint: 'Show all agents\' private reasoning and identities.',
    },
    {
      key: 'language',
      type: 'select',
      label: 'Language',
      required: false,
      default: 'zh',
      options: [
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'auto', label: 'Auto (follow theme language)' },
      ],
      hint: 'Language for game output',
    },
  ],
  create(_config) {
    return new WerewolfMode();
  },
};
