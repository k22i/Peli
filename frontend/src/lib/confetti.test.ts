import { describe, expect, it } from "vite-plus/test";

import {
  alpha,
  burstLife,
  cap,
  gentleLife,
  spawn,
  spawnGentle,
  step,
  stepGentle,
  type Particle,
} from "@/lib/confetti";

const width = 1200;
const height = 800;
const now = 10_000;

// mulberry32: the same stream every run, so an irregular burst is repeatable.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function particle(overrides: Partial<Particle> = {}): Particle {
  return {
    emoji: "🎉",
    x: width / 2,
    y: height,
    vx: 0,
    vy: 0,
    rot: 0,
    vr: 0,
    born: 0,
    life: burstLife,
    size: 28,
    ...overrides,
  };
}

function first(particles: readonly Particle[]): Particle {
  const [head] = particles;
  if (!head) throw new Error("expected at least one particle");
  return head;
}

describe("spawn", () => {
  it("throws the requested number of emoji from the bottom centre", () => {
    const particles = spawn("🎉", 40, width, height, now, seeded(1));
    expect(particles).toHaveLength(40);
    for (const each of particles) {
      expect(each.emoji).toBe("🎉");
      expect(each.born).toBe(now);
      expect(each.life).toBe(burstLife);
      expect(each.y).toBeGreaterThan(height * 0.95);
      expect(each.y).toBeLessThanOrEqual(height);
      expect(Math.abs(each.x - width / 2)).toBeLessThan(width * 0.05);
      expect(each.size).toBeGreaterThan(20);
    }
  });

  it("starts every particle upward", () => {
    for (const each of spawn("😂", 40, width, height, now, seeded(2))) {
      expect(each.vy).toBeLessThan(0);
    }
  });

  it("fans out to both sides with varied speeds", () => {
    const particles = spawn("🔥", 40, width, height, now, seeded(3));
    expect(particles.some((each) => each.vx < -100)).toBe(true);
    expect(particles.some((each) => each.vx > 100)).toBe(true);
    expect(new Set(particles.map((each) => Math.round(each.vy))).size).toBeGreaterThan(10);
    expect(new Set(particles.map((each) => each.vr.toFixed(2))).size).toBeGreaterThan(5);
  });

  it("peaks between 40 and 75% of the height", () => {
    const frame = 1 / 120;
    for (const start of spawn("🍿", 20, width, height, now, seeded(4))) {
      let flying = start;
      let top = flying.y;
      let at = now;
      while (flying.vy < 0) {
        at += frame * 1000;
        const [next] = step([flying], frame, at);
        if (!next) break;
        flying = next;
        top = Math.min(top, flying.y);
      }
      const rise = (height - top) / height;
      expect(rise).toBeGreaterThan(0.35);
      expect(rise).toBeLessThan(0.8);
    }
  });

  it("spawns nothing for a count or a layer of zero", () => {
    expect(spawn("🎉", 0, width, height, now, seeded(5))).toEqual([]);
    expect(spawn("🎉", 5, 0, height, now, seeded(5))).toEqual([]);
  });
});

describe("step", () => {
  it("pulls particles down, moves them sideways and spins them", () => {
    const before = particle({ vx: 300, vy: -400, vr: 2 });
    const after = first(step([before], 1 / 60, 100));
    expect(after.vy).toBeGreaterThan(before.vy);
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeLessThan(before.y);
    expect(after.rot).toBeGreaterThan(before.rot);
    // The sideways drag slows the drift over time.
    expect(after.vx).toBeLessThan(before.vx);
  });

  it("drops particles once their life is over", () => {
    const dead = particle({ born: 0 });
    expect(step([dead], 1 / 60, burstLife)).toEqual([]);
    expect(step([dead], 1 / 60, burstLife - 1)).toHaveLength(1);
  });
});

describe("alpha", () => {
  it("stays opaque and then fades over the last 30% of the life", () => {
    const p = particle({ born: 1000 });
    expect(alpha(p, 1000)).toBe(1);
    expect(alpha(p, 1000 + burstLife * 0.5)).toBe(1);
    expect(alpha(p, 1000 + burstLife * 0.7)).toBe(1);
    expect(alpha(p, 1000 + burstLife * 0.85)).toBeCloseTo(0.5, 5);
    expect(alpha(p, 1000 + burstLife)).toBe(0);
    expect(alpha(p, 1000 + burstLife * 2)).toBe(0);
  });
});

describe("cap", () => {
  it("keeps the newest 150 and drops the oldest first", () => {
    const particles = Array.from({ length: 200 }, (_, index) => particle({ born: index * 10 }));
    const kept = cap(particles);
    expect(kept).toHaveLength(150);
    expect(first(kept).born).toBe(50 * 10);
    expect(kept.at(-1)?.born).toBe(199 * 10);
  });

  it("leaves a short list alone", () => {
    const particles = [particle(), particle({ born: 1 })];
    expect(cap(particles)).toEqual(particles);
  });
});

describe("spawnGentle", () => {
  it("gives three to five particles that drift up without spinning", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const particles = spawnGentle("❤️", width, height, now, seeded(seed));
      expect(particles.length).toBeGreaterThanOrEqual(3);
      expect(particles.length).toBeLessThanOrEqual(5);
      for (const each of particles) {
        expect(each.born).toBe(now);
        expect(each.life).toBe(gentleLife);
        expect(each.vy).toBeLessThan(0);
        expect(Math.abs(each.vy)).toBeLessThan(height * 0.2);
        expect(each.rot).toBe(0);
        expect(each.vr).toBe(0);
        expect(Math.abs(each.x - width / 2)).toBeLessThan(width * 0.4);
      }
    }
  });
});

describe("stepGentle", () => {
  it("floats upward without gravity and still expires", () => {
    const start = first(spawnGentle("🍿", width, height, now, seeded(7)));
    const after = first(stepGentle([start], 1 / 60, now + 1000));
    expect(after.y).toBeLessThan(start.y);
    expect(after.rot).toBe(0);
    expect(stepGentle([start], 1 / 60, now + gentleLife)).toEqual([]);
  });
});
