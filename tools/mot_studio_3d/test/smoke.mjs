import fs from 'node:fs';
import { parseMot, timeline } from '../src/engine.js';
import { buildRobot, applyPose } from '../src/robot.js';
const dir = process.argv[2];
for (const n of ['explore_foward1', 'explore_back_away1', 'explore_turn_left1', 'explore_turn_right1']) {
  const { frames } = parseMot(new Uint8Array(fs.readFileSync(`${dir}/${n}.mot`)));
  const rb = buildRobot(), st = { x: 0, z: 0, yaw: 0, prevHip: null };
  for (const s of timeline(frames)) applyPose(rb, s.s, st, [-1, -1, -1, -1]);
  console.log(`${n.padEnd(22)} x=${st.x.toFixed(2)} z=${st.z.toFixed(2)} cm, rumbo ${(st.yaw * 180 / Math.PI).toFixed(1)}°`);
}
