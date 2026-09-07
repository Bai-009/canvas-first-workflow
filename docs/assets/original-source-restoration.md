# Original-source banner restoration

The user rejected the promotional banner's degraded material appearance in both languages, not merely a difference between the English and Chinese editions. Earlier typography approval was not approval of coarse texture or blurred detail. The architecture diagram is unrelated and keeps its accepted native rendering.

The original sources and intermediate exports are all 1774 × 887 pixels. The issue is visible detail and material appearance, not a demonstrated reduction in pixel dimensions. New candidates use the original collaboration image and earlier paper artwork directly, avoiding another edit of the degraded serif exports.

The user has confirmed the current English matched-wordmark and Chinese restored banners. These are the selected README artwork.

## Chinese single-pass prompt

```text
Image 1 is the ORIGINAL Chinese CanvasFlow collaboration banner. Image 2 is the EARLIER original paper artwork and is a MATERIAL QUALITY reference only.
Produce the final Chinese typography candidate DIRECTLY from these original sources, not from any repeatedly edited intermediate.

Preserve image 1's exact composition, card arrangement, connecting blue lines, paper ribbon, camera, shadows, and all existing Chinese text. Use the pristine fine smooth stationery material seen in image 2: dense high-quality thin uncoated ivory paper, crisp small grey printed lines, clean narrow edges, smooth neutral grey-white backdrop with extremely fine almost invisible grain. Remove excessive coarse wrinkling, cracks, mottling and blurry clumps. Do not add texture for the sake of showing paper. Paper should be evident primarily in the thin edges, gently curling ribbon and soft natural shadows. Photographic clarity, no low-resolution smearing, no oversharpening halos or muddy speckled background.

The only design change is the wordmark: replace heavy sans "CanvasFlow" with the exact word "CanvasFlow" in an elegant light/regular Baskerville / Tiempos-like literary serif inspired by Anthropic; graceful wide open forms, medium contrast, no bold blockiness. Keep same upper-left position and approximate footprint, three progressively smaller grey squares at its right.

Exact node text MUST stay:
解析
切分
跨页表格不要切断
正在调整切分策略
向量化
The request is blue, its caret remains visible, and the secondary status has its original small amber dot. No slogans. Keep original composition, wide 2:1 aspect ratio. Render high-resolution sharp details, 3840x1920 if supported. This single-pass edit should preserve the calm premium quality of the original photograph.
```

## English single-pass prompt

```text
Image 1 is the ORIGINAL CanvasFlow collaboration banner, before repeated edits degraded its detail. Image 2 is the EARLIER original paper artwork and is a MATERIAL QUALITY reference only.

Create one carefully restored English edition directly from image 1. Preserve image 1's exact composition, placement and size of cards, connectors, paper strip, light, shadows and three-square mark. Use image 2's very fine, clean, dense smooth paper material and pristine edge definition. The material must feel like high-quality uncoated stationery viewed in crisp product photography. It must NOT look mottled, blotchy, blurry, low-resolution, crumpled, cracked, leathery or fibrous at a coarse scale. Background is a nearly smooth pale neutral grey-white surface with imperceptibly fine grain, a clean tonal gradient, and plenty of undisturbed empty space. Make every faint grey UI line crisp and every thin sheet edge precisely defined. No oversharpening halos, no synthetic grain overlay, no waxy denoising.

Only design changes:
1. Replace the upper-left heavy sans-serif "CanvasFlow" with exact text "CanvasFlow" in a refined light-to-regular editorial serif similar to Baskerville / Tiempos, matching the literary warmth of Anthropic. Graceful, open, moderately contrasted strokes, no heavy bold, no hairline fashion lettering. Keep the approximate original wordmark bounding box and three small grey squares.
2. Replace Chinese labels with exact English: "Parse", "Chunk", "Keep multi-page tables intact", "Updating chunking strategy", "Embed". Preserve the caret and amber status dot; the request remains inside the foreground node. Clean regular small sans-serif lettering.
No slogans or new labels. No architectural diagram elements. Keep the original 2:1 wide composition. Render at 3840x1920 if supported, preserving real clean details rather than enlarging blur. The goal is to recover the pristine ORIGINAL illustration quality while making the two necessary typography/localization changes in a SINGLE pass.
```


## Wordmark alignment

The user preferred the Chinese candidate’s lighter serif wordmark. The English README now previews `canvasflow-restored-en-matched.png`, edited using that Chinese wordmark as a visual reference. The Chinese image is unchanged. Generated matching is approximate, not pixel-identical; the user has confirmed the current result.
