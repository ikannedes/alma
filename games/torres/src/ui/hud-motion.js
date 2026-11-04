import { ELIXIR_ACCUMULATOR_DENOMINATOR } from '../sim/elixir.js';

// Called only with minted frame state, while its HUD is still detached.
export function bindHudMotion(node, hud, receipt) {
  const opening = Math.max(0, 1 - hud.tick / 24);
  const age = receipt ? hud.tick - receipt.tick : 24;
  const arrival = age >= 0 ? Math.max(0, 1 - age / 18) : 0;
  node.dataset.arrivalSlot = String(receipt?.slot ?? -1);
  node.style.setProperty('--opening-offset', `${opening * 14}px`);
  node.style.setProperty('--arrival-offset', `${arrival * 22}px`);
  node.style.setProperty('--arrival-tilt', `${arrival * -8}deg`);
  node.style.setProperty('--spend-scale', String(1 + arrival * .16));
  // Fractional regeneration is visible even between whole elixir grants.
  const progress = node.ownerDocument.createElement('span');
  progress.className = 'hud-resource-progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.style.setProperty('--resource-percent', `${(hud.elixir.amount + hud.elixir.accumulator / ELIXIR_ACCUMULATOR_DENOMINATOR) * 10}%`);
  node.appendChild(progress);
}

export const HUD_MOTION_STYLE = `
.game-ui-hud-frame [data-ui="hud-hand"]{transform:translateY(var(--opening-offset))}
${[0,1,2,3].map(slot => `.game-ui-hud-frame[data-arrival-slot="${slot}"] .hud-card[data-slot="${slot}"]{transform:translateY(var(--arrival-offset)) rotate(var(--arrival-tilt));transform-origin:50% 100%}`).join('')}
.game-ui-hud-frame [data-ui="hud-elixir"]{transform:scale(var(--spend-scale))}
.hud-resource-progress{position:absolute;left:115px;top:1251px;width:496px;height:22px;pointer-events:none;z-index:17;border-radius:7px;background:#5B4B8A;clip-path:inset(0 calc(100% - var(--resource-percent)) 0 0 round 7px);box-shadow:inset 0 3px #DCEDE9;transform:translateZ(0)}
@media(prefers-reduced-motion:reduce){.game-ui-hud-frame [data-ui="hud-hand"],.game-ui-hud-frame .hud-card[data-slot],.game-ui-hud-frame [data-ui="hud-elixir"]{transform:none!important}}
`;
