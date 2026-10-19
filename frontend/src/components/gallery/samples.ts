// Made-up titles for the gallery. No artwork: the cards show their generated
// placeholders, so the gallery works offline and ships no third-party images.
export type SampleTitle = {
  title: string;
  year: number;
  runtime: string;
  badge?: string;
  progress?: number;
  episode?: string;
};

export const sampleTitles: SampleTitle[] = [
  { title: "Low Tide", year: 2025, runtime: "1h 52m", badge: "New" },
  { title: "The Lighthouse Keeper", year: 2024, runtime: "2h 08m" },
  { title: "Saltwater Hymns", year: 2023, runtime: "1h 41m", badge: "4K" },
  { title: "Northern Current", year: 2025, runtime: "8 episodes" },
  { title: "Paper Moons", year: 2022, runtime: "1h 37m" },
  { title: "Glass Harbor", year: 2024, runtime: "2 seasons" },
  { title: "The Quiet Reef", year: 2021, runtime: "1h 59m" },
  { title: "Undertow", year: 2025, runtime: "2h 14m", badge: "HDR" },
  { title: "Kelp Forest", year: 2020, runtime: "6 episodes" },
  { title: "Midnight Ferry", year: 2023, runtime: "1h 46m" },
  { title: "Driftwood", year: 2024, runtime: "1h 33m" },
  { title: "Coral City", year: 2025, runtime: "3 seasons" },
];

export const continueWatching: SampleTitle[] = [
  {
    title: "Northern Current",
    year: 2025,
    runtime: "32m left",
    episode: "S1 · E4",
    progress: 0.62,
  },
  { title: "Glass Harbor", year: 2024, runtime: "12m left", episode: "S2 · E7", progress: 0.84 },
  { title: "Undertow", year: 2025, runtime: "1h 21m left", progress: 0.38 },
  { title: "Kelp Forest", year: 2020, runtime: "48m left", episode: "S1 · E2", progress: 0.12 },
  { title: "Coral City", year: 2025, runtime: "5m left", episode: "S3 · E1", progress: 0.93 },
  { title: "Paper Moons", year: 2022, runtime: "58m left", progress: 0.4 },
];

export const genres = [
  "Action",
  "Animation",
  "Comedy",
  "Documentary",
  "Drama",
  "Fantasy",
  "Horror",
  "Mystery",
  "Romance",
  "Sci-fi",
  "Thriller",
];
