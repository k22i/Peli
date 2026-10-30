import { describe, expect, it } from "vite-plus/test";

import { accuracy, fakeRates, fakeTargets, fields, labelled, report } from "./accuracy";
import corpus from "./corpus/labelled.json";

// The CI gate (#51): the parser's per-field accuracy and the fake checks'
// error rates on the labelled corpus stay at or above the targets, so a
// parser regression fails the build. corpus/accuracy.md lists the numbers
// and every miss.

const rows = labelled(corpus);

it("has the whole labelled corpus", () => {
  expect(rows).toHaveLength(360);
  expect(
    ["dev", "holdout", "blind"].map((split) => rows.filter((row) => row.split === split).length),
  ).toEqual([200, 100, 60]);
});

describe.each(fields)("$name", (field) => {
  it(`is right for at least ${field.target}% of streams`, () => {
    expect(accuracy(rows, field).pct).toBeGreaterThanOrEqual(field.target);
  });
});

describe("fake checks", () => {
  const rates = fakeRates(rows);

  it("hide almost no genuine stream", () => {
    expect(rates.hiddenFalsePositiveRate).toBeLessThanOrEqual(
      fakeTargets.hiddenFalsePositiveRateMax,
    );
  });

  it("hide most fakes", () => {
    expect(rates.hiddenRecall).toBeGreaterThanOrEqual(fakeTargets.hiddenRecallMin);
  });

  it("flag CAM and TS releases, and nothing else", () => {
    expect(rates.camTsRecall).toBeGreaterThanOrEqual(fakeTargets.camTsRecallMin);
    expect(rates.camTsFalsePositiveRate).toBeLessThanOrEqual(fakeTargets.camTsFalsePositiveRateMax);
  });
});

// A parser change shows as a diff in the report.
it("matches the recorded report", async () => {
  await expect(report(rows)).toMatchFileSnapshot("./corpus/accuracy.md");
});
