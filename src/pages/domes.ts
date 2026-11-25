// ---------- 圆顶档案页 ----------

import { DomeProfile, PierSlot } from '../types';
import { state, loadAll } from '../state';
import { dbPut, dbDelete } from '../db';
import { h, field, numInput } from '../ui';

export async function renderDomes(root: HTMLElement): Promise<void> {
  await loadAll();
  root.innerHTML = '';

  const listPanel = h('div', { class: 'panel' }, h('h3', {}, '圆顶列表'));
  const editPanel = h('div', { class: 'panel' });
  const row = h('div', { class: 'row' });
  row.style.alignItems = 'flex-start';
  listPanel.style.flex = '0 0 300px';
  row.append(listPanel, editPanel);
  root.append(row);

  const newBtn = h('button', { class: 'primary' }, '+ 新建圆顶');
  listPanel.append(newBtn);

  function renderList(): void {
    listPanel.querySelectorAll('table')?.forEach(t => t.remove());
    const tbl = h('table', {},
      h('tr', {}, h('th', {}, '名称'), h('th', {}, '直径'), h('th', {}, '墩位数'), h('th', {}, '')));
    for (const d of state.domes) {
      const telCount = state.telescopes.filter(t => t.domeId === d.id).length;
      const sel = h('button', {}, '编辑');
      sel.onclick = () => { state.currentDomeId = d.id; renderEdit(); };
      const tr = h('tr', {},
        h('td', {}, d.name + (telCount ? ` (${telCount}台)` : '')),
        h('td', {}, `${d.diameter}m`),
        h('td', {}, String(d.piers.length)),
        h('td', {}, sel));
      if (d.id === state.currentDomeId) tr.style.background = '#1f2a3d';
      tbl.append(tr);
    }
    listPanel.append(tbl);
  }

  function renderEdit(): void {
    const d = state.domes.find(x => x.id === state.currentDomeId);
    editPanel.innerHTML = '';
    if (!d) { editPanel.append(h('p', { class: 'muted' }, '选择或新建一个圆顶')); return; }
    editPanel.append(h('h3', {}, `圆顶档案: ${d.name}`));

    const inputs: Record<string, HTMLInputElement> = {};
    const mk = (key: keyof DomeProfile, label: string, step = 0.1) => {
      const i = numInput(d[key] as number, step);
      inputs[key as string] = i;
      return field(label, i);
    };
    const nameI = h('input', { value: d.name });
    const form1 = h('div', {},
      field('名称', nameI),
      mk('diameter', '直径 (m)'),
      mk('wallHeight', '墙高 (m)'),
      mk('slitWidth', '狭缝宽度 (m)'),
      mk('slitBottomHeight', '狭缝下沿高 (m)'),
    );
    const form2 = h('div', {},
      mk('lowerShutterMax', '下挡板行程 (m)'),
      mk('upperShutterMax', '上挡板行程 (m)'),
      mk('slewSpeedMax', '转速上限 (°/s)'),
      mk('accel', '加减速 (°/s²)'),
      mk('shutterSpeed', '挡板速度 (m/s)', 0.01),
    );

    // 墩子表
    const pierTbl = h('table', {},
      h('tr', {}, h('th', {}, '墩位'), h('th', {}, 'X/东 (m)'), h('th', {}, 'Y/北 (m)'),
        h('th', {}, '高度 (m)'), h('th', {}, '直径 (m)'), h('th', {}, '')));
    const pierRows: { pier: PierSlot; inputs: HTMLInputElement[] }[] = [];
    const renderPiers = () => {
      pierTbl.querySelectorAll('tr:not(:first-child)').forEach(r => r.remove());
      pierRows.length = 0;
      for (const p of d.piers) {
        const ins = [
          numInput(p.x, 0.05, 70), numInput(p.y, 0.05, 70),
          numInput(p.height, 0.05, 70), numInput(p.diameter, 0.05, 70),
        ];
        const nameI2 = h('input', { value: p.name, style: 'width:50px' });
        const del = h('button', { class: 'danger' }, '删');
        del.onclick = () => { d.piers = d.piers.filter(x => x.id !== p.id); renderPiers(); };
        pierRows.push({ pier: p, inputs: [nameI2, ...ins] });
        pierTbl.append(h('tr', {},
          h('td', {}, nameI2), h('td', {}, ins[0]), h('td', {}, ins[1]),
          h('td', {}, ins[2]), h('td', {}, ins[3]), h('td', {}, del)));
      }
    };
    renderPiers();
    const addPier = h('button', {}, '+ 加墩位');
    addPier.onclick = () => {
      d.piers.push({ id: 'p' + Date.now(), name: 'P' + (d.piers.length + 1), x: 0, y: 0, height: 1, diameter: 0.4 });
      renderPiers();
    };

    const save = h('button', { class: 'primary' }, '保存');
    save.onclick = async () => {
      d.name = nameI.value;
      for (const [k, i] of Object.entries(inputs)) (d as unknown as Record<string, number>)[k] = Number(i.value);
      for (const { pier, inputs: ins } of pierRows) {
        pier.name = ins[0].value;
        pier.x = Number(ins[1].value); pier.y = Number(ins[2].value);
        pier.height = Number(ins[3].value); pier.diameter = Number(ins[4].value);
      }
      await dbPut('domes', d);
      await loadAll();
      renderList(); renderEdit();
    };
    const del = h('button', { class: 'danger' }, '删除圆顶');
    del.onclick = async () => {
      if (!confirm(`删除 ${d.name}?`)) return;
      await dbDelete('domes', d.id);
      state.currentDomeId = state.domes.find(x => x.id !== d.id)?.id ?? null;
      await loadAll();
      renderList(); renderEdit();
    };

    editPanel.append(
      h('div', { class: 'row' }, h('div', {}, form1), h('div', {}, form2)),
      h('h4', {}, '墩位 (一个圆顶可放两三台设备)'),
      pierTbl, addPier, h('div', { style: 'margin-top:10px' }, save, ' ', del),
    );
  }

  newBtn.onclick = async () => {
    const d: DomeProfile = {
      id: 'dome' + Date.now(), name: '新圆顶',
      diameter: 4, wallHeight: 2, slitWidth: 0.9, slitBottomHeight: 1.1,
      lowerShutterMax: 0.9, upperShutterMax: 2, slewSpeedMax: 2, accel: 0.5,
      shutterSpeed: 0.05,
      piers: [{ id: 'p' + Date.now(), name: 'P1', x: 0, y: 0, height: 1, diameter: 0.4 }],
    };
    await dbPut('domes', d);
    await loadAll();
    state.currentDomeId = d.id;
    renderList(); renderEdit();
  };

  renderList();
  renderEdit();
}
