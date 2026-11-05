# Ranking engine accuracy

Written by `src/lib/ranking/accuracy.test.ts`; `vp test run -u` updates it.

| Field | dev (n=200) | holdout (n=100) | blind (n=60) | longrun (n=132) | all (n=492) | Target |
|---|---:|---:|---:|---:|---:|---:|
| resolution | 100% | 100% | 100% | 98.5% | 99.6% | ≥ 98% |
| hdr | 100% | 100% | 100% | 100% | 100% | ≥ 97% |
| video codec | 100% | 100% | 100% | 100% | 100% | ≥ 97% |
| audio codec | 100% | 100% | 100% | 97% | 99.2% | ≥ 95% |
| channels | 100% | 100% | 100% | 98.5% | 99.6% | ≥ 95% |
| atmos | 100% | 100% | 100% | 100% | 100% | ≥ 98% |
| size | 100% | 99% | 100% | 99.2% | 99.6% | ≥ 98% |
| source | 100% | 100% | 100% | 97.7% | 99.4% | ≥ 93% |
| release group | 96.5% | 90% | 95% | 87.9% | 92.7% | ≥ 85% |
| languages | 99.5% | 94% | 90% | 92.4% | 95.3% | ≥ 80% |
| season | 99.5% | 99% | 100% | 98.5% | 99.2% | ≥ 97% |
| episode | 100% | 99% | 100% | 87.9% | 96.5% | ≥ 95% |
| pack | 96% | 97% | 96.7% | 75% | 90.7% | ≥ 90% |
| cached | 100% | 100% | 100% | 100% | 100% | ≥ 100% |

| Fake checks | dev (n=200) | holdout (n=100) | blind (n=60) | longrun (n=132) | all (n=492) | Target |
|---|---:|---:|---:|---:|---:|---:|
| Hidden, false-positive rate | 0% | 0% | 0% | 1.1% | 0.2% | ≤ 1% |
| Hidden, recall | 82.6% | 87.5% | 57.1% | 85.7% | 82.5% | ≥ 75% |
| CAM / TS recall | 100% | 100% | 100% | 0% | 100% | ≥ 95% |
| CAM / TS false-positive rate | 0% | 0% | 0% | 0.8% | 0.2% | ≤ 1% |

## Misses

### resolution

- `comet-tb/one-piece-e1000#20`: got "1080p", want null
- `torrentio/naruto-shippuden-e300#11`: got "1080p", want null

### audio codec

- `torrentio/one-piece-e1000#2`: got "aac", want null
- `torrentio/one-piece-e1000#35`: got "ac3", want null
- `torrentio-tb/one-piece-e1000#40`: got "ac3", want null
- `torrentio/naruto-shippuden-e300#9`: got "aac", want null

### channels

- `torrentio/naruto-shippuden-e300#2`: got "2.0", want null
- `torrentio/naruto-shippuden-e300#11`: got "2.0", want null

### size

- `comet-tb/coyote-vs-acme#229`: got 1556925644, want 1.4
- `comet-tb/naruto-shippuden-e300#73`: got 1248916405, want 1.2

### source

- `torrentio/one-piece-e1000#48`: got "ts", want null
- `comet-tb/one-piece-e1000#245`: got null, want "webrip"
- `comet-tb/naruto-shippuden-e300#38`: got null, want "dvd"

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
- `torrentio/one-piece-e1000#8`: got "Anime Time", want "i_c"
- `comet-tb/one-piece-e1000#110`: got "ColdFilm", want null
- `comet-tb/one-piece-e1000#114`: got "ColdFilm", want null
- `comet-tb/one-piece-e1000#171`: got "LostFilm", want null
- `comet-tb/detective-conan-e1100#70`: got "Concise", want null
- `comet-tb/detective-conan-e1100#74`: got null, want "Chap"
- `comet-tb/detective-conan-e1100#2`: got null, want "Heiwa Fansubs"
- `torrentio/naruto-shippuden-e300#30`: got null, want "Hatsuyuki"
- `comet-tb/naruto-shippuden-e300#73`: got "PC", want null
- `comet-tb/naruto-shippuden-e300#23`: got "KuroSen", want "KuroSen!"
- `comet-tb/naruto-shippuden-e300#36`: got "Dub", want null
- `comet-tb/naruto-shippuden-e300#25`: got "Lege", want null
- `comet-tb/naruto-shippuden-e300#63`: got null, want ["Mirage-Team","Team"]
- `comet-tb/naruto-shippuden-e300#38`: got null, want ["SB-RAW","RAW"]
- `torrentio/one-piece-e1000#24`: got "CR", want null
- `torrentio/detective-conan-e500#5`: got "DVD", want null

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
- `torrentio/detective-conan-e1100#4`: got ["en"], want []
- `torrentio/detective-conan-e1100#8`: got ["en"], want []
- `torrentio/detective-conan-e1100#0`: got ["en"], want []
- `torrentio/detective-conan-e1100#6`: got ["en"], want []
- `comet-tb/detective-conan-e1100#49`: got ["ar"], want []
- `torrentio/naruto-shippuden-e300#26`: got ["multi"], want ["multi","fr"]
- `comet-tb/naruto-shippuden-e300#23`: got ["es"], want []
- `comet-tb/naruto-shippuden-e300#25`: got ["es"], want []
- `torrentio/naruto-shippuden-e300#32`: got ["en","multi","ja","ar"], want ["multi","ja","en"]
- `torrentio/detective-conan-e500#10`: got ["en","ja","multi","ar"], want ["multi","ja","en"]

### season

- `torrentio-tb/attack-on-titan-e01#134`: got 1, want null
- `torrentsdb/breaking-bad-s01e01#5`: got 4, want null
- `torrentio/naruto-shippuden-e300#28`: got 1, want null
- `comet-tb/naruto-shippuden-e300#25`: got null, want 1

### episode

- `comet-tb/frieren-e01#310`: got 2, want null
- `torrentio/one-piece-e1000#8`: got null, want 1000
- `torrentio/one-piece-e1000#35`: got null, want 1000
- `torrentio/one-piece-e1000#11`: got null, want 1000
- `torrentio/one-piece-e1000#4`: got 55, want 1000
- `torrentio-tb/one-piece-e1000#0`: got null, want 1000
- `comet-tb/detective-conan-e1100#2`: got 4, want null
- `comet-tb/detective-conan-e1100#11`: got 1000, want null
- `torrentio/naruto-shippuden-e300#4`: got null, want 300
- `torrentio/naruto-shippuden-e300#23`: got null, want 300
- `torrentio/naruto-shippuden-e300#26`: got 453, want 300
- `torrentio/naruto-shippuden-e300#0`: got null, want 300
- `torrentsdb/naruto-shippuden-e300#0`: got null, want 300
- `torrentio-tb/naruto-shippuden-e300#8`: got null, want 300
- `comet-tb/naruto-shippuden-e300#12`: got null, want 300
- `torrentio/one-piece-e1000#24`: got null, want 1000
- `torrentio/one-piece-e700#15`: got null, want 700

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
- `torrentio/one-piece-e1000#8`: got true, want false
- `torrentio/one-piece-e1000#35`: got true, want false
- `torrentio/one-piece-e1000#11`: got true, want false
- `torrentio-tb/one-piece-e1000#0`: got true, want false
- `comet-tb/one-piece-e1000#205`: got false, want true
- `comet-tb/one-piece-e1000#226`: got true, want false
- `comet-tb/one-piece-e1000#211`: got false, want true
- `comet-tb/one-piece-e1000#151`: got false, want true
- `comet-tb/detective-conan-e1100#70`: got false, want true
- `comet-tb/detective-conan-e1100#71`: got false, want true
- `comet-tb/detective-conan-e1100#52`: got false, want true
- `comet-tb/detective-conan-e1100#32`: got false, want true
- `comet-tb/detective-conan-e1100#46`: got false, want true
- `comet-tb/detective-conan-e1100#33`: got false, want true
- `comet-tb/detective-conan-e1100#37`: got false, want true
- `comet-tb/detective-conan-e1100#49`: got false, want true
- `comet-tb/detective-conan-e1100#11`: got false, want true
- `comet-tb/detective-conan-e1100#40`: got false, want true
- `torrentio/naruto-shippuden-e300#4`: got true, want false
- `torrentio/naruto-shippuden-e300#0`: got true, want false
- `torrentsdb/naruto-shippuden-e300#0`: got false, want true
- `torrentio-tb/naruto-shippuden-e300#8`: got true, want false
- `comet-tb/naruto-shippuden-e300#90`: got false, want true
- `comet-tb/naruto-shippuden-e300#88`: got false, want true
- `comet-tb/naruto-shippuden-e300#79`: got false, want true
- `comet-tb/naruto-shippuden-e300#23`: got false, want true
- `comet-tb/naruto-shippuden-e300#40`: got false, want true
- `comet-tb/naruto-shippuden-e300#59`: got false, want true
- `comet-tb/naruto-shippuden-e300#25`: got false, want true
- `comet-tb/naruto-shippuden-e300#95`: got false, want true
- `comet-tb/naruto-shippuden-e300#34`: got false, want true
- `torrentio/one-piece-e1000#24`: got true, want false
- `torrentio/one-piece-e700#15`: got true, want false

### Fake checks

- `comet-tb/parasite#940`: ok, labelled fake: different title (Slime Parasite)
- `comet-tb/the-office-s03e05#142`: ok, labelled fake: 14 episodes in 116 MB
- `comet-tb/project-hail-mary#998`: ok, labelled fake: Internet Archive upload named after the book; most likely the audiobook (judgement)
- `comet-tb/one-piece-e1100#54`: ok, labelled fake: One Piece Film Z, asked for episode 1100
- `torrentio-tb/attack-on-titan-e01#134`: ok, labelled fake: episode 1 of the Junior High spin-off
- `comet-tb/solo-leveling-s01e01#126`: ok (title mismatch), labelled fake: Family Guy
- `comet-tb/spider-man-brand-new-day#380`: ok, labelled fake: Spider-Man 2 (2004)
- `torrentio/attack-on-titan-e01#47`: ok, labelled fake: OAD episode 1, not the series' episode 1
- `comet-tb/one-piece-e1000#14`: ok, labelled fake: anniversary special, not episode 1000
- `comet-tb/one-piece-e1000#15`: ok, labelled fake: Fan Letter special, not episode 1000
- `comet-tb/detective-conan-e1100#4`: ok, labelled fake: a film
- `torrentio/naruto-shippuden-e300#26`: hidden (wrong episode), labelled genuine
- `comet-tb/naruto-shippuden-e300#73`: ok, labelled fake: a PC game
- `comet-tb/naruto-shippuden-e300#25`: ok, labelled fake: seasons 1-13 pack, asked for episode 300 (season 14)
- `torrentio/naruto-shippuden-e300#11`: ok, labelled fake: Ocean Cut re-edit of the first Naruto; S14E05 is another episode
