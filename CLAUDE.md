# FLAPPYCAT agent rules

## Project shape
- `src/engine.mjs`: pure core. `step(state, input)` returns a new state and never mutates the input. The best-score *rule* (`bestOf`) lives here because it is a pure function.
- `src/render.mjs`: canvas renderer only. Reads state, does no game logic, reads card baselines from `CONFIG`.
- `src/main.mjs`: browser shell. Local storage, audio, and the `window.__FLAPPY` diagnostic hook.
- `scripts/verify.mjs`: fast gate, zero dependency.
- `scripts/verify-web.mjs`: browser gate with Playwright.
- `.github/workflows/verify.yml`: push-only CI entrypoint.
- `.github/workflows/pages.yml`: deploys the static site from `main`.
- `docs/OBLIGATIONS.json`: dated obligations. Overdue turns the fast gate red.
- `docs/shots/*.svg`: README illustrations, not real screenshots.

## Iron rules
- Build or update the gate before trusting any new behavior.
- Keep the core pure: no filesystem, DOM, network, system time, unseeded randomness, local storage, or audio in `src/engine.mjs`. Storage and audio are I/O and belong to the shell; the purity scan bans both tokens.
- Pipes are drawn as integer-coordinate flat rects only. No stroke, gradient, or alpha in `drawPipes`, or the pixel equality assertions become unprovable.
- Card text baselines live in `CONFIG`, never as literals in the renderer. Two copies drift, and then the geometry assertions stop checking the numbers the screen actually uses.
- Every `localStorage` call goes through the `STORAGE` registry. A raw string key is a whitelist violation and reds. New key means new registry entry.
- If a `run: |` block pipes into `tee`, that same block must set `pipefail`.
- Report artifacts stay `report-*`, stdout logs stay `stdout-<slug>.log`.
- `AGENTS.md` and `CLAUDE.md` must stay byte-identical.
- This file stays under 200 lines. Tighten wording or split docs, never raise the cap.
- Never hardcode a secret-shaped literal, not even in a mutation fixture. Build sentinels at runtime.
- Any write that claims success must be read back or proven by a real external effect. Persistence assertions reload the page; they never just read a variable.

## Thresholds: derive, do not guess
- Prefer an equality against an independent ruler over a floor. The browser bot score is compared byte-for-byte against the same pure engine run in Node for the same frame count, so no guessed number is left in it.
- A polling assertion that stops the moment it reaches the floor makes the measured value equal the floor forever. That is a confirmation, not a measurement. Run to a fixed budget, then compare.
- A floor whose job is catching total freeze stays loose. `FPS_FLOOR` is 13 against a measured 38, and a second assertion reds if anyone tightens it past a third of the measured baseline. A floor that normal jitter can hit is a false-red factory, and false reds push people to change the product to please the ruler.
- Update `FPS_MEASURED_BASELINE` only from a real CI metric, never from a guess.
- Before asserting anything about a capability, assert the capability exists. `AudioContext` presence and working local storage are checked first, otherwise the assertions that depend on them pass vacuously.

## Coupled parameters
- `MAX_GAP_DELTA` must equal `gapRange().span`. An equality assertion pins them; a mutation proves it is not decorative.
- `PIPE_SPACING`, `SCROLL`, `GRAVITY`, `FLAP_VY` decide how far the bot can climb between pipes. Moving any of them means re-measuring the climb proof.
- `CAP_H`, `CAP_OVERHANG`, `PIPE_W`, `GAP_MARGIN`: every visible pipe body section must stay taller than the cap, or the pixel equality expectation goes wrong.
- `CARD.hDead`, `DEAD_LINES`, `DEAD_STRIP`, `SHOT_BAND`, `CARD_INNER_W` are one group. Adding a card line means growing `hDead`, which moves the card bottom, which pushes `SHOT_BAND.y0`. Four fast-gate assertions plus two mutations plus one measured-font-metrics assertion in the browser gate guard this group.
- `CARD.hReady` and `READY_LINES` are the same shape on the ready card.
- `FPS_FLOOR` and `FPS_MEASURED_BASELINE`: three times the floor must not exceed the baseline.
- Pipe geometry lives in `pipeGeometry()` only. Renderer and gates import it, never recompute it.
- The shared report marker stays exactly `<!-- verify-gate -->` in both `verify.yml` and the composer.
- README's referenced shot set must equal the actual `docs/shots/` file set, both directions.
- README must mention a feature whose storage key or shortcut exists in `main.mjs`. The witness is the code, not my memory.

## Commands
- `npm run verify`: fast gate.
- `npm run verify:web`: browser gate.
- `npm run serve`: static server for local play.
- `npm run report`: compose one report comment from artifacts.

## What the gates prove
- Fast gate: deterministic stepping, non-mutation, collisions, scoring, bot survival across eight seeds, `bestOf` monotonicity and hostile-input sanitizing, coupling equalities, card-line fit and ordering, purity scan, storage-key whitelist, workflow set equality, pipefail scan, secret scan, rules-file limits, obligation freshness, README agreement with both the shot set and the code.
- Browser gate: the real page boots clean, CJK differs from a guaranteed-tofu glyph, storage is really available, best score survives a real reload and never drops after a worse run, sound on starts an audio node while muted starts none, the mute preference survives a reload, repainting the same state is pixel-identical, the browser run equals the pure engine at the same frame count, pipe pixels equal engine geometry, the death card strip equals its geometric area and its last line fits under measured font descent, restart resets, three deterministic screenshots differ in both PNG and canvas hashes.
- The CI report must arrive as a comment. No delivered comment means the run did not count.

## Unmeasurable, be honest
- A green gate cannot prove the game is fun.
- Audible sound is not proven. The gate proves nodes start and that muting starts none. Whether a speaker makes noise, and whether it sounds good, is unverified and registered as a dated obligation.
- CI cannot verify mobile touch feel.
- The storage-degraded fallback path is never exercised in CI; storage is only asserted to be available.
- README illustrations are hand-drawn and already stale against the taller death card.
- Nobody watches the watcher here: the gates run on CI, and CI red or green is the only signal outside my own code.
