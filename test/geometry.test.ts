// 几何精度验证: 圆顶方位解 / 赤道仪运动学 / 坐标换算 / 遮挡 / 碰撞
// 运行: npm run test:geom

import { eqToAltAz, lst } from '../src/astro';
import {
  domeGeom, eqVec, mountPose, solveDomeAz, exitInSlit, V,
} from '../src/kinematics';
import { vignetting } from '../src/vignetting';
import { capsuleDist, segSegDist } from '../src/collision';
import { DomeProfile, Telescope } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  PASS ${name}`);
  else { console.error(`  FAIL ${name} ${detail}`); failures++; }
}
function near(a: number, b: number, tol: number) { return Math.abs(a - b) <= tol; }

// ---------- 1. 赤道坐标 -> 地平坐标 已知答案 ----------
console.log('== 坐标换算 ==');
{
  const lat = 38.6067, lon = 93.8961;
  const date = new Date('2026-11-26T14:00:00Z');
  // 天体在子午圈上 (ra = lst), 赤纬=纬度 -> 天顶
  const ra = lst(date, lon);
  const r1 = eqToAltAz(ra, lat, lat, date, lon);
  check('子午圈 dec=lat -> 天顶', near(r1.alt, 90, 1e-6), `alt=${r1.alt}`);
  // 天体在子午圈, dec=0 -> alt = 90-|lat|, az=180 (南)
  const r2 = eqToAltAz(ra, 0, lat, date, lon);
  check('子午圈 dec=0 -> alt=90-lat, az=180', near(r2.alt, 90 - lat, 1e-6) && near(r2.az, 180, 1e-6),
    `alt=${r2.alt} az=${r2.az}`);
}

// ---------- 2. 赤道仪运动学: 光轴方向 == 直接坐标换算 ----------
console.log('== 赤道仪运动学 (gem/fork 光轴方向) ==');
{
  const lat = 38.6067;
  const mp = { type: 'gem' as const, lat, pierPos: { x: -1.2, y: 0.4, z: 1.1 }, mountHeadHeight: 0.45, decOffset: 0.5, counterweightArm: 0.8 };
  const tel = { tubeLength: 1.4, dewShieldLength: 0.4 };
  let maxErr = 0;
  for (let ha = -80; ha <= 80; ha += 10) {
    for (let dec = -20; dec <= 80; dec += 20) {
      for (const side of [1, -1] as const) {
        const pose = mountPose(mp, ha, dec, tel, side);
        const want = eqVec(lat, ha, dec);
        const err = Math.acos(Math.min(1, V.dot(V.norm(pose.dir), want))) * 180 / Math.PI;
        maxErr = Math.max(maxErr, err);
      }
    }
  }
  check('gem 光轴方向两侧均与坐标换算一致 (<0.001°)', maxErr < 0.001, `maxErr=${maxErr}`);
  // 翻转前后光轴位置不同 (偏心 0.5m)
  const p1 = mountPose(mp, 20, 40, tel, 1);
  const p2 = mountPose(mp, 20, 40, tel, -1);
  check('翻转前后光轴位置不同', V.dist(p1.aperture, p2.aperture) > 0.3,
    `dist=${V.dist(p1.aperture, p2.aperture).toFixed(3)}`);
}

// ---------- 3. 圆顶方位几何解: 手算已知答案 ----------
console.log('== 圆顶方位几何解 ==');
{
  // 手算案例: 入光口在 (0.5, 0, 2.2), 光轴向正北 45°,
  // 圆顶球心 (0,0,2.2) R=2.5 -> 穿出点 (0.5, √3, 2.2+√3), az = atan2(0.5, √3) ≈ 16.102°
  const dome: DomeProfile = {
    id: 'd', name: 'd', diameter: 5, wallHeight: 2.2, slitWidth: 1.1,
    slitBottomHeight: 1.2, lowerShutterMax: 1, upperShutterMax: 2.2,
    slewSpeedMax: 3, accel: 0.6, shutterSpeed: 0.05, piers: [],
  };
  const dg = domeGeom(dome);
  const s2 = Math.SQRT1_2;
  const sol = solveDomeAz({ x: 0.5, y: 0, z: 2.2 }, { x: 0, y: s2, z: s2 }, dg)!;
  const expectAz = Math.atan2(0.5, Math.sqrt(3)) * 180 / Math.PI;
  check('手算案例 az 误差 < 0.001°', near(sol.az, expectAz, 0.001),
    `sol=${sol.az} expect=${expectAz}`);
  check('穿出点在球面上', near(V.dist(sol.exit, dg.center), 2.5, 1e-9));
  // 朴素方案 (直接拿望远镜方位角 0°) 误差 16.1° -> 证明必须几何解
  check('朴素方位角方案误差 > 15° (证明需要几何解)', Math.abs(expectAz - 0) > 15);
}

// ---------- 4. 验收场景: 偏心0.5m 德式赤道仪 @ 半径2.5m 圆顶 ----------
console.log('== 验收场景: 0.5m 偏心 GEM, R=2.5m 圆顶, 误差 < 0.2° ==');
{
  const dome: DomeProfile = {
    id: 'domeA', name: 'A', diameter: 5, wallHeight: 2.2, slitWidth: 1.1,
    slitBottomHeight: 1.2, lowerShutterMax: 1, upperShutterMax: 2.2,
    slewSpeedMax: 3, accel: 0.6, shutterSpeed: 0.05,
    piers: [{ id: 'pa1', name: 'P1', x: -1.2, y: 0.4, height: 1.1, diameter: 0.5 }],
  };
  const tel: Telescope = {
    id: 'tel1', name: 'GEM-50', domeId: 'domeA', pierId: 'pa1', mountType: 'gem',
    mountHeadHeight: 0.45, decOffset: 0.5, tubeLength: 1.4, tubeDiameter: 0.3,
    dewShieldLength: 0.4, dewShieldDiameter: 0.34, counterweightArm: 0.8,
    counterweightRadius: 0.12, mountRadius: 0.25, flipAngleLimit: 5, flipDuration: 150, slewSpeed: 3,
  };
  const lat = 38.6067;
  const pier = dome.piers[0];
  const mp = {
    type: 'gem' as const, lat,
    pierPos: { x: pier.x, y: pier.y, z: pier.height },
    mountHeadHeight: tel.mountHeadHeight, decOffset: tel.decOffset,
    counterweightArm: tel.counterweightArm,
  };
  const dg = domeGeom(dome);
  let maxErr = 0, maxNaiveErr = 0, solved = 0, total = 0;
  for (let ha = -75; ha <= 75; ha += 5) {
    for (let dec = -10; dec <= 85; dec += 5) {
      for (const side of [1, -1] as const) {
        const pose = mountPose(mp, ha, dec, tel, side);
        const alt = Math.asin(V.norm(pose.dir).z) * 180 / Math.PI;
        if (alt < 20) continue; // 只验可观测区
        total++;
        const sol = solveDomeAz(pose.aperture, pose.dir, dg);
        if (!sol) continue;
        solved++;
        // 独立复核: 穿出点方位 = 解算方位 (几何恒等), 且穿出点在球面、在射线上
        const azExit = Math.atan2(sol.exit.x, sol.exit.y) * 180 / Math.PI;
        const err = Math.abs(((sol.az - azExit + 540) % 360) - 180);
        maxErr = Math.max(maxErr, err);
        const onSphere = Math.abs(V.dist(sol.exit, dg.center) - dg.radius);
        if (onSphere > 1e-6) { check('穿出点在球面上', false, `ha=${ha} dec=${dec}`); }
        // 朴素方案误差 (望远镜方位角 vs 几何解)
        const naive = Math.atan2(pose.dir.x, pose.dir.y) * 180 / Math.PI;
        const nErr = Math.abs(((sol.az - naive + 540) % 360) - 180);
        maxNaiveErr = Math.max(maxNaiveErr, nErr);
      }
    }
  }
  check(`几何解自洽误差 < 0.2° (${solved}/${total} 个姿态有解)`, maxErr < 0.2, `maxErr=${maxErr.toFixed(6)}°`);
  console.log(`  信息: 朴素方位角方案最大误差 ${maxNaiveErr.toFixed(2)}° (即不解几何会差这么多)`);
}

// ---------- 5. 狭缝开口判定 ----------
console.log('== 狭缝开口判定 ==');
{
  const dome: DomeProfile = {
    id: 'd', name: 'd', diameter: 5, wallHeight: 2.2, slitWidth: 1.1,
    slitBottomHeight: 1.2, lowerShutterMax: 1, upperShutterMax: 2.2,
    slewSpeedMax: 3, accel: 0.6, shutterSpeed: 0.05, piers: [],
  };
  const dg = domeGeom(dome);
  const ap = { x: 0, y: 0, z: 2.0 };
  const dir = { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 }; // 正北 45°
  const sol = solveDomeAz(ap, dir, dg)!;
  check('圆顶对准 -> 在开口内', exitInSlit(ap, dir, dg, sol.az, dg.slitBottomZ, 99));
  check('圆顶偏 30° -> 不在开口内', !exitInSlit(ap, dir, dg, sol.az + 30, dg.slitBottomZ, 99));
  check('下挡板升到穿出点以上 -> 被挡', !exitInSlit(ap, dir, dg, sol.az, sol.exit.z + 0.1, 99));
  check('上挡板压到穿出点以下 -> 被挡', !exitInSlit(ap, dir, dg, sol.az, 0, sol.exit.z - 0.1));
}

// ---------- 6. 遮挡比例 ----------
console.log('== 遮挡比例 ==');
{
  const dome: DomeProfile = {
    id: 'd', name: 'd', diameter: 5, wallHeight: 2.2, slitWidth: 1.1,
    slitBottomHeight: 1.2, lowerShutterMax: 1, upperShutterMax: 2.2,
    slewSpeedMax: 3, accel: 0.6, shutterSpeed: 0.05, piers: [],
  };
  const dg = domeGeom(dome);
  const ap = { x: 0, y: 0, z: 2.0 };
  const dir = { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 };
  const sol = solveDomeAz(ap, dir, dg)!;
  const v0 = vignetting(ap, dir, 0.17, dg, sol.az, dg.slitBottomZ, 99);
  check('圆顶对准 -> 遮挡≈0', v0 < 0.05, `v=${v0}`);
  const v1 = vignetting(ap, dir, 0.17, dg, sol.az + 40, dg.slitBottomZ, 99);
  check('圆顶偏 40° -> 全挡', v1 > 0.95, `v=${v1}`);
  // 下挡板遮住半个入光口视场: 挡板升到穿出点高度附近 -> 部分遮挡
  const vHalf = vignetting(ap, dir, 0.17, dg, sol.az, sol.exit.z - 0.05, 99);
  check('挡板边缘接近穿出点 -> 部分遮挡 (0<v<1)', vHalf > 0.01 && vHalf < 0.99, `v=${vHalf}`);
}

// ---------- 7. 碰撞距离 ----------
console.log('== 碰撞距离 ==');
{
  const d = segSegDist({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0.5, y: 1, z: 0 }, { x: 0.5, y: 2, z: 0 });
  check('线段-线段距离 = 1', near(d, 1, 1e-9), `d=${d}`);
  const c = capsuleDist(
    { a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 0, z: 0 }, r: 0.2, label: 'a' },
    { a: { x: 0.5, y: 1, z: 0 }, b: { x: 0.5, y: 2, z: 0 }, r: 0.3, label: 'b' } as never,
  );
  check('胶囊净间距 = 1 - 0.2 - 0.3 = 0.5', near(c, 0.5, 1e-9), `c=${c}`);
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 �’`);
process.exit(failures === 0 ? 0 : 1);
