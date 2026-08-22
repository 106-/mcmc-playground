(() => {
  'use strict';

  const TARGET_POINTS = 101;
  const HIST_BINS = 50;
  const PAD = { left: 34, right: 18, top: 18, bottom: 30 };

  const targetCanvas = document.querySelector('#targetCanvas');
  const resultCanvas = document.querySelector('#resultCanvas');
  const chainCanvas = document.querySelector('#chainCanvas');
  const sampleInput = document.querySelector('#sampleCount');
  const stepInput = document.querySelector('#stepSize');
  const sampleOutput = document.querySelector('#sampleCountOutput');
  const stepOutput = document.querySelector('#stepSizeOutput');
  const runButton = document.querySelector('[data-action="run"]');
  const runLabel = document.querySelector('[data-run-label]');
  const statusPill = document.querySelector('[data-status]');
  const emptyResult = document.querySelector('[data-empty-result]');
  const targetWrap = document.querySelector('.target-wrap');

  const metrics = {
    samples: document.querySelector('#metricSamples'),
    acceptance: document.querySelector('#metricAcceptance'),
    position: document.querySelector('#metricPosition'),
    match: document.querySelector('#metricMatch'),
  };

  const state = {
    target: Array(TARGET_POINTS).fill(0.62),
    histogram: Array(HIST_BINS).fill(0),
    samples: [],
    recent: [],
    position: 5,
    accepted: 0,
    iterations: 0,
    targetSamples: Number(sampleInput.value),
    burnIn: 100,
    running: false,
    raf: null,
    dragging: false,
    lastIndex: null,
  };

  const colors = {
    ink: '#17221b', blue: '#1747ff', blueFade: 'rgba(23,71,255,.15)',
    pink: '#ff6fae', grid: '#dedfd6', white: '#fffef9', muted: '#8c938c', lime: '#c9ff45'
  };

  function setupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: rect.width, height: rect.height };
  }

  function plotRect(width, height) {
    return { x: PAD.left, y: PAD.top, width: width - PAD.left - PAD.right, height: height - PAD.top - PAD.bottom };
  }

  function drawGrid(ctx, rect, horizontal = 4) {
    ctx.save();
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    for (let i = 0; i <= horizontal; i += 1) {
      const y = rect.y + (rect.height * i) / horizontal;
      ctx.beginPath(); ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.width, y); ctx.stroke();
    }
    for (let i = 0; i <= 10; i += 1) {
      const x = rect.x + (rect.width * i) / 10;
      ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.height); ctx.stroke();
    }
    ctx.restore();
  }

  function smoothPath(ctx, points) {
    if (points.length < 2) return;
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length - 1; i += 1) {
      const midX = (points[i][0] + points[i + 1][0]) / 2;
      const midY = (points[i][1] + points[i + 1][1]) / 2;
      ctx.quadraticCurveTo(points[i][0], points[i][1], midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last[0], last[1]);
  }

  function drawTarget() {
    const { ctx, width, height } = setupCanvas(targetCanvas);
    const rect = plotRect(width, height);
    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, rect);

    const points = state.target.map((value, index) => [
      rect.x + rect.width * index / (TARGET_POINTS - 1),
      rect.y + rect.height * (1 - value * 0.92),
    ]);

    const gradient = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
    gradient.addColorStop(0, 'rgba(23,71,255,.32)');
    gradient.addColorStop(1, 'rgba(23,71,255,.035)');
    ctx.beginPath();
    smoothPath(ctx, points);
    ctx.lineTo(points[points.length - 1][0], rect.y + rect.height);
    ctx.lineTo(points[0][0], rect.y + rect.height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath(); smoothPath(ctx, points);
    ctx.strokeStyle = colors.blue; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

    const posX = rect.x + rect.width * state.position / 10;
    const posY = rect.y + rect.height * (1 - targetAt(state.position) * 0.92);
    ctx.beginPath(); ctx.arc(posX, posY, 5, 0, Math.PI * 2);
    ctx.fillStyle = colors.lime; ctx.fill(); ctx.strokeStyle = colors.ink; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawResult() {
    const { ctx, width, height } = setupCanvas(resultCanvas);
    const rect = plotRect(width, height);
    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, rect);

    const maxHist = Math.max(...state.histogram, 1);
    const gap = 2;
    const barW = rect.width / HIST_BINS;
    state.histogram.forEach((count, index) => {
      const barH = (count / maxHist) * rect.height * 0.84;
      const x = rect.x + index * barW;
      const y = rect.y + rect.height - barH;
      ctx.fillStyle = colors.blue;
      ctx.globalAlpha = 0.83;
      ctx.fillRect(x + gap / 2, y, Math.max(1, barW - gap), barH);
    });
    ctx.globalAlpha = 1;

    const maxTarget = Math.max(...state.target);
    const targetPoints = state.target.map((value, index) => [
      rect.x + rect.width * index / (TARGET_POINTS - 1),
      rect.y + rect.height - (value / maxTarget) * rect.height * 0.84,
    ]);
    ctx.beginPath(); smoothPath(ctx, targetPoints);
    ctx.strokeStyle = colors.pink; ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);

    if (state.samples.length) {
      const x = rect.x + rect.width * state.position / 10;
      ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.height);
      ctx.strokeStyle = colors.ink; ctx.globalAlpha = .45; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, rect.y + 7, 4, 0, Math.PI * 2); ctx.fillStyle = colors.lime; ctx.fill(); ctx.strokeStyle = colors.ink; ctx.stroke();
    }
  }

  function drawChain() {
    const { ctx, width, height } = setupCanvas(chainCanvas);
    ctx.clearRect(0, 0, width, height);
    const y = height / 2 + 5;
    ctx.strokeStyle = '#cdd0ca'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(width - 8, y); ctx.stroke();
    if (!state.recent.length) {
      ctx.fillStyle = colors.muted; ctx.font = '9px ui-monospace, monospace';
      ctx.fillText('START →', 8, y - 12);
      return;
    }
    const recent = state.recent.slice(-70);
    const dx = (width - 16) / Math.max(69, recent.length - 1);
    recent.forEach((step, i) => {
      const x = 8 + i * dx;
      const offset = (step.position / 10 - .5) * 34;
      ctx.beginPath(); ctx.arc(x, y - offset, step.accepted ? 2.7 : 2, 0, Math.PI * 2);
      ctx.fillStyle = step.accepted ? colors.blue : '#b9bdb8'; ctx.fill();
    });
  }

  function targetAt(x) {
    if (x < 0 || x > 10) return 0;
    const scaled = x / 10 * (TARGET_POINTS - 1);
    const left = Math.floor(scaled);
    const right = Math.min(TARGET_POINTS - 1, left + 1);
    const t = scaled - left;
    return Math.max(0.015, state.target[left] * (1 - t) + state.target[right] * t);
  }

  function normalRandom() {
    const u = Math.max(Number.MIN_VALUE, Math.random());
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function mhStep(collect = true) {
    const proposal = state.position + normalRandom() * Number(stepInput.value);
    const ratio = targetAt(proposal) / targetAt(state.position);
    const accepted = Math.random() < Math.min(1, ratio);
    if (accepted) {
      state.position = proposal;
      state.accepted += 1;
    }
    state.iterations += 1;
    state.recent.push({ position: state.position, accepted });
    if (state.recent.length > 100) state.recent.shift();

    if (collect && state.iterations > state.burnIn && state.samples.length < state.targetSamples) {
      state.samples.push(state.position);
      const bin = Math.min(HIST_BINS - 1, Math.max(0, Math.floor(state.position / 10 * HIST_BINS)));
      state.histogram[bin] += 1;
    }
  }

  function runFrame() {
    if (!state.running) return;
    const remaining = state.targetSamples - state.samples.length;
    const steps = Math.min(45, Math.max(1, remaining));
    for (let i = 0; i < steps; i += 1) mhStep();
    renderDynamic();
    if (state.samples.length >= state.targetSamples) {
      setRunning(false, true);
      return;
    }
    state.raf = requestAnimationFrame(runFrame);
  }

  function setRunning(running, completed = false) {
    state.running = running;
    if (running) {
      state.targetSamples = Number(sampleInput.value);
      runLabel.textContent = '一時停止';
      runButton.querySelector('.play-icon').textContent = 'Ⅱ';
      statusPill.dataset.status = 'running';
      statusPill.querySelector('b').textContent = 'WALKING';
      state.raf = requestAnimationFrame(runFrame);
    } else {
      if (state.raf) cancelAnimationFrame(state.raf);
      runLabel.textContent = state.samples.length ? '続きをサンプリング' : 'サンプリング開始';
      runButton.querySelector('.play-icon').textContent = '▶';
      statusPill.dataset.status = completed ? 'done' : 'idle';
      statusPill.querySelector('b').textContent = completed ? 'DONE' : 'READY';
    }
  }

  function shapeMatch() {
    if (state.samples.length < 50) return null;
    const targetBins = Array(HIST_BINS).fill(0);
    state.target.forEach((value, index) => {
      const bin = Math.min(HIST_BINS - 1, Math.floor(index / TARGET_POINTS * HIST_BINS));
      targetBins[bin] += value;
    });
    const targetSum = targetBins.reduce((a, b) => a + b, 0);
    const histSum = state.samples.length;
    const distance = targetBins.reduce((sum, val, i) => sum + Math.abs(val / targetSum - state.histogram[i] / histSum), 0) / 2;
    return Math.max(0, Math.round((1 - distance) * 100));
  }

  function updateMetrics() {
    metrics.samples.textContent = state.samples.length.toLocaleString('ja-JP');
    metrics.acceptance.textContent = state.iterations ? `${Math.round(state.accepted / state.iterations * 100)}%` : '—';
    metrics.position.textContent = state.position.toFixed(2);
    const match = shapeMatch();
    metrics.match.textContent = match === null ? '—' : `${match}%`;
    emptyResult.hidden = state.samples.length > 0;
  }

  function renderDynamic() {
    drawTarget(); drawResult(); drawChain(); updateMetrics();
  }

  function resetSamples() {
    setRunning(false);
    state.histogram.fill(0);
    state.samples = [];
    state.recent = [];
    state.position = 5;
    state.accepted = 0;
    state.iterations = 0;
    renderDynamic();
  }

  function applyPreset(name) {
    state.target = Array.from({ length: TARGET_POINTS }, (_, index) => {
      const x = index / (TARGET_POINTS - 1) * 10;
      if (name === 'double') {
        return .06 + .78 * Math.exp(-((x - 2.6) ** 2) / 1.1) + .58 * Math.exp(-((x - 7.2) ** 2) / 2.1);
      }
      if (name === 'skew') {
        const z = Math.max(.001, x / 10);
        return .04 + 3.1 * Math.pow(z, 1.3) * Math.exp(-4.2 * z);
      }
      return .62;
    });
    const max = Math.max(...state.target);
    state.target = state.target.map(v => Math.min(.96, v / max * .88));
    document.querySelectorAll('[data-preset]').forEach(button => button.classList.toggle('is-active', button.dataset.preset === name));
    targetWrap.classList.toggle('has-drawn', name !== 'uniform');
    resetSamples();
  }

  function drawFromPointer(event) {
    const rect = targetCanvas.getBoundingClientRect();
    const plot = plotRect(rect.width, rect.height);
    const localX = Math.min(plot.x + plot.width, Math.max(plot.x, event.clientX - rect.left));
    const localY = Math.min(plot.y + plot.height, Math.max(plot.y, event.clientY - rect.top));
    const index = Math.round((localX - plot.x) / plot.width * (TARGET_POINTS - 1));
    const value = Math.min(.98, Math.max(.025, (1 - (localY - plot.y) / plot.height) / .92));
    const start = state.lastIndex === null ? index : state.lastIndex;
    const distance = Math.abs(index - start);
    const direction = index >= start ? 1 : -1;
    const from = state.target[start];
    for (let offset = 0; offset <= distance; offset += 1) {
      const i = start + offset * direction;
      const t = distance === 0 ? 1 : offset / distance;
      const center = from + (value - from) * t;
      for (let j = -3; j <= 3; j += 1) {
        const k = i + j;
        if (k >= 0 && k < TARGET_POINTS) {
          const influence = 0.55 * (1 - Math.abs(j) / 4);
          state.target[k] = state.target[k] * (1 - influence) + center * influence;
        }
      }
    }
    state.lastIndex = index;
    targetWrap.classList.add('has-drawn');
    document.querySelectorAll('[data-preset]').forEach(button => button.classList.remove('is-active'));
    drawTarget(); drawResult();
  }

  targetCanvas.addEventListener('pointerdown', event => {
    state.dragging = true;
    state.lastIndex = null;
    targetCanvas.setPointerCapture(event.pointerId);
    if (state.samples.length) resetSamples();
    drawFromPointer(event);
  });
  targetCanvas.addEventListener('pointermove', event => { if (state.dragging) drawFromPointer(event); });
  targetCanvas.addEventListener('pointerup', () => { state.dragging = false; state.lastIndex = null; });
  targetCanvas.addEventListener('pointercancel', () => { state.dragging = false; state.lastIndex = null; });

  runButton.addEventListener('click', () => setRunning(!state.running));
  document.querySelector('[data-action="step"]').addEventListener('click', () => {
    if (state.running) setRunning(false);
    mhStep(); renderDynamic();
  });
  document.querySelector('[data-action="reset"]').addEventListener('click', resetSamples);
  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
  sampleInput.addEventListener('input', () => {
    sampleOutput.textContent = Number(sampleInput.value).toLocaleString('ja-JP');
    state.targetSamples = Number(sampleInput.value);
    if (!state.running && state.samples.length < state.targetSamples && state.samples.length > 0) {
      statusPill.dataset.status = 'idle'; statusPill.querySelector('b').textContent = 'READY';
    }
  });
  stepInput.addEventListener('input', () => { stepOutput.textContent = Number(stepInput.value).toFixed(2); });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderDynamic, 80);
  });

  renderDynamic();
})();
