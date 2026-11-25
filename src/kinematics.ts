// ---------- 望远镜运动学 + 圆顶穿出点几何解 ----------
// 坐标系: x=东, y=北, z=天顶 (m); 圆顶中心在 (0,0,wallHeight)

import { DomeProfile, MountType, Telescope, Vec3 } from './types';
import { D2R, R2D, eqToAltAz } from './astro';

export const V = {
  add: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
  }),
  len: (a: Vec3): number => Math.hypot(a.x, a.y, a.z),
  norm: (a: Vec3): Vec3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; },
  dist: (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
};

/** 绕单位轴 k 旋转向量 v, 角度 ang (弧度, 右手定则) — Rodrigues 公式 */
export function rotate(v: Vec3, k: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  const kv = V.dot(k, v);
  const cx = V.cross(k, v);
  return {
    x: v.x * c + cx.x * s + k.x * kv * (1 - c),
    y: v.y * c + cx.y * s + k.y * kv * (1 - c),
    z: v.z * c + cx.z * s + k.z * kv * (1 - c),
  };
}

/** 高度角/方位角 -> 单位向量 (az 自北向东, deg) */
export function altAzToVec(altDeg: number, azDeg: number): Vec3 {
  const a = altDeg * D2R, z = azDeg * D2R;
  return { x: Math.cos(a) * Math.sin(z), y: Math.cos(a) * Math.cos(z), z: Math.sin(a) };
}

/** 单位向量 -> {alt, az} (deg) */
export function vecToAltAz(v: Vec3): { alt: number; az: number } {
  const n = V.norm(v);
  const alt = Math.asin(Math.max(-1, Math.min(1, n.z))) * R2D;
  let az = Math.atan2(n.x, n.y) * R2D;
  if (az < 0) az += 360;
  return { alt, az };
}

/** 天极方向 (北天极) */
export function poleVec(latDeg: number): Vec3 {
  return altAzToVec(latDeg, 0);
}

export interface MountPose {
  /** 光轴上一点 (镜筒中点) */
  axisPoint: Vec3;
  /** 光轴方向 (指向目标) */
  dir: Vec3;
  /** 入光口(遮光罩前端)位置 */
  aperture: Vec3;
  /** 镜筒后端 */
  tubeBack: Vec3;
  /** 镜筒前端(镜筒口, 不含遮光罩) */
  tubeFront: Vec3;
  /** 轴交点 (赤经轴/赤纬轴交点 或 方位/高度轴交点) */
  center: Vec3;
  /** 配重杆末端 (gem, 否则等于 center) */
  cwEnd: Vec3;
  /** 墩顶 */
  pierTop: Vec3;
  /** 翻转侧: +1 正常, -1 翻转后 */
  side: 1 | -1;
}

export interface MountParams {
  type: MountType;
  lat: number;             // 站点纬度
  pierPos: Vec3;           // 墩顶位置 (世界系)
  mountHeadHeight: number;
  decOffset: number;
  counterweightArm: number;
}

/**
 * 由目标 (ha, dec) 或 (alt, az) 求赤道仪姿态。
 * side: 中天翻转侧 (仅 gem 有意义)。
 * 对 gem/fork 传入 ha/dec; 对 altaz 传入目标的 alt/az (经 ha/dec 换算得到)。
 */
export function mountPose(
  mp: MountParams,
  haDeg: number, decDeg: number,
  tel: Pick<Telescope, 'tubeLength' | 'dewShieldLength'>,
  side: 1 | -1 = 1,
  // 翻转过程插值: 0..1, 用于模拟翻转中间姿态 (从 side=+1 扫到 -1)
  flipBlend?: number
): MountPose {
  const p = poleVec(mp.lat);
  let center: Vec3, dir: Vec3, cwEnd: Vec3, offDir: Vec3;

  if (mp.type === 'altaz') {
    // 地平式: 方位轴竖直, 高度轴水平
    dir = eqVec(mp.lat, haDeg, decDeg);
    center = V.add(mp.pierPos, { x: 0, y: 0, z: mp.mountHeadHeight });
    cwEnd = center;
    const azEl = vecToAltAz(dir);
    const altAxis = altAzToVec(0, azEl.az + 90);
    offDir = orthComp(dir, altAxis);
  } else {
    // 德式/叉式: 极轴指向北天极。
    // 赤纬轴 d = 绕极轴把"东"转 -H (时角向西为正);
    // 翻转侧: 赤经轴再转 180°, 赤纬角取反, 光轴方向不变, 镜筒落到本体另一侧。
    const H = haDeg * D2R;
    const rho0 = (90 - decDeg) * D2R;
    let theta: number, rho: number;
    if (flipBlend !== undefined && flipBlend > 0 && flipBlend < 1) {
      theta = -H + Math.PI * flipBlend;
      rho = rho0 * (1 - 2 * flipBlend);
    } else {
      theta = -H + (side === -1 ? Math.PI : 0);
      rho = side === -1 ? -rho0 : rho0;
    }
    const east: Vec3 = { x: 1, y: 0, z: 0 };
    const d = rotate(east, p, theta);   // 赤纬轴方向
    dir = rotate(p, d, rho);            // 光轴方向 (恒等于目标方向)
    center = V.add(mp.pierPos, V.scale(p, mp.mountHeadHeight));
    // 镜筒偏置方向: 垂直于赤纬轴与光轴, 指向镜筒所在侧 (翻转后变号)
    offDir = V.norm(V.cross(d, dir));
    // 配重在镜筒对侧
    cwEnd = V.add(center, V.scale(offDir, -(mp.counterweightArm || 0)));
  }

  const axisPoint = V.add(center, V.scale(offDir, mp.decOffset));
  const halfTube = tel.tubeLength / 2;
  const aperture = V.add(axisPoint, V.scale(dir, halfTube + tel.dewShieldLength));
  const tubeFront = V.add(axisPoint, V.scale(dir, halfTube));
  const tubeBack = V.add(axisPoint, V.scale(dir, -halfTube));

  return { axisPoint, dir, aperture, tubeBack, tubeFront, center, cwEnd, pierTop: mp.pierPos, side };
}

/** v 垂直于轴 k 的分量 (单位化) */
function orthComp(v: Vec3, k: Vec3): Vec3 {
  const c = V.sub(v, V.scale(k, V.dot(v, k)));
  const l = V.len(c);
  if (l < 1e-9) {
    // v 与 k 平行: 任取垂直方向
    const alt = Math.abs(k.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    return V.norm(V.cross(k, alt));
  }
  return V.scale(c, 1 / l);
}

/** 由纬度/时角/赤纬直接构造指向向量 (与 eqToAltAz 一致) */
export function eqVec(latDeg: number, haDeg: number, decDeg: number): Vec3 {
  // 在 (东,北,天) 系中: 先构造赤道系向量再旋转
  const H = haDeg * D2R, d = decDeg * D2R, p = latDeg * D2R;
  // 时角系: x' 向西, y' 向南... 直接用标准公式
  const alt = Math.asin(Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(p) * Math.cos(H));
  const cosA = (Math.sin(d) - Math.sin(alt) * Math.sin(p)) / (Math.cos(alt) * Math.cos(p));
  let az = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (Math.sin(H) > 0) az = 2 * Math.PI - az;
  return altAzToVec(alt * R2D, az * R2D);
}

// ---------- 圆顶几何 ----------

export interface DomeGeom {
  center: Vec3;   // 球心
  radius: number;
  wallTop: number;     // 球心高度 = wallHeight
  slitWidth: number;
  slitBottomZ: number; // 狭缝下沿高度
  lowerShutterMax: number;
  upperShutterMax: number;
}

export function domeGeom(d: DomeProfile): DomeGeom {
  return {
    center: { x: 0, y: 0, z: d.wallHeight },
    radius: d.diameter / 2,
    wallTop: d.wallHeight,
    slitWidth: d.slitWidth,
    slitBottomZ: d.slitBottomHeight,
    lowerShutterMax: d.lowerShutterMax,
    upperShutterMax: d.upperShutterMax,
  };
}

/**
 * 光轴穿出穹顶的几何解:
 * 从 aperture 沿 dir 的射线与球面的远交点 E, 圆顶方位 = atan2(E.x, E.y)。
 * 返回 null 表示光轴水平或向下 (无法穿出)。
 */
export function solveDomeAz(
  aperture: Vec3, dir: Vec3, dg: DomeGeom
): { az: number; exit: Vec3 } | null {
  const oc = V.sub(aperture, dg.center);
  const b = V.dot(oc, dir);
  const c = V.dot(oc, oc) - dg.radius * dg.radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  // 远交点 (沿 dir 方向较大的 lambda)
  const lam = -b + sq;
  if (lam <= 0) return null;
  const E = V.add(aperture, V.scale(dir, lam));
  if (E.z < dg.slitBottomZ - 1e-9) return null; // 穿出点在狭缝以下(被墙挡)
  let az = Math.atan2(E.x, E.y) * R2D;
  if (az < 0) az += 360;
  return { az, exit: E };
}

/**
 * 狭缝开口模型: 判断从球内一点沿某方向穿出球面的点是否落在开口内。
 * 开口 = 狭缝带(垂直平面板, 半宽 slitWidth/2, 法向垂直于圆顶方位) ∩
 *        下挡板以上 ∩ 上挡板以下。
 * lowerZ/upperZ: 当前挡板位置 (离地高度)。
 */
export function exitInSlit(
  aperture: Vec3, dir: Vec3, dg: DomeGeom,
  domeAzDeg: number, lowerZ: number, upperZ: number
): boolean {
  const oc = V.sub(aperture, dg.center);
  const b = V.dot(oc, dir);
  const c = V.dot(oc, oc) - dg.radius * dg.radius;
  const disc = b * b - c;
  if (disc < 0) return false;
  const lam = -b + Math.sqrt(disc);
  if (lam <= 0) return false;
  const E = V.add(aperture, V.scale(dir, lam));
  if (E.z < dg.slitBottomZ) return false;
  if (E.z < lowerZ || E.z > upperZ) return false;
  // 狭缝带: 到狭缝中心竖直平面的垂直距离 <= slitWidth/2
  const az = domeAzDeg * D2R;
  const n = { x: Math.cos(az), y: -Math.sin(az), z: 0 }; // 狭缝平面法向 (垂直于方位方向)
  const perp = E.x * n.x + E.y * n.y; // 球心在狭缝平面上, 直接投影
  return Math.abs(perp) <= dg.slitWidth / 2 + 1e-9;
}

/** 狭缝开口在球面上对某高度 z 的方位半宽 (deg) */
export function slitHalfAngleAt(dg: DomeGeom, z: number, domeAzDeg: number): number {
  const dz = z - dg.center.z;
  const r = Math.sqrt(Math.max(0, dg.radius * dg.radius - dz * dz));
  if (r < 1e-6) return 0;
  const half = Math.asin(Math.min(1, dg.slitWidth / 2 / r)) * R2D;
  void domeAzDeg;
  return half;
}
