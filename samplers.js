(function attachSamplers(global) {
  'use strict';

  const DOMAIN_MAX = 10;
  const DIVERGENCE_LIMIT = 1000;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalRandom(random = Math.random) {
    const u = Math.max(Number.MIN_VALUE, random());
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function sigmoid(q) {
    if (q >= 0) {
      const z = Math.exp(-q);
      return 1 / (1 + z);
    }
    const z = Math.exp(q);
    return z / (1 + z);
  }

  function createTransformedTarget(density) {
    function qToX(q) {
      return DOMAIN_MAX * sigmoid(q);
    }

    function xToQ(x) {
      const s = clamp(x / DOMAIN_MAX, 1e-9, 1 - 1e-9);
      return Math.log(s / (1 - s));
    }

    function logDensity(q) {
      const s = sigmoid(q);
      const x = DOMAIN_MAX * s;
      const jacobian = DOMAIN_MAX * s * (1 - s);
      return Math.log(Math.max(1e-12, density(x))) + Math.log(Math.max(1e-12, jacobian));
    }

    function gradient(q) {
      const h = 1e-4 * Math.max(1, Math.abs(q));
      return (logDensity(q + h) - logDensity(q - h)) / (2 * h);
    }

    return { qToX, xToQ, logDensity, gradient };
  }

  function leapfrog(q, momentum, epsilon, target) {
    const halfMomentum = momentum + 0.5 * epsilon * target.gradient(q);
    const nextQ = q + epsilon * halfMomentum;
    const nextMomentum = halfMomentum + 0.5 * epsilon * target.gradient(nextQ);
    return { q: nextQ, momentum: nextMomentum };
  }

  function hamiltonian(q, momentum, target) {
    return -target.logDensity(q) + 0.5 * momentum * momentum;
  }

  function hmcTransition({ x, density, stepSize, leapfrogSteps, random = Math.random }) {
    const target = createTransformedTarget(density);
    const q0 = target.xToQ(x);
    const momentum0 = normalRandom(random);
    let q = q0;
    let momentum = momentum0;
    const trajectory = [x];

    for (let i = 0; i < leapfrogSteps; i += 1) {
      const next = leapfrog(q, momentum, stepSize, target);
      q = next.q;
      momentum = next.momentum;
      trajectory.push(target.qToX(q));
      if (!Number.isFinite(q) || !Number.isFinite(momentum)) break;
    }

    const proposal = target.qToX(q);
    const energyBefore = hamiltonian(q0, momentum0, target);
    const energyAfter = hamiltonian(q, -momentum, target);
    const deltaEnergy = energyAfter - energyBefore;
    const alpha = Number.isFinite(deltaEnergy) ? Math.exp(Math.min(0, -deltaEnergy)) : 0;
    const randomDraw = random();
    const accepted = randomDraw < alpha;

    return {
      sampler: 'hmc', before: x, proposal,
      result: accepted ? proposal : x,
      accepted, alpha, acceptanceStat: alpha, randomDraw,
      beforeDensity: density(x), proposalDensity: density(proposal),
      energyBefore, energyAfter, deltaEnergy,
      trajectory, leapfrogSteps,
    };
  }

  function noUTurn(qMinus, qPlus, momentumMinus, momentumPlus) {
    const distance = qPlus - qMinus;
    return distance * momentumMinus >= 0 && distance * momentumPlus >= 0;
  }

  function buildTree(q, momentum, logSlice, direction, depth, stepSize, target, joint0, random) {
    if (depth === 0) {
      const next = leapfrog(q, momentum, direction * stepSize, target);
      const joint = target.logDensity(next.q) - 0.5 * next.momentum * next.momentum;
      const valid = Number.isFinite(joint) && logSlice <= joint ? 1 : 0;
      const safe = Number.isFinite(joint) && logSlice - DIVERGENCE_LIMIT < joint ? 1 : 0;
      const alpha = Number.isFinite(joint) ? Math.exp(Math.min(0, joint - joint0)) : 0;
      return {
        qMinus: next.q, qPlus: next.q,
        momentumMinus: next.momentum, momentumPlus: next.momentum,
        proposalQ: next.q, valid, safe,
        alphaSum: alpha, alphaCount: 1,
        trajectory: [next.q], leapfrogSteps: 1,
        diverged: safe === 0,
      };
    }

    const left = buildTree(q, momentum, logSlice, direction, depth - 1, stepSize, target, joint0, random);
    if (!left.safe) return left;

    const edgeQ = direction === -1 ? left.qMinus : left.qPlus;
    const edgeMomentum = direction === -1 ? left.momentumMinus : left.momentumPlus;
    const right = buildTree(edgeQ, edgeMomentum, logSlice, direction, depth - 1, stepSize, target, joint0, random);

    let proposalQ = left.proposalQ;
    const totalValid = left.valid + right.valid;
    if (totalValid > 0 && random() < right.valid / totalValid) proposalQ = right.proposalQ;

    const qMinus = direction === -1 ? right.qMinus : left.qMinus;
    const momentumMinus = direction === -1 ? right.momentumMinus : left.momentumMinus;
    const qPlus = direction === -1 ? left.qPlus : right.qPlus;
    const momentumPlus = direction === -1 ? left.momentumPlus : right.momentumPlus;

    return {
      qMinus, qPlus, momentumMinus, momentumPlus, proposalQ,
      valid: totalValid,
      safe: left.safe && right.safe && noUTurn(qMinus, qPlus, momentumMinus, momentumPlus) ? 1 : 0,
      alphaSum: left.alphaSum + right.alphaSum,
      alphaCount: left.alphaCount + right.alphaCount,
      trajectory: left.trajectory.concat(right.trajectory),
      leapfrogSteps: left.leapfrogSteps + right.leapfrogSteps,
      diverged: left.diverged || right.diverged,
    };
  }

  function nutsTransition({ x, density, stepSize, maxDepth, random = Math.random }) {
    const target = createTransformedTarget(density);
    const q0 = target.xToQ(x);
    const momentum0 = normalRandom(random);
    const joint0 = target.logDensity(q0) - 0.5 * momentum0 * momentum0;
    const logSlice = joint0 + Math.log(Math.max(Number.MIN_VALUE, random()));

    let qMinus = q0;
    let qPlus = q0;
    let momentumMinus = momentum0;
    let momentumPlus = momentum0;
    let proposalQ = q0;
    let valid = 1;
    let keepGoing = 1;
    let depth = 0;
    let alphaSum = 0;
    let alphaCount = 0;
    let leapfrogSteps = 0;
    let stoppedByTurn = false;
    let diverged = false;
    const trajectoryQ = [q0];

    while (keepGoing && depth < maxDepth) {
      const direction = random() < 0.5 ? -1 : 1;
      const tree = direction === -1
        ? buildTree(qMinus, momentumMinus, logSlice, direction, depth, stepSize, target, joint0, random)
        : buildTree(qPlus, momentumPlus, logSlice, direction, depth, stepSize, target, joint0, random);

      if (direction === -1) {
        qMinus = tree.qMinus;
        momentumMinus = tree.momentumMinus;
      } else {
        qPlus = tree.qPlus;
        momentumPlus = tree.momentumPlus;
      }

      if (tree.safe && tree.valid > 0 && random() < tree.valid / Math.max(1, valid + tree.valid)) {
        proposalQ = tree.proposalQ;
      }

      valid += tree.valid;
      const turnDetected = !noUTurn(qMinus, qPlus, momentumMinus, momentumPlus);
      stoppedByTurn = stoppedByTurn || turnDetected;
      keepGoing = tree.safe && !turnDetected ? 1 : 0;
      alphaSum += tree.alphaSum;
      alphaCount += tree.alphaCount;
      leapfrogSteps += tree.leapfrogSteps;
      diverged = diverged || tree.diverged;
      trajectoryQ.push(...tree.trajectory);
      depth += 1;
    }

    const proposal = target.qToX(proposalQ);
    const accepted = Math.abs(proposal - x) > 1e-10;
    const alpha = alphaCount ? alphaSum / alphaCount : 0;

    return {
      sampler: 'nuts', before: x, proposal,
      result: proposal, accepted, alpha, acceptanceStat: alpha,
      beforeDensity: density(x), proposalDensity: density(proposal),
      trajectory: trajectoryQ.map(target.qToX),
      treeDepth: depth, leapfrogSteps,
      stoppedByTurn, diverged,
    };
  }

  const api = { createTransformedTarget, hmcTransition, nutsTransition, normalRandom };
  global.MCMCSamplers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
