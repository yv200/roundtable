import type { ModeManifest } from './types.js';

const modes = new Map<string, ModeManifest>();

export function registerMode(manifest: ModeManifest): void {
  modes.set(manifest.id, manifest);
}

export function getMode(id: string): ModeManifest | undefined {
  return modes.get(id);
}

export function getAllModes(): ModeManifest[] {
  return [...modes.values()];
}
