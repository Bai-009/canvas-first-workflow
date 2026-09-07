# Bilingual artwork notes

The English and Chinese READMEs link to one another above the banner. Each document selects its own localized banner and architecture image.

## Architecture

The accepted native diagram layout is retained. `src/render-architecture-paper.py --lang en` or `--lang zh-CN` builds each edition; `src/architecture.zh-CN.json` contains its label translations. CoreText outlines Baskerville / Avenir Next in English, and STSongti / PingFang in Chinese, before PNG export. No font files are distributed.

An experimental textured architecture image was generated after misunderstanding feedback about the promotional banner. It is not used in the READMEs.

## Banner localization

### Texture-preserving correction prompt

```text
Precise text-only localization. The input image is APPROVED. Its background and material must not change.
Replace ONLY the ink glyphs in five small existing text regions:
Parse -> 解析
Chunk -> 切分
Keep multi-page tables intact -> 跨页表格不要切断
Updating chunking strategy -> 正在调整切分策略
Embed -> 向量化

CRITICAL: Treat ALL non-text pixels as locked. Copy the original photograph intact. Do NOT re-render the scene, enhance texture, add fibres, add wrinkles, sharpen paper, change contrast, change white balance, change shadows, or alter the background in any way. The open background is smooth, subdued and neutral grey ivory, not visibly crumpled paper. Fine texture on the cards already exists and MUST remain at exactly its current subtle strength. Do not interpret "Chinese edition" as a material/style redesign.
Keep the large CanvasFlow serif wordmark and three grey squares EXACTLY identical. Preserve all geometry, original English image dimensions/aspect ratio, camera, caret, amber status dot, connections, paper folds, delicate light and the original quiet image quality. Chinese glyphs should have a restrained thin-to-regular sans weight, fitted into the same text footprints and perspective. The status caption must stay small and secondary. No other changes whatsoever.
```

The approved English serif banner is the reference. Only node labels, the request, and the agent status are localized. The Latin CanvasFlow wordmark stays unchanged.

The first Chinese edit changed the paper texture too much and was rejected. A second text-only edit was also superseded. The READMEs now preview the [English](canvasflow-restored-en.png) and [Chinese](canvasflow-restored-zh-CN.png) original-source restoration candidates. Labels and composition were checked, but generated localization still changes background texture; pixel-identical material preservation is not guaranteed. The user has not approved this revised Chinese artwork yet.

### Initial localization prompt

```text
Use case: text-localization. Edit this approved CanvasFlow banner to create its Simplified Chinese edition. Preserve EXACTLY the upper-left "CanvasFlow" serif wordmark, its typography and three small grey squares. Preserve composition, ivory paper texture, paper panels, blue connections, shadows, light, camera and 2:1 framing. Change ONLY the five node text strings as follows:
"Parse" → "解析"
"Chunk" → "切分"
"Keep multi-page tables intact" → "跨页表格不要切断"
"Updating chunking strategy" → "正在调整切分策略"
"Embed" → "向量化"
Chinese text should be elegantly typeset in a clean, regular-weight modern Chinese face. Keep physical perspective and hierarchy of original text. Preserve the insertion caret after the request and the amber status dot. The Chinese request stays on one line with generous space. No new slogans or labels. The exact Latin wordmark CanvasFlow MUST remain unchanged.
```
