// ---------- 入光口遮挡计算 ----------
// 在入光口圆盘上取采样点, 每个采样点沿光轴方向发出平行射线,
// 检查穿出穹顶处是否落在狭缝开口内; 被挡比例 = 被挡采样数 / 总数。

import { Vec3 } from './types';
import { DomeGeom, V, exitInSlit } from './kinematics';

/** 圆盘均匀采样 (向日葵螺旋), 返回相对圆盘中心的 (u,v) 偏移, 半径归一 */
export function discSamples(n: number): [number, number][] {
  const pts: [number, number][] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * ga;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

const SAMPLES = discSamples(37);

/**
 * 计算入光口被狭缝边和挡板遮挡的比例。
 * @param aperture 入光口中心 (世界系)
 * @param dir      光轴方向
 * @param apertureRadius 入光口半径 (遮光罩内径)
 * @param domeAzDeg 圆顶实际方位
 * @param lowerZ/upperZ 挡板当前位置 (离地高度)
 */
export function vignetting(
  aperture: Vec3, dir: Vec3, apertureRadius: number,
  dg: DomeGeom, domeAzDeg: number, lowerZ: number, upperZ: number
): number {
  // 圆盘局部基: u,v 垂直于 dir
  const ref = Math.abs(dir.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = V.norm(V.cross(dir, ref));
  const v = V.cross(dir, u);
  let blocked = 0;
  for (const [su, sv] of SAMPLES) {
    const p: Vec3 = V.add(aperture,
      V.add(V.scale(u, su * apertureRadius), V.scale(v, sv * apertureRadius)));
    if (!exitInSlit(p, dir, dg, domeAzDeg, lowerZ, upperZ)) blocked++;
  }
  return blocked / SAMPLES.length;
}
