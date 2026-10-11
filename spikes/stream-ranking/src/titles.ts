// The ~20 titles in the fixture corpus. Chosen to stress different things:
// rich 4K/HDR/remux catalogues, old SD/HDTV shows, non-English and multi-audio releases,
// season packs, anime with fansub naming and absolute episode numbers, and fresh theatrical
// releases where CAMs, TS and fakes show up.

export type TitleSpec = {
  slug: string;
  kind: 'movie' | 'series' | 'anime';
  type: 'movie' | 'series';
  id: string;
  why: string;
};

export const titles: TitleSpec[] = [
  // Movies
  { slug: 'shawshank', kind: 'movie', type: 'movie', id: 'tt0111161', why: 'classic, every kind of encode' },
  { slug: 'dune-part-two', kind: 'movie', type: 'movie', id: 'tt15239678', why: '4K HDR / DV / Atmos / remux' },
  { slug: 'oppenheimer', kind: 'movie', type: 'movie', id: 'tt15398776', why: 'IMAX, very large remuxes, 3h runtime' },
  { slug: 'parasite', kind: 'movie', type: 'movie', id: 'tt6751668', why: 'non-English original audio' },
  { slug: 'rrr', kind: 'movie', type: 'movie', id: 'tt8178634', why: 'Indian multi-audio releases' },
  { slug: 'project-hail-mary', kind: 'movie', type: 'movie', id: 'tt12042730', why: '2026, recently on digital' },
  { slug: 'spider-man-brand-new-day', kind: 'movie', type: 'movie', id: 'tt22084616', why: '2026 theatrical: CAM / TS / fakes' },
  { slug: 'coyote-vs-acme', kind: 'movie', type: 'movie', id: 'tt1756855', why: '2026 theatrical: CAM / TS / fakes' },
  // Series
  { slug: 'breaking-bad-s01e01', kind: 'series', type: 'series', id: 'tt0903747:1:1', why: 'season and complete-series packs' },
  { slug: 'the-office-s03e05', kind: 'series', type: 'series', id: 'tt0386676:3:5', why: 'old show: SD, HDTV, DVD rips' },
  { slug: 'last-of-us-s02e01', kind: 'series', type: 'series', id: 'tt3581920:2:1', why: 'recent HDR / DV episodes' },
  { slug: 'severance-s02e01', kind: 'series', type: 'series', id: 'tt11280740:2:1', why: 'streaming-service WEB-DLs' },
  { slug: 'shogun-s01e01', kind: 'series', type: 'series', id: 'tt2788316:1:1', why: 'multi-language' },
  { slug: 'lanterns-s01e08', kind: 'series', type: 'series', id: 'tt26545992:1:8', why: 'airing now: newest episode, few seeds' },
  // Anime
  { slug: 'frieren-e01', kind: 'anime', type: 'series', id: 'kitsu:46474:1', why: 'fansub naming via kitsu id' },
  { slug: 'attack-on-titan-e01', kind: 'anime', type: 'series', id: 'kitsu:7442:1', why: 'old anime, BD batches' },
  { slug: 'one-piece-e1100', kind: 'anime', type: 'series', id: 'kitsu:12:1100', why: 'absolute episode numbers' },
  { slug: 'dandadan-e01', kind: 'anime', type: 'series', id: 'kitsu:48269:1', why: 'dual audio, recent' },
  { slug: 'solo-leveling-s01e01', kind: 'anime', type: 'series', id: 'tt21209876:1:1', why: 'anime through an IMDb id' },
  { slug: 'your-name', kind: 'anime', type: 'movie', id: 'tt5311514', why: 'anime movie' },
];
