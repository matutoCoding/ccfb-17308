// ---------- 天文坐标换算 ----------
// 约定: 地方坐标系 x=东, y=北, z=天顶; 方位角自北向东量 (deg)

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

/** 儒略日 */
export function julianDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** 格林尼治平恒星时 (deg) */
export function gmst(date: Date): number {
  const jd = julianDate(date);
  const T = (jd - 2451545.0) / 36525;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545) +
    0.000387933 * T * T - (T * T * T) / 38710000;
  g = ((g % 360) + 360) % 360;
  return g;
}

/** 地方平恒星时 (deg), lon 东经为正 */
export function lst(date: Date, lonDeg: number): number {
  return (((gmst(date) + lonDeg) % 360) + 360) % 360;
}

/** 时角 (deg, 向西为正) */
export function hourAngle(date: Date, lonDeg: number, raDeg: number): number {
  let ha = lst(date, lonDeg) - raDeg;
  ha = ((ha % 360) + 360) % 360;
  if (ha > 180) ha -= 360;
  return ha;
}

/** 赤道坐标 -> 地平坐标。返回 {alt, az} (deg), az 自北向东 */
export function eqToAltAz(
  raDeg: number, decDeg: number, latDeg: number, date: Date, lonDeg: number
): { alt: number; az: number; ha: number } {
  const ha = hourAngle(date, lonDeg, raDeg);
  const H = ha * D2R, d = decDeg * D2R, p = latDeg * D2R;
  const sinAlt = Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(p) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  // 方位: 自北向东
  const cosA = (Math.sin(d) - Math.sin(alt) * Math.sin(p)) / (Math.cos(alt) * Math.cos(p));
  let az = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (Math.sin(H) > 0) az = 2 * Math.PI - az;
  return { alt: alt * R2D, az: az * R2D, ha };
}

/** 太阳高度角 (粗略, 用于判断天文夜) */
export function sunAltitude(date: Date, latDeg: number, lonDeg: number): number {
  const jd = julianDate(date);
  const n = jd - 2451545.0;
  const L = ((280.46 + 0.9856474 * n) % 360 + 360) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360 + 360) % 360;
  const lambda = (L + 1.915 * Math.sin(g * D2R) + 0.02 * Math.sin(2 * g * D2R)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) * R2D;
  return eqToAltAz(((ra % 360) + 360) % 360, dec, latDeg, date, lonDeg).alt;
}

/** 求当晚天文夜区间: 太阳高度 < -18° 的时间段 (相对 nightStart 的秒) */
export function nightWindow(
  dateStr: string, lat: number, lon: number
): { start: Date; end: Date } {
  // 从当地 18:00 扫到次日 10:00 (UTC+8 站点)
  const base = new Date(dateStr + 'T10:00:00Z'); // 18:00 北京时间
  let start: Date | null = null, end: Date | null = null;
  for (let m = 0; m <= 16 * 60; m += 5) {
    const t = new Date(base.getTime() + m * 60000);
    const dark = sunAltitude(t, lat, lon) < -18;
    if (dark && !start) start = t;
    if (!dark && start && !end) { end = t; break; }
  }
  if (!start) start = base;
  if (!end) end = new Date(start.getTime() + 8 * 3600000);
  return { start, end };
}

/** 地形遮挡: 给定方位角, 线性插值地平线高度 */
export function horizonAlt(horizon: { az: number; alt: number }[], azDeg: number): number {
  if (!horizon.length) return 0;
  const pts = [...horizon].sort((a, b) => a.az - b.az);
  const az = ((azDeg % 360) + 360) % 360;
  let i = pts.findIndex(p => p.az > az);
  if (i === -1) i = 0;
  const p2 = pts[i];
  const p1 = pts[(i - 1 + pts.length) % pts.length];
  let span = p2.az - p1.az; if (span <= 0) span += 360;
  let d = az - p1.az; if (d < 0) d += 360;
  return p1.alt + (p2.alt - p1.alt) * (d / span);
}

/** 方位角最短差 (deg, -180..180) */
export function azDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
