// ---------- 碰撞复核页 ----------

import { state, loadAll, currentPlan, currentSim } from '../state';
import { dbPut } from '../db';
import { h, field, numInput, fmtTime } from '../ui';
import { simulate, SimOptions } from '../simulation';
import { Player } from '../player';
import { SimEvent, SimResult } from '../types';

export async function renderReview(root: HTMLElement): Promise<void> {
  await loadAll();
  root.innerHTML = '';

  const plan = currentPlan();
  const simMaybe = currentSim();
  if (!plan || !simMaybe) {
    root.append(h('div', { class: 'panel' },
      h('p', { class: 'muted' }, '请先在"整夜推演"页运行一次推演')));
    return;
  }
  const sim: SimResult = simMaybe;

  // 调整参数
  const optPanel = h('div', { class: 'panel' }, h('h3', {}, '复核参数调整'));
  const flipOffI = numInput(0, 1, 80);
  const marginI = numInput(0.05, 0.01, 80);
  const extraI = numInput(0.05, 0.01, 80);
  const telChecks = state.telescopes.map(t => {
    const c = h('input', { type: 'checkbox' });
    return { t, c };
  });
  const rerunBtn = h('button', { class: 'primary' }, '按新参数重算');
  optPanel.append(
    field('翻转时机偏移 (分钟, 提前为负)', flipOffI),
    field('接近告警阈值 (m)', marginI),
    field('安全区厚度 (m)', extraI),
    h('div', {}, h('span', { class: 'muted' }, '安全区应用到: '),
      ...telChecks.flatMap(({ t, c }) => [h('label', { style: 'margin-right:10px' }, c, ` ${t.name}`)])),
    rerunBtn,
  );
  root.append(optPanel);

  const mainRow = h('div', { class: 'row' });
  mainRow.style.alignItems = 'flex-start';
  const evPanel = h('div', { class: 'panel' }, h('h3', {}, `事件列表 (${sim.events.length})`));
  evPanel.style.flex = '0 0 460px';
  const playerPanel = h('div', {});
  mainRow.append(evPanel, playerPanel);
  root.append(mainRow);

  let player: Player | null = null;
  let currentEvents: SimEvent[] = sim.events;

  function buildPlayer(s: SimResult, t?: number, highlightTel?: string | null): void {
    player?.dispose();
    playerPanel.innerHTML = '';
    player = new Player({
      sim: s, plan: plan!, domes: state.domes, telescopes: state.telescopes,
      initialTime: t, highlightTelId: highlightTel ?? undefined,
    }, playerPanel);
    // 跳到事件所在圆顶
    if (highlightTel) {
      const tel = state.telescopes.find(x => x.id === highlightTel);
      if (tel) player.showDome(tel.domeId);
    }
  }

  function renderEvents(events: SimEvent[]): void {
    evPanel.innerHTML = '';
    evPanel.append(h('h3', {}, `事件列表 (${events.length})`));
    const list = h('div', { class: 'evlist' });
    const typeTag = (e: SimEvent) => {
      const map: Record<string, [string, string]> = {
        collision: ['碰撞', 'danger'], approach: ['接近', 'warn'],
        'flip-start': ['翻转开始', ''], 'flip-end': ['翻转完成', ''],
        conflict: ['圆顶冲突', 'warn'], 'dome-lag': ['圆顶滞后', 'warn'],
      };
      const [txt, cls] = map[e.type] ?? [e.type, ''];
      return h('span', { class: `tag ${cls}` }, txt);
    };
    for (const e of events) {
      const item = h('div', { class: 'evitem' },
        h('div', {}, typeTag(e), ` ${fmtTime(e.t)} `,
          e.minDist !== undefined ? h('span', { class: 'tag danger' }, `${(e.minDist * 1000).toFixed(0)}mm`) : ''),
        h('div', { class: 'muted' }, e.detail));
      item.onclick = () => {
        list.querySelectorAll('.evitem').forEach(x => x.classList.remove('sel'));
        item.classList.add('sel');
        buildPlayer(currentSim() ?? sim, e.t, e.telescopeId);
      };
      list.append(item);
    }
    if (!events.length) list.append(h('p', { class: 'muted' }, '无事件 — 整夜安全'));
    evPanel.append(list);
  }

  rerunBtn.onclick = async () => {
    const opts: SimOptions = {
      flipTimeOffsetMin: Number(flipOffI.value),
      safetyMargin: Number(marginI.value),
      extraClearance: Number(extraI.value),
      extraClearanceTelIds: telChecks.filter(x => x.c.checked).map(x => x.t.id),
    };
    rerunBtn.disabled = true;
    rerunBtn.textContent = '重算中…';
    await new Promise(r => setTimeout(r, 30));
    const sim2 = simulate(plan!, state.domes, state.telescopes, opts);
    await dbPut('sims', sim2);
    await loadAll();
    state.currentSimId = sim2.id;
    currentEvents = sim2.events;
    renderEvents(currentEvents);
    buildPlayer(sim2);
    rerunBtn.disabled = false;
    rerunBtn.textContent = '按新参数重算';
  };

  renderEvents(currentEvents);
  buildPlayer(sim);
}
