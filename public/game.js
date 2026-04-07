const S = 1;        // No extra scale needed — sprites are pre-rendered
const GAME_W = 960;
const GAME_H = 540;

const TABLE_CX = 500;
const TABLE_CY = 340;

// Sprite indices grouped by gender (visual appearance of pre-rendered sprites)
const FEMALE_SPRITES = [0, 2, 4];  // agent-0: red suit, agent-2: purple suit, agent-4: orange top
const MALE_SPRITES = [1, 3, 5];    // agent-1: blue hoodie, agent-3: green vest, agent-5: teal shirt

const CHAR_H = 65;
const CHAR_STAND_H = 82;
const HOST_H = 82;
const CRITIC_H = 82;

// Dynamic elliptical layout around table
// Generates seat positions based on player count
function generateSeatPositions(count) {
  if (count <= 0) return [];

  // Ellipse parameters — fits around the table nicely
  const cx = TABLE_CX;
  const cy = TABLE_CY;
  const rx = 120 + Math.max(0, count - 6) * 8;  // wider for more people
  const ry = 85 + Math.max(0, count - 6) * 5;

  const seats = [];
  // Start from top-left, go clockwise
  // Offset so seats are symmetric: start from -PI/2 + half-step
  const startAngle = -Math.PI / 2;

  for (let i = 0; i < count; i++) {
    const angle = startAngle + (i / count) * Math.PI * 2;
    const x = Math.round(cx + rx * Math.cos(angle));
    const y = Math.round(cy + ry * Math.sin(angle));

    // Determine side for depth sorting
    let side;
    if (y < cy - 20) side = 'back';
    else if (y > cy + 20) side = 'front';
    else if (x < cx) side = 'left';
    else side = 'right';

    seats.push({ x, y, side });
  }
  return seats;
}

// Default 6-seat layout (overridden dynamically in scene setup)
let SEAT_POSITIONS = generateSeatPositions(6);

const HOST_POS = { x: 160, y: 150 };
const CRITIC_POS = { x: 840, y: 150 };
const BB_POS = { x: 330, y: 50 };
const BB_W = 100;
const BB_H = 55;
const TBL_RX = 52;
const TBL_RY = 24;

// ═══ Boot Scene — load sprites ═══════════════════════════════════════════

class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload() {
    // Agent sprites (6 standing + 6 sitting)
    for (let i = 0; i < 6; i++) {
      this.load.image(`agent-stand-${i}`, `sprites/agent-stand-${i}.png`);
      this.load.image(`agent-sit-${i}`, `sprites/agent-sit-${i}.png`);
    }
    this.load.image('table-sprite', 'sprites/table.png');
    this.load.image('host-sprite', 'sprites/host.png');
    this.load.image('critic-sprite', 'sprites/critic.png');
    this.load.image('critic-flag-green', 'sprites/critic-flag-green.png');
    this.load.image('critic-flag-red', 'sprites/critic-flag-red.png');
  }

  create() {
    const g = this.add.graphics();

    // Floor tile
    g.fillStyle(0x1e1e32); g.fillRect(0,0,8,8);
    g.fillStyle(0x22223a); g.fillRect(0,0,4,4); g.fillRect(4,4,4,4);
    g.generateTexture('floor-tile', 8, 8); g.clear();

    // Blackboard
    g.fillStyle(0x5a3a1a); g.fillRect(0,0,BB_W,BB_H);
    g.fillStyle(0x1a3a2a); g.fillRect(3,3,BB_W-6,BB_H-6);
    g.fillStyle(0x5a3a1a); g.fillRect(8,BB_H-6,BB_W-16,3);
    g.generateTexture('blackboard', BB_W, BB_H); g.clear();

    // Table is loaded as sprite in preload()

    // Thinking dots
    g.fillStyle(0xffffff,0.7);
    g.fillCircle(3,3,2); g.fillCircle(10,3,2); g.fillCircle(17,3,2);
    g.generateTexture('thinking-dots', 20, 6); g.clear();

    // Green/Red flags
    g.fillStyle(0x8B6914); g.fillRect(1, 0, 2, 18);
    g.fillStyle(0x2ecc71); g.fillRect(3, 0, 10, 7);
    g.fillStyle(0x27ae60); g.fillRect(3, 2, 10, 3);
    g.generateTexture('flag-green', 14, 18); g.clear();

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
    this.blackboardText = null;
    this.currentSpeaker = null;
    this.idleTweens = [];
  }

  _scaleToHeight(sprite, targetH) {
    const ratio = targetH / sprite.height;
    sprite.setScale(ratio);
    return ratio;
  }

  create() {
    // Floor
    for (let x = 0; x < GAME_W; x += 24) {
      for (let y = 0; y < GAME_H; y += 24) {
        this.add.image(x+12, y+12, 'floor-tile').setScale(3);
      }
    }

    // Wall
    const wall = this.add.graphics();
    wall.fillStyle(0x16162a); wall.fillRect(0, 0, GAME_W, 42);
    wall.fillStyle(0x3a3a5a); wall.fillRect(0, 38, GAME_W, 4);

    // Blackboard
    this.add.image(BB_POS.x + BB_W*3/2, BB_POS.y + BB_H*3/2, 'blackboard').setScale(3);

    this.topicText = this.add.text(BB_POS.x + BB_W*3/2, BB_POS.y + 14, '', {
      fontFamily: 'monospace', fontSize: '9px', color: '#667766',
      align: 'center', wordWrap: { width: BB_W*3 - 30 },
    }).setOrigin(0.5, 0);

    this.blackboardText = this.add.text(
      BB_POS.x + BB_W*3/2, BB_POS.y + BB_H*3/2 + 8, '',
      { fontFamily: 'monospace', fontSize: '11px', color: '#ccddcc', fontStyle: 'bold',
        align: 'center', wordWrap: { width: BB_W*3 - 24 } }
    ).setOrigin(0.5, 0.5);

    // Table (pre-rendered sprite, scale to ~160px wide)
    const tableImg = this.add.image(TABLE_CX, TABLE_CY, 'table-sprite').setDepth(10);
    const tableScale = 160 / tableImg.width;
    tableImg.setScale(tableScale);

    // Host (pre-rendered sprite)
    this.hostSprite = this.add.image(HOST_POS.x, HOST_POS.y, 'host-sprite').setDepth(5);
    this._scaleToHeight(this.hostSprite, HOST_H);
    this.add.text(HOST_POS.x, HOST_POS.y + HOST_H/2 + 8, '📐 Host', {
      fontFamily: 'monospace', fontSize: '15px', color: '#FFB347', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(5);

    // Critic (pre-rendered sprite)
    this.criticSprite = this.add.image(CRITIC_POS.x, CRITIC_POS.y, 'critic-sprite').setDepth(5).setAlpha(0.7);
    this._scaleToHeight(this.criticSprite, CRITIC_H);
    // critic flag sprites are now swapped directly on criticSprite
    this.add.text(CRITIC_POS.x, CRITIC_POS.y + CRITIC_H/2 + 8, '🔍 Critic', {
      fontFamily: 'monospace', fontSize: '15px', color: '#4ECDC4', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(5);

    // Decorations
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
        targets: this.hostSprite, y: HOST_POS.y - 2,
        duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      }),
      this.tweens.add({
        targets: this.criticSprite, y: CRITIC_POS.y - 2,
        duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      })
    );
  }

  _startAgentIdleAnimations() {
    Object.entries(this.characters).forEach(([id, char], i) => {
      char.idleTween = this.tweens.add({
        targets: char.sprite, y: char.originalY - 2,
        duration: 1200 + i * 200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
      this.idleTweens.push(char.idleTween);
    });
  }

  setupAgents(agents) {
    Object.values(this.characters).forEach(c => {
      if (c.sprite) c.sprite.destroy();
      if (c.nameText) c.nameText.destroy();
      if (c.thinkingIcon) c.thinkingIcon.destroy();
    });
    this.characters = {};

    let femaleIdx = 0;
    let maleIdx = 0;

    // Regenerate seat layout based on actual player count
    SEAT_POSITIONS = generateSeatPositions(agents.length);

    agents.forEach((agent, i) => {
      const seat = SEAT_POSITIONS[i];
      const isFemale = agent.gender === 'female';
      const spriteIdx = isFemale
        ? FEMALE_SPRITES[(femaleIdx++) % FEMALE_SPRITES.length]
        : MALE_SPRITES[(maleIdx++) % MALE_SPRITES.length];
      const isBehind = seat.side === 'back';

      // Use pre-rendered sitting sprite
      const sprite = this.add.image(seat.x, seat.y, `agent-sit-${spriteIdx}`)
        .setDepth(isBehind ? 8 : 15);
      this._scaleToHeight(sprite, CHAR_H);

      const nameText = this.add.text(seat.x, seat.y + CHAR_H/2 + 4, agent.emoji + ' ' + agent.name, {
        fontFamily: 'monospace', fontSize: '13px', color: agent.color, fontStyle: 'bold',
        stroke: '#0a0a14', strokeThickness: 3,
      }).setOrigin(0.5, 0).setDepth(20);

      const thinkingIcon = this.add.image(seat.x, seat.y - CHAR_H/2 - 8, 'thinking-dots')
        .setScale(1.5).setDepth(25).setVisible(false);

      this.characters[agent.id] = {
        sprite, nameText, thinkingIcon, seat, agent, spriteIdx,
        isStanding: false, originalY: seat.y, idleTween: null,
      };
    });

    this._startAgentIdleAnimations();
  }

  async enterAgentsSequentially(agents) {
    // First set up all agents (creates sprites)
    this.setupAgents(agents);

    // Hide all agent sprites initially
    Object.values(this.characters).forEach(char => {
      char.sprite.setAlpha(0);
      char.sprite.setY(GAME_H + 50);
      char.nameText.setAlpha(0);
    });

    // Stop idle animations while entering
    this.idleTweens.forEach(t => t.remove());
    this.idleTweens = [];

    // Enter one by one
    const entries = Object.entries(this.characters);
    for (let i = 0; i < entries.length; i++) {
      const [id, char] = entries[i];
      char.sprite.setTexture(`agent-stand-${char.spriteIdx}`);
      this._scaleToHeight(char.sprite, CHAR_STAND_H);
      char.sprite.setAlpha(1);

      await new Promise(resolve => {
        this.tweens.add({
          targets: char.sprite,
          y: char.originalY,
          duration: 600,
          ease: 'Power2.easeOut',
          onComplete: () => {
            // Sit down
            char.sprite.setTexture(`agent-sit-${char.spriteIdx}`);
            this._scaleToHeight(char.sprite, CHAR_H);
            char.sprite.setY(char.originalY);
            char.nameText.setAlpha(1);
            resolve();
          },
        });
      });

      await new Promise(r => setTimeout(r, 350));
    }

    this._startAgentIdleAnimations();
  }

  setTopic(title) {
    if (!this.topicText) return;
    const maxLen = 60;
    const display = title.length > maxLen ? title.slice(0, maxLen - 1) + '…' : title;
    this.topicText.setWordWrapWidth(BB_W * 3 - 30);
    this.topicText.setText(display);
  }

  setSubtopic(title) {
    if (!this.blackboardText) return;
    const wrapW = BB_W * 3 - 36;
    const maxH = BB_H * 3 - 55;
    let size = 11;
    this.blackboardText.setWordWrapWidth(wrapW);
    this.blackboardText.setFontSize(size + 'px');
    this.blackboardText.setText(title);

    while (this.blackboardText.height > maxH && size > 7) {
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
      targets: char.thinkingIcon, y: char.seat.y - CHAR_H/2 - 20,
      duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: char.sprite, y: char.originalY - 3,
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
      // Switch to standing sprite
      char.sprite.setTexture(`agent-stand-${char.spriteIdx}`);
      this._scaleToHeight(char.sprite, CHAR_STAND_H);
      char.sprite.setDepth(25);
      char.nameText.setDepth(26);
      this.tweens.add({
        targets: char.sprite, y: char.originalY - 20,
        duration: 300, ease: 'Back.easeOut',
      });
      this.tweens.add({
        targets: char.nameText, y: char.originalY - 20 + CHAR_STAND_H/2 + 4,
        duration: 300, ease: 'Back.easeOut',
      });
    }

    // Breathing animation
    const baseScale = char.sprite.scaleY;
    this.tweens.add({
      targets: char.sprite,
      scaleX: { from: char.sprite.scaleX, to: char.sprite.scaleX * 1.03 },
      scaleY: { from: baseScale, to: baseScale * 1.04 },
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
      if (char.isStanding) {
        char.isStanding = false;
        char.sprite.setTexture(`agent-sit-${char.spriteIdx}`);
        this._scaleToHeight(char.sprite, CHAR_H);
        char.sprite.setY(char.originalY);
        char.sprite.setDepth(char.seat.side === 'back' ? 8 : 15);
        char.nameText.setY(char.originalY + CHAR_H/2 + 4);
        char.nameText.setDepth(20);
      }
    });

    if (this.hostSprite) {
      this.hostSprite.setAlpha(1).setY(HOST_POS.y);
      this._scaleToHeight(this.hostSprite, HOST_H);
    }
    if (this.criticSprite) {
      this.criticSprite.setAlpha(0.7).setY(CRITIC_POS.y);
      this._scaleToHeight(this.criticSprite, CRITIC_H);
    }
    this.currentSpeaker = null;
    this._startHostCriticIdle();
    this._startAgentIdleAnimations();
  }

  showCriticFlag(approved) {
    if (!this.criticSprite) return;
    const flagTex = approved ? 'critic-flag-green' : 'critic-flag-red';

    // Swap to flag-holding sprite (slightly taller to show flag)
    this.criticSprite.setTexture(flagTex);
    this._scaleToHeight(this.criticSprite, CRITIC_H + 5);
    this.criticSprite.setAlpha(1);

    // After a few seconds, restore normal critic
    this.time.delayedCall(3000, () => {
      if (!this.criticSprite) return;
      this.criticSprite.setTexture('critic-sprite');
      this._scaleToHeight(this.criticSprite, CRITIC_H);
      this.criticSprite.setAlpha(0.7);
      this.criticSprite.setY(CRITIC_POS.y);
    });
  }

  _pulseSprite(sprite) {
    if (!sprite) return;
    sprite.setAlpha(1);
    const baseScaleY = sprite.scaleY;
    this.tweens.add({
      targets: sprite,
      scaleY: { from: baseScaleY, to: baseScaleY * 1.05 },
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
      wx = HOST_POS.x; wy = HOST_POS.y - 60;
    } else if (agentId === 'critic') {
      wx = CRITIC_POS.x; wy = CRITIC_POS.y - 60;
    } else {
      const c = this.characters[agentId];
      if (!c) return null;
      wx = c.sprite.x;
      wy = c.sprite.y - (c.isStanding ? CHAR_STAND_H/2 + 15 : CHAR_H/2 + 10);
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

  async enterAgents(agents) {
    const scene = this.getScene();
    if (!scene || !scene.scene.isActive()) {
      await new Promise(r => setTimeout(r, 300));
      return this.enterAgents(agents);
    }
    return scene.enterAgentsSequentially(agents);
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

  showBubble(agentId, text, color) {
    if (!this.bubbleEl) return;
    const scene = this.getScene();
    if (!scene) return;
    const pos = scene.getCharacterScreenPos(agentId);
    if (!pos) return;
    this.bubbleEl.style.left = pos.x + 'px';
    this.bubbleEl.style.top = pos.y + 'px';
    if (color) {
      this.bubbleEl.style.borderColor = color;
      const tail = this.bubbleEl.querySelector('.bubble-tail');
      if (tail) tail.style.borderTopColor = color;
    }
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
