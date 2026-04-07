// ── Role definitions ─────────────────────────────────────────────────────

export type RoleId = 'werewolf' | 'villager' | 'seer' | 'witch' | 'hunter' | 'guard' | 'fool';
export type Team = 'wolf' | 'village';

export interface RoleConfig {
  id: RoleId;
  name: string;
  nameZh: string;
  team: Team;
  emoji: string;
  hasNightAction: boolean;
  nightOrder: number;    // lower = earlier in the night
  description: string;
}

export const ROLES: Record<RoleId, RoleConfig> = {
  werewolf: {
    id: 'werewolf', name: 'Werewolf', nameZh: '狼人',
    team: 'wolf', emoji: '🐺', hasNightAction: true, nightOrder: 20,
    description: 'Kills one villager each night. Must blend in during the day.',
  },
  villager: {
    id: 'villager', name: 'Villager', nameZh: '村民',
    team: 'village', emoji: '🧑‍🌾', hasNightAction: false, nightOrder: 99,
    description: 'No special ability. Uses logic and observation to find wolves.',
  },
  seer: {
    id: 'seer', name: 'Seer', nameZh: '预言家',
    team: 'village', emoji: '🔮', hasNightAction: true, nightOrder: 40,
    description: 'Checks one player\'s identity each night.',
  },
  witch: {
    id: 'witch', name: 'Witch', nameZh: '女巫',
    team: 'village', emoji: '🧪', hasNightAction: true, nightOrder: 30,
    description: 'Has one save potion and one poison potion (each usable once per game).',
  },
  hunter: {
    id: 'hunter', name: 'Hunter', nameZh: '猎人',
    team: 'village', emoji: '🏹', hasNightAction: false, nightOrder: 99,
    description: 'On death, can take one player with them.',
  },
  guard: {
    id: 'guard', name: 'Guard', nameZh: '守卫',
    team: 'village', emoji: '🛡️', hasNightAction: true, nightOrder: 10,
    description: 'Protects one player each night. Cannot protect the same player two nights in a row.',
  },
  fool: {
    id: 'fool', name: 'Fool', nameZh: '白痴',
    team: 'village', emoji: '🤡', hasNightAction: false, nightOrder: 99,
    description: 'If voted out, reveals identity and stays alive (but loses voting rights).',
  },
};

// ── Presets ───────────────────────────────────────────────────────────────

export interface PresetConfig {
  playerCount: number;
  roles: RoleId[];
  label: string;
}

export const PRESETS: Record<string, PresetConfig> = {
  simple: {
    playerCount: 6,
    label: 'Simple (6 players)',
    roles: ['werewolf', 'werewolf', 'seer', 'villager', 'villager', 'villager'],
  },
  standard: {
    playerCount: 8,
    label: 'Standard (8 players)',
    roles: ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'],
  },
  chaos: {
    playerCount: 10,
    label: 'Chaos (10 players)',
    roles: ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'guard', 'fool', 'villager', 'villager'],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
