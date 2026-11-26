---
name: app-icon-icon-composer
description: What build/appicon.icon (the macOS 26 Icon Composer bundle) can render, how to preview it, and the bird's scale in each icon variant
metadata:
  type: project
---

`build/appicon.icon` is the Icon Composer bundle for macOS 26 (`icon.json` + `Assets/*.svg`); `build/appicon.png` (from `appicon.svg`) is still what `wails3 generate icons` turns into `darwin/icons.icns` and `windows/icon.ico`, and `build/ios/assets/` holds the iOS set. On 2026-11-26 the bundle's bird was rebuilt to match the PNG's cream gradient, shine, bottom rim and eye gloss, and enlarged.

**What a layer SVG may use:** flat fills, `<linearGradient>` / `<radialGradient>` **only with `gradientUnits="userSpaceOnUse"`** (the default objectBoundingBox gives each child element its own box, so the head gets a separate gradient), `<clipPath>` (works), and nothing else. SVG filters (`feGaussianBlur`, `feDropShadow`, `feFlood` + `feComposite`) render as nothing, which is why the raster icon's `lift`/`shade` are absent there.

**How to fake the PNG's filters:** the shine is a full-canvas `<rect>` filled with a radial white gradient, clipped to the body. The inner shade is two copies of the bird in `#f0cba4` at `opacity=".55"`, offset `0 -1.5` and `0 -.6`, drawn under the gradient body — the sliver they leave is the rim. The tile's gradient stays `icon.json`'s `fill.automatic-gradient`; adding a full-bleed amber layer to reproduce the PNG's `bg` gradient breaks the stack (the bird turns amber).

**Sizes** (bird width as a share of the visible tile): the bundle was 9.6 units/px ≈ 47.6 %, `appicon.png` is 9.6 in an 824 tile ≈ 55 %, iOS `appicon-light.svg` is 11.4 ≈ 58 %, and the bundle is now **12.6 ≈ 62.6 %**. Change `scale(12.6)` in both `Assets/pelican.svg` and `Assets/features.svg`; keep `translate(512 520)`. Shadow opacity went 0.5 → 0.7 for the PNG's lift.

**Previews:** compile to a temp dir and pull a 256 px render out — `xcrun actool --compile /tmp/out --platform macosx --minimum-deployment-target 26.0 --app-icon appicon --output-partial-info-plist /tmp/out/p.plist <abs path to appicon.icon>`, then `iconutil -c iconset /tmp/out/appicon.icns -o /tmp/out/set.iconset` (`icon_128x128@2x.png` is the largest). The output dir must already exist. Run it from outside the repo with an absolute path: from the repo cwd actool failed with a stale `Failed to create a catalog from the Icon Studio document: /private/tmp/peli-icon/build/appicon.icon`. `assetutil --info /tmp/out/Assets.car` shows the Aqua, DarkAqua and tintable appearances still being generated.

**Why:** the flat cream bird read as a different, plainer icon than the app icon users see everywhere else, and it looked small next to other Dock icons.

**How to apply:** edit the two layer SVGs and re-check with the actool preview; don't hand the bundle to filters, and don't add a background layer. Related: [[peli-design-direction]].
