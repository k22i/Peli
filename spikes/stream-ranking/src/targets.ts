// Accuracy targets proposed for #51, measured over all labelled streams (dev + holdout + blind).
// Each sits a little below what this spike's parser reached, so a regression fails the build
// while small label noise doesn't.
export const fieldTargets: Record<string, number> = {
  resolution: 98,
  hdr: 97,
  'video codec': 97,
  'audio codec': 95,
  channels: 95,
  atmos: 98,
  size: 98,
  source: 93,
  'release group': 85,
  languages: 80, // exact set match; the least well-defined field
  season: 97,
  episode: 95,
  pack: 90,
  cached: 100,
};

export const fakeTargets = {
  hiddenFalsePositiveRateMax: 1, // % of genuine streams wrongly hidden
  hiddenRecallMin: 60, // % of fakes hidden (strong signals only)
  camTsRecallMin: 95,
  camTsFalsePositiveRateMax: 1,
};

export const perfTargets = {
  rank200P95Ms: 16, // one frame, reference machine (M1 Pro), V8 and JSC
};
