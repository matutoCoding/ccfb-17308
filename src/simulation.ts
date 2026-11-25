// ---------- 整夜推演引擎 ----------
// 30s 主步长; 圆顶伺服 1s 子步; 中天翻转期间 5s 子步做碰撞采样。

import {
  DomeProfile, ObservingPlan, ScheduleEntry, SimEvent, SimResult, SimStep,
  TargetReport, Telescope, TelState, APPROACH_DIST, VIGNETTE_WARN,
} from './types';
import { D2R, azDiff, eqToAltAz, horizonAlt, nightWindow } from './astro';
import {
  MountPose, MountParams, domeGeom, mountPose, solveDomeAz, slitHalfAngleAt, V,
} from './kinematics';
import { vignetting } from './vignetting';
import { Capsule, EnvObstacle, checkClearances } from './collision';

export interface SimOptions {
  stepSec?: number;
  safetyMargin?: number;          // 接近告警阈值 (m), 默认 5cm
  flipTimeOffsetMin?: number;     // 翻转时机调整 (分钟, 提前为负)
  extraClearanceTelIds?: string[]; // 加安全区的望远镜
  extraClearance?: number;        // 安全区额外厚度 (m)
}

interface TelRuntime {
  tel: Telescope;
  mp: MountParams;
  entry: ScheduleEntry | null;
  entryEnd: number;         // t (s) 当前条目结束
  side: 1 | -1;
  flipping: boolean;
  flipT0: number; flipT1: number;
  flipFromSide: 1 | -1;
  pose: MountPose | null;
  ha: number; dec: number;
  slewRemaining: number;    // 还需转的角度 (deg)
  state: TelState;
  flippedForEntry: boolean;
}

interface DomeRuntime {
  dome: DomeProfile;
  az: number; vel: number;
  lowerZ: number; upperZ: number;
  followTelId: string | null;
  conflictActive: boolean;
}

const PARK_HA = 0;

export function simulate(
  plan: ObservingPlan,
  domes: DomeProfile[],
  telescopes: Telescope[],
  opts: SimOptions = {}
): SimResult {
  const stepSec = opts.stepSec ?? 30;
  const margin = opts.safetyMargin ?? APPROACH_DIST;
  const { start, end } = nightWindow(plan.date, plan.site.lat, plan.site.lon);
  const durationSec = Math.floor((end.getTime() - start.getTime()) / 1000);
  const lat = plan.site.lat, lon = plan.site.lon;

  const domeMap = new Map(domes.map(d => [d.id, d]));
  const telMap = new Map(telescopes.map(t => [t.id, t]));

  // 运行时状态
  const tels: TelRuntime[] = telescopes.map(tel => {
    const dome = domeMap.get(tel.domeId)!;
    const pier = dome.piers.find(p => p.id === tel.pierId)!;
    const mp: MountParams = {
      type: tel.mountType, lat,
      pierPos: { x: pier.x, y: pier.y, z: pier.height },
      mountHeadHeight: tel.mountHeadHeight,
      decOffset: tel.decOffset,
      counterweightArm: tel.counterweightArm,
    };
    return {
      tel, mp, entry: null, entryEnd: -1, side: 1, flipping: false,
      flipT0: 0, flipT1: 0, flipFromSide: 1, pose: null,
      ha: PARK_HA, dec: lat, slewRemaining: 0, state: 'idle', flippedForEntry: false,
    };
  });

  const domeRt = new Map<string, DomeRuntime>();
  for (const d of domes) {
    domeRt.set(d.id, {
      dome: d, az: 0, vel: 0,
      lowerZ: d.slitBottomHeight,
      upperZ: d.slitBottomHeight + d.slitWidth * 0 + d.diameter / 2, // 初始全开
      followTelId: null, conflictActive: false,
    });
  }

  // 每台望远镜的计划条目 (按开始时间排序)
  const entriesByTel = new Map<string, ScheduleEntry[]>();
  for (const e of plan.entries) {
    if (!telMap.has(e.telescopeId)) continue;
    const arr = entriesByTel.get(e.telescopeId) ?? [];
    arr.push(e);
    entriesByTel.set(e.telescopeId, arr);
  }
  for (const arr of entriesByTel.values()) arr.sort((a, b) => a.startMin - b.startMin);

  // 报告累积
  const repMap = new Map<string, TargetReport>();
  for (const e of plan.entries) {
    repMap.set(e.id, {
      entryId: e.id, telescopeId: e.telescopeId, targetName: e.targetName,
      scheduledMin: e.durationMin, effectiveMin: 0, vignettedMin: 0,
      flipWaitMin: 0, slewMin: 0, belowMin: 0,
    });
  }

  const steps: SimStep[] = [];
  const events: SimEvent[] = [];
  let evSeq = 0;
  const pushEvent = (t: number, ev: Omit<SimEvent, 'id' | 't'>) =>
    events.push({ id: `ev${++evSeq}`, t, ...ev });

  // 接近事件按对象对聚合 (记录最小间距)
  const approachMap = new Map<string, SimEvent>();

  const nSteps = Math.floor(durationSec / stepSec);

  for (let k = 0; k <= nSteps; k++) {
    const t = k * stepSec;
    const now = new Date(start.getTime() + t * 1000);

    // ---- 1. 更新每台望远镜状态与姿态 ----
    for (const rt of tels) {
      const entries = entriesByTel.get(rt.tel.id) ?? [];
      // 当前/下一个条目
      let cur: ScheduleEntry | null = null;
      for (const e of entries) {
        const s = e.startMin * 60, en = s + e.durationMin * 60;
        if (t >= s && t < en) { cur = e; break; }
      }
      if (cur?.id !== rt.entry?.id) {
        // 条目切换: 计算转台
        if (cur) {
          const tgt = eqToAltAz(cur.ra, cur.dec, lat, now, lon);
          const curAlt = rt.pose ? vecToAltAzOf(rt.pose) : { alt: 90, az: 0 };
          const ang = Math.hypot(azDiff(tgt.az, curAlt.az), tgt.alt - curAlt.alt);
          rt.slewRemaining = ang;
          rt.flippedForEntry = false;
          // 起始侧选择: 若目标起始时角已过翻转限, 直接用翻转侧
          rt.side = tgt.ha > rt.tel.flipAngleLimit ? -1 : 1;
        }
        rt.entry = cur;
        rt.entryEnd = cur ? (cur.startMin + cur.durationMin) * 60 : -1;
      }

      if (rt.entry) {
        const e = rt.entry;
        const tgt = eqToAltAz(e.ra, e.dec, lat, now, lon);
        rt.ha = tgt.ha; rt.dec = e.dec;
        const horizon = horizonAlt(plan.horizon, tgt.az);
        const below = tgt.alt < plan.minAltitude || tgt.alt < horizon;

        if (rt.flipping) {
          rt.state = 'flip';
          const blend = Math.min(1, (t - rt.flipT0) / (rt.flipT1 - rt.flipT0));
          rt.pose = mountPose(rt.mp, rt.ha, rt.dec, rt.tel, rt.flipFromSide, blend);
          if (t >= rt.flipT1) {
            rt.flipping = false;
            rt.side = rt.flipFromSide === 1 ? -1 : 1;
            pushEvent(t, {
              type: 'flip-end', telescopeId: rt.tel.id,
              detail: `${rt.tel.name} 中天翻转完成`,
            });
          }
        } else if (rt.slewRemaining > 0.5) {
          rt.state = 'slew';
          rt.slewRemaining = Math.max(0, rt.slewRemaining - rt.tel.slewSpeed * stepSec);
          const rep = repMap.get(e.id)!; rep.slewMin += stepSec / 60;
        } else if (below) {
          rt.state = 'below';
          const rep = repMap.get(e.id)!; rep.belowMin += stepSec / 60;
        } else {
          rt.state = 'track';
        }

        // 中天翻转触发 (gem, 跟踪中, 时角超限)
        const flipAt = rt.tel.flipAngleLimit + (opts.flipTimeOffsetMin ?? 0) * (15 / 60) * 60 / 60;
        if (rt.tel.mountType === 'gem' && !rt.flipping && !rt.flippedForEntry &&
            rt.state === 'track' && rt.side === 1 && rt.ha > flipAt) {
          rt.flipping = true;
          rt.flipFromSide = rt.side;
          rt.flipT0 = t;
          rt.flipT1 = t + rt.tel.flipDuration;
          rt.flippedForEntry = true;
          pushEvent(t, {
            type: 'flip-start', telescopeId: rt.tel.id,
            detail: `${rt.tel.name} 时角 ${rt.ha.toFixed(1)}° 超过翻转限 ${flipAt.toFixed(1)}°, 开始中天翻转 (预计 ${rt.tel.flipDuration}s)`,
          });
        }

        if (!rt.flipping && rt.state !== 'flip') {
          rt.pose = mountPose(rt.mp, rt.ha, rt.dec, rt.tel, rt.side);
        }
        if (rt.state === 'flip') {
          const rep = repMap.get(e.id)!; rep.flipWaitMin += stepSec / 60;
        }
      } else {
        rt.state = 'idle';
        // 停泊: 镜筒指天顶附近 (ha=0, dec=lat)
        rt.pose = mountPose(rt.mp, PARK_HA, lat, rt.tel, 1);
      }
    }

    // ---- 2. 圆顶伺服 (1s 子步) ----
    // 决定每个圆顶跟随哪台望远镜
    const domeTargets = new Map<string, { az: number; telId: string; exitZ: number }>();
    for (const rt of tels) {
      if (!rt.pose || (rt.state !== 'track' && rt.state !== 'slew' && rt.state !== 'flip' && rt.state !== 'below')) continue;
      const dg = domeGeom(domeMap.get(rt.tel.domeId)!);
      const sol = solveDomeAz(rt.pose.aperture, rt.pose.dir, dg);
      if (!sol) continue;
      const existing = domeTargets.get(rt.tel.domeId);
      if (!existing) {
        domeTargets.set(rt.tel.domeId, { az: sol.az, telId: rt.tel.id, exitZ: sol.exit.z });
      } else {
        // 同圆顶第二台也要观测 -> 冲突
        const dAz = Math.abs(azDiff(sol.az, existing.az));
        const half = slitHalfAngleAt(dg, sol.exit.z, existing.az);
        if (dAz > half) {
          const dr = domeRt.get(rt.tel.domeId)!;
          if (!dr.conflictActive) {
            dr.conflictActive = true;
            const compromise = existing.az + azDiff(sol.az, existing.az) / 2;
            pushEvent(t, {
              type: 'conflict', telescopeId: rt.tel.id,
              detail: `圆顶冲突: ${telMap.get(existing.telId)!.name} 需要方位 ${existing.az.toFixed(1)}°, ` +
                `${rt.tel.name} 需要 ${sol.az.toFixed(1)}° (狭缝半宽 ${half.toFixed(1)}°)。` +
                (dAz < half * 2
                  ? `建议折中方位 ${((compromise + 360) % 360).toFixed(1)}° 或调整目标顺序`
                  : `方位差 ${dAz.toFixed(1)}° 超过狭缝宽度, 建议错开观测时段`),
            });
          }
        }
      }
    }
    for (const dr of domeRt.values()) {
      if (!domeTargets.has(dr.dome.id)) dr.conflictActive = false;
    }

    // 伺服积分 + 挡板跟随
    for (const [domeId, dr] of domeRt) {
      const tgt = domeTargets.get(domeId);
      const d = dr.dome;
      const subSteps = stepSec; // 1s 子步
      for (let s = 0; s < subSteps; s++) {
        if (tgt) {
          const err = azDiff(tgt.az, dr.az);
          const vMax = d.slewSpeedMax, a = d.accel;
          // 梯形速度规划 (离散近似)
          const vNeed = Math.sign(err) * Math.min(vMax, Math.abs(err) / 1);
          let dv = vNeed - dr.vel;
          dv = Math.max(-a, Math.min(a, dv));
          dr.vel += dv;
          // 减速约束: 距离内能停下
          const stopDist = dr.vel * dr.vel / (2 * a);
          if (Math.abs(err) < stopDist) dr.vel = Math.sign(err) * Math.max(0, Math.sqrt(2 * a * Math.abs(err)));
          dr.az = (dr.az + dr.vel * 1 + 360) % 360;
        } else {
          dr.vel = 0;
        }
        // 挡板: 跟随穿出点高度 ±0.4m 余量
        if (tgt) {
          const loT = Math.max(d.slitBottomHeight, tgt.exitZ - 0.4);
          const hiT = Math.min(d.wallHeight + d.diameter / 2, tgt.exitZ + 0.4);
          const mv = d.shutterSpeed * 1;
          dr.lowerZ += Math.max(-mv, Math.min(mv, loT - dr.lowerZ));
          dr.upperZ += Math.max(-mv, Math.min(mv, hiT - dr.upperZ));
          dr.lowerZ = Math.min(dr.lowerZ, d.slitBottomHeight + d.lowerShutterMax);
          dr.upperZ = Math.max(dr.upperZ, d.wallHeight + d.diameter / 2 - d.upperShutterMax);
        }
      }
      if (tgt) dr.followTelId = tgt.telId;
    }

    // ---- 3. 遮挡计算 ----
    const telSteps: SimStep['tel'] = [];
    for (const rt of tels) {
      if (!rt.pose) continue;
      const d = domeMap.get(rt.tel.domeId)!;
      const dg = domeGeom(d);
      const dr = domeRt.get(rt.tel.domeId)!;
      const sol = solveDomeAz(rt.pose.aperture, rt.pose.dir, dg);
      const vig = vignetting(
        rt.pose.aperture, rt.pose.dir, rt.tel.dewShieldDiameter / 2,
        dg, dr.az, dr.lowerZ, dr.upperZ
      );
      const altaz = vecToAltAzOf(rt.pose);
      telSteps.push({
        telescopeId: rt.tel.id, state: rt.state,
        alt: altaz.alt, az: altaz.az,
        domeAzTarget: sol ? sol.az : NaN,
        domeAz: dr.az,
        vignetting: vig,
        minClearance: Infinity,
        entryId: rt.entry?.id,
        ha: rt.ha, dec: rt.dec, side: rt.side,
        flipBlend: rt.flipping ? Math.min(1, (t - rt.flipT0) / (rt.flipT1 - rt.flipT0)) : 0,
      });
      if (rt.entry && rt.state === 'track') {
        const rep = repMap.get(rt.entry.id)!;
        if (vig >= VIGNETTE_WARN) rep.vignettedMin += stepSec / 60;
        else rep.effectiveMin += stepSec / 60;
      }
      // 圆顶滞后告警
      if (sol && rt.state === 'track') {
        const lag = Math.abs(azDiff(sol.az, dr.az));
        const half = slitHalfAngleAt(dg, sol.exit.z, dr.az);
        if (lag > half && !dr.conflictActive) {
          const key = `lag:${rt.tel.id}`;
          if (!approachMap.has(key)) {
            const ev: SimEvent = {
              id: `ev${++evSeq}`, t, type: 'dome-lag', telescopeId: rt.tel.id,
              detail: `${rt.tel.name} 圆顶滞后 ${lag.toFixed(1)}° 超过狭缝半宽 ${half.toFixed(1)}°, 目标被狭缝边遮挡`,
            };
            events.push(ev);
            approachMap.set(key, ev);
          }
        } else {
          approachMap.delete(`lag:${rt.tel.id}`);
        }
      }
    }

    // ---- 4. 碰撞检测 ----
    const extra = opts.extraClearance ?? 0;
    const buildCaps = (tel: Telescope, pose: MountPose): Capsule[] => {
      const pad = (opts.extraClearanceTelIds?.includes(tel.id) ? extra : 0);
      const caps: Capsule[] = [
        { a: pose.tubeBack, b: pose.tubeFront, r: tel.tubeDiameter / 2 + pad, label: `${tel.name}:镜筒`, telId: tel.id },
        { a: pose.tubeFront, b: pose.aperture, r: tel.dewShieldDiameter / 2 + pad, label: `${tel.name}:遮光罩`, telId: tel.id },
        { a: pose.center, b: pose.center, r: tel.mountRadius + pad, label: `${tel.name}:本体`, telId: tel.id },
      ];
      if (tel.mountType === 'gem' && tel.counterweightArm > 0) {
        caps.push({ a: pose.center, b: pose.cwEnd, r: tel.counterweightRadius + pad, label: `${tel.name}:配重杆`, telId: tel.id });
      }
      return caps;
    };
    const capsulesByTel = tels.filter(rt => rt.pose).map(rt => ({
      telId: rt.tel.id, capsules: buildCaps(rt.tel, rt.pose!),
    }));

    const buildEnv = (domeId: string): EnvObstacle[] => {
      const d = domeMap.get(domeId)!;
      const env: EnvObstacle[] = [];
      // 圆墙 (薄壁, 地面到狭缝下沿) 和圆顶下沿圆环
      env.push({ kind: 'cylinder', label: `${d.name}:圆墙`, cx: 0, cy: 0, r: d.diameter / 2, z0: 0, z1: d.slitBottomHeight, solid: false });
      env.push({ kind: 'ring', label: `${d.name}:圆顶下沿`, cx: 0, cy: 0, r: d.diameter / 2, z0: d.wallHeight, z1: d.wallHeight });
      // 墩子
      for (const p of d.piers) {
        const telHere = tels.find(rt => rt.tel.domeId === domeId && rt.tel.pierId === p.id);
        env.push({
          kind: 'cylinder', label: `${d.name}:墩子${p.name}${telHere ? ':' + telHere.tel.id : ''}`,
          cx: p.x, cy: p.y, r: p.diameter / 2, z0: 0, z1: p.height,
        });
      }
      return env;
    };

    // 按圆顶分组做检测
    const domeIds = [...new Set(tels.map(rt => rt.tel.domeId))];
    const allHits: import('./collision').ClearanceHit[] = [];
    for (const domeId of domeIds) {
      const group = capsulesByTel.filter(g => tels.find(rt => rt.tel.id === g.telId)!.tel.domeId === domeId);
      allHits.push(...checkClearances(group, buildEnv(domeId)));
    }
    // 翻转期间 5s 子步加密采样: 镜筒/配重杆快速扫过, 30s 主步长会漏掉短暂接近
    for (const rt of tels) {
      if (!rt.flipping || !rt.pose) continue;
      const domeId = rt.tel.domeId;
      const env = buildEnv(domeId);
      const others = capsulesByTel.filter(g =>
        g.telId !== rt.tel.id && tels.find(r => r.tel.id === g.telId)!.tel.domeId === domeId);
      for (let ts = t + 5; ts < Math.min(t + stepSec, rt.flipT1); ts += 5) {
        const blend = Math.min(1, (ts - rt.flipT0) / (rt.flipT1 - rt.flipT0));
        const pose = mountPose(rt.mp, rt.ha, rt.dec, rt.tel, rt.flipFromSide, blend);
        const group = [...others, { telId: rt.tel.id, capsules: buildCaps(rt.tel, pose) }];
        allHits.push(...checkClearances(group, env));
      }
    }
    {
      const hits = allHits;
      // 记录每台望远镜的最小间距
      for (const ts of telSteps) {
        const my = hits.filter(h => h.telId === ts.telescopeId || h.otherTelId === ts.telescopeId);
        if (my.length) ts.minClearance = Math.min(...my.map(h => h.dist));
      }
      // 事件
      for (const h of hits) {
        if (h.dist >= margin) continue;
        const key = `${h.aLabel}|${h.bLabel}`;
        const type = h.dist < 0 ? 'collision' : 'approach';
        const existing = approachMap.get(key);
        if (existing) {
          if (h.dist < (existing.minDist ?? Infinity)) {
            existing.minDist = h.dist;
            existing.t = t;
            existing.type = type;
            existing.detail = `${h.aLabel} ↔ ${h.bLabel}: 最小间距 ${(h.dist * 1000).toFixed(0)}mm` +
              (h.dist < 0 ? ' (已碰撞!)' : '');
          }
        } else {
          const ev: SimEvent = {
            id: `ev${++evSeq}`, t, type,
            telescopeId: h.telId,
            otherLabel: h.bLabel,
            detail: `${h.aLabel} ↔ ${h.bLabel}: 最小间距 ${(h.dist * 1000).toFixed(0)}mm` +
              (h.dist < 0 ? ' (已碰撞!)' : ''),
            minDist: h.dist,
          };
          events.push(ev);
          approachMap.set(key, ev);
        }
      }
      // 离开阈值的 key 清理
      for (const [key, ev] of approachMap) {
        if (key.startsWith('lag:')) continue;
        if (ev.type !== 'approach' && ev.type !== 'collision') continue;
        const still = hits.some(h => `${h.aLabel}|${h.bLabel}` === key && h.dist < margin);
        if (!still) approachMap.delete(key);
      }
    }

    steps.push({
      t,
      domeAz: Object.fromEntries([...domeRt].map(([id, dr]) => [id, dr.az])),
      domeShutters: Object.fromEntries([...domeRt].map(([id, dr]) => [id, [dr.lowerZ, dr.upperZ]])),
      tel: telSteps,
    });
  }

  return {
    id: `sim_${Date.now()}`,
    planId: plan.id,
    createdAt: new Date().toISOString(),
    stepSec, durationSec,
    steps, events,
    report: [...repMap.values()],
  };
}

function vecToAltAzOf(pose: MountPose): { alt: number; az: number } {
  const n = V.norm(pose.dir);
  const alt = Math.asin(Math.max(-1, Math.min(1, n.z))) / D2R;
  let az = Math.atan2(n.x, n.y) / D2R;
  if (az < 0) az += 360;
  return { alt, az };
}
