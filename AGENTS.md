# FLAPPYCAT agent rules

## Project shape
- `src/engine.mjs`: pure core. `step(state, input)` returns a new state and never mutates the input.
- `src/render.mjs`: canvas renderer only. Reads state, does no game logic.
- `src/main.mjs`: browser shell plus the `window.__FLAPPY` diagnostic hook.
- `scripts/verify.mjs`: fast gate, zero dependency.
- `scripts/verify-web.mjs`: browser gate with Playwright.
- `.github/workflows/verify.yml`: push-only CI entrypoint.
- `.github/workflows/pages.yml`: deploys the static site from `main`.
- `docs/OBLIGATIONS.json`: dated obligations. Overdue turns the fast gate red.
- `docs/shots/*.svg`: README illustrations, not real screenshots.

## Iron rules
- Build or update the gate before trusting any new behavior.
- Keep the core pure: no filesystem, DOM, network, system time, or unseeded randomness in `src/engine.mjs`.
- Pipes are drawn as integer-coordinate flat rects only. No stroke, gradient, or alpha in `drawPipes`, or the pixel equality assertions become unprovable.
- If a `run: |` block pipes into `tee`, that same block must set `pipefail`.
- Report artifacts stay `report-*`, stdout logs stay `stdout-<slug>.log`.
- `AGENTS.md` and `CLAUDE.md` must stay byte-identical.
- This file stays under 200 lines. Tighten wording or split docs, never raise the cap.
- Never hardcode a secret-shaped literal, not even in a mutation fixture. Build sentinels at runtime.
- Any write that claims success must be read back or proven by a real external effect.

## Thresholds: derive, do not guess
- Prefer an equality against an independent ruler over a floor. The browser bot score is compared byte-for-byte against the same pure engine run in Node for the same frame count, so there is no guessed number left in it.
- A floor whose job is catching total freeze stays loose. `FPS_FLOOR` is 13 against a measured 40, and a second assertion reds if anyone tightens it past a third of the measured baseline. A floor that normal jitter can hit is a false-red factory, and false reds push people to change the product to please the ruler.
- Update `FPS_MEASURED_BASELINE` only from a real CI metric, never from a guess.

## Coupled parameters
- `MAX_GAP_DELTA` must equal `gapRange().span`. An equality assertion pins them; a mutation proves it is not decorative.
- `PIPE_SPACING`, `SCROLL`, `GRAVITY`, `FLAP_VY` decide how far the bot can climb between pipes. Moving any of them means re-measuring the climb proof.
- `CAP_H`, `CAP_OVERHANG`, `PIPE_W`, `GAP_MARGIN`: every visible pipe body section must stay taller than the cap, or the pixel equality expectation goes wrong.
- `CARD`, `CARD_INNER_W`, `DEAD_STRIP`, `DEAD_TITLE_BASELINE`, `SHOT_BAND`: the band must clear the dead card and the ground; the strip must sit inside the card, clear of the corner radius, above the measured title ascent. `CARD_INNER_W` equals `CARD.w - stroke * 2`.
- `FPS_FLOOR` and `FPS_MEASURED_BASELINE` are coupled: three times the floor must not exceed the baseline.
- Pipe geometry lives in `pipeGeometry()` only. Renderer and gates import it, never recompute it.
- The shared report marker stays exactly `<!-- verify-gate -->` in both `verify.yml` and the composer.
- README's referenced shot set must equal the actual `docs/shots/` file set, both directions.

## Commands
- `npm run verify`: fast gate.
- `npm run verify:web`: browser gate.
- `npm run serve`: static server for local play.
- `npm run report`: compose one report comment from artifacts.

## What the gates prove
- Fast gate: deterministic stepping, non-mutation, collisions, scoring, bot survival across eight seeds, coupling equalities, purity scan, workflow set equality, pipefail scan, secret scan, rules-file limits, obligation freshness, README and shot-set agreement.
- Browser gate: the real page boots clean, CJK renders differently from a guaranteed-tofu private-use glyph, repainting the same state is pixel-identical, Space starts play, the browser run equals the pure engine at the same frame count, pipe body and cap pixels equal engine geometry exactly, the death card panel strip equals its geometric area, restart resets, three deterministic screenshots differ in both PNG and canvas-pixel hashes.
- The CI report must arrive as a comment. No delivered comment means the run did not count.

## Open probe, not a conclusion
- `shot-play` produced an identical hash across two runs while `shot-ready` and `shot-dead` drifted. Root cause is unknown. The report now carries the canvas pixel hash next to the PNG hash plus CJK, latin, and tofu glyph signatures, which is enough to tell painting drift from CSS compositing drift from font drift. Do not invent a cause before those numbers line up.

## Unmeasurable, be honest
- A green gate cannot prove the game is fun.
- CI cannot verify mobile touch feel, and there is no sound at all yet.
- Granting workflow write permissions needs a human with repo settings access.
- Nobody watches the watcher here: the gates run on CI, and CI red or green is the only signal outside my own code.
