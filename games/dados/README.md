# 3D Dice Game · Liar's Dice & Open Roll

**English** · [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/crper/dice-game/actions/workflows/deploy.yml/badge.svg)](https://github.com/crper/dice-game/actions/workflows/deploy.yml)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6.svg)
![Vite](https://img.shields.io/badge/Vite-8-646cff.svg)
![Three.js](https://img.shields.io/badge/Three.js-0.185-000000.svg)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38bdf8.svg)

<div align="center">
  <sub>📱 微信公众号 · <strong>黑白汤</strong> &nbsp;—&nbsp; 微信搜索即可关注，不定期写点 AI 与前端的折腾记录</sub>
  <!-- 拿到公众号二维码后，放到 docs/wechat-mp.png 并解开下一行注释即可变成扫码关注 -->
  <!-- <img src="docs/wechat-mp.png" width="150" alt="黑白汤 公众号二维码" /> -->
</div>

A browser dice game on a real 3D table. Two modes ship with it: **Liar's Dice** (大话骰), where each side keeps a concealed hand and players outbid each other until someone challenges, and **Open Roll** (明牌), which throws every die in the open and reports the result immediately. One mode is on screen at a time.

The dice are not sprites or CSS tricks. Each one is a rounded-box mesh driven by a lightweight rigid-body simulation — gravity, floor and wall bounces, friction and spin damping — that converges on an exact rest pose, so the value the game reports is always the value you can read on the table.

<!-- Replace with your deployed URL after enabling GitHub Pages. -->
> **Live demo:** https://crper.github.io/dice-game/

## Features

- **Configurable dice count** — 1 to 10 per seat, adjustable at any time from the table settings panel. Changing it restarts the round, so the table always matches the rules in force.
- **Two complete modes**
  - *Liar's Dice (大话骰)*: concealed hands, turn-based bidding, strict-raise validation, challenge ("open") resolution, per-round scoring, and a wild-ones house rule you can toggle.
  - *Open Roll (明牌)*: one hand thrown in the open, with the total, a big/small verdict, straight and all-same detection, and a per-face distribution chart.
- **A table that stays legible** — dice are laid out with real spacing, and each seat's dice sit in a labelled felt tray, so whose dice are whose never becomes a question.
- **3D dice on a felt table** — rounded-box geometry, procedurally drawn pip textures with recessed holes, image-based lighting, soft shadows, and a baked light pool on the felt.
- **Tumbling physics** — a free-tumble phase followed by a settle phase that snaps each die to a provably correct resting orientation.
- **Interaction that behaves** — the camera can never rotate far enough to put the far seat in front of the near one; three angle presets replace drag-only control; vertical page scrolling is never swallowed on touch; and in open mode the felt itself is the roll button.
- **Responsive** — one column on phones, table-plus-sidebar on wide screens. All in-round controls live on the table itself (a bidding console in Liar's Dice, count + throw in open mode); the camera reads the real overlay heights and fits the dice into the space left over.
- **Bilingual UI** — Simplified Chinese by default with one-tap English from the app bar; the choice persists, and even the felt tray labels are repainted in the selected language.
- **Feedback that reads** — explicit button states, a live phase indicator on the table, a winner banner whose wording is derived from the actual judgement, animated reveals, and synthesised sound effects (no audio assets, mutable).
- **Accessible** — Radix-based primitives via shadcn/ui (dialog, slider, switch, toggle group), `role="status"` announcements, visible focus rings, and `prefers-reduced-motion` support that skips the tumble entirely.
- **Graceful degradation** — without WebGL the table falls back to a flat pip rendering of the same roll instead of showing an error.

## Rules in brief

### Liar's Dice (大话骰)

1. Each seat receives the same number of dice and may only see its own.
2. Players alternate bids of the form *"at least N dice show face F"*. A bid must strictly beat the previous one: a higher quantity, or the same quantity with a higher face.
3. On your turn you may **challenge** the standing bid instead of raising. Every die is revealed and counted.
4. The bid **holds** when the actual count reaches the quantity claimed — the challenger loses. Otherwise it **fails** and the bidder loses.
5. With **1-is-wild** enabled, every die showing a 1 counts toward any face except 1 itself.

### Open Roll (明牌)

A single hand is thrown and published at once. The report names the result — 豹子 (every die identical), 顺子 (a run of distinct faces), or plain big/small against the statistical mean of 3.5 per die — and charts how the six faces are distributed.

## Quick start

```bash
git clone https://github.com/crper/dice-game.git
cd dice-game
npm install
npm run dev          # http://localhost:5173
```

Requires Node.js 20.19 or newer.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the dev server with HMR. |
| `npm run build` | Type-check and build for production into `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run typecheck` | Run `tsc` across all three tsconfig projects. |
| `npm run lint` | Run Oxlint (0 warnings expected). |
| `npm run test` | Run the unit tests (Vitest) over the rules engine and reducer. |
| `npm run verify:faces` | Assert the die face-to-texture mapping is correct. |
| `npm run check` | `typecheck` + `lint` + `test` + `verify:faces`. |

### Why `verify:faces` exists

A 3D die can silently display one value while the game reports another. Attaching six materials to a box is easy to get wrong: the material slot order must match the geometry's face order, opposite faces must sum to 7, and the rotation that brings a face "up" must agree with both.

The script loads the real modules through Vite's resolver and asserts, for all six values across several spins, that snapping face *v* up lands *v*'s material on the top slot — plus that opposite faces sum to 7 and that the rounded-box geometry exposes six slots covering every vertex. It runs in CI before every deploy.

## Project structure

```
src/
├── components/           # Presentational and container components
│   ├── ui/               # shadcn/ui primitives (button, dialog, slider, switch, …)
│   │                     # plus game-specific pieces (PipFace, icon re-exports)
│   ├── DiceStage.tsx     # WebGL canvas host, HUD chrome and the on-table console
│   ├── TableConsole.tsx  # On-felt controls: bidding (Liar's Dice), count + throw (open)
│   ├── ResultCard.tsx    # Post-challenge breakdown
│   └── OpenRollCard.tsx  # Open-mode result report
├── hooks/
│   ├── useDiceGame.ts    # Round orchestration: timers, AI turns, sound, persistence
│   └── useDiceScene.ts   # Bridges React state to the imperative Three.js scene
├── i18n/                 # react-i18next setup + zh/en resource trees (zh is default)
├── lib/                  # Pure logic — no React, no Three.js, no copy
│   ├── constants.ts      # Tuning values and limits
│   ├── dice.ts           # Rolling, summaries, randomness
│   ├── liarDice.ts       # Bid validation, probability estimates, AI decisions
│   ├── sound.ts          # Synthesised WebAudio effects
│   └── stats.ts          # Structured open-mode verdicts and distributions
├── state/
│   └── gameReducer.ts    # The pure game state machine
├── three/                # Everything Three.js
│   ├── DiceScene.ts      # Renderer, camera, render loop, public scene API
│   ├── diceFace.ts       # Face-to-slot mapping and "face up" rotations
│   ├── layout.ts         # Dice slots, felt trays and the table's required size
│   ├── pipTexture.ts     # Procedurally drawn die faces
│   ├── table.ts          # Felt, seat trays, bumper, lights, environment
│   └── tumble.ts         # The roll simulation
├── types/
│   └── game.ts           # Shared domain types
├── App.tsx               # Layout shell
├── index.css             # Tailwind theme tokens and keyframes
└── main.tsx              # Entry point
```

## How it works

**The game state is a pure reducer.** `state/gameReducer.ts` has no timers, no DOM, and no randomness beyond dealing a hand. Every transition — start round, bid, challenge, reveal, next round — is a plain function of the previous state and one action, which is what makes the rules testable in isolation.

**Timing lives in `useDiceGame`.** The reducer is instant; the scene animates. Each animated phase therefore has *two* exits: an event from the 3D scene when the dice come to rest, and a generous fallback timer. A stalled WebGL context, a backgrounded tab, or a dropped frame can never leave the round stuck.

**The scene never guesses.** `DiceScene` is told which values to land on. The simulation runs a chaotic phase with gravity, bounces, friction and spin damping, then blends each die into an exact rest pose — the position from the layout, the quaternion from `quaternionForFaceUp(value, spin)`. Randomness makes the roll look real; the settle phase makes the result truthful.

**Face orientation is provable, not assumed.** Three.js assigns `BoxGeometry` six material slots in a fixed order (`+X, -X, +Y, -Y, +Z, -Z`), and `RoundedBoxGeometry` preserves those groups after becoming non-indexed. Pip layouts are invariant under both 180° rotation and mirroring, so an arbitrary spin around Y can never make a face read as a different value — which is exactly why the tumble animation is free to pick one. `npm run verify:faces` locks all of it down.

**The table is sized from what must fit on it.** Dice layout, tray outlines and the table radius are all derived from one `computeLayout` pass. Trays are rounded by a fixed ratio of their shorter side, and that rounding is load-bearing: a rectangle's corners are its furthest points from the centre, so sharp-cornered trays would spill off the round felt at ten dice per seat. `trayReach()` feeds the rounded extent back into the table radius, and the camera fit then samples the felt rim plus every die slot, targeting different fill factors per axis so the overlays keep their room.

**Rendering is demand-driven.** The scene draws on change rather than every frame: dice coming to rest, the reveal animation, camera damping and resizes all mark the frame dirty, and the shadow pass only re-runs while dice are actually moving.

## Deploying to GitHub Pages

The repository ships with a workflow at `.github/workflows/deploy.yml` that installs the [Vite+](https://viteplus.dev) toolchain via [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) (with dependency caching), then type-checks, lints, unit-tests, verifies the face mapping, builds, and publishes `dist/` on every push to `main`.

1. Push the project to GitHub.
2. Open **Settings → Pages** in the repository and set **Source** to **GitHub Actions**.
3. Push to `main`, or run the workflow manually from the **Actions** tab.

`base` is read from the `VITE_BASE` environment variable, which the workflow fills in from the Pages configuration — so a project site (`https://<user>.github.io/<repo>/`) works with no code change, while local development still runs from `/`.

To build a sub-path deployment by hand:

```bash
VITE_BASE=/your-repo/ npm run build
```

## Tech stack

| Layer | Choice |
| --- | --- |
| UI | React 19 |
| Components | shadcn/ui (Radix primitives) — button, dialog, slider, switch, toggle group, card, badge |
| Language | TypeScript 7 (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`) |
| Build | Vite 8 (Rolldown), Vite+ toolchain in CI |
| 3D | Three.js 0.186 |
| Styling | Tailwind CSS 4 with the `cn` class-merging helper |
| i18n | i18next + react-i18next (简体中文 default, English one tap away) |
| Icons | lucide-react |
| Tests | Vitest |
| Linting | Oxlint |

## License

[MIT](./LICENSE) © dice-game-3d contributors

Dice pips, felt, icons and sound are all generated at runtime — the project ships no third-party art or audio assets.

---

<div align="center">
  <sub>📱 <strong>微信公众号 · 黑白汤</strong><br/>微信搜索即可关注 · <a href="https://crper.github.io/dice-game/">在线试玩</a> · <a href="./README.zh-CN.md">中文文档</a></sub>
</div>
