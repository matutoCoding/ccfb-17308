// ---------- 推演回放组件 (整夜推演页与碰撞复核页共用) ----------

import { DomeProfile, ObservingPlan, SimResult, Telescope, VIGNETTE_WARN } from './types';
import { Scene3D } from './scene3d';
import { MountParams, mountPose } from './kinematics';
import { h, fmt, fmtTime } from './ui';

const TEL_COLORS = ['#58a6ff', '#f0883e', '#3fb950', '#d2a8ff', '#ffa657', '#79c0ff'];

export interface PlayerOpts {
  sim: SimResult;
  plan: ObservingPlan;
  domes: DomeProfile[];
  telescopes: Telescope[];
  initialTime?: number;      // 初始时刻 (s)
  highlightTelId?: string | null;
}

export class Player {
  scene: Scene3D;
  timeIdx = 0;
  playing = false;
  speed = 60; // 每秒推进的模拟秒数
  viewEl: HTMLElement;
  hudEl: HTMLElement;
  occEl: HTMLElement;
  slider: HTMLInputElement;
  plotCanvas: HTMLCanvasElement;
  domeSel: HTMLSelectElement;
  camSel: HTMLSelectElement;
  private raf: number | null = null;
  private lastTs = 0;

  constructor(private opts: PlayerOpts, private container: HTMLElement) {
    const dome0 = opts.domes[0];
    // 工具行
    this.domeSel = h('select', {},
      ...opts.domes.map(d => h('option', { value: d.id }, d.name)));
    this.camSel = h('select', {},
      h('option', { value: 'orbit' }, '外部视角'),
      ...opts.telescopes.map(t => h('option', { value: 'tube:' + t.id }, `镜筒视角: ${t.name}`)));
    this.camSel.onchange = () => this.applyCamera();
    this.domeSel.onchange = () => this.rebuildScene();

    const playBtn = h('button', {}, '▶ 播放');
    playBtn.onclick = () => {
      this.playing = !this.playing;
      playBtn.textContent = this.playing ? '⏸ 暂停' : '▶ 播放';
    };
    const speedSel = h('select', {},
      ...[10, 60, 300, 900].map(s => h('option', { value: String(s) }, `×${s}`)));
    speedSel.value = '60';
    speedSel.onchange = () => { this.speed = Number(speedSel.value); };

    this.slider = h('input', {
      type: 'range', min: '0', max: String(opts.sim.steps.length - 1), value: '0',
    });
    this.slider.oninput = () => { this.timeIdx = Number(this.slider.value); this.applyTime(); };

    const toolbar = h('div', { class: 'toolbar' },
      playBtn, h('span', { class: 'muted' }, '速度'), speedSel,
      h('span', { class: 'muted' }, '圆顶'), this.domeSel,
      h('span', { class: 'muted' }, '相机'), this.camSel);

    this.viewEl = h('div', { class: 'view3d' });
    this.hudEl = h('div', { class: 'hud' });
    this.occEl = h('div', { class: 'occlabel' });
    this.viewEl.append(this.hudEl, this.occEl);

    this.plotCanvas = h('canvas', { class: 'plot' });
    this.plotCanvas.width = 1200; this.plotCanvas.height = 180;

    container.append(
      h('div', { class: 'panel' }, h('h3', {}, '三维推演'), toolbar, this.viewEl),
      h('div', { class: 'panel' }, h('h3', {}, '时间轴'), this.slider, this.plotCanvas),
    );

    this.scene = new Scene3D(this.viewEl);
    this.domeSel.value = dome0.id;
    this.rebuildScene();
    if (opts.initialTime !== undefined) {
      this.timeIdx = Math.round(opts.initialTime / opts.sim.stepSec);
    }
    this.applyTime();
    this.drawPlot();

    const tick = (ts: number) => {
      this.raf = requestAnimationFrame(tick);
      if (!this.playing) { this.lastTs = ts; return; }
      const dt = (ts - this.lastTs) / 1000;
      this.lastTs = ts;
      const adv = dt * this.speed / this.opts.sim.stepSec;
      this.timeIdx = Math.min(this.opts.sim.steps.length - 1, this.timeIdx + adv);
      if (this.timeIdx >= this.opts.sim.steps.length - 1) {
        this.playing = false;
        playBtn.textContent = '▶ 播放';
      }
      this.applyTime();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private currentDome(): DomeProfile {
    return this.opts.domes.find(d => d.id === this.domeSel.value) ?? this.opts.domes[0];
  }

  private rebuildScene(): void {
    const dome = this.currentDome();
    const tels = this.opts.telescopes.filter(t => t.domeId === dome.id);
    this.scene.build(dome, tels);
    this.applyCamera();
    this.applyTime();
  }

  private applyCamera(): void {
    const v = this.camSel.value;
    if (v === 'orbit') this.scene.setCameraMode('orbit');
    else this.scene.setCameraMode('tube', v.slice(5));
  }

  /** 把当前时刻的姿态/圆顶/挡板应用到三维场景 */
  applyTime(): void {
    const { sim, telescopes, plan } = this.opts;
    const idx = Math.floor(this.timeIdx);
    const step = sim.steps[idx];
    if (!step) return;
    this.slider.value = String(idx);
    const dome = this.currentDome();

    const domeAz = step.domeAz[dome.id] ?? 0;
    this.scene.setDomeAz(domeAz);
    const shut = step.domeShutters[dome.id];
    if (shut) this.scene.updateShutters(shut[0], shut[1]);

    let hud = `t ${fmtTime(step.t)}   圆顶方位 ${fmt(domeAz)}°`;
    let worstVig = 0;

    for (const ts of step.tel) {
      const tel = telescopes.find(t => t.id === ts.telescopeId);
      if (!tel || tel.domeId !== dome.id) continue;
      const pier = dome.piers.find(p => p.id === tel.pierId)!;
      const mp: MountParams = {
        type: tel.mountType, lat: plan.site.lat,
        pierPos: { x: pier.x, y: pier.y, z: pier.height },
        mountHeadHeight: tel.mountHeadHeight,
        decOffset: tel.decOffset, counterweightArm: tel.counterweightArm,
      };
      const pose = mountPose(mp, ts.ha, ts.dec, tel, ts.side,
        ts.flipBlend > 0 && ts.flipBlend < 1 ? ts.flipBlend : undefined);
      this.scene.updateTelescope(tel.id, pose);
      const vigPct = (ts.vignetting * 100).toFixed(0);
      hud += `\n${tel.name}: ${ts.state}  高度 ${fmt(ts.alt)}° 方位 ${fmt(ts.az)}°` +
        (ts.state === 'idle' ? '' : `  遮挡 ${vigPct}%`) +
        (Number.isFinite(ts.minClearance) && ts.minClearance < 0.2
          ? `  间距 ${(ts.minClearance * 1000).toFixed(0)}mm` : '');
      if (ts.state === 'track' || ts.state === 'flip') worstVig = Math.max(worstVig, ts.vignetting);
    }
    this.hudEl.textContent = hud;

    // 遮挡红框
    const tubeTel = this.camSel.value.startsWith('tube:') ? this.camSel.value.slice(5) : null;
    const focusVig = tubeTel
      ? step.tel.find(t => t.telescopeId === tubeTel)?.vignetting ?? 0
      : worstVig;
    const occluded = focusVig >= VIGNETTE_WARN;
    this.viewEl.classList.toggle('occluded', occluded);
    this.occEl.textContent = occluded ? `⚠ 遮挡 ${(focusVig * 100).toFixed(0)}%` : '';

    // 高亮
    if (this.opts.highlightTelId !== undefined) {
      this.scene.highlight(this.opts.highlightTelId ?? null);
    }
    this.drawPlot();
  }

  /** 遮挡曲线 + 播放头 */
  private drawPlot(): void {
    const { sim, telescopes } = this.opts;
    const ctx = this.plotCanvas.getContext('2d')!;
    const W = this.plotCanvas.width, H = this.plotCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);
    // 5% 告警线
    ctx.strokeStyle = '#8b949e';
    ctx.setLineDash([4, 4]);
    const y5 = H - 0.05 * H;
    ctx.beginPath(); ctx.moveTo(0, y5); ctx.lineTo(W, y5); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px sans-serif';
    ctx.fillText('遮挡 5%', 6, y5 - 3);

    const n = sim.steps.length;
    const domeId = this.domeSel.value;
    telescopes.filter(t => t.domeId === domeId).forEach((tel, i) => {
      const color = TEL_COLORS[i % TEL_COLORS.length];
      ctx.strokeStyle = color;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < n; k++) {
        const ts = sim.steps[k].tel.find(x => x.telescopeId === tel.id);
        if (!ts || ts.state === 'idle') { pen = false; continue; } // 停泊时不画
        const x = k / (n - 1) * W;
        const y = H - ts.vignetting * H;
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(tel.name, 8 + i * 130, 14);
    });

    // 事件标记
    for (const ev of sim.events) {
      if (ev.type !== 'collision' && ev.type !== 'approach' && ev.type !== 'flip-start') continue;
      const x = ev.t / sim.durationSec * W;
      ctx.strokeStyle = ev.type === 'collision' ? '#f85149' : ev.type === 'approach' ? '#f0883e' : '#d2a8ff';
      ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, H - 10); ctx.stroke();
    }

    // 播放头
    const px = this.timeIdx / (n - 1) * W;
    ctx.strokeStyle = '#e6edf3';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }

  seekTime(tSec: number): void {
    this.timeIdx = tSec / this.opts.sim.stepSec;
    this.applyTime();
  }

  /** 切换显示的圆顶 */
  showDome(domeId: string): void {
    if (this.opts.domes.some(d => d.id === domeId)) {
      this.domeSel.value = domeId;
      this.rebuildScene();
    }
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.scene.dispose();
  }
}
