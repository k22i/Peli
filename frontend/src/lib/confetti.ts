// Confetti physics for emoji reactions. Pure data in, pure data out: no DOM,
// no canvas, no clock of its own. Positions are CSS pixels relative to the
// layer's top-left corner, `y` growing downward. Times are milliseconds from
// the same clock as requestAnimationFrame's timestamps; `dt` is the seconds
// since the last step.
export type Particle = {
  emoji: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  born: number;
  life: number;
  size: number;
};

// Long enough to read the emoji, short enough not to sit on the picture.
export const burstLife = 2500;
export const gentleLife = 2500;

// Gravity in px/s². A particle keeps its speed on the way up and comes down
// quicker than it went, which is what real confetti does.
const gravity = 1400;

// Sideways damping, per second. Only the horizontal motion slows: the fan
// spreads and then eases off, while the vertical arc stays a clean parabola.
const drift = 1.2;

// The last 30% of the life fades out; before that the emoji is fully opaque.
const fadeFrom = 0.7;

// Half-angle of the fan, measured from straight up.
const fan = (35 * Math.PI) / 180;

// Where a burst peaks, as a fraction of the layer's height.
const peakMin = 0.4;
const peakMax = 0.75;

// Spreads `count` emoji out of the bottom centre: a fan of about ±35°, each one
// with its own speed so the group peaks between 40 and 75% of the height.
export function spawn(
  emoji: string,
  count: number,
  width: number,
  height: number,
  now: number,
  rand: () => number = Math.random,
): Particle[] {
  if (count <= 0 || width <= 0 || height <= 0) return [];
  return Array.from({ length: count }, () => {
    const size = 22 + rand() * 14;
    // The wanted peak sets the vertical speed, so widening the fan spreads the
    // burst across the layer without flattening the arc.
    const rise = height * (peakMin + rand() * (peakMax - peakMin));
    const vy = -Math.sqrt(2 * gravity * rise);
    const angle = (rand() * 2 - 1) * fan;
    return {
      emoji,
      x: width / 2 + (rand() - 0.5) * width * 0.06,
      y: height - size / 2,
      vx: -vy * Math.tan(angle),
      vy,
      rot: (rand() - 0.5) * 0.6,
      vr: (rand() - 0.5) * 5,
      born: now,
      life: burstLife,
      size,
    };
  });
}

// The reduced-motion burst: three to five emoji that drift slowly upward with
// no spin, then fade out over the same ~2.5 s.
export function spawnGentle(
  emoji: string,
  width: number,
  height: number,
  now: number,
  rand: () => number = Math.random,
): Particle[] {
  if (width <= 0 || height <= 0) return [];
  const count = 3 + Math.floor(rand() * 3);
  return Array.from({ length: count }, () => {
    const size = 22 + rand() * 12;
    return {
      emoji,
      x: width * (0.5 + (rand() - 0.5) * 0.6),
      y: height - size / 2,
      vx: (rand() - 0.5) * width * 0.03,
      // About a third of the height over the life: slow enough to read as a float.
      vy: -height * (0.1 + rand() * 0.06),
      rot: 0,
      vr: 0,
      born: now,
      life: gentleLife,
      size,
    };
  });
}

// Advances a burst by `dt` seconds: gravity on the vertical axis, drag on the
// horizontal one, rotation, and the dead dropped.
export function step(particles: readonly Particle[], dt: number, now: number): Particle[] {
  const damping = Math.exp(-drift * dt);
  const live: Particle[] = [];
  for (const particle of particles) {
    if (now - particle.born >= particle.life) continue;
    live.push({
      ...particle,
      x: particle.x + particle.vx * dt,
      // Constant acceleration, so the average speed over the step keeps the arc
      // right even when a frame takes a while.
      y: particle.y + (particle.vy + (gravity * dt) / 2) * dt,
      vx: particle.vx * damping,
      vy: particle.vy + gravity * dt,
      rot: particle.rot + particle.vr * dt,
    });
  }
  return live;
}

// The reduced-motion step: no gravity and no spin, just the drift and the fade.
// A separate integrator because gravity is a property of the motion, not of the
// particle, and a slow float has none.
export function stepGentle(particles: readonly Particle[], dt: number, now: number): Particle[] {
  const live: Particle[] = [];
  for (const particle of particles) {
    if (now - particle.born >= particle.life) continue;
    live.push({
      ...particle,
      x: particle.x + particle.vx * dt,
      y: particle.y + particle.vy * dt,
    });
  }
  return live;
}

// Opacity at `now`: full until the last 30% of the life, then a linear fade.
export function alpha(particle: Particle, now: number): number {
  const age = (now - particle.born) / particle.life;
  if (age >= 1) return 0;
  if (age <= fadeFrom) return 1;
  return (1 - age) / (1 - fadeFrom);
}

// Keeps the newest `max` particles, so a busy party drops the oldest burst's
// leftovers rather than the one that just arrived.
export function cap(particles: readonly Particle[], max = 150): Particle[] {
  if (max <= 0) return [];
  if (particles.length <= max) return [...particles];
  return particles.toSorted((first, second) => first.born - second.born).slice(-max);
}
