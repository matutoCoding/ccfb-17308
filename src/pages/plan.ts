// ---------- 观测计划页 ----------

import { ObservingPlan, ScheduleEntry } from '../types';
import { state, loadAll } from '../state';
import { dbPut, dbDelete } from '../db';
import { h, field, numInput, fmt } from '../ui';
import { eqToAltAz, horizonAlt, nightWindow } from '../astro';

export async function renderPlan(root: HTMLElement): Promise<void> {
  await loadAll();
  root.innerHTML = '';

  const planSelPanel = h('div', { class: 'panel' }, h('h3', {}, '计划'));
  const editPanel = h('div', { class: 'panel' });
  const tablePanel = h('div', { class: 'panel' }, h('h3', {}, '目标与时段 (低于限高/地形遮挡自动标灰)'));
  root.append(planSelPanel, editPanel, tablePanel);

  let plan = state.plans.find(p => p.id === state.currentPlanId);

  function renderSel(): void {
    planSelPanel.innerHTML = '';
    planSelPanel.append(h('h3', {}, '计划'));
    const sel = h('select', {},
      ...state.plans.map(p => h('option',
        { value: p.id, ...(p.id === plan?.id ? { selected: '' } : {}) }, `${p.name} (${p.date})`)));
    sel.onchange = () => { state.currentPlanId = sel.value; plan = state.plans.find(p => p.id === sel.value); renderAll(); };
    const newBtn = h('button', { class: 'primary' }, '+ 新建计划');
    newBtn.onclick = async () => {
      const p: ObservingPlan = {
        id: 'plan' + Date.now(), name: '新计划', date: new Date().toISOString().slice(0, 10),
        site: { name: '冷湖赛什腾山', lat: 38.6067, lon: 93.8961, elevation: 4200 },
        minAltitude: 25, horizon: [], entries: [],
      };
      await dbPut('plans', p);
      await loadAll();
      state.currentPlanId = p.id; plan = p;
      renderAll();
    };
    const delBtn = h('button', { class: 'danger' }, '删除计划');
    delBtn.onclick = async () => {
      if (!plan || !confirm(`删除 ${plan.name}?`)) return;
      await dbDelete('plans', plan.id);
      state.currentPlanId = null;
      await loadAll();
      state.currentPlanId = state.plans[0]?.id ?? null;
      plan = state.plans.find(p => p.id === state.currentPlanId);
      renderAll();
    };
    planSelPanel.append(sel, ' ', newBtn, ' ', delBtn);
  }

  function renderEdit(): void {
    editPanel.innerHTML = '';
    if (!plan) { editPanel.append(h('p', { class: 'muted' }, '请先新建计划')); return; }
    editPanel.append(h('h3', {}, '站点与夜晚'));
    const nameI = h('input', { value: plan.name });
    const dateI = h('input', { type: 'date', value: plan.date });
    const latI = numInput(plan.site.lat, 0.0001, 90);
    const lonI = numInput(plan.site.lon, 0.0001, 90);
    const elI = numInput(plan.site.elevation, 1, 70);
    const minAltI = numInput(plan.minAltitude, 1, 60);
    const horizonI = h('textarea', { rows: '3', style: 'width:100%' },
      plan.horizon.map(p => `${p.az},${p.alt}`).join('\n'));
    horizonI.placeholder = '地形遮挡剖面, 每行: 方位角,遮挡高度 (deg)';

    const { start, end } = nightWindow(plan.date, plan.site.lat, plan.site.lon);
    const nightInfo = h('div', { class: 'muted' },
      `天文夜 (太阳<-18°): ${start.toISOString().slice(11, 16)}Z → ${end.toISOString().slice(11, 16)}Z, ` +
      `共 ${((end.getTime() - start.getTime()) / 3600000).toFixed(1)} 小时。计划时间轴以此为 0 点。`);

    const save = h('button', { class: 'primary' }, '保存基本参数');
    save.onclick = async () => {
      plan!.name = nameI.value;
      plan!.date = dateI.value;
      plan!.site = { name: plan!.site.name, lat: Number(latI.value), lon: Number(lonI.value), elevation: Number(elI.value) };
      plan!.minAltitude = Number(minAltI.value);
      plan!.horizon = horizonI.value.split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => { const [az, alt] = l.split(',').map(Number); return { az, alt }; })
        .filter(p => Number.isFinite(p.az) && Number.isFinite(p.alt));
      await dbPut('plans', plan!);
      renderAll();
    };
    editPanel.append(
      field('计划名', nameI), field('日期', dateI),
      field('纬度°', latI), field('经度°', lonI), field('海拔m', elI),
      field('限制高度°', minAltI),
      h('div', {}, h('div', { class: 'muted' }, '地形遮挡 (az,alt 每行一条)'), horizonI),
      nightInfo, save,
    );
  }

  function renderTable(): void {
    tablePanel.innerHTML = '';
    tablePanel.append(h('h3', {}, '目标与时段 (低于限高/地形遮挡自动标灰)'));
    if (!plan) return;
    const { start } = nightWindow(plan.date, plan.site.lat, plan.site.lon);

    // 导入区
    const csvI = h('textarea', { rows: '4', style: 'width:100%' }, '');
    csvI.placeholder = '导入目标列表, 每行: 望远镜ID,目标名,赤经°,赤纬°,开始(分钟),时长(分钟)\n例如: tel1,M31,10.68,41.27,10,120';
    const importBtn = h('button', {}, '导入目标');
    importBtn.onclick = async () => {
      const lines = csvI.value.split('\n').map(l => l.trim()).filter(Boolean);
      let n = 0;
      for (const l of lines) {
        const [telId, name, ra, dec, st, dur] = l.split(',').map(s => s.trim());
        if (!telId || !name || !Number.isFinite(+ra) || !Number.isFinite(+dec)) continue;
        plan!.entries.push({
          id: 'e' + Date.now() + '_' + n++, telescopeId: telId, targetName: name,
          ra: +ra, dec: +dec, startMin: +(st || 0), durationMin: +(dur || 60),
        });
      }
      await dbPut('plans', plan!);
      csvI.value = '';
      renderTable();
    };

    // 表
    const tbl = h('table', {});
    tbl.append(h('tr', {},
      h('th', {}, '望远镜'), h('th', {}, '目标'), h('th', {}, 'RA°'), h('th', {}, 'Dec°'),
      h('th', {}, '开始(min)'), h('th', {}, '时长(min)'),
      h('th', {}, '起始高度/方位'), h('th', {}, '整夜可观测性'), h('th', {}, '')));

    const telName = (id: string) => state.telescopes.find(t => t.id === id)?.name ?? id;

    for (const e of [...plan.entries].sort((a, b) => a.startMin - b.startMin)) {
      const t0 = new Date(start.getTime() + e.startMin * 60000);
      const aa = eqToAltAz(e.ra, e.dec, plan!.site.lat, t0, plan!.site.lon);
      // 扫描整个条目时段, 找出标灰区间
      const gray: string[] = [];
      let inGray = false, gStart = 0;
      for (let m = 0; m <= e.durationMin; m += 5) {
        const t = new Date(t0.getTime() + m * 60000);
        const a = eqToAltAz(e.ra, e.dec, plan!.site.lat, t, plan!.site.lon);
        const bad = a.alt < plan!.minAltitude || a.alt < horizonAlt(plan!.horizon, a.az);
        if (bad && !inGray) { inGray = true; gStart = m; }
        if (!bad && inGray) { inGray = false; gray.push(`+${gStart}~+${m}min`); }
      }
      if (inGray) gray.push(`+${gStart}~+${e.durationMin}min`);
      const startBad = aa.alt < plan!.minAltitude || aa.alt < horizonAlt(plan!.horizon, aa.az);

      const del = h('button', { class: 'danger' }, '删');
      del.onclick = async () => {
        plan!.entries = plan!.entries.filter(x => x.id !== e.id);
        await dbPut('plans', plan!);
        renderTable();
      };
      const tr = h('tr', {},
        h('td', {}, telName(e.telescopeId)),
        h('td', {}, e.targetName),
        h('td', {}, fmt(e.ra, 2)), h('td', {}, fmt(e.dec, 2)),
        h('td', {}, String(e.startMin)), h('td', {}, String(e.durationMin)),
        h('td', {}, `${fmt(aa.alt)}° / ${fmt(aa.az)}°`),
        h('td', {}, gray.length ? `遮挡时段: ${gray.join(', ')}` : '全程可观测'),
        h('td', {}, del));
      if (startBad) tr.classList.add('grayed');
      if (gray.length) tr.style.color = '#f0883e';
      if (startBad) tr.style.color = '';
      tbl.append(tr);
    }

    // 快捷填充: 用测试目标
    const fillBtn = h('button', {}, '填入示例 CSV');
    fillBtn.onclick = () => {
      csvI.value = [
        'tel1,NGC891,35.64,42.35,300,120',
        'tel2,NGC7662,351.5,42.53,240,90',
      ].join('\n');
    };

    tablePanel.append(
      h('div', { class: 'muted' }, '按站点经纬度海拔和当晚时刻, J2000 赤经赤纬已换算为高度角/方位角; 标灰行为不可观测时段。'),
      tbl,
      h('h4', {}, '导入目标'), csvI, h('div', {}, importBtn, ' ', fillBtn),
    );
  }

  function renderAll(): void {
    renderSel(); renderEdit(); renderTable();
  }
  renderAll();
}
