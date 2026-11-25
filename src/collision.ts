// ---------- 碰撞检测 ----------
// 望远镜部件建模为胶囊体(线段+半径), 环境建模为圆柱(墩子/圆墙)和圆环(圆顶下沿)。
// 胶囊间用线段-线段最近距离解析解; 胶囊对环境用采样点距离。

import { Vec3 } from './types';
import { V } from './kinematics';

export interface Capsule { a: Vec3; b: Vec3; r: number; label: string; telId?: string }

/** 线段-线段最近距离 */
export function segSegDist(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = V.sub(q1, p1), d2 = V.sub(q2, p2), r = V.sub(p1, p2);
  const a = V.dot(d1, d1), e = V.dot(d2, d2), f = V.dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) return V.len(r);
  if (a <= 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = V.dot(d1, r);
    if (e <= 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = V.dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  const c1 = V.add(p1, V.scale(d1, s));
  const c2 = V.add(p2, V.scale(d2, t));
  return V.dist(c1, c2);
}

/** 两胶囊净间距 (表面到表面) */
export function capsuleDist(c1: Capsule, c2: Capsule): number {
  return segSegDist(c1.a, c1.b, c2.a, c2.b) - c1.r - c2.r;
}

/** 点到竖直圆柱的距离。
 *  solid=true (墩子): 实心柱, 内部为负(穿入)。
 *  solid=false (圆墙): 薄壁, 返回 "壁面到点的有向距离", 内侧为正(安全), 穿墙为负。 */
export function pointCylinderDist(
  p: Vec3, cx: number, cy: number, r: number, z0: number, z1: number, solid: boolean
): number {
  const radial = Math.hypot(p.x - cx, p.y - cy);
  if (!solid) {
    if (p.z >= z0 && p.z <= z1) return r - radial; // 壁面内为正
    // 端缘圆环
    const zEdge = p.z < z0 ? z0 : z1;
    return Math.hypot(radial - r, p.z - zEdge);
  }
  const dr = radial - r;
  let dz = 0;
  if (p.z < z0) dz = p.z - z0;
  else if (p.z > z1) dz = p.z - z1;
  if (dr <= 0 && dz === 0) return dr; // 内部(穿入)
  if (dr <= 0) return dz > 0 ? dz : dz; // 正上/下方
  if (dz === 0) return dr;
  return Math.hypot(dr, dz);
}

/** 点到水平圆环 (圆心 (cx,cy,cz), 半径 R) 的距离 */
export function pointRingDist(p: Vec3, cx: number, cy: number, cz: number, R: number): number {
  const dr = Math.hypot(p.x - cx, p.y - cy) - R;
  const dz = p.z - cz;
  return Math.hypot(dr, dz);
}

export interface EnvObstacle {
  kind: 'cylinder' | 'ring';
  label: string;
  cx: number; cy: number;
  r: number; z0: number; z1: number; // cylinder: r, z0..z1; ring: r=R, z0=z1=cz
  solid?: boolean;                   // cylinder: 实心(墩子) 还是薄壁(圆墙)
}

/** 胶囊对环境障碍物的最小净间距 (采样) */
export function capsuleEnvDist(cap: Capsule, obs: EnvObstacle): number {
  const len = V.dist(cap.a, cap.b);
  const n = Math.max(2, Math.ceil(len / 0.02)); // 每 2cm 一个采样点
  let best = Infinity;
  for (let i = 0; i <= n; i++) {
    const p = V.add(cap.a, V.scale(V.sub(cap.b, cap.a), i / n));
    let d: number;
    if (obs.kind === 'cylinder') {
      d = pointCylinderDist(p, obs.cx, obs.cy, obs.r, obs.z0, obs.z1, obs.solid ?? true);
    } else {
      d = pointRingDist(p, obs.cx, obs.cy, obs.z0, obs.r);
    }
    const net = d - cap.r;
    if (net < best) best = net;
  }
  return best;
}

export interface ClearanceHit {
  dist: number;         // 净间距 (m), 负值=穿入
  aLabel: string;
  bLabel: string;
  telId?: string;
  otherTelId?: string;
}

/** 一组望远镜胶囊 vs (彼此 + 环境) 的全量最小间距 */
export function checkClearances(
  capsulesByTel: { telId: string; capsules: Capsule[] }[],
  env: EnvObstacle[]
): ClearanceHit[] {
  const hits: ClearanceHit[] = [];
  // 望远镜 vs 环境
  for (const { telId, capsules } of capsulesByTel) {
    for (const cap of capsules) {
      for (const ob of env) {
        // 跳过望远镜自己的墩子 (它坐在墩子上, 恒为负)
        if (ob.label.endsWith(`:${telId}`)) continue;
        const d = capsuleEnvDist(cap, ob);
        hits.push({ dist: d, aLabel: cap.label, bLabel: ob.label, telId });
      }
    }
  }
  // 望远镜 vs 望远镜
  for (let i = 0; i < capsulesByTel.length; i++) {
    for (let j = i + 1; j < capsulesByTel.length; j++) {
      for (const c1 of capsulesByTel[i].capsules) {
        for (const c2 of capsulesByTel[j].capsules) {
          const d = capsuleDist(c1, c2);
          hits.push({
            dist: d, aLabel: c1.label, bLabel: c2.label,
            telId: capsulesByTel[i].telId, otherTelId: capsulesByTel[j].telId,
          });
        }
      }
    }
  }
  return hits;
}
