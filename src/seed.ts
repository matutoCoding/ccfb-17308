// ---------- 测试数据: 冷湖站点, 2 个圆顶, 6 台设备 (含一套故意会撞的配置) ----------

import { DomeProfile, ObservingPlan, Telescope } from './types';
import { dbAll, dbPut } from './db';

export const LENGHU = { name: '冷湖赛什腾山', lat: 38.6067, lon: 93.8961, elevation: 4200 };

export function makeTestData(): { domes: DomeProfile[]; telescopes: Telescope[]; plan: ObservingPlan } {
  const domes: DomeProfile[] = [
    {
      id: 'domeA', name: '圆顶A (5m)',
      diameter: 5, wallHeight: 2.2, slitWidth: 1.1,
      slitBottomHeight: 1.2, lowerShutterMax: 1.0, upperShutterMax: 2.2,
      slewSpeedMax: 3, accel: 0.6, shutterSpeed: 0.05,
      piers: [
        { id: 'pa1', name: 'P1', x: -1.2, y: 0.4, height: 1.1, diameter: 0.5 },
        { id: 'pa2', name: 'P2', x: 1.2, y: -0.5, height: 1.1, diameter: 0.5 },
        { id: 'pa3', name: 'P3', x: 0.2, y: 1.3, height: 0.9, diameter: 0.4 },
      ],
    },
    {
      id: 'domeB', name: '圆顶B (4m)',
      diameter: 4, wallHeight: 2.0, slitWidth: 0.9,
      slitBottomHeight: 1.1, lowerShutterMax: 0.9, upperShutterMax: 2.0,
      slewSpeedMax: 2, accel: 0.4, shutterSpeed: 0.04,
      piers: [
        { id: 'pb1', name: 'P1', x: -0.7, y: 0.6, height: 1.0, diameter: 0.45 },
        { id: 'pb2', name: 'P2', x: 0.7, y: -0.7, height: 1.0, diameter: 0.45 },
        { id: 'pb3', name: 'P3', x: 0.9, y: 0.8, height: 0.8, diameter: 0.35 },
      ],
    },
  ];

  const telescopes: Telescope[] = [
    {
      // 精度验证用: 偏心 0.5m 德式赤道仪, 放在半径 2.5m 圆顶里
      id: 'tel1', name: 'GEM-50 (偏心0.5m)', domeId: 'domeA', pierId: 'pa1',
      mountType: 'gem', mountHeadHeight: 0.45, decOffset: 0.5,
      tubeLength: 1.4, tubeDiameter: 0.30, dewShieldLength: 0.4, dewShieldDiameter: 0.34,
      counterweightArm: 0.8, counterweightRadius: 0.12, mountRadius: 0.25,
      flipAngleLimit: 5, flipDuration: 150, slewSpeed: 3,
    },
    {
      id: 'tel2', name: 'Fork-40 (叉式)', domeId: 'domeA', pierId: 'pa2',
      mountType: 'fork', mountHeadHeight: 0.5, decOffset: 0.15,
      tubeLength: 1.1, tubeDiameter: 0.42, dewShieldLength: 0.35, dewShieldDiameter: 0.44,
      counterweightArm: 0, counterweightRadius: 0, mountRadius: 0.3,
      flipAngleLimit: 90, flipDuration: 0, slewSpeed: 4,
    },
    {
      id: 'tel3', name: 'AZ-60 (地平式)', domeId: 'domeA', pierId: 'pa3',
      mountType: 'altaz', mountHeadHeight: 0.7, decOffset: 0.2,
      tubeLength: 1.6, tubeDiameter: 0.62, dewShieldLength: 0.5, dewShieldDiameter: 0.64,
      counterweightArm: 0, counterweightRadius: 0, mountRadius: 0.35,
      flipAngleLimit: 90, flipDuration: 0, slewSpeed: 5,
    },
    {
      id: 'tel4', name: 'GEM-35B', domeId: 'domeB', pierId: 'pb1',
      mountType: 'gem', mountHeadHeight: 0.4, decOffset: 0.35,
      tubeLength: 1.2, tubeDiameter: 0.36, dewShieldLength: 0.4, dewShieldDiameter: 0.38,
      counterweightArm: 0.7, counterweightRadius: 0.11, mountRadius: 0.22,
      flipAngleLimit: 8, flipDuration: 120, slewSpeed: 3,
    },
    {
      // 故意会撞的配置: 长镜筒 + 长配重杆 + 矮墩子, 墩位靠近圆顶边缘和另一台设备,
      // 中天翻转时镜筒扫过圆顶下沿, 配重杆扫向隔壁墩子
      id: 'tel5', name: 'GEM-长筒 (危险配置)', domeId: 'domeB', pierId: 'pb2',
      mountType: 'gem', mountHeadHeight: 0.55, decOffset: 0.45,
      tubeLength: 2.1, tubeDiameter: 0.40, dewShieldLength: 0.5, dewShieldDiameter: 0.44,
      counterweightArm: 1.1, counterweightRadius: 0.14, mountRadius: 0.25,
      flipAngleLimit: 3, flipDuration: 180, slewSpeed: 2.5,
    },
    {
      id: 'tel6', name: 'Fork-25B', domeId: 'domeB', pierId: 'pb3',
      mountType: 'fork', mountHeadHeight: 0.45, decOffset: 0.12,
      tubeLength: 0.8, tubeDiameter: 0.27, dewShieldLength: 0.25, dewShieldDiameter: 0.29,
      counterweightArm: 0, counterweightRadius: 0, mountRadius: 0.2,
      flipAngleLimit: 90, flipDuration: 0, slewSpeed: 4,
    },
  ];
  // tel6 (Fork-25B) 在 domeB pb3 墩, 测试计划里不排目标, 仅作档案演示。

  const plan: ObservingPlan = {
    id: 'plan1',
    name: '11月26日夜 测试计划',
    date: '2026-11-26',
    site: LENGHU,
    minAltitude: 25,
    horizon: [
      { az: 0, alt: 4 }, { az: 60, alt: 6 }, { az: 120, alt: 14 },
      { az: 160, alt: 12 }, { az: 200, alt: 5 }, { az: 260, alt: 7 },
      { az: 300, alt: 10 }, { az: 340, alt: 5 },
    ],
    entries: [
      // tel1: 两个目标, 第二个会触发中天翻转
      { id: 'e1', telescopeId: 'tel1', targetName: 'M31', ra: 10.68, dec: 41.27, startMin: 10, durationMin: 120 },
      { id: 'e2', telescopeId: 'tel1', targetName: 'NGC253', ra: 11.89, dec: -25.29, startMin: 150, durationMin: 150 },
      // tel2: 与 tel1 同时段不同方位 -> 圆顶冲突
      { id: 'e3', telescopeId: 'tel2', targetName: 'M33', ra: 23.46, dec: 30.66, startMin: 30, durationMin: 180 },
      // tel3: 地平式, 整晚两个目标
      { id: 'e4', telescopeId: 'tel3', targetName: 'M45', ra: 56.75, dec: 24.12, startMin: 60, durationMin: 240 },
      // tel4: 圆顶B 正常观测
      { id: 'e5', telescopeId: 'tel4', targetName: 'NGC2244', ra: 98.0, dec: 4.9, startMin: 120, durationMin: 200 },
      // tel5: 危险配置, 目标赤纬高, 跟踪过中天必然翻转 -> 撞圆顶下沿/隔壁
      { id: 'e6', telescopeId: 'tel5', targetName: 'Polaris-邻近', ra: 37.95, dec: 55.0, startMin: 20, durationMin: 260 },
    ],
  };

  return { domes, telescopes, plan };
}

export async function seedIfEmpty(): Promise<boolean> {
  const existing = await dbAll('domes');
  if (existing.length) return false;
  const { domes, telescopes, plan } = makeTestData();
  for (const d of domes) await dbPut('domes', d);
  for (const t of telescopes) await dbPut('telescopes', t);
  await dbPut('plans', plan);
  return true;
}

export async function reseed(): Promise<void> {
  const { domes, telescopes, plan } = makeTestData();
  for (const d of domes) await dbPut('domes', d);
  for (const t of telescopes) await dbPut('telescopes', t);
  await dbPut('plans', plan);
}
