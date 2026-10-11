// The CI gate #51 asks for: per-field parser accuracy and fake-detection error rates on the
// labelled corpus must stay at or above the targets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fields, parseLabelled, score } from '../src/eval.ts';
import { judge } from '../src/fakes.ts';
import { loadLabelled } from '../src/labels.ts';
import { fakeTargets, fieldTargets } from '../src/targets.ts';

const rows = loadLabelled();

test('labelled corpus is complete', () => {
  assert.equal(rows.length, 360);
});

for (const f of fields) {
  test(`${f.name} accuracy ≥ ${fieldTargets[f.name]}%`, () => {
    const { pct, misses } = score(rows, f);
    assert.ok(pct >= fieldTargets[f.name], `${pct}% < ${fieldTargets[f.name]}%; first misses: ${JSON.stringify(misses.slice(0, 5))}`);
  });
}

test('fake detection error rates', () => {
  let fp = 0, genuine = 0, caught = 0, fakes = 0;
  let camHit = 0, cams = 0, camFp = 0;
  for (const r of rows) {
    const v = judge(parseLabelled(r), r.ctx);
    if (r.label.fake) {
      fakes++;
      if (v.bucket === 'hidden') caught++;
    } else {
      genuine++;
      if (v.bucket === 'hidden') fp++;
    }
    const cam = ['cam', 'ts', 'tc', 'scr'].includes(String(r.label.source));
    if (cam) cams++;
    if (v.reasons.includes('cam / ts')) cam ? camHit++ : camFp++;
  }
  assert.ok((100 * fp) / genuine <= fakeTargets.hiddenFalsePositiveRateMax, `hidden FP rate ${((100 * fp) / genuine).toFixed(1)}%`);
  assert.ok((100 * caught) / fakes >= fakeTargets.hiddenRecallMin, `hidden recall ${((100 * caught) / fakes).toFixed(1)}%`);
  assert.ok((100 * camHit) / cams >= fakeTargets.camTsRecallMin, `CAM/TS recall ${((100 * camHit) / cams).toFixed(1)}%`);
  assert.ok((100 * camFp) / (rows.length - cams) <= fakeTargets.camTsFalsePositiveRateMax, 'CAM/TS FP rate');
});
