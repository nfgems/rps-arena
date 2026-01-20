// Background Animation - Floating RPS Characters (matches game style)
// Used on both landing and lobby screens
(function() {
  const COLORS = {
    rock: '#FFA500',
    paper: '#1E90FF',
    scissors: '#2ECC71',
  };

  // Character class - matches the game's visual style
  class RPSCharacter {
    constructor(canvas) {
      this.canvas = canvas;
      this.reset(true);
    }

    reset(initial = false) {
      this.role = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];
      this.radius = 25 + Math.random() * 35;
      this.opacity = 0.25 + Math.random() * 0.35;

      if (initial) {
        this.x = Math.random() * this.canvas.width;
        this.y = Math.random() * this.canvas.height;
      } else {
        const edge = Math.floor(Math.random() * 4);
        switch(edge) {
          case 0: this.x = Math.random() * this.canvas.width; this.y = -this.radius * 2; break;
          case 1: this.x = this.canvas.width + this.radius * 2; this.y = Math.random() * this.canvas.height; break;
          case 2: this.x = Math.random() * this.canvas.width; this.y = this.canvas.height + this.radius * 2; break;
          case 3: this.x = -this.radius * 2; this.y = Math.random() * this.canvas.height; break;
        }
      }

      const angle = Math.random() * Math.PI * 2;
      const speed = 0.2 + Math.random() * 0.4;
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.phase = Math.random() * Math.PI * 2;
    }

    update() {
      this.x += this.vx;
      this.y += this.vy;

      const margin = this.radius * 3;
      if (this.x < -margin || this.x > this.canvas.width + margin ||
          this.y < -margin || this.y > this.canvas.height + margin) {
        this.reset(false);
      }
    }

    draw(ctx, time) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.globalAlpha = this.opacity;

      const color = COLORS[this.role];
      const t = time + this.phase;

      ctx.shadowColor = color;
      ctx.shadowBlur = 30;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.shadowBlur = 0;
      this.drawIcon(ctx, t);

      ctx.restore();
    }

    drawIcon(ctx, time) {
      const scale = this.radius / 22;
      ctx.save();
      ctx.scale(scale, scale);

      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;

      switch(this.role) {
        case 'rock': this.drawRockIcon(ctx, time); break;
        case 'paper': this.drawPaperIcon(ctx, time); break;
        case 'scissors': this.drawScissorsIcon(ctx, time); break;
      }

      ctx.restore();
    }

    drawRockIcon(ctx, time) {
      const wobble = Math.sin(time * 3) * 1;
      const pulseScale = 1 + Math.sin(time * 2) * 0.05;

      ctx.save();
      ctx.scale(pulseScale, pulseScale);

      ctx.beginPath();
      ctx.arc(wobble, 0, 10, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.beginPath();
      ctx.arc(wobble - 3, -2, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    drawPaperIcon(ctx, time) {
      const bob = Math.sin(time * 4) * 2;
      const tilt = Math.sin(time * 2) * 0.1;

      ctx.save();
      ctx.rotate(tilt);
      ctx.translate(0, bob);

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-8, -10, 16, 20);

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i += 4) {
        ctx.beginPath();
        ctx.moveTo(-5, i);
        ctx.lineTo(5, i);
        ctx.stroke();
      }

      ctx.restore();
    }

    drawScissorsIcon(ctx, time) {
      const snip = Math.sin(time * 6) * 0.3;

      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';

      ctx.save();
      ctx.rotate(-0.3 - snip);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -12);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.rotate(0.3 + snip);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -12);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(-4, 6, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(4, 6, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Chase pair - predator chasing prey across screen
  class ChasePair {
    constructor(canvas) {
      this.canvas = canvas;
      this.reset();
    }

    reset() {
      const roles = ['rock', 'paper', 'scissors'];
      const predatorIdx = Math.floor(Math.random() * 3);
      const preyIdx = predatorIdx === 0 ? 2 : predatorIdx - 1;

      this.predator = {
        role: roles[predatorIdx],
        radius: 35 + Math.random() * 15,
        opacity: 0.4 + Math.random() * 0.2
      };

      this.prey = {
        role: roles[preyIdx],
        radius: 28 + Math.random() * 12,
        opacity: 0.4 + Math.random() * 0.2
      };

      const startEdge = Math.floor(Math.random() * 4);
      const angleVariance = (Math.random() - 0.5) * 0.5;

      switch(startEdge) {
        case 0:
          this.prey.x = 100 + Math.random() * (this.canvas.width - 200);
          this.prey.y = -60;
          this.angle = Math.PI / 2 + angleVariance;
          break;
        case 1:
          this.prey.x = this.canvas.width + 60;
          this.prey.y = 100 + Math.random() * (this.canvas.height - 200);
          this.angle = Math.PI + angleVariance;
          break;
        case 2:
          this.prey.x = 100 + Math.random() * (this.canvas.width - 200);
          this.prey.y = this.canvas.height + 60;
          this.angle = -Math.PI / 2 + angleVariance;
          break;
        case 3:
          this.prey.x = -60;
          this.prey.y = 100 + Math.random() * (this.canvas.height - 200);
          this.angle = angleVariance;
          break;
      }

      this.predator.x = this.prey.x - Math.cos(this.angle) * 100;
      this.predator.y = this.prey.y - Math.sin(this.angle) * 100;

      this.speed = 1.2 + Math.random() * 0.8;
      this.phase = Math.random() * Math.PI * 2;
    }

    update() {
      const wobble = Math.sin(Date.now() * 0.002 + this.phase) * 0.2;
      const moveAngle = this.angle + wobble;

      this.prey.x += Math.cos(moveAngle) * this.speed * 1.15;
      this.prey.y += Math.sin(moveAngle) * this.speed * 1.15;

      this.predator.x += Math.cos(moveAngle) * this.speed;
      this.predator.y += Math.sin(moveAngle) * this.speed;

      const margin = 150;
      if (this.prey.x < -margin || this.prey.x > this.canvas.width + margin ||
          this.prey.y < -margin || this.prey.y > this.canvas.height + margin) {
        this.reset();
      }
    }

    draw(ctx, time) {
      this.drawCharacter(ctx, this.prey, time);
      this.drawCharacter(ctx, this.predator, time);
    }

    drawCharacter(ctx, char, time) {
      ctx.save();
      ctx.translate(char.x, char.y);
      ctx.globalAlpha = char.opacity;

      const color = COLORS[char.role];
      const t = time + this.phase;

      ctx.shadowColor = color;
      ctx.shadowBlur = 35;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, char.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.shadowBlur = 0;
      const scale = char.radius / 22;
      ctx.save();
      ctx.scale(scale, scale);

      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;

      switch(char.role) {
        case 'rock': this.drawRockIcon(ctx, t); break;
        case 'paper': this.drawPaperIcon(ctx, t); break;
        case 'scissors': this.drawScissorsIcon(ctx, t); break;
      }

      ctx.restore();
      ctx.restore();
    }

    drawRockIcon(ctx, time) {
      const wobble = Math.sin(time * 3) * 1;
      ctx.beginPath();
      ctx.arc(wobble, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.beginPath();
      ctx.arc(wobble - 3, -2, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    drawPaperIcon(ctx, time) {
      const bob = Math.sin(time * 4) * 2;
      const tilt = Math.sin(time * 2) * 0.1;
      ctx.save();
      ctx.rotate(tilt);
      ctx.translate(0, bob);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-8, -10, 16, 20);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i += 4) {
        ctx.beginPath();
        ctx.moveTo(-5, i);
        ctx.lineTo(5, i);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawScissorsIcon(ctx, time) {
      const snip = Math.sin(time * 6) * 0.3;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';

      ctx.save();
      ctx.rotate(-0.3 - snip);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -12);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.rotate(0.3 + snip);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -12);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(-4, 6, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(4, 6, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Background manager for a single canvas
  class BackgroundManager {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      if (!this.canvas) return;

      this.ctx = this.canvas.getContext('2d');
      this.characters = [];
      this.chasePairs = [];
      this.animationId = null;
      this.isRunning = false;
    }

    resize() {
      if (!this.canvas) return;
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
    }

    init() {
      if (!this.canvas) return;
      this.resize();

      const count = Math.max(12, Math.floor((this.canvas.width * this.canvas.height) / 60000));
      this.characters = [];
      for (let i = 0; i < count; i++) {
        this.characters.push(new RPSCharacter(this.canvas));
      }

      this.chasePairs = [];
      for (let i = 0; i < 3; i++) {
        this.chasePairs.push(new ChasePair(this.canvas));
      }
    }

    animate() {
      if (!this.isRunning || !this.canvas) return;

      const time = Date.now() * 0.001;

      this.ctx.fillStyle = '#1a1a2e';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      for (const char of this.characters) {
        char.update();
        char.draw(this.ctx, time);
      }

      for (const pair of this.chasePairs) {
        pair.update();
        pair.draw(this.ctx, time);
      }

      this.animationId = requestAnimationFrame(() => this.animate());
    }

    start() {
      if (this.isRunning || !this.canvas) return;
      this.isRunning = true;
      this.init();
      this.animate();
    }

    stop() {
      this.isRunning = false;
      if (this.animationId) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
    }
  }

  // Create managers for both screens
  const landingBg = new BackgroundManager('landing-bg-canvas');
  const lobbyBg = new BackgroundManager('lobby-bg-canvas');

  window.addEventListener('resize', () => {
    if (landingBg.isRunning) landingBg.resize();
    if (lobbyBg.isRunning) lobbyBg.resize();
  });

  // Watch for landing screen visibility
  const landingScreen = document.getElementById('landing-screen');
  if (landingScreen) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          if (landingScreen.classList.contains('hidden')) {
            landingBg.stop();
          } else {
            landingBg.start();
          }
        }
      }
    });
    observer.observe(landingScreen, { attributes: true });

    // Start immediately if visible
    if (!landingScreen.classList.contains('hidden')) {
      landingBg.start();
    }
  }

  // Watch for lobby screen visibility
  const lobbyScreen = document.getElementById('lobby-screen');
  if (lobbyScreen) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          if (lobbyScreen.classList.contains('hidden')) {
            lobbyBg.stop();
          } else {
            lobbyBg.start();
          }
        }
      }
    });
    observer.observe(lobbyScreen, { attributes: true });

    if (!lobbyScreen.classList.contains('hidden')) {
      lobbyBg.start();
    }
  }

  window.lobbyBackground = {
    landing: landingBg,
    lobby: lobbyBg,
    start: () => lobbyBg.start(),
    stop: () => lobbyBg.stop()
  };
})();
