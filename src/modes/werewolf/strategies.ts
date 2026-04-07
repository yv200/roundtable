/**
 * Werewolf Strategy System
 * 
 * - Skills (markdown files) contain strategy knowledge per role
 * - analyzeGameState() reads the current game situation
 * - getStrategyPrompt() loads the right skill + generates situational advice
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Session, AgentConfig } from '../../core/types.js';
import { getAliveAgents, getWolves, getAgentRole, agentName } from './rules.js';
import { ROLES, type RoleId } from './roles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', '..', '..', 'src', 'modes', 'werewolf', 'skills');

// ── Skill file loader (cached) ──────────────────────────────────────────

const skillCache = new Map<string, string>();

function loadSkill(name: string): string {
  if (skillCache.has(name)) return skillCache.get(name)!;
  try {
    const text = readFileSync(join(SKILLS_DIR, `${name}.md`), 'utf-8');
    skillCache.set(name, text);
    return text;
  } catch {
    return '';
  }
}

function getSkillForRole(role: RoleId): string {
  const isWolf = ROLES[role].team === 'wolf';
  if (isWolf) return loadSkill('wolf');
  if (role === 'seer') return loadSkill('seer');
  if (role === 'witch') return loadSkill('witch');
  if (role === 'hunter') return loadSkill('hunter');
  if (role === 'guard') return loadSkill('guard');
  return loadSkill('villager');
}

// ── Game state analysis ─────────────────────────────────────────────────

export interface GameSituation {
  dayNum: number;
  aliveCount: number;
  wolfCount: number;
  goodCount: number;
  isFirstDay: boolean;
  isLateGame: boolean;
  isCritical: boolean;
  seerClaims: string[];
  hasCounterClaim: boolean;
  wolfAccusations: Array<{ accuser: string; target: string }>;
  goodVerifications: Array<{ accuser: string; target: string }>;
  iAmAccused: boolean;
  teammateAccused: boolean;
  eliminatedWolves: string[];
  eliminatedGood: string[];
}

export function analyzeGameState(
  agent: AgentConfig, session: Session, phaseId: string, role: RoleId, dayNum: number,
): GameSituation {
  const isWolf = ROLES[role].team === 'wolf';
  const alive = getAliveAgents(session);
  const aliveCount = alive.length;
  const wolfCount = alive.filter(id => getAgentRole(session, id) === 'werewolf').length;
  const goodCount = aliveCount - wolfCount;

  const seerClaims: string[] = [];
  const wolfAccusations: Array<{ accuser: string; target: string }> = [];
  const goodVerifications: Array<{ accuser: string; target: string }> = [];

  for (const msg of session.messages) {
    if (msg.type !== 'agent') continue;
    const text = msg.content;
    const lower = text.toLowerCase();

    const isSeerClaim = (
      (lower.includes('预言家') && (lower.includes('我是') || lower.includes('我就是'))) ||
      lower.includes('i am the seer') || lower.includes('i\'m the seer')
    );
    if (isSeerClaim && !seerClaims.includes(msg.agentId)) {
      seerClaims.push(msg.agentId);
    }

    const isWolfAccusation = (
      lower.includes('查杀') || lower.includes('是狼') ||
      lower.includes('is a wolf') || lower.includes('wolf result') || lower.includes('checked')
    );
    const isGoodVerification = (
      lower.includes('金水') || lower.includes('是好人') ||
      lower.includes('is good') || lower.includes('verified good')
    );

    if (isWolfAccusation || isGoodVerification) {
      for (const a of session.agents) {
        if (text.includes(a.name) && a.id !== msg.agentId) {
          if (isWolfAccusation) wolfAccusations.push({ accuser: msg.agentId, target: a.id });
          if (isGoodVerification) goodVerifications.push({ accuser: msg.agentId, target: a.id });
        }
      }
    }
  }

  const iAmAccused = wolfAccusations.some(a => a.target === agent.id);
  const teammateAccused = isWolf && wolfAccusations.some(a =>
    getWolves(session).includes(a.target) && a.target !== agent.id
  );

  return {
    dayNum, aliveCount, wolfCount, goodCount,
    isFirstDay: dayNum === 1,
    isLateGame: aliveCount <= 4,
    isCritical: wolfCount >= goodCount - 1,
    seerClaims, hasCounterClaim: seerClaims.length >= 2,
    wolfAccusations, goodVerifications,
    iAmAccused, teammateAccused,
    eliminatedWolves: session.eliminatedAgents.filter(id => getAgentRole(session, id) === 'werewolf'),
    eliminatedGood: session.eliminatedAgents.filter(id => getAgentRole(session, id) !== 'werewolf'),
  };
}

// ── Situational advice generator ────────────────────────────────────────

function getSituationalAdvice(
  agent: AgentConfig, session: Session, role: RoleId, sit: GameSituation,
): string[] {
  const lines: string[] = [];
  const isWolf = ROLES[role].team === 'wolf';

  // ── Seer situations ──
  if (role === 'seer') {
    const checks: Array<{ target: string; isWolf: boolean }> = session.privateState.get('seer-checks') || [];
    if (sit.isFirstDay && sit.seerClaims.length === 0) {
      lines.push('🔑 你是第一个发言的，立刻跳预言家身份！');
      const wolfCheck = checks.find(c => c.isWolf);
      const goodCheck = checks.find(c => !c.isWolf);
      if (wolfCheck) lines.push(`⚔️ 查杀! ${agentName(session, wolfCheck.target)} 是狼人。报出来，推动投票。`);
      if (goodCheck && !wolfCheck) lines.push(`✅ ${agentName(session, goodCheck.target)} 是金水。报出来，争取盟友。留警徽流。`);
    }
    if (sit.seerClaims.length > 0 && !sit.seerClaims.includes(agent.id)) {
      lines.push(`⚠️ ${sit.seerClaims.map(id => agentName(session, id)).join(', ')} 已经跳了预言家。必须对跳！展示你的查验结果和心路历程。`);
    }
    if (!sit.isFirstDay && checks.length > 0) {
      const summary = checks.map(c => `${agentName(session, c.target)}=${c.isWolf ? '🐺' : '✅'}`).join(', ');
      lines.push(`📋 累计查验: ${summary}。全部报出来。更新警徽流。`);
    }
  }

  // ── Wolf situations ──
  else if (isWolf) {
    if (sit.iAmAccused) {
      lines.push('🚨 你被查杀了！选择: 悍跳预言家反制 / 假冒猎人自保 / 质疑对方逻辑');
    } else if (sit.teammateAccused) {
      lines.push('⚠️ 队友被指控！可以: 暗中质疑预言家 / 转移话题 / 悍跳发队友金水 / 做倒钩');
    } else if (sit.isFirstDay && sit.seerClaims.length === 0) {
      lines.push('🎭 无人跳预言家，考虑悍跳：发查杀推人出局 / 发金水保队友');
    } else if (sit.seerClaims.length > 0 && !sit.hasCounterClaim) {
      lines.push(`⚠️ ${sit.seerClaims.map(id => agentName(session, id)).join(', ')} 跳了预言家。考虑悍跳对抗或今晚刀他。`);
    }
    if (sit.isCritical) lines.push('🔴 残局! 再投出一个好人就赢了。全力推票。');
  }

  // ── Villager/other situations ──
  else {
    if (sit.seerClaims.length === 1 && !sit.hasCounterClaim) {
      lines.push(`📌 ${agentName(session, sit.seerClaims[0])} 是唯一预言家。默认跟着走。`);
      const acc = sit.wolfAccusations.find(a => a.accuser === sit.seerClaims[0]);
      if (acc) lines.push(`他查杀了 ${agentName(session, acc.target)}。投！`);
    } else if (sit.hasCounterClaim) {
      lines.push(`⚔️ 对跳: ${sit.seerClaims.map(id => agentName(session, id)).join(' vs ')}。必须选边！看心路历程、查验吻合度、谁先跳。`);
    } else if (sit.seerClaims.length === 0 && sit.isFirstDay) {
      lines.push('🔍 无人跳预言家。推动信息共享，要求有查验结果的人发言。');
    }
    if (sit.iAmAccused) lines.push('😰 你被指控了！用逻辑反驳，引用发言分析。');
    if (role === 'witch') {
      const saveUsed = session.privateState.get('witch-save-used') || false;
      const poisonUsed = session.privateState.get('witch-poison-used') || false;
      if (!poisonUsed && sit.isLateGame) lines.push('☠️ 残局还有毒药——宣布出来可以保命。');
    }
    if (role === 'hunter' && sit.iAmAccused) {
      lines.push('🔫 亮猎人身份！"投我出去我会开枪，你们确定？"');
    }
  }

  // Universal
  if (sit.eliminatedWolves.length > 0) {
    lines.push(`已确认狼人: ${sit.eliminatedWolves.map(id => agentName(session, id)).join(', ')}。回溯谁保过他们。`);
  }
  if (sit.isLateGame) {
    lines.push(`🔴 残局 ${sit.aliveCount} 人, ${sit.wolfCount}🐺 vs ${sit.goodCount}👤。每票都关键。`);
  }

  return lines;
}

// ── Main export: build full strategy prompt ─────────────────────────────

export function getStrategyPrompt(
  agent: AgentConfig, session: Session, phaseId: string, role: RoleId, dayNum: number,
): string {
  const baseSkill = loadSkill('base');
  const roleSkill = getSkillForRole(role);
  const sit = analyzeGameState(agent, session, phaseId, role, dayNum);
  const advice = getSituationalAdvice(agent, session, role, sit);

  const sections = [
    baseSkill,
    '\n---\n',
    roleSkill,
  ];

  if (advice.length > 0) {
    sections.push(
      `\n---\n## 当前局势分析 (Day ${dayNum}, ${sit.aliveCount}人存活)\n`,
      ...advice.map(l => `- ${l}`),
    );
  }

  return sections.join('\n');
}
