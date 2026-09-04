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
  const hmcStepInput = document.querySelector('#hmcStepSize');
  const hmcLeapfrogInput = document.querySelector('#hmcLeapfrog');
  const nutsStepInput = document.querySelector('#nutsStepSize');
  const nutsDepthInput = document.querySelector('#nutsDepth');
  const smoothingInput = document.querySelector('#smoothing');
  const runButton = document.querySelector('[data-action="run"]');
  const runLabel = document.querySelector('[data-run-label]');
  const statusPill = document.querySelector('[data-status]');
  const emptyResult = document.querySelector('[data-empty-result]');
  const targetWrap = document.querySelector('.target-wrap');
  const decisionCard = document.querySelector('[data-decision]');

  const outputs = {
    samples: document.querySelector('#sampleCountOutput'),
    mhStep: document.querySelector('#stepSizeOutput'),
    hmcStep: document.querySelector('#hmcStepSizeOutput'),
    hmcLeapfrog: document.querySelector('#hmcLeapfrogOutput'),
    nutsStep: document.querySelector('#nutsStepSizeOutput'),
    nutsDepth: document.querySelector('#nutsDepthOutput'),
    fitError: document.querySelector('#fitErrorOutput'),
  };

  const decisionFields = {
    status: document.querySelector('[data-decision-status]'),
    beforeLabel: document.querySelector('[data-before-label]'),
    proposalLabel: document.querySelector('[data-proposal-label]'),
    comparisonLabel: document.querySelector('[data-comparison-label]'),
    before: document.querySelector('[data-decision-before]'),
    proposal: document.querySelector('[data-decision-proposal]'),
    beforeDensity: document.querySelector('[data-density-before]'),
    proposalDensity: document.querySelector('[data-density-proposal]'),
    ratio: document.querySelector('[data-decision-ratio]'),
    alpha: document.querySelector('[data-decision-alpha]'),
  };

  const metrics = {
    samples: document.querySelector('#metricSamples'),
    acceptance: document.querySelector('#metricAcceptance'),
    acceptanceLabel: document.querySelector('[data-acceptance-label]'),
    position: document.querySelector('#metricPosition'),
    match: document.querySelector('#metricMatch'),
  };

  const state = {
    target: Array(TARGET_POINTS).fill(0.62),
    smoothTarget: Array(TARGET_POINTS).fill(0.62),
    histogram: Array(HIST_BINS).fill(0),
    samples: [],
    recent: [],
    position: 5,
    sampler: 'mh',
    accepted: 0,
    acceptanceSum: 0,
    iterations: 0,
    targetSamples: Number(sampleInput.value),
    burnIn: 100,
    running: false,
    raf: null,
    dragging: false,
    lastIndex: null,
    lastDecision: null,
    lastTrajectory: [],
  };

  const colors = {
    ink: '#17221b', blue: '#1747ff', pink: '#ff6fae',
    grid: '#dedfd6', muted: '#8c938c', lime: '#c9ff45', orange: '#f09b36',
  };

  const samplerCopy = {
    mh: {
      heading: 'MH で歩かせる',
      note: '手描きの青い分布を、そのまま目標にします。',
      steps: [
        ['次の場所を提案', 'いまの場所から、σ ぶんランダムにジャンプ。'],
        ['高さをくらべる', '候補と現在地の「分布の高さ」の比を計算。'],
        ['採択 or 棄却', '高い方へは必ず。低い方へも、ときどき進む。'],
      ],
      formulaKicker: 'ACCEPTANCE',
      formula: 'α = min (1, <i>p(x′)</i> / <i>p(x)</i>)',
      formulaNote: '正規化定数は、比をとると消えてくれる。',
    },
    hmc: {
      heading: 'HMC で走らせる',
      note: '滑らかなピンクの分布の勾配を使います。線は直近の軌道です。',
      steps: [
        ['運動量をひく', '位置とは別に、進む勢いを正規分布から与える。'],
        ['勾配に沿って進む', 'リープフロッグ法で位置と運動量を交互に更新。'],
        ['エネルギーで判定', '数値積分の誤差を採択・棄却で補正する。'],
      ],
      formulaKicker: 'HAMILTONIAN',
      formula: 'H(q, r) = −log <i>π(q)</i> + ½r²',
      formulaNote: '位置エネルギーと運動エネルギーの和を保ちながら進む。',
    },
    nuts: {
      heading: 'NUTS で走らせる',
      note: '滑らかな分布上で両方向へ軌道を伸ばし、Uターン前に止めます。',
      steps: [
        ['両方向へ木を伸ばす', 'リープフロッグ軌道を倍々に構築する。'],
        ['Uターンを探す', '元の方向へ戻り始めたら、軌道の延長を止める。'],
        ['軌道から選ぶ', '有効な候補から、偏りが出ないよう次の点を選ぶ。'],
      ],
      formulaKicker: 'NO U-TURN',
      formula: '(<i>q⁺ − q⁻</i>) · <i>r±</i> &lt; 0',
      formulaNote: '進行方向と軌道の幅が逆を向いたらUターン。',
    },
  };

  function setupCanvas(canvas) {
    const bounds = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(bounds.width * dpr);
    canvas.height = Math.round(bounds.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: bounds.width, height: bounds.height };
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
      const y = rect.y + rect.height * i / horizontal;
      ctx.beginPath(); ctx.moveTo(rect.x, y); ctx.lineTo(rect.x + rect.width, y); ctx.stroke();
    }
    for (let i = 0; i <= 10; i += 1) {
      const x = rect.x + rect.width * i / 10;
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

  function gaussianSmooth(values, sigma) {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const result = Array(values.length).fill(0);
    for (let i = 0; i < values.length; i += 1) {
      let total = 0;
      let weightTotal = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const index = Math.min(values.length - 1, Math.max(0, i + offset));
        const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
        total += values[index] * weight;
        weightTotal += weight;
      }
      result[i] = Math.max(0.015, total / weightTotal);
    }
    return result;
  }

  function recomputeSmoothTarget() {
    state.smoothTarget = gaussianSmooth(state.target, Number(smoothingInput.value));
    const meanSquare = state.target.reduce((sum, value, index) => {
      const difference = value - state.smoothTarget[index];
      return sum + difference * difference;
    }, 0) / TARGET_POINTS;
    outputs.fitError.textContent = `${(Math.sqrt(meanSquare) * 100).toFixed(1)}%`;
  }

  function linearAt(values, x) {
    if (x < 0 || x > 10) return 0;
    const scaled = x / 10 * (values.length - 1);
    const left = Math.floor(scaled);
    const right = Math.min(values.length - 1, left + 1);
    const t = scaled - left;
    return Math.max(0.015, values[left] * (1 - t) + values[right] * t);
  }

  function cubicAt(values, x) {
    if (x < 0 || x > 10) return 0;
    const scaled = x / 10 * (values.length - 1);
    const i1 = Math.floor(scaled);
    const t = scaled - i1;
    const i0 = Math.max(0, i1 - 1);
    const i2 = Math.min(values.length - 1, i1 + 1);
    const i3 = Math.min(values.length - 1, i1 + 2);
    const p0 = values[i0];
    const p1 = values[i1];
    const p2 = values[i2];
    const p3 = values[i3];
    const value = 0.5 * ((2 * p1) + (-p0 + p2) * t
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
      + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    return Math.max(0.015, value);
  }

  function rawTargetAt(x) {
    return linearAt(state.target, x);
  }

  function smoothTargetAt(x) {
    return cubicAt(state.smoothTarget, x);
  }

  function activeTargetAt(x) {
    return state.sampler === 'mh' ? rawTargetAt(x) : smoothTargetAt(x);
  }

  function pointsFor(values, rect, scale = 0.92) {
    return values.map((value, index) => [
      rect.x + rect.width * index / (values.length - 1),
      rect.y + rect.height * (1 - value * scale),
    ]);
  }

  function drawTarget() {
    const { ctx, width, height } = setupCanvas(targetCanvas);
    const rect = plotRect(width, height);
    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, rect);

    const rawPoints = pointsFor(state.target, rect);
    const fitPoints = pointsFor(state.smoothTarget, rect);
    const gradient = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.height);
    gradient.addColorStop(0, 'rgba(23,71,255,.26)');
    gradient.addColorStop(1, 'rgba(23,71,255,.025)');

    ctx.beginPath();
    smoothPath(ctx, rawPoints);
    ctx.lineTo(rawPoints[rawPoints.length - 1][0], rect.y + rect.height);
    ctx.lineTo(rawPoints[0][0], rect.y + rect.height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    rawPoints.forEach((point, index) => index ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1]));
    [...fitPoints].reverse().forEach(point => ctx.lineTo(point[0], point[1]));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,111,174,.14)';
    ctx.fill();

    ctx.beginPath(); smoothPath(ctx, rawPoints);
    ctx.strokeStyle = colors.blue; ctx.lineWidth = state.sampler === 'mh' ? 3 : 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

    ctx.beginPath(); smoothPath(ctx, fitPoints);
    ctx.strokeStyle = colors.pink; ctx.lineWidth = state.sampler === 'mh' ? 2 : 3; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);

    drawTrajectory(ctx, rect);

    const posX = rect.x + rect.width * state.position / 10;
    const posY = rect.y + rect.height * (1 - activeTargetAt(state.position) * 0.92);
    ctx.beginPath(); ctx.arc(posX, posY, 5, 0, Math.PI * 2);
    ctx.fillStyle = colors.lime; ctx.fill(); ctx.strokeStyle = colors.ink; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawTrajectory(ctx, rect) {
    if (state.lastTrajectory.length < 2) return;
    const maxPoints = 70;
    const stride = Math.max(1, Math.ceil(state.lastTrajectory.length / maxPoints));
    const trajectory = state.lastTrajectory.filter((_, index) => index % stride === 0 || index === state.lastTrajectory.length - 1);
    const points = trajectory
      .filter(x => x >= 0 && x <= 10)
      .map(x => [
        rect.x + rect.width * x / 10,
        rect.y + rect.height * (1 - activeTargetAt(x) * 0.92) - 9,
      ]);
    if (points.length < 2) return;
    ctx.save();
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1]));
    ctx.strokeStyle = colors.orange; ctx.lineWidth = 1.5; ctx.globalAlpha = .75; ctx.stroke();
    points.forEach((point, index) => {
      ctx.beginPath(); ctx.arc(point[0], point[1], index === points.length - 1 ? 3.2 : 2, 0, Math.PI * 2);
      ctx.fillStyle = index === points.length - 1 ? colors.lime : colors.orange; ctx.fill();
    });
    ctx.restore();
  }

  function drawCurve(ctx, points, color, width, dash = []) {
    ctx.beginPath(); smoothPath(ctx, points);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
  }

  function drawResult() {
    const { ctx, width, height } = setupCanvas(resultCanvas);
    const rect = plotRect(width, height);
    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, rect);

    const maxHist = Math.max(...state.histogram, 1);
    const gap = 2;
    const barWidth = rect.width / HIST_BINS;
    state.histogram.forEach((count, index) => {
      const barHeight = count / maxHist * rect.height * 0.84;
      ctx.fillStyle = colors.blue;
      ctx.globalAlpha = .8;
      ctx.fillRect(rect.x + index * barWidth + gap / 2, rect.y + rect.height - barHeight, Math.max(1, barWidth - gap), barHeight);
    });
    ctx.globalAlpha = 1;

    const maxTarget = Math.max(...state.target, ...state.smoothTarget);
    const makeResultPoints = values => values.map((value, index) => [
      rect.x + rect.width * index / (values.length - 1),
      rect.y + rect.height - value / maxTarget * rect.height * 0.84,
    ]);
    drawCurve(ctx, makeResultPoints(state.target), colors.pink, state.sampler === 'mh' ? 2.8 : 1.7, [7, 5]);
    drawCurve(ctx, makeResultPoints(state.smoothTarget), colors.ink, state.sampler === 'mh' ? 1.5 : 2.8);

    if (state.samples.length) {
      const x = rect.x + rect.width * state.position / 10;
      ctx.beginPath(); ctx.moveTo(x, rect.y); ctx.lineTo(x, rect.y + rect.height);
      ctx.strokeStyle = colors.ink; ctx.globalAlpha = .4; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
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
      ctx.fillStyle = colors.muted; ctx.font = '9px ui-monospace, monospace'; ctx.fillText('START →', 8, y - 12);
      return;
    }
    const recent = state.recent.slice(-70);
    const dx = (width - 16) / Math.max(69, recent.length - 1);
    recent.forEach((step, index) => {
      const x = 8 + index * dx;
      const offset = (step.position / 10 - .5) * 34;
      ctx.beginPath(); ctx.arc(x, y - offset, step.accepted ? 2.7 : 2, 0, Math.PI * 2);
      ctx.fillStyle = step.accepted ? colors.blue : '#b9bdb8'; ctx.fill();
    });
  }

  function mhTransition() {
    const before = state.position;
    const proposal = before + MCMCSamplers.normalRandom() * Number(stepInput.value);
    const beforeDensity = rawTargetAt(before);
    const proposalDensity = rawTargetAt(proposal);
    const ratio = proposalDensity / beforeDensity;
    const alpha = Math.min(1, ratio);
    const randomDraw = Math.random();
    const accepted = randomDraw < alpha;
    return {
      sampler: 'mh', before, proposal,
      result: accepted ? proposal : before,
      beforeDensity, proposalDensity, ratio, alpha,
      acceptanceStat: alpha, randomDraw, accepted,
      trajectory: [before, proposal],
    };
  }

  function nextTransition() {
    if (state.sampler === 'hmc') {
      return MCMCSamplers.hmcTransition({
        x: state.position,
        density: smoothTargetAt,
        stepSize: Number(hmcStepInput.value),
        leapfrogSteps: Number(hmcLeapfrogInput.value),
      });
    }
    if (state.sampler === 'nuts') {
      return MCMCSamplers.nutsTransition({
        x: state.position,
        density: smoothTargetAt,
        stepSize: Number(nutsStepInput.value),
        maxDepth: Number(nutsDepthInput.value),
      });
    }
    return mhTransition();
  }

  function sampleStep(collect = true) {
    const transition = nextTransition();
    state.position = transition.result;
    state.lastDecision = transition;
    state.lastTrajectory = transition.trajectory || [];
    state.accepted += transition.accepted ? 1 : 0;
    state.acceptanceSum += transition.acceptanceStat;
    state.iterations += 1;
    state.recent.push({ position: state.position, accepted: transition.accepted });
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
    const batchSize = state.sampler === 'mh' ? 45 : state.sampler === 'hmc' ? 14 : 5;
    const steps = Math.min(batchSize, Math.max(1, remaining));
    for (let i = 0; i < steps; i += 1) sampleStep();
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
      statusPill.querySelector('b').textContent = 'SAMPLING';
      state.raf = requestAnimationFrame(runFrame);
    } else {
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = null;
      runLabel.textContent = state.samples.length ? '続きをサンプリング' : 'サンプリング開始';
      runButton.querySelector('.play-icon').textContent = '▶';
      statusPill.dataset.status = completed ? 'done' : 'idle';
      statusPill.querySelector('b').textContent = completed ? 'DONE' : 'READY';
    }
  }

  function shapeMatch() {
    if (state.samples.length < 50) return null;
    const targetBins = Array.from({ length: HIST_BINS }, (_, index) => activeTargetAt((index + .5) / HIST_BINS * 10));
    const targetSum = targetBins.reduce((a, b) => a + b, 0);
    const histSum = state.samples.length;
    const distance = targetBins.reduce((sum, value, index) => sum + Math.abs(value / targetSum - state.histogram[index] / histSum), 0) / 2;
    return Math.max(0, Math.round((1 - distance) * 100));
  }

  function updateMetrics() {
    metrics.samples.textContent = state.samples.length.toLocaleString('ja-JP');
    if (!state.iterations) {
      metrics.acceptance.textContent = '—';
    } else if (state.sampler === 'nuts') {
      metrics.acceptance.textContent = `${Math.round(state.acceptanceSum / state.iterations * 100)}%`;
    } else {
      metrics.acceptance.textContent = `${Math.round(state.accepted / state.iterations * 100)}%`;
    }
    metrics.acceptanceLabel.textContent = state.sampler === 'nuts' ? '平均採択確率' : '採択率';
    metrics.position.textContent = state.position.toFixed(2);
    const match = shapeMatch();
    metrics.match.textContent = match === null ? '—' : `${match}%`;
    emptyResult.hidden = state.samples.length > 0;
  }

  function updateDecision() {
    const decision = state.lastDecision;
    decisionCard.hidden = decision === null;
    if (!decision) return;
    decisionCard.dataset.result = decision.accepted ? 'accepted' : 'rejected';

    decisionFields.before.innerHTML = decision.before.toFixed(3);
    decisionFields.proposal.innerHTML = decision.proposal.toFixed(3);
    decisionFields.beforeDensity.textContent = `p(x) = ${decision.beforeDensity.toFixed(3)}`;
    decisionFields.proposalDensity.textContent = `p(x′) = ${decision.proposalDensity.toFixed(3)}`;

    if (decision.sampler === 'mh') {
      decisionFields.beforeLabel.innerHTML = '前の値 <i>x</i>';
      decisionFields.proposalLabel.innerHTML = '新たな候補 <i>x′</i>';
      decisionFields.comparisonLabel.innerHTML = '高さの比 <i>p(x′) / p(x)</i>';
      decisionFields.status.textContent = decision.accepted
        ? `採択 → x = ${decision.result.toFixed(2)}`
        : `棄却 → x = ${decision.result.toFixed(2)} のまま`;
      decisionFields.ratio.textContent = `${decision.proposalDensity.toFixed(3)} / ${decision.beforeDensity.toFixed(3)} = ${decision.ratio.toFixed(3)}`;
      decisionFields.alpha.textContent = `α = ${decision.alpha.toFixed(3)} · u = ${decision.randomDraw.toFixed(3)}`;
      return;
    }

    if (decision.sampler === 'hmc') {
      decisionFields.beforeLabel.innerHTML = '出発点 <i>x</i>';
      decisionFields.proposalLabel.innerHTML = '軌道の終点 <i>x′</i>';
      decisionFields.comparisonLabel.textContent = 'エネルギー差 H′ − H';
      decisionFields.status.textContent = decision.accepted
        ? `採択 → x = ${decision.result.toFixed(2)}`
        : `棄却 → x = ${decision.result.toFixed(2)} のまま`;
      decisionFields.ratio.textContent = decision.deltaEnergy.toFixed(4);
      decisionFields.alpha.textContent = `α = ${decision.alpha.toFixed(3)} · u = ${decision.randomDraw.toFixed(3)} · ${decision.leapfrogSteps} step`;
      return;
    }

    decisionFields.beforeLabel.innerHTML = '出発点 <i>x</i>';
    decisionFields.proposalLabel.innerHTML = '選ばれた点 <i>x′</i>';
    decisionFields.comparisonLabel.textContent = '構築した軌道';
    decisionFields.status.textContent = decision.diverged
      ? `発散 → x = ${decision.result.toFixed(2)}`
      : `${decision.accepted ? '移動' : '停留'} → x = ${decision.result.toFixed(2)}`;
    decisionFields.ratio.textContent = `${decision.leapfrogSteps} leapfrog`;
    const stopReason = decision.diverged ? '発散で停止' : decision.stoppedByTurn ? 'Uターンで停止' : '最大深度で停止';
    decisionFields.alpha.textContent = `depth ${decision.treeDepth} · 平均α = ${decision.alpha.toFixed(3)} · ${stopReason}`;
  }

  function updateSamplerUI() {
    const copy = samplerCopy[state.sampler];
    document.querySelector('[data-sampler-heading]').textContent = copy.heading;
    document.querySelector('[data-sampler-note]').textContent = copy.note;
    document.querySelectorAll('[data-sampler]').forEach(button => {
      const active = button.dataset.sampler === state.sampler;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    });
    document.querySelectorAll('[data-control]').forEach(control => {
      control.hidden = control.dataset.control !== state.sampler;
    });
    document.querySelector('[data-step-legend]').innerHTML = state.sampler === 'nuts'
      ? '移動 <i class="accepted-dot"></i> / 停留 <i class="rejected-dot"></i>'
      : '採択 <i class="accepted-dot"></i> / 棄却 <i class="rejected-dot"></i>';
    copy.steps.forEach((step, index) => {
      document.querySelector(`[data-how-title="${index}"]`).textContent = step[0];
      document.querySelector(`[data-how-copy="${index}"]`).textContent = step[1];
    });
    document.querySelector('[data-formula-kicker]').textContent = copy.formulaKicker;
    document.querySelector('[data-formula]').innerHTML = copy.formula;
    document.querySelector('[data-formula-note]').textContent = copy.formulaNote;
  }

  function renderDynamic() {
    drawTarget(); drawResult(); drawChain(); updateMetrics(); updateDecision();
  }

  function resetSamples() {
    setRunning(false);
    state.histogram.fill(0);
    state.samples = [];
    state.recent = [];
    state.position = 5;
    state.accepted = 0;
    state.acceptanceSum = 0;
    state.iterations = 0;
    state.lastDecision = null;
    state.lastTrajectory = [];
    runLabel.textContent = 'サンプリング開始';
    statusPill.dataset.status = 'idle';
    statusPill.querySelector('b').textContent = 'READY';
    renderDynamic();
  }

  function selectSampler(name) {
    if (name === state.sampler) return;
    state.sampler = name;
    updateSamplerUI();
    resetSamples();
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
    state.target = state.target.map(value => Math.min(.96, value / max * .88));
    document.querySelectorAll('[data-preset]').forEach(button => button.classList.toggle('is-active', button.dataset.preset === name));
    targetWrap.classList.toggle('has-drawn', name !== 'uniform');
    recomputeSmoothTarget();
    resetSamples();
  }

  function drawFromPointer(event) {
    const bounds = targetCanvas.getBoundingClientRect();
    const plot = plotRect(bounds.width, bounds.height);
    const localX = Math.min(plot.x + plot.width, Math.max(plot.x, event.clientX - bounds.left));
    const localY = Math.min(plot.y + plot.height, Math.max(plot.y, event.clientY - bounds.top));
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
          const influence = .55 * (1 - Math.abs(j) / 4);
          state.target[k] = state.target[k] * (1 - influence) + center * influence;
        }
      }
    }
    state.lastIndex = index;
    targetWrap.classList.add('has-drawn');
    document.querySelectorAll('[data-preset]').forEach(button => button.classList.remove('is-active'));
    recomputeSmoothTarget();
    drawTarget(); drawResult();
  }

  targetCanvas.addEventListener('pointerdown', event => {
    state.dragging = true;
    state.lastIndex = null;
    targetCanvas.setPointerCapture(event.pointerId);
    if (state.iterations) resetSamples();
    drawFromPointer(event);
  });
  targetCanvas.addEventListener('pointermove', event => { if (state.dragging) drawFromPointer(event); });
  targetCanvas.addEventListener('pointerup', () => { state.dragging = false; state.lastIndex = null; });
  targetCanvas.addEventListener('pointercancel', () => { state.dragging = false; state.lastIndex = null; });

  runButton.addEventListener('click', () => setRunning(!state.running));
  document.querySelector('[data-action="step"]').addEventListener('click', () => {
    if (state.running) setRunning(false);
    sampleStep(); renderDynamic();
  });
  document.querySelector('[data-action="reset"]').addEventListener('click', resetSamples);
  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
  document.querySelectorAll('[data-sampler]').forEach(button => button.addEventListener('click', () => selectSampler(button.dataset.sampler)));

  sampleInput.addEventListener('input', () => {
    outputs.samples.textContent = Number(sampleInput.value).toLocaleString('ja-JP');
    state.targetSamples = Number(sampleInput.value);
  });
  stepInput.addEventListener('input', () => { outputs.mhStep.textContent = Number(stepInput.value).toFixed(2); });
  hmcStepInput.addEventListener('input', () => { outputs.hmcStep.textContent = Number(hmcStepInput.value).toFixed(2); });
  hmcLeapfrogInput.addEventListener('input', () => { outputs.hmcLeapfrog.textContent = hmcLeapfrogInput.value; });
  nutsStepInput.addEventListener('input', () => { outputs.nutsStep.textContent = Number(nutsStepInput.value).toFixed(2); });
  nutsDepthInput.addEventListener('input', () => { outputs.nutsDepth.textContent = nutsDepthInput.value; });
  smoothingInput.addEventListener('input', () => {
    if (state.iterations) resetSamples();
    recomputeSmoothTarget();
    renderDynamic();
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderDynamic, 80);
  });

  recomputeSmoothTarget();
  updateSamplerUI();
  renderDynamic();
})();
