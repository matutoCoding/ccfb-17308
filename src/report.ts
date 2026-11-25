// ---------- 夜报导出 ----------

import { ObservingPlan, SimResult } from './types';
import { fmtTime } from './ui';

export function reportCsv(sim: SimResult, plan: ObservingPlan): string {
  const telName = (id: string) => id;
  const lines = [
    '目标,望远镜,计划时长(min),有效曝光(min),被挡时长(min),翻转等待(min),转台(min),低于限高(min)',
    ...sim.report.map(r => [
      r.targetName, telName(r.telescopeId), r.scheduledMin.toFixed(0),
      r.effectiveMin.toFixed(1), r.vignettedMin.toFixed(1), r.flipWaitMin.toFixed(1),
      r.slewMin.toFixed(1), r.belowMin.toFixed(1),
    ].join(',')),
  ];
  return '﻿' + lines.join('\n');
}

export function reportHtml(sim: SimResult, plan: ObservingPlan): string {
  const rows = sim.report.map(r => `
    <tr>
      <td>${r.targetName}</td><td>${r.telescopeId}</td>
      <td>${r.scheduledMin.toFixed(0)}</td>
      <td><b>${r.effectiveMin.toFixed(1)}</b></td>
      <td>${r.vignettedMin.toFixed(1)}</td>
      <td>${r.flipWaitMin.toFixed(1)}</td>
      <td>${r.slewMin.toFixed(1)}</td>
      <td>${r.belowMin.toFixed(1)}</td>
    </tr>`).join('');
  const events = sim.events.map(e =>
    `<tr><td>${fmtTime(e.t)}</td><td>${e.type}</td><td>${e.detail}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>夜报 ${plan.name}</title>
<style>body{font-family:sans-serif;margin:2em;color:#222}table{border-collapse:collapse;margin:1em 0}
td,th{border:1px solid #999;padding:4px 10px;font-size:13px}th{background:#eee}</style></head><body>
<h1>观测夜报 — ${plan.name}</h1>
<p>站点: ${plan.site.name} (${plan.site.lat}°, ${plan.site.lon}°, ${plan.site.elevation}m) · 日期 ${plan.date} · 推演于 ${sim.createdAt.slice(0, 19).replace('T', ' ')}</p>
<h2>目标汇总</h2>
<table><tr><th>目标</th><th>望远镜</th><th>计划(min)</th><th>有效曝光(min)</th><th>被挡(min)</th><th>翻转等待(min)</th><th>转台(min)</th><th>低于限高(min)</th></tr>${rows}</table>
<h2>事件 (${sim.events.length})</h2>
<table><tr><th>时刻</th><th>类型</th><th>说明</th></tr>${events}</table>
</body></html>`;
}
