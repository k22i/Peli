// The stream ranking engine (#51): parse what each stream claims, flag
// likely fakes, score, de-duplicate across addons and group by quality. One
// engine for the picker (#52, through the worker), plugin results (#56), the
// next-episode auto-pick (#58) and the in-player switcher (#68).
export * from "./context";
export * from "./engine";
export { judge, mbps, type Bucket, type Reason, type Verdict } from "./fakes";
export * from "./parse";
export * from "./score";
export { RankingSession, emptyView, warmRanking } from "./ranker";
