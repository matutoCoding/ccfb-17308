// ---------- 整夜推演页 ----------

import { state, loadAll, currentPlan } from '../state';
import { dbPut } from '../db';
import { h } from '../ui';
import { simulate } from '../simulation';
import { Player } from '../player';
import { reportCsv, reportHtml } from '../report';
import { download } from '../ui';

export async function renderSimulate(root: HTMLElement): Promise<void> {
  await loadAll();
  root.innerHTML = '';

  const plan = currentPlan();
  const head = h('div', { class: 'panel' }, h('h3', {}, '整夜推演'));
  root.append(head);
  if (!plan) {
    head.append(h('p', { class: 'muted' }, '请先在"观测计划"页创建计划'));
    return;
  }

  const status = h('span', { class: 'muted' }, ` 当前计划: ${plan.name} (${plan.entries.length} 个目标)`);
  const runBtn = h('button', { class: 'primary' }, '▶ 运行整夜推演 (30s 步长)');
  head.append(runBtn, status);

  const playerHost = h('div', {});
  root.append(playerHost);
  let player: Player | null = null;

  async function runAndShow(): Promise<void> {
    runBtn.disabled = true;
    status.textContent = ' 推演中…';
    await new Promise(r => setTimeout(r, 30)); // 让 UI 刷新
    const sim = simulate(plan!, state.domes, state.telescopes);
    await dbPut('sims', sim);
    await loadAll();
    state.currentSimId = sim.id;
    status.textContent = ` 完成: ${sim.steps.length} 步, ${sim.events.length} 个事件 (碰撞 ${sim.events.filter(e => e.type === 'collision').length}, 接近 ${sim.events.filter(e => e.type === 'approach').length})`;
    runBtn.disabled = false;

    player?.dispose();
    playerHost.innerHTML = '';
    player = new Player({ sim, plan: plan!, domes: state.domes, telescopes: state.telescopes }, playerHost);

    // 夜报导出
    const csvBtn = h('button', {}, '导出夜报 CSV');
    csvBtn.onclick = () => download(`夜报_${plan!.name}.csv`, reportCsv(sim, plan!), 'text/csv');
    const htmlBtn = h('button', {}, '导出夜报 HTML');
    htmlBtn.onclick = () => download(`夜报_${plan!.name}.html`, reportHtml(sim, plan!), 'text/html');
    const repTbl = h('table', {},
      h('tr', {},
        h('th', {}, '目标'), h('th', {}, '望远镜'), h('th', {}, '计划(min)'),
        h('th', {}, '有效曝光(min)'), h('th', {}, '被挡(min)'),
        h('th', {}, '翻转等待(min)'), h('th', {}, '转台(min)'), h('th', {}, '低于限高(min)')),
      ...sim.report.map(r => h('tr', {},
        h('td', {}, r.targetName), h('td', {}, r.telescopeId),
        h('td', {}, r.scheduledMin.toFixed(0)),
        h('td', {}, r.effectiveMin.toFixed(1)),
        h('td', {}, r.vignettedMin.toFixed(1)),
        h('td', {}, r.flipWaitMin.toFixed(1)),
        h('td', {}, r.slewMin.toFixed(1)),
        h('td', {}, r.belowMin.toFixed(1)))));
    playerHost.append(h('div', { class: 'panel' },
      h('h3', {}, '夜报汇总'), h('div', { class: 'toolbar' }, csvBtn, htmlBtn), repTbl));
  }

  runBtn.onclick = runAndShow;

  // 若已有推演结果, 直接加载最近一次
  const existing = state.sims.find(s => s.id === state.currentSimId && s.planId === plan.id)
    ?? state.sims.filter(s => s.planId === plan.id).pop();
  if (existing) {
    player = new Player({ sim: existing, plan, domes: state.domes, telescopes: state.telescopes }, playerHost);
    status.textContent = ` 已加载上次推演 (${existing.createdAt.slice(0, 19).replace('T', ' ')}), 可重新运行`;
  }
}
