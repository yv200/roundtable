const S = 3;
const GAME_W = 960;
const GAME_H = 540;

const TABLE_CX = 480;
const TABLE_CY = 350;

const SEAT_POSITIONS = [
  { x: 310, y: 300, side: 'left' },
  { x: 290, y: 385, side: 'left' },
  { x: 650, y: 300, side: 'right' },
  { x: 670, y: 385, side: 'right' },
  { x: 420, y: 445, side: 'front' },
  { x: 540, y: 445, side: 'front' },
];

const HOST_POS = { x: 200, y: 155 };
const CRITIC_POS = { x: 760, y: 155 };
const BB_POS = { x: 330, y: 50 };
const BB_W = 100;
const BB_H = 55;
const TBL_RX = 52;
const TBL_RY = 24;

// ═══ Pixel Art Drawing (small textures, scaled up via sprite.setScale) ═══

function drawCharacter(g, color, x0, y0) {
  const skin = 0xFFDDB5, dark = 0x1a1a2e, shoe = 0x2a2a3e;
  const hair = Phaser.Display.Color.IntegerToColor(color).darken(20).color;
  g.fillStyle(hair);
  g.fillRect(x0+4,y0,8,3); g.fillRect(x0+3,y0+1,10,2);
  g.fillStyle(skin);  g.fillRect(x0+4,y0+3,8,5);
  g.fillStyle(dark);   g.fillRect(x0+5,y0+4,2,2); g.fillRect(x0+9,y0+4,2,2);
  g.fillStyle(0xcc9988); g.fillRect(x0+7,y0+6,2,1);
  g.fillStyle(color);  g.fillRect(x0+3,y0+8,10,7);
  g.fillStyle(color);  g.fillRect(x0+1,y0+8,2,6); g.fillRect(x0+13,y0+8,2,6);
  g.fillStyle(skin);   g.fillRect(x0+1,y0+14,2,1); g.fillRect(x0+13,y0+14,2,1);
  g.fillStyle(dark);   g.fillRect(x0+4,y0+15,4,4); g.fillRect(x0+9,y0+15,4,4);
  g.fillStyle(shoe);   g.fillRect(x0+3,y0+19,5,2); g.fillRect(x0+9,y0+19,5,2);
}

function drawCharacterSitting(g, color, x0, y0, blink) {
  const skin = 0xFFDDB5, dark = 0x1a1a2e;
  const hair = Phaser.Display.Color.IntegerToColor(color).darken(20).color;
  g.fillStyle(hair);
  g.fillRect(x0+4,y0,8,3); g.fillRect(x0+3,y0+1,10,2);
  g.fillStyle(skin);  g.fillRect(x0+4,y0+3,8,5);
  if (blink) {
    g.fillStyle(0x998877); g.fillRect(x0+5,y0+5,2,1); g.fillRect(x0+9,y0+5,2,1);
  } else {
    g.fillStyle(dark); g.fillRect(x0+5,y0+4,2,2); g.fillRect(x0+9,y0+4,2,2);
  }
  g.fillStyle(0xcc9988); g.fillRect(x0+7,y0+6,2,1);
  g.fillStyle(color);  g.fillRect(x0+3,y0+8,10,7);
  g.fillStyle(color);  g.fillRect(x0+1,y0+8,2,5); g.fillRect(x0+13,y0+8,2,5);
  g.fillStyle(skin);   g.fillRect(x0+0,y0+13,3,1); g.fillRect(x0+13,y0+13,3,1);
}

// ═══ Boot Scene ══════════════════════════════════════════════════════════

class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    const g = this.add.graphics();

    g.fillStyle(0x1e1e32); g.fillRect(0,0,8,8);
    g.fillStyle(0x22223a); g.fillRect(0,0,4,4); g.fillRect(4,4,4,4);
    g.generateTexture('floor-tile', 8, 8); g.clear();

    g.fillStyle(0x5a3a1a); g.fillRect(0,0,BB_W,BB_H);
    g.fillStyle(0x1a3a2a); g.fillRect(3,3,BB_W-6,BB_H-6);
    g.fillStyle(0x5a3a1a); g.fillRect(8,BB_H-6,BB_W-16,3);
    g.generateTexture('blackboard', BB_W, BB_H); g.clear();

    const tw = TBL_RX*2+8, th = TBL_RY*2+4;
    g.fillStyle(0x0a0a14,0.5); g.fillEllipse(tw/2+2,th/2+3,tw,th);
    g.fillStyle(0x5c3d2e);     g.fillEllipse(tw/2,th/2,tw,th);
    g.fillStyle(0x6b4a38);     g.fillEllipse(tw/2,th/2,tw-8,th-6);
    g.fillStyle(0x7a5842,0.4); g.fillEllipse(tw/2,th/2-2,tw-20,th-14);
    g.generateTexture('table', tw, th); g.clear();

    g.fillStyle(0xffffff,0.7);
    g.fillCircle(3,3,2); g.fillCircle(10,3,2); g.fillCircle(17,3,2);
    g.generateTexture('thinking-dots', 20, 6); g.clear();

    drawCharacter(g, 0xFFB347, 0, 0);
    g.generateTexture('host-standing', 16, 22); g.clear();

    drawCharacter(g, 0x4ECDC4, 0, 0);
    g.generateTexture('critic-standing', 16, 22); g.clear();

    // Green flag (approved)
    g.fillStyle(0x8B6914); g.fillRect(1, 0, 2, 18);
    g.fillStyle(0x2ecc71); g.fillRect(3, 0, 10, 7);
    g.fillStyle(0x27ae60); g.fillRect(3, 2, 10, 3);
    g.generateTexture('flag-green', 14, 18); g.clear();

    // Red flag (rejected)
    g.fillStyle(0x8B6914); g.fillRect(1, 0, 2, 18);
    g.fillStyle(0xe74c3c); g.fillRect(3, 0, 10, 7);
    g.fillStyle(0xc0392b); g.fillRect(3, 2, 10, 3);
    g.generateTexture('flag-red', 14, 18); g.clear();

    g.destroy();
    this.scene.start('Roundtable');
  }
}

// ═══ Roundtable Scene ════════════════════════════════════════════════════

class RoundtableScene extends Phaser.Scene {
  constructor() { super('Roundtable'); }

  init() {
    this.characters = {};
    this.hostSprite = null;
    this.criticSprite = null;
    this.criticFlag = null;
    this.blackboardText = null;
    this.currentSpeaker = null;
    this.idleTweens = [];
  }

  create() {
    for (let x = 0; x < GAME_W; x += 8*S) {
      for (let y = 0; y < GAME_H; y += 8*S) {
        this.add.image(x+4*S, y+4*S, 'floor-tile').setScale(S);
      }
    }

    const wall = this.add.graphics();
    wall.fillStyle(0x16162a); wall.fillRect(0, 0, GAME_W, 42);
    wall.fillStyle(0x3a3a5a); wall.fillRect(0, 38, GAME_W, 4);

    this.add.image(BB_POS.x + BB_W*S/2, BB_POS.y + BB_H*S/2, 'blackboard').setScale(S);

    this.topicText = this.add.text(BB_POS.x + BB_W*S/2, BB_POS.y + 16, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#667766',
      align: 'center', wordWrap: { width: BB_W*S - 40 },
    }).setOrigin(0.5, 0);

    this.blackboardText = this.add.text(
      BB_POS.x + BB_W*S/2, BB_POS.y + BB_H*S/2 + 10, '',
      { fontFamily: 'monospace', fontSize: '15px', color: '#ccddcc', fontStyle: 'bold',
        align: 'center', wordWrap: { width: BB_W*S - 36 } }
    ).setOrigin(0.5, 0.5);

    this.add.image(TABLE_CX, TABLE_CY, 'table').setScale(S).setDepth(10);

    this.hostSprite = this.add.image(HOST_POS.x, HOST_POS.y, 'host-standing').setScale(S).setDepth(5);
    this.add.text(HOST_POS.x, HOST_POS.y + 40, '📐 Host', {
      fontFamily: 'monospace', fontSize: '15px', color: '#FFB347', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(5);

    this.criticSprite = this.add.image(CRITIC_POS.x, CRITIC_POS.y, 'critic-standing').setScale(S).setDepth(5).setAlpha(0.7);
    this.criticFlag = this.add.image(CRITIC_POS.x + 28, CRITIC_POS.y - 20, 'flag-green')
      .setScale(S).setDepth(6).setVisible(false);
    this.add.text(CRITIC_POS.x, CRITIC_POS.y + 40, '🔍 Critic', {
      fontFamily: 'monospace', fontSize: '15px', color: '#4ECDC4', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(5);

    const plant = this.add.graphics();
    plant.fillStyle(0x2d5a27); plant.fillCircle(12,9,12); plant.fillCircle(21,15,9);
    plant.fillStyle(0x5a3a1a); plant.fillRect(12,21,9,12);
    plant.fillStyle(0x4a3020); plant.fillRect(6,33,21,9);
    plant.setPosition(20, 470).setDepth(2);

    const clock = this.add.graphics();
    clock.fillStyle(0x3a3a5a); clock.fillCircle(15,15,15);
    clock.fillStyle(0xccccdd); clock.fillCircle(15,15,12);
    clock.lineStyle(2, 0x1a1a2e);
    clock.lineBetween(15,15,15,5); clock.lineBetween(15,15,22,12);
    clock.setPosition(900, 6).setDepth(2);

    this._startHostCriticIdle();
  }

  _startHostCriticIdle() {
    this.idleTweens.push(
      this.tweens.add({
        targets: this.hostSprite, y: HOST_POS.y - S,
        duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }),
      this.tweens.add({
        targets: this.criticSprite, y: CRITIC_POS.y - S,
        duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      })
    );
  }

  _startAgentIdleAnimations() {
    Object.entries(this.characters).forEach(([id, char], i) => {
      char.idleTween = this.tweens.add({
        targets: char.sprite, y: char.originalY - S,
        duration: 1200 + i * 200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
      this.idleTweens.push(char.idleTween);

      char.blinkTimer = this.time.addEvent({
        delay: 2000 + Math.random() * 4000, loop: true,
        callback: () => {
          if (char.isStanding) return;
          char.sprite.setTexture(`agent-sit-blink-${id}`);
          this.time.delayedCall(150, () => {
            if (!char.isStanding) char.sprite.setTexture(`agent-sit-${id}`);
          });
        },
      });
    });
  }

  setupAgents(agents) {
    Object.values(this.characters).forEach(c => {
      if (c.sprite) c.sprite.destroy();
      if (c.nameText) c.nameText.destroy();
      if (c.thinkingIcon) c.thinkingIcon.destroy();
    });
    this.characters = {};

    agents.forEach((agent, i) => {
      const seat = SEAT_POSITIONS[i % SEAT_POSITIONS.length];
      const color = Phaser.Display.Color.HexStringToColor(agent.color).color;

      const g = this.add.graphics();
      drawCharacterSitting(g, color, 0, 0, false);
      g.generateTexture(`agent-sit-${agent.id}`, 16, 15); g.clear();
      drawCharacterSitting(g, color, 0, 0, true);
      g.generateTexture(`agent-sit-blink-${agent.id}`, 16, 15); g.clear();
      drawCharacter(g, color, 0, 0);
      g.generateTexture(`agent-stand-${agent.id}`, 16, 22); g.clear();
      g.destroy();

      const isBehind = seat.side !== 'front';
      const sprite = this.add.image(seat.x, seat.y, `agent-sit-${agent.id}`)
        .setScale(S).setDepth(isBehind ? 8 : 15);

      const nameText = this.add.text(seat.x, seat.y + 30, agent.emoji + ' ' + agent.name, {
        fontFamily: 'monospace', fontSize: '15px', color: agent.color, fontStyle: 'bold',
        stroke: '#0a0a14', strokeThickness: 3,
      }).setOrigin(0.5, 0).setDepth(20);

      const thinkingIcon = this.add.image(seat.x, seat.y - 42, 'thinking-dots')
        .setScale(S).setDepth(25).setVisible(false);

      this.characters[agent.id] = {
        sprite, nameText, thinkingIcon, seat, agent,
        isStanding: false, originalY: seat.y, idleTween: null, blinkTimer: null,
      };
    });

    this._startAgentIdleAnimations();
  }

  setTopic(title) {
    if (!this.topicText) return;
    this.topicText.setWordWrapWidth(BB_W * S - 40);
    this.topicText.setText(title);
  }

  setSubtopic(title) {
    if (!this.blackboardText) return;
    const wrapW = BB_W * S - 36;
    const maxH = BB_H * S - 55;
    let size = 15;
    this.blackboardText.setWordWrapWidth(wrapW);
    this.blackboardText.setFontSize(size + 'px');
    this.blackboardText.setText(title);

    while (this.blackboardText.height > maxH && size > 9) {
      size--;
      this.blackboardText.setFontSize(size + 'px');
      this.blackboardText.setWordWrapWidth(wrapW);
    }

    this.tweens.add({
      targets: this.blackboardText, alpha: { from: 0.3, to: 1 },
      duration: 400, ease: 'Power2',
    });
  }

  setThinking(agentId) {
    this.clearAllStates();
    const char = this.characters[agentId];
    if (!char) {
      if (agentId === 'critic') this._pulseSprite(this.criticSprite);
      return;
    }
    if (char.idleTween) char.idleTween.remove();
    char.thinkingIcon.setVisible(true);
    this.tweens.add({
      targets: char.thinkingIcon, y: char.seat.y - 50,
      duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: char.sprite, y: char.originalY - 2,
      duration: 800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  setSpeaking(agentId) {
    this.clearAllStates();
    const char = this.characters[agentId];
    if (!char) {
      if (agentId === 'planner' || agentId === 'summary') this._pulseSprite(this.hostSprite);
      else if (agentId === 'critic') this._pulseSprite(this.criticSprite);
      this.currentSpeaker = agentId;
      return;
    }
    if (char.idleTween) char.idleTween.remove();

    if (!char.isStanding) {
      char.isStanding = true;
      char.sprite.setTexture(`agent-stand-${agentId}`);
      char.sprite.setDepth(25);
      char.nameText.setDepth(26);
      this.tweens.add({
        targets: char.sprite, y: char.originalY - 24,
        duration: 300, ease: 'Back.easeOut',
      });
      this.tweens.add({
        targets: char.nameText, y: char.originalY - 24 + 42,
        duration: 300, ease: 'Back.easeOut',
      });
    }

    this.tweens.add({
      targets: char.sprite,
      scaleX: { from: S, to: S * 1.04 },
      scaleY: { from: S, to: S * 1.06 },
      duration: 500, yoyo: true, repeat: -1,
      ease: 'Sine.easeInOut', delay: 350,
    });
    this.currentSpeaker = agentId;
  }

  clearAllStates() {
    this.idleTweens.forEach(t => t.remove());
    this.idleTweens = [];
    this.tweens.killAll();

    Object.entries(this.characters).forEach(([id, char]) => {
      char.thinkingIcon.setVisible(false);
      if (char.blinkTimer) { char.blinkTimer.remove(); char.blinkTimer = null; }
      if (char.isStanding) {
        char.isStanding = false;
        char.sprite.setTexture(`agent-sit-${id}`);
        char.sprite.setY(char.originalY);
        char.sprite.setScale(S);
        char.sprite.setDepth(char.seat.side !== 'front' ? 8 : 15);
        char.nameText.setY(char.originalY + 30);
        char.nameText.setDepth(20);
      }
    });

    if (this.hostSprite) this.hostSprite.setAlpha(1).setScale(S).setY(HOST_POS.y);
    if (this.criticSprite) this.criticSprite.setAlpha(0.7).setScale(S).setY(CRITIC_POS.y);
    if (this.criticFlag) this.criticFlag.setVisible(false);
    this.currentSpeaker = null;
    this._startHostCriticIdle();
    this._startAgentIdleAnimations();
  }

  showCriticFlag(approved) {
    if (!this.criticFlag || !this.criticSprite) return;
    this.criticFlag.setTexture(approved ? 'flag-green' : 'flag-red');
    this.criticFlag.setVisible(true).setAlpha(0).setY(CRITIC_POS.y - 10).setAngle(0);
    this.criticSprite.setAlpha(1);

    this.tweens.add({
      targets: this.criticFlag,
      y: CRITIC_POS.y - 30,
      alpha: 1,
      duration: 400,
      ease: 'Back.easeOut',
    });

    this.tweens.add({
      targets: this.criticFlag,
      angle: { from: -20, to: 20 },
      y: { from: CRITIC_POS.y - 34, to: CRITIC_POS.y - 26 },
      duration: 200,
      yoyo: true,
      repeat: 5,
      ease: 'Sine.easeInOut',
      delay: 400,
    });

    this.tweens.add({
      targets: this.criticSprite,
      y: CRITIC_POS.y - 4,
      duration: 200,
      yoyo: true,
      repeat: 5,
      ease: 'Sine.easeInOut',
      delay: 400,
    });
  }

  _pulseSprite(sprite) {
    if (!sprite) return;
    sprite.setAlpha(1);
    this.tweens.add({
      targets: sprite,
      scaleY: { from: S, to: S * 1.05 },
      duration: 400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
  }

  getCharacterScreenPos(agentId) {
    const canvas = this.game.canvas;
    const canvasRect = canvas.getBoundingClientRect();
    const wrapper = document.getElementById('game-wrapper');
    const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : canvasRect;
    const ox = canvasRect.left - wrapperRect.left;
    const oy = canvasRect.top - wrapperRect.top;
    const sx = canvasRect.width / GAME_W;
    const sy = canvasRect.height / GAME_H;

    let wx, wy;
    if (agentId === 'planner' || agentId === 'summary') {
      wx = HOST_POS.x; wy = HOST_POS.y - 50;
    } else if (agentId === 'critic') {
      wx = CRITIC_POS.x; wy = CRITIC_POS.y - 50;
    } else {
      const c = this.characters[agentId];
      if (!c) return null;
      wx = c.sprite.x;
      wy = c.sprite.y - (c.isStanding ? 60 : 42);
    }
    return { x: wx * sx + ox, y: wy * sy + oy };
  }
}

// ═══ Game Bridge ═════════════════════════════════════════════════════════

const GameBridge = {
  game: null, bubbleEl: null, bubbleTimeout: null, initialized: false,

  init(containerId) {
    if (this.initialized) return;
    this.game = new Phaser.Game({
      type: Phaser.AUTO, parent: containerId,
      width: GAME_W, height: GAME_H,
      pixelArt: true, antialias: false, roundPixels: true,
      backgroundColor: '#0a0a14',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.NO_CENTER },
      scene: [BootScene, RoundtableScene],
    });
    this.bubbleEl = document.getElementById('speech-bubble');
    this.initialized = true;
  },

  getScene() {
    return this.game ? this.game.scene.getScene('Roundtable') : null;
  },

  setupAgents(agents) {
    const scene = this.getScene();
    if (scene && scene.scene.isActive()) scene.setupAgents(agents);
    else setTimeout(() => this.setupAgents(agents), 200);
  },

  setTopic(title) {
    const s = this.getScene();
    if (s && s.scene.isActive()) s.setTopic(title);
    else setTimeout(() => this.setTopic(title), 200);
  },

  setSubtopic(title) {
    const s = this.getScene();
    if (s && s.scene.isActive()) s.setSubtopic(title);
    else setTimeout(() => this.setSubtopic(title), 200);
  },

  setThinking(agentId) {
    const s = this.getScene(); if (s) s.setThinking(agentId);
    this.hideBubble();
  },

  setSpeaking(agentId) { const s = this.getScene(); if (s) s.setSpeaking(agentId); },

  showCriticFlag(approved) { const s = this.getScene(); if (s) s.showCriticFlag(approved); },

  showBubble(agentId, text) {
    if (!this.bubbleEl) return;
    const scene = this.getScene();
    if (!scene) return;
    const pos = scene.getCharacterScreenPos(agentId);
    if (!pos) return;
    this.bubbleEl.style.left = pos.x + 'px';
    this.bubbleEl.style.top = pos.y + 'px';
    this.bubbleEl.classList.add('visible');
    const textEl = this.bubbleEl.querySelector('.bubble-text');
    textEl.textContent = text;
    textEl.scrollTop = textEl.scrollHeight;
    if (this.bubbleTimeout) clearTimeout(this.bubbleTimeout);
  },

  hideBubble() { if (this.bubbleEl) this.bubbleEl.classList.remove('visible'); },

  stopAll() {
    const s = this.getScene(); if (s) s.clearAllStates();
    this.hideBubble();
  },

  destroy() {
    if (this.game) { this.game.destroy(true); this.game = null; this.initialized = false; }
  },
};
