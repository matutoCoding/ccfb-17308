// ---------- 基础数据模型 ----------

export interface Vec3 { x: number; y: number; z: number }

export interface PierSlot {
  id: string;
  name: string;
  x: number;          // 相对圆顶中心,东向为 x (m)
  y: number;          // 北向为 y (m)
  height: number;     // 墩子高度 (m)
  diameter: number;   // 墩子直径 (m)
}

export interface DomeProfile {
  id: string;
  name: string;
  diameter: number;        // 球顶直径 (m)
  wallHeight: number;      // 圆墙高度(球心所在高度) (m)
  slitWidth: number;       // 狭缝宽度 (m)
  slitBottomHeight: number;// 狭缝下沿离地高度 (m)
  lowerShutterMax: number; // 下挡板最大行程 (m, 沿狭缝从底向上)
  upperShutterMax: number; // 上挡板最大行程 (m, 沿狭缝从顶向下)
  slewSpeedMax: number;    // 方位转速上限 (deg/s)
  accel: number;           // 方位加减速 (deg/s^2)
  shutterSpeed: number;    // 挡板移动速度 (m/s)
  piers: PierSlot[];
}

export type MountType = 'gem' | 'fork' | 'altaz';

export interface Telescope {
  id: string;
  name: string;
  domeId: string;
  pierId: string;
  mountType: MountType;
  mountHeadHeight: number; // 墩顶沿赤经轴(gem/fork)或竖直方向(altaz)到轴交点 (m)
  decOffset: number;       // 赤经轴到镜筒光轴的偏距 (m)
  tubeLength: number;      // 镜筒长度 (m)
  tubeDiameter: number;    // 镜筒外径 (m)
  dewShieldLength: number; // 遮光罩长度 (m)
  dewShieldDiameter: number;
  counterweightArm: number;    // 配重杆长度 (m, gem)
  counterweightRadius: number; // 配重块半径 (m)
  mountRadius: number;         // 赤道仪本体近似半径 (m)
  flipAngleLimit: number;      // 过中天多少度后触发翻转 (deg, gem)
  flipDuration: number;        // 翻转耗时 (s)
  slewSpeed: number;           // 望远镜转台速度 (deg/s)
}

export interface Site {
  name: string;
  lat: number;       // deg
  lon: number;       // deg, 东经为正
  elevation: number; // m
}

export interface ScheduleEntry {
  id: string;
  telescopeId: string;
  targetName: string;
  ra: number;        // deg, J2000
  dec: number;       // deg, J2000
  startMin: number;  // 相对当晚起始时刻的分钟
  durationMin: number;
}

export interface ObservingPlan {
  id: string;
  name: string;
  date: string;          // 当晚日期 YYYY-MM-DD (指夜晚开始的那天)
  site: Site;
  minAltitude: number;   // 限制高度 (deg)
  horizon: { az: number; alt: number }[]; // 地形遮挡剖面
  entries: ScheduleEntry[];
}

// ---------- 推演结果 ----------

export type TelState = 'track' | 'slew' | 'flip' | 'idle' | 'below' | 'wait-dome';

export interface TelStep {
  telescopeId: string;
  state: TelState;
  alt: number;
  az: number;
  domeAzTarget: number;  // 几何解出的圆顶方位
  domeAz: number;        // 圆顶实际方位
  vignetting: number;    // 0..1 入光口被挡比例
  minClearance: number;  // 本步最小间距 (m), Infinity 表示无接近
  entryId?: string;
  // 回放用: 姿态参数 (由它们可精确重建 MountPose)
  ha: number;
  dec: number;
  side: 1 | -1;
  flipBlend: number;     // 0..1, 仅翻转中介于 0 和 1
}

export interface SimStep {
  t: number;             // 相对夜晚开始的秒
  domeAz: Record<string, number>; // domeId -> az
  domeShutters: Record<string, [number, number]>; // domeId -> [lowerZ, upperZ]
  tel: TelStep[];
}

export interface SimEvent {
  id: string;
  t: number;
  type: 'approach' | 'collision' | 'flip-start' | 'flip-end' | 'conflict' | 'dome-lag';
  telescopeId?: string;
  otherLabel?: string;
  detail: string;
  minDist?: number;
}

export interface TargetReport {
  entryId: string;
  telescopeId: string;
  targetName: string;
  scheduledMin: number;
  effectiveMin: number;   // 遮挡<5% 的时间
  vignettedMin: number;   // 遮挡>=5% 的时间
  flipWaitMin: number;
  slewMin: number;
  belowMin: number;       // 低于限高/地形遮挡
}

export interface SimResult {
  id: string;
  planId: string;
  createdAt: string;
  stepSec: number;
  durationSec: number;
  steps: SimStep[];
  events: SimEvent[];
  report: TargetReport[];
}

export const APPROACH_DIST = 0.05;   // 接近阈值 5cm
export const VIGNETTE_WARN = 0.05;   // 遮挡告警 5%
