# FLAPPYCAT agent rules

## Project shape
- `src/engine.mjs`: pure core. `step(state, input)` returns a new state and never mutates the input.
- `src/render.mjs`: canvas renderer only. Reads state, does no game logic.
- `src/main.mjs`: browser shell and test hooks.
- `scripts/verify.mjs`: fast gate, zero dependency.
- `scripts/verify-web.mjs`: browser gate with Playwright.
- `.github/workflows/verify.yml`: push-only CI entrypoint.
- `.github/workflows/pages.yml`: deploy static site to Pages.

## Iron rules
- Change the gate before trusting any new behavior.
- Keep the core pure: no filesystem, DOM, network, system time, or unseeded randomness in `src/engine.mjs`.
- If a `run: |` block pipes into `tee`, that same block must set `pipefail`.
- Report artifacts must stay `report-*`, stdout logs `stdout-<slug>.log`.
- `AGENTS.md` and `CLAUDE.md` must stay byte-identical.
- This file must stay under 200 lines. Tighten wording or split docs, never raise the cap.
- Any write that claims success must be read back or otherwise proven by a real external effect.

## Coupled parameters
- `PIPE_GAP`, `MAX_GAP_DELTA`, `PIPE_SPACING`, `SCROLL`, and bot climb capacity are coupled. If one moves, re-measure the climb proof in `scripts/verify.mjs`.
- `CAP_H`, `CAP_OVERHANG`, `PIPE_W`, and `GAP_MARGIN` are coupled. The web gate's exact pixel checks depend on every visible pipe body section staying taller than the cap.
- Pipe geometry lives in `pipeGeometry()` only. Renderer and tests must import it, not recompute it.
- Shared report workflow marker must stay exactly `<!-- verify-gate -->`.

## Commands
- `npm run verify`: fast gate.
- `npm run verify:web`: browser gate.
- `node scripts/compose-report.mjs reports`: compose one report comment from artifacts.

## What the gates prove
- Fast gate proves deterministic stepping, collisions, scoring, non-mutation, reachability, repository structure, workflow safety, and mutation checks for the scanners.
- Browser gate proves the real page boots, Space starts play, exact pipe body pixels match engine geometry, the bot can score on the real loop, game over renders, restart works, and CJK glyphs render differently from a guaranteed tofu glyph.
- The CI report must be delivered as a comment. No delivered comment means the run did not count.

## Measurable limits
- Browser bot score floor and FPS floor are currently guessed. They are registered in `docs/OBLIGATIONS.json` and must be tightened from the first real CI run.
- Human-only acceptance remains: touch feel, sound, and "is it actually fun".

## Unmeasurable, be honest
- A green gate cannot prove the game is fun.
- CI cannot verify mobile touch feel.
- Pages enablement and workflow write permissions require the repo owner to click buttons.
