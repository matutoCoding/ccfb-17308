// ---------- 望远镜装配页 (三维里拧两根轴看姿态) ----------

import { MountType, Telescope } from '../types';
import { state, loadAll } from '../state';
import { dbPut, dbDelete } from '../db';
import { h, field, numInput, fmt } from '../ui';
import { Scene3D } from '../scene3d';
import { MountParams, domeGeom, mountPose, solveDomeAz, vecToAltAz } from '../kinematics';

export async function renderTelescopes(root: HTMLElement): Promise<void> {
  await loadAll();
  root.innerHTML = '';

  const listPanel = h('div', { class: 'panel' }, h('h3', {}, '设备列表'));
  listPanel.style.flex = '0 0 260px';
  const editPanel = h('div', { class: 'panel' });
  editPanel.style.flex = '0 0 420px';
  const viewPanel = h('div', { class: 'panel' }, h('h3', {}, '装配三维预览 (拖动滑杆拧轴)'));
  const row = h('div', { class: 'row' });
  row.style.alignItems = 'flex-start';
  row.append(listPanel, editPanel, viewPanel);
  root.append(row);

  const viewEl = h('div', { class: 'view3d' });
  const hudEl = h('div', { class: 'hud' });
  viewEl.appendChild(hudEl);
  viewPanel.appendChild(viewEl);
  const scene = new Scene3D(viewEl);

  // 轴角度状态 (deg)
  let axis1 = 0;   // gem/fork: 时角; altaz: 方位
  let axis2 = 40;  // gem/fork: 赤纬; altaz: 高度
  let side: 1 | -1 = 1;

  const newBtn = h('button', { class: 'primary' }, '+ 新建设备');
  listPanel.append(newBtn);

  function currentTel(): Telescope | undefined {
    return state.telescopes.find(t => t.id === state.currentTelId);
  }

  function renderList(): void {
    listPanel.querySelectorAll('table')?.forEach(t => t.remove());
    const tbl = h('table', {}, h('tr', {}, h('th', {}, '名称'), h('th', {}, '类型'), h('th', {}, '圆顶'), h('th', {}, '')));
    const typeName = { gem: '德式', fork: '叉式', altaz: '地平式' } as Record<MountType, string>;
    for (const t of state.telescopes) {
      const dome = state.domes.find(d => d.id === t.domeId);
      const sel = h('button', {}, '装配');
      sel.onclick = () => { state.currentTelId = t.id; renderEdit(); rebuild(); };
      const tr = h('tr', {},
        h('td', {}, t.name), h('td', {}, typeName[t.mountType]),
        h('td', {}, dome?.name ?? '?'), h('td', {}, sel));
      if (t.id === state.currentTelId) tr.style.background = '#1f2a3d';
      tbl.append(tr);
    }
    listPanel.append(tbl);
  }

  function renderEdit(): void {
    const t = currentTel();
    editPanel.innerHTML = '';
    if (!t) { editPanel.append(h('p', { class: 'muted' }, '选择或新建设备')); return; }
    editPanel.append(h('h3', {}, `装配参数: ${t.name}`));

    const nameI = h('input', { value: t.name });
    const typeSel = h('select', {},
      ...(['gem', 'fork', 'altaz'] as MountType[]).map(m =>
        h('option', { value: m, ...(m === t.mountType ? { selected: '' } : {}) },
          { gem: '德式赤道仪', fork: '叉式赤道仪', altaz: '地平式' }[m])));
    const domeSel = h('select', {},
      ...state.domes.map(d => h('option', { value: d.id, ...(d.id === t.domeId ? { selected: '' } : {}) }, d.name)));
    const pierSel = h('select', {});
    const fillPiers = () => {
      pierSel.innerHTML = '';
      const dome = state.domes.find(d => d.id === domeSel.value);
      for (const p of dome?.piers ?? []) {
        pierSel.append(h('option', { value: p.id, ...(p.id === t.pierId ? { selected: '' } : {}) },
          `墩位 ${p.name} (x=${p.x}, y=${p.y})`));
      }
    };
    fillPiers();
    domeSel.onchange = fillPiers;

    const inputs: Record<string, HTMLInputElement> = {};
    const mk = (key: keyof Telescope, label: string, step = 0.05) => {
      const i = numInput(t[key] as number, step);
      inputs[key] = i;
      return field(label, i);
    };

    editPanel.append(
      field('名称', nameI), field('类型', typeSel), field('圆顶', domeSel), field('墩位', pierSel),
      h('hr', { style: 'border-color:#30363d' }),
      h('div', {},
        mk('mountHeadHeight', '轴头高 (m)'),
        mk('decOffset', '赤经轴→镜筒偏距 (m)'),
        mk('tubeLength', '镜筒长 (m)'),
        mk('tubeDiameter', '镜筒径 (m)'),
        mk('dewShieldLength', '遮光罩长 (m)'),
        mk('dewShieldDiameter', '遮光罩径 (m)')),
      h('div', {},
        mk('counterweightArm', '配重杆长 (m)'),
        mk('counterweightRadius', '配重半径 (m)'),
        mk('mountRadius', '本体半径 (m)'),
        mk('flipAngleLimit', '翻转限 (°)', 1),
        mk('flipDuration', '翻转耗时 (s)', 10),
        mk('slewSpeed', '转台速度 (°/s)', 0.5)),
    );

    const save = h('button', { class: 'primary' }, '保存并重算预览');
    save.onclick = async () => {
      t.name = nameI.value;
      t.mountType = typeSel.value as MountType;
      t.domeId = domeSel.value;
      t.pierId = pierSel.value;
      for (const [k, i] of Object.entries(inputs)) (t as unknown as Record<string, number>)[k] = Number(i.value);
      await dbPut('telescopes', t);
      await loadAll();
      renderList(); rebuild();
    };
    const del = h('button', { class: 'danger' }, '删除');
    del.onclick = async () => {
      if (!confirm(`删除 ${t.name}?`)) return;
      await dbDelete('telescopes', t.id);
      state.currentTelId = state.telescopes[0]?.id ?? null;
      await loadAll();
      renderList(); renderEdit(); rebuild();
    };
    editPanel.append(h('div', { style: 'margin-top:10px' }, save, ' ', del));
  }

  // 轴滑杆
  const sliderPanel = h('div', { class: 'panel' });
  const s1 = h('input', { type: 'range', min: '-180', max: '180', value: String(axis1), step: '0.5' });
  const s2 = h('input', { type: 'range', min: '-30', max: '90', value: String(axis2), step: '0.5' });
  const sideBtn = h('button', {}, '中天翻转侧: 正常');
  sideBtn.onclick = () => {
    side = side === 1 ? -1 : 1;
    sideBtn.textContent = side === 1 ? '中天翻转侧: 正常' : '中天翻转侧: 已翻转';
    updatePose();
  };
  const l1 = h('div', { class: 'muted' }, '轴1');
  const l2 = h('div', { class: 'muted' }, '轴2');
  s1.oninput = () => { axis1 = Number(s1.value); updatePose(); };
  s2.oninput = () => { axis2 = Number(s2.value); updatePose(); };
  sliderPanel.append(l1, s1, l2, s2, sideBtn);
  viewPanel.appendChild(sliderPanel);

  function updatePose(): void {
    const t = currentTel();
    if (!t) return;
    const dome = state.domes.find(d => d.id === t.domeId);
    const pier = dome?.piers.find(p => p.id === t.pierId);
    if (!dome || !pier) return;
    const isAltAz = t.mountType === 'altaz';
    l1.textContent = isAltAz ? `方位轴: ${axis1.toFixed(1)}°` : `时角轴: ${axis1.toFixed(1)}°`;
    l2.textContent = isAltAz ? `高度轴: ${axis2.toFixed(1)}°` : `赤纬轴: ${axis2.toFixed(1)}°`;

    // altaz: 把 az/alt 转成等效 ha/dec 显示 (用固定 LST 仅作预览)
    let ha = axis1, dec = axis2;
    if (isAltAz) {
      // 预览: 直接按 az/alt 造姿态 —— 用伪 ha/dec 使 eqVec 给出所需方向
      // alt=axis2, az=axis1 -> 反解 ha/dec (lat=站点纬度)
      const lat = 38.6067;
      const alt = axis2 * Math.PI / 180, az = axis1 * Math.PI / 180, p = lat * Math.PI / 180;
      const sinDec = Math.sin(alt) * Math.sin(p) + Math.cos(alt) * Math.cos(p) * Math.cos(az);
      dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * 180 / Math.PI;
      const cosH = (Math.sin(alt) - Math.sin(p) * sinDec) / (Math.cos(p) * Math.cos(Math.asin(sinDec)));
      let H = Math.acos(Math.max(-1, Math.min(1, cosH))) * 180 / Math.PI;
      if (Math.sin(az) > 0) H = -H;
      ha = H;
    }
    const mp: MountParams = {
      type: t.mountType, lat: 38.6067,
      pierPos: { x: pier.x, y: pier.y, z: pier.height },
      mountHeadHeight: t.mountHeadHeight, decOffset: t.decOffset,
      counterweightArm: t.counterweightArm,
    };
    const pose = mountPose(mp, ha, dec, t, side);
    scene.updateTelescope(t.id, pose);
    const aa = vecToAltAz(pose.dir);
    const dg = domeGeom(dome);
    const sol = solveDomeAz(pose.aperture, pose.dir, dg);
    hudEl.textContent =
      `高度 ${fmt(aa.alt)}°  方位 ${fmt(aa.az)}°\n` +
      (sol
        ? `光轴穿出点方位 ${fmt(sol.az)}°  (望远镜方位与圆顶方位差 ${fmt(Math.abs(((sol.az - aa.az + 540) % 360) - 180))}°)`
        : '光轴无法穿出穹顶 (低于狭缝)');
  }

  function rebuild(): void {
    const t = currentTel();
    const dome = state.domes.find(d => d.id === (t?.domeId ?? state.currentDomeId));
    if (!dome) return;
    const tels = state.telescopes.filter(x => x.domeId === dome.id);
    scene.build(dome, tels);
    // 其他设备放停泊姿态
    for (const other of tels) {
      if (other.id === t?.id) continue;
      const pier = dome.piers.find(p => p.id === other.pierId)!;
      const mp: MountParams = {
        type: other.mountType, lat: 38.6067,
        pierPos: { x: pier.x, y: pier.y, z: pier.height },
        mountHeadHeight: other.mountHeadHeight, decOffset: other.decOffset,
        counterweightArm: other.counterweightArm,
      };
      scene.updateTelescope(other.id, mountPose(mp, 0, 38.6067, other, 1));
    }
    updatePose();
  }

  newBtn.onclick = async () => {
    const dome = state.domes[0];
    if (!dome) return;
    const t: Telescope = {
      id: 'tel' + Date.now(), name: '新设备', domeId: dome.id, pierId: dome.piers[0]?.id ?? '',
      mountType: 'gem', mountHeadHeight: 0.4, decOffset: 0.3,
      tubeLength: 1.2, tubeDiameter: 0.3, dewShieldLength: 0.35, dewShieldDiameter: 0.33,
      counterweightArm: 0.7, counterweightRadius: 0.11, mountRadius: 0.22,
      flipAngleLimit: 5, flipDuration: 120, slewSpeed: 3,
    };
    await dbPut('telescopes', t);
    await loadAll();
    state.currentTelId = t.id;
    renderList(); renderEdit(); rebuild();
  };

  renderList();
  renderEdit();
  rebuild();
}
