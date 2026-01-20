// Lobby Background Animation - Floating RPS Characters (matches game style)
(function() {
  const canvas = document.getElementById('lobby-bg-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  const COLORS = {
    rock: '#FFA500',
    paper: '#1E90FF',
    scissors: '#2ECC71',
  };

  // Character class - matches the game's visual style
  class RPSCharacter {
    constructor() {
      this.reset(true);
    }

    reset(initial = false) {
      this.role = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];
      this.radius = 25 + Math.random() * 35; // 25-60px radius (like game's PLAYER_RADIUS but bigger)
      this.opacity = 0.25 + Math.random() * 0.35; // 0.25-0.6 opacity - more visible

      if (initial) {
        this.x = Math.random() * canvas.width;
        this.y = Math.random() * canvas.height;
      } else {
        // Spawn from edges
        const edge = Math.floor(Math.random() * 4);
        switch(edge) {
          case 0: this.x = Math.random() * canvas.width; this.y = -this.radius * 2; break;
          case 1: this.x = canvas.width + this.radius * 2; this.y = Math.random() * canvas.height; break;
          case 2: this.x = Math.random() * canvas.width; this.y = canvas.height + this.radius * 2; break;
          case 3: this.x = -this.radius * 2; this.y = Math.random() * canvas.height; break;
        }
      }

      // Slow drift movement
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
      if (this.x < -margin || this.x > canvas.width + margin ||
          this.y < -margin || this.y > canvas.height + margin) {
        this.reset(false);
      }
    }

    draw(time) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.globalAlpha = this.opacity;

      const color = COLORS[this.role];
      const t = time + this.phase;

      // Draw glow
      ctx.shadowColor = color;
      ctx.shadowBlur = 30;

      // Draw main colored circle (like the game)
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
      ctx.fill();

      // Draw border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw white icon inside (like the game)
      ctx.shadowBlur = 0;
      this.drawIcon(t);

      ctx.restore();
    }

    drawIcon(time) {
      const scale = this.radius / 22; // Scale relative to game's PLAYER_RADIUS
      ctx.save();
      ctx.scale(scale, scale);

      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;

      switch(this.role) {
        case 'rock': this.drawRockIcon(time); break;
        case 'paper': this.drawPaperIcon(time); break;
        case 'scissors': this.drawScissorsIcon(time); break;
      }

      ctx.restore();
    }

    // Rock - wobbling white circle with texture (from game)
    drawRockIcon(time) {
      const wobble = Math.sin(time * 3) * 1;
      const pulseScale = 1 + Math.sin(time * 2) * 0.05;

      ctx.save();
      ctx.scale(pulseScale, pulseScale);

      ctx.beginPath();
      ctx.arc(wobble, 0, 10, 0, Math.PI * 2);
      ctx.fill();

      // Texture detail
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.beginPath();
      ctx.arc(wobble - 3, -2, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    // Paper - fluttering rectangle with lines (from game)
    drawPaperIcon(time) {
      const bob = Math.sin(time * 4) * 2;
      const tilt = Math.sin(time * 2) * 0.1;

      ctx.save();
      ctx.rotate(tilt);
      ctx.translate(0, bob);

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-8, -10, 16, 20);

      // Lines on paper
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

    // Scissors - snipping blades with handles (from game)
    drawScissorsIcon(time) {
      const snip = Math.sin(time * 6) * 0.3;

      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';

      // Left blade
      ctx.save();
      ctx.rotate(-0.3 - snip);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -12);
      ctx.stroke();
      ctx.restore();

      // Right blade
      ctx.save();
      ctx.rotate(0.3 + snip);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -12);
      ctx.stroke();
      ctx.restore();

      // Handle circles
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
    constructor() {
      this.reset();
    }

    reset() {
      // RPS relationships: rock > scissors, scissors > paper, paper > rock
      const roles = ['rock', 'paper', 'scissors'];
      const predatorIdx = Math.floor(Math.random() * 3);
      // What the predator beats
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

      // Start from edge
      const startEdge = Math.floor(Math.random() * 4);
      const angleVariance = (Math.random() - 0.5) * 0.5;

      switch(startEdge) {
        case 0: // top
          this.prey.x = 100 + Math.random() * (canvas.width - 200);
          this.prey.y = -60;
          this.angle = Math.PI / 2 + angleVariance;
          break;
        case 1: // right
          this.prey.x = canvas.width + 60;
          this.prey.y = 100 + Math.random() * (canvas.height - 200);
          this.angle = Math.PI + angleVariance;
          break;
        case 2: // bottom
          this.prey.x = 100 + Math.random() * (canvas.width - 200);
          this.prey.y = canvas.height + 60;
          this.angle = -Math.PI / 2 + angleVariance;
          break;
        case 3: // left
          this.prey.x = -60;
          this.prey.y = 100 + Math.random() * (canvas.height - 200);
          this.angle = angleVariance;
          break;
      }

      // Predator follows behind
      this.predator.x = this.prey.x - Math.cos(this.angle) * 100;
      this.predator.y = this.prey.y - Math.sin(this.angle) * 100;

      this.speed = 1.2 + Math.random() * 0.8;
      this.phase = Math.random() * Math.PI * 2;
    }

    update() {
      const wobble = Math.sin(Date.now() * 0.002 + this.phase) * 0.2;
      const moveAngle = this.angle + wobble;

      // Prey runs faster
      this.prey.x += Math.cos(moveAngle) * this.speed * 1.15;
      this.prey.y += Math.sin(moveAngle) * this.speed * 1.15;

      // Predator chases
      this.predator.x += Math.cos(moveAngle) * this.speed;
      this.predator.y += Math.sin(moveAngle) * this.speed;

      // Reset when off screen
      const margin = 150;
      if (this.prey.x < -margin || this.prey.x > canvas.width + margin ||
          this.prey.y < -margin || this.prey.y > canvas.height + margin) {
        this.reset();
      }
    }

    draw(time) {
      this.drawCharacter(this.prey, time);
      this.drawCharacter(this.predator, time);
    }

    drawCharacter(char, time) {
      ctx.save();
      ctx.translate(char.x, char.y);
      ctx.globalAlpha = char.opacity;

      const color = COLORS[char.role];
      const t = time + this.phase;

      // Glow
      ctx.shadowColor = color;
      ctx.shadowBlur = 35;

      // Main circle
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, char.radius, 0, Math.PI * 2);
      ctx.fill();

      // Border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Icon
      ctx.shadowBlur = 0;
      const scale = char.radius / 22;
      ctx.save();
      ctx.scale(scale, scale);

      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;

      switch(char.role) {
        case 'rock': this.drawRockIcon(t); break;
        case 'paper': this.drawPaperIcon(t); break;
        case 'scissors': this.drawScissorsIcon(t); break;
      }

      ctx.restore();
      ctx.restore();
    }

    drawRockIcon(time) {
      const wobble = Math.sin(time * 3) * 1;
      ctx.beginPath();
      ctx.arc(wobble, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.beginPath();
      ctx.arc(wobble - 3, -2, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    drawPaperIcon(time) {
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

    drawScissorsIcon(time) {
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

  let characters = [];
  let chasePairs = [];
  let animationId = null;
  let isRunning = false;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function init() {
    resize();

    // Floating background characters
    const count = Math.max(12, Math.floor((canvas.width * canvas.height) / 60000));
    characters = [];
    for (let i = 0; i < count; i++) {
      characters.push(new RPSCharacter());
    }

    // Chase animations
    chasePairs = [];
    for (let i = 0; i < 3; i++) {
      chasePairs.push(new ChasePair());
    }
  }

  function animate() {
    if (!isRunning) return;

    const time = Date.now() * 0.001;

    // Clear with dark background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw floating characters
    for (const char of characters) {
      char.update();
      char.draw(time);
    }

    // Draw chase pairs
    for (const pair of chasePairs) {
      pair.update();
      pair.draw(time);
    }

    animationId = requestAnimationFrame(animate);
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    init();
    animate();
  }

  function stop() {
    isRunning = false;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  }

  window.addEventListener('resize', () => {
    if (isRunning) resize();
  });

  // Watch for lobby screen visibility
  const lobbyScreen = document.getElementById('lobby-screen');
  if (lobbyScreen) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          if (lobbyScreen.classList.contains('hidden')) {
            stop();
          } else {
            start();
          }
        }
      }
    });
    observer.observe(lobbyScreen, { attributes: true });

    if (!lobbyScreen.classList.contains('hidden')) {
      start();
    }
  }

  window.lobbyBackground = { start, stop };
})();
