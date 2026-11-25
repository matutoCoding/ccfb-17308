// 整夜推演冒烟测试: 用测试数据跑一整夜, 检查事件/报告完整性
// 运行: npx tsx test/sim.test.ts

import { makeTestData } from '../src/seed';
import { simulate } from '../src/simulation';

const { domes, telescopes, plan } = makeTestData();
console.log(`计划: ${plan.name}, ${plan.entries.length} 个条目, ${telescopes.length} 台设备`);

const t0 = Date.now();
const sim = simulate(plan, domes, telescopes);
const ms = Date.now() - t0;

console.log(`推演 ${sim.steps.length} 步 (${sim.durationSec / 3600} 小时, 步长 ${sim.stepSec}s), 耗时 ${ms}ms`);
console.log(`事件 ${sim.events.length} 个:`);
const byType = new Map<string, number>();
for (const e of sim.events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
for (const [k, v] of byType) console.log(`  ${k}: ${v}`);

let fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  PASS ${name}`);
  else { console.error(`  FAIL ${name} ${detail}`); fail++; }
};

check('步数 = 夜长/30s', sim.steps.length === Math.floor(sim.durationSec / 30) + 1);
check('有中天翻转事件', sim.events.some(e => e.type === 'flip-start'));
check('危险配置产生接近或碰撞事件',
  sim.events.some(e => (e.type === 'approach' || e.type === 'collision') && e.detail.includes('长筒')));
check('有圆顶冲突事件', sim.events.some(e => e.type === 'conflict'));
check('报告覆盖所有条目', sim.report.length === plan.entries.length);

// 遮挡>5% 的时段都被计入报告
const vig5 = sim.steps.flatMap(s => s.tel).filter(t => t.state === 'track' && t.vignetting >= 0.05).length;
const repVig = sim.report.reduce((a, r) => a + r.vignettedMin, 0);
check('遮挡>5% 时段全部计入报告', Math.abs(repVig - vig5 * 0.5) < 0.51,
  `steps=${vig5} report=${repVig}min`);

// 接近<5cm 的事件间距都被记录
const approaches = sim.events.filter(e => e.type === 'approach' || e.type === 'collision');
check('接近事件都带最小间距', approaches.every(e => typeof e.minDist === 'number' && e.minDist < 0.05));

for (const r of sim.report) {
  console.log(`  ${r.targetName} (${r.telescopeId}): 计划${r.scheduledMin}min 有效${r.effectiveMin.toFixed(1)} 被挡${r.vignettedMin.toFixed(1)} 翻转${r.flipWaitMin.toFixed(1)} 转台${r.slewMin.toFixed(1)} 限高${r.belowMin.toFixed(1)}`);
}
for (const e of sim.events.slice(0, 20)) {
  console.log(`  [t=${(e.t / 60).toFixed(0)}min ${e.type}] ${e.detail}`);
}

console.log(fail === 0 ? '\n冒烟测试通过 ✔' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
