import type { ModeManifest } from '../../core/types.js';
import { DiscussionMode } from './mode.js';

export const discussionManifest: ModeManifest = {
  id: 'discussion',
  name: 'Discussion',
  description: 'Multi-agent structured research discussion with automated critique and synthesis.',
  icon: '🎙️',
  configSchema: [
    {
      key: 'topic',
      type: 'text',
      label: 'Topic',
      required: true,
      hint: 'What should the agents research and discuss?',
    },
    {
      key: 'agentPreference',
      type: 'text',
      label: 'Panel Preferences',
      required: false,
      hint: 'Optional: e.g. "Include an economist and a skeptic"',
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
        { value: 'auto', label: 'Auto (follow topic language)' },
      ],
      hint: 'Language for discussion output',
    },
  ],
  create(_config) {
    return new DiscussionMode();
  },
};
