# Ranking engine accuracy

Written by `src/lib/ranking/accuracy.test.ts`; `vp test run -u` updates it.

| Field | dev (n=200) | holdout (n=100) | blind (n=60) | all (n=360) | Target |
|---|---:|---:|---:|---:|---:|
| resolution | 100% | 100% | 100% | 100% | ≥ 98% |
| hdr | 100% | 100% | 100% | 100% | ≥ 97% |
| video codec | 100% | 100% | 100% | 100% | ≥ 97% |
| audio codec | 100% | 100% | 100% | 100% | ≥ 95% |
| channels | 100% | 100% | 100% | 100% | ≥ 95% |
| atmos | 100% | 100% | 100% | 100% | ≥ 98% |
| size | 100% | 99% | 100% | 99.7% | ≥ 98% |
| source | 100% | 100% | 100% | 100% | ≥ 93% |
| release group | 96.5% | 90% | 95% | 94.4% | ≥ 85% |
| languages | 99.5% | 94% | 90% | 96.4% | ≥ 80% |
| season | 99.5% | 99% | 100% | 99.4% | ≥ 97% |
| episode | 100% | 99% | 100% | 99.7% | ≥ 95% |
| pack | 96% | 97% | 96.7% | 96.4% | ≥ 90% |
| cached | 100% | 100% | 100% | 100% | ≥ 100% |

| Fake checks | dev (n=200) | holdout (n=100) | blind (n=60) | all (n=360) | Target |
|---|---:|---:|---:|---:|---:|
| Hidden, false-positive rate | 0% | 0% | 0% | 0% | ≤ 1% |
| Hidden, recall | 73.9% | 62.5% | 28.6% | 63.2% | ≥ 60% |
| CAM / TS recall | 100% | 100% | 100% | 100% | ≥ 95% |
| CAM / TS false-positive rate | 0% | 0% | 0% | 0% | ≤ 1% |

## Misses

### size

- `comet-tb/coyote-vs-acme#229`: got 1556925644, want 1.4

### release group

- `comet-tb/one-piece-e1100#1198`: got null, want "RGzsRutracker"
- `comet-tb/rrr#243`: got null, want "Saicord"
- `comet-tb/rrr#203`: got null, want "Mr-X"
- `comet-tb/parasite#465`: got null, want "YTS.LT"
- `comet-tb/parasite#1069`: got "Laliberte", want null
- `comet-tb/shogun-s01e01#291`: got null, want "TeeWee"
- `comet-tb/one-piece-e1100#54`: got null, want "YTS.MX"
- `torrentio/shawshank#17`: got "NNMClub", want null
- `torrentio/your-name#14`: got null, want ["YTS.AM","YTS"]
- `torrentio-tb/coyote-vs-acme#94`: got "Team_il68k", want "New-Team"
- `torrentio-tb/spider-man-brand-new-day#263`: got "CAM", want null
- `torrentsdb/shogun-s01e01#13`: got null, want "i_c"
- `torrentsdb/project-hail-mary#49`: got null, want "ExKinoRay"
- `torrentsdb/shogun-s01e01#57`: got "DSNP", want null
- `torrentsdb/rrr#49`: got null, want "nickarad"
- `peerflix/dune-part-two#2`: got null, want "Grupo Custom U-HD"
- `peerflix/dune-part-two#15`: got null, want "Grupo Custom U-HD"
- `comet-tb/severance-s02e01#63`: got "PSOTNIK", want ["FLUX","PSOTNIK HT"]
- `torrentio/parasite#45`: got "Team", want ["Dread-Team","Mjcvcd-Dread-Team"]
- `torrentsdb/attack-on-titan-e01#11`: got null, want "i_c"

### languages

- `comet-tb/rrr#203`: got ["hi","en"], want ["hi"]
- `comet-tb/solo-leveling-s01e01#230`: got ["ta","hi"], want ["ta"]
- `torrentio-tb/rrr#15`: got ["te","hi"], want ["te"]
- `torrentio-tb/breaking-bad-s01e01#64`: got ["en"], want []
- `torrentio-tb/solo-leveling-s01e01#0`: got ["multi"], want ["multi","en","it","pt","es","ko","fr","de","hi"]
- `torrentio-tb/your-name#66`: got ["es","multi","ja","en"], want ["multi","es"]
- `peerflix/parasite#3`: got ["en","es","ko"], want ["es","ko"]
- `comet-tb/oppenheimer#449`: got ["zh"], want ["zh","en"]
- `comet-tb/parasite#504`: got ["hi","multi","nl"], want ["multi","hi"]
- `comet-tb/rrr#238`: got ["hi","te","en"], want ["hi"]
- `comet-tb/severance-s02e01#63`: got ["pl"], want []
- `torrentio-tb/dandadan-e01#41`: got [], want ["ja"]
- `peerflix/parasite#2`: got ["en","es","ko"], want ["es","ko"]

### season

- `torrentio-tb/attack-on-titan-e01#134`: got 1, want null
- `torrentsdb/breaking-bad-s01e01#5`: got 4, want null

### episode

- `comet-tb/frieren-e01#310`: got 2, want null

### pack

- `comet-tb/attack-on-titan-e01#544`: got false, want true
- `comet-tb/frieren-e01#310`: got false, want true
- `torrentsdb/attack-on-titan-e01#8`: got false, want true
- `torrentsdb/breaking-bad-s01e01#14`: got true, want false
- `torrentsdb/frieren-e01#15`: got false, want true
- `torrentsdb/attack-on-titan-e01#0`: got false, want true
- `torrentsdb/dandadan-e01#14`: got false, want true
- `torrentsdb/frieren-e01#22`: got false, want true
- `torrentsdb/attack-on-titan-e01#25`: got false, want true
- `torrentsdb/breaking-bad-s01e01#5`: got true, want false
- `torrentsdb/frieren-e01#9`: got false, want true
- `torrentsdb/attack-on-titan-e01#11`: got false, want true
- `torrentsdb/frieren-e01#4`: got false, want true

### Fake checks

- `comet-tb/one-piece-e1100#1198`: ok, labelled fake: a season 1 pack, asked for absolute episode 1100
- `comet-tb/parasite#940`: ok, labelled fake: different title (Slime Parasite)
- `comet-tb/the-office-s03e05#142`: ok, labelled fake: 14 episodes in 116 MB
- `comet-tb/one-piece-e1100#1151`: ok, labelled fake: East Blue season pack, asked for episode 1100
- `comet-tb/one-piece-e1100#188`: ok, labelled fake: the 2023 live-action series, asked for anime episode 1100
- `comet-tb/project-hail-mary#998`: ok, labelled fake: Internet Archive upload named after the book; most likely the audiobook (judgement)
- `comet-tb/one-piece-e1100#187`: ok, labelled fake: the 2023 live-action series, asked for anime episode 1100
- `comet-tb/one-piece-e1100#54`: ok, labelled fake: One Piece Film Z, asked for episode 1100
- `torrentio-tb/attack-on-titan-e01#134`: ok, labelled fake: episode 1 of the Junior High spin-off
- `comet-tb/one-piece-e1100#524`: ok (title mismatch), labelled fake: Hunter x Hunter
- `comet-tb/solo-leveling-s01e01#126`: ok (title mismatch), labelled fake: Family Guy
- `comet-tb/spider-man-brand-new-day#380`: ok, labelled fake: Spider-Man 2 (2004)
- `torrentio/attack-on-titan-e01#47`: ok, labelled fake: OAD episode 1, not the series' episode 1
- `torrentsdb/frieren-e01#4`: suspicious (too large), labelled fake: season 2 episode 14, tagged S01E01 by the addon
