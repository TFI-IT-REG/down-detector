---
name: visualize
description: Write a detailed, copy-paste image prompt for Google Gemini's image generator, tuned so the result is easy to use in code (cut out, animate, drop into a page). Use when the user types /visualize, with or without a description of what to draw.
argument-hint: "[what to draw, optional]"
---

# /visualize v1.0.0

The user wants an image made in Gemini, not by you. Your job is to write the prompt they paste into Gemini, plus what to do if the result comes back wrong. Do not generate images yourself, call image APIs, or send anything to an outside service.

## 1. Work out what to draw

- If the user gave a description after `/visualize`, that's the subject.
- If not, use the most recent visual thing in the conversation: a mockup, a character, a scene, an icon. Pull every concrete detail from it: hex colors, sizes, poses, what each element is for.
- Only if neither tells you what to draw, ask one short question. Otherwise decide and write.

## 2. Decide how the image will be used

Pick the format that is easiest to use in code, and say which in one line before the prompt:

| Use | Ask Gemini for |
|---|---|
| Something that moves (character, mascot, creature) | A sprite sheet: one image, a grid of equal cells, one pose or frame per cell, same character, same scale, feet on the same baseline |
| A cutout to place on a page (character, object, icon) | A single subject, centered, with padding |
| A background or scene | The scene only, no characters or text, so pieces can be layered on top |
| A mockup or poster | The full composition at the target aspect ratio |

For anything that moves, prefer a sprite sheet over separate body parts. Gemini keeps whole-pose frames consistent far better than loose limbs, and a sheet animates with plain CSS `steps()`.

## 3. Rules every prompt follows

- **Lead with what it is and the exact layout**: "A 2D sprite sheet, 4 columns by 2 rows, each cell 256 x 256 px, total 1024 x 512 px."
- **Background:** for cutouts and sprites, a flat solid pure chroma green `#00FF00` background with no shadows, floor, gradient or texture. Gemini doesn't reliably produce true transparency, and flat green keys out cleanly. Tell it not to use that green anywhere on the subject. For scenes, describe the background in full.
- **Style:** name it plainly (flat vector cartoon, thick outlines, cel shading, pixel art at N px). Give the outline color and weight.
- **Palette:** list exact hex codes for each part, taken from the conversation when they exist.
- **Proportions and character sheet:** describe the subject once in detail (build, head size, clothing, props, expression), then say it must be identical in every cell.
- **Each cell or frame described one by one**, in order, left to right, top to bottom.
- **Consistency:** same size, same facing direction unless stated, same baseline, centered in each cell, at least 16 px padding, nothing crossing cell edges.
- **Negatives:** no text, labels, numbers, watermark, signature, borders, grid lines, cell dividers, drop shadows on the background, or extra characters.
- **Nothing proprietary:** no real brands, logos, trademarked characters or recognisable real people. No company data, names or internal details in the prompt.

## 4. Reply format

1. One line: what the image is for and which format you chose.
2. The prompt in a single `text` code block, ready to paste. Plain sentences and short labelled sections; no markdown inside the block.
3. **If it comes back wrong:** two or three short follow-up prompts for the usual failures (grid lines or labels added, character changes between frames, wrong background, cropped feet). Each in its own `text` code block.
4. **Next step:** one line saying to upload the image back to the chat, and what you'll do with it (for example, slice the sheet and wire it into the animation).

Keep everything outside the code blocks short.
