// ---------- three.js 三维场景 ----------
// 世界系: x=东, y=北, z=天 (与几何核心一致), 相机 up 设为 +Z

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DomeProfile, Telescope, Vec3 } from './types';
import { MountPose } from './kinematics';

const v3 = (v: Vec3) => new THREE.Vector3(v.x, v.y, v.z);

interface TelMeshes {
  group: THREE.Group;
  tube: THREE.Mesh;
  dew: THREE.Mesh;
  cwRod: THREE.Mesh;
  cwWeight: THREE.Mesh;
  mount: THREE.Mesh;
  raHousing: THREE.Mesh;
  raBaseLen: number;
  cwBaseLen: number;
  mats: THREE.MeshStandardMaterial[];
}

export class Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  domeGroup = new THREE.Group();
  rotating = new THREE.Group(); // 随圆顶方位旋转的部分: 球壳 + 挡板
  telMeshes = new Map<string, TelMeshes>();
  dome: DomeProfile | null = null;
  telescopes: Telescope[] = [];
  tubeCamTelId: string | null = null;
  lastPoses = new Map<string, MountPose>();
  domeAzRad = 0;
  private lowerShutter: THREE.Mesh | null = null;
  private upperShutter: THREE.Mesh | null = null;
  private slitHalfGap = 0.2;
  private disposed = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070d);
    this.camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.05, 2000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(9, -9, 6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 2);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(30, -20, 50);
    this.scene.add(sun);

    // 地面
    const grid = new THREE.GridHelper(40, 40, 0x30363d, 0x1c2129);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(20, 64).rotateX(0),
      new THREE.MeshStandardMaterial({ color: 0x0d1117 })
    );
    this.scene.add(ground);

    // 星空背景
    this.scene.add(this.makeStars());
    this.scene.add(this.domeGroup);
    this.domeGroup.add(this.rotating);

    const onResize = () => {
      const w = container.clientWidth, hgt = container.clientHeight;
      this.renderer.setSize(w, hgt);
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(onResize).observe(container);

    const loop = () => {
      if (this.disposed) return;
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private makeStars(): THREE.Points {
    const n = 3000;
    const pos = new Float32Array(n * 3);
    let seed = 42;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const z = Math.abs(u); // 只画地平线以上
      pos[i * 3] = r * Math.cos(a) * 800;
      pos[i * 3 + 1] = r * Math.sin(a) * 800;
      pos[i * 3 + 2] = z * 800;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaac4e0, size: 1.2, sizeAttenuation: false }));
  }

  /** 重建圆顶与全部望远镜 */
  build(dome: DomeProfile, telescopes: Telescope[]): void {
    this.dome = dome;
    this.telescopes = telescopes;
    this.domeGroup.clear();
    this.rotating.clear();
    this.domeGroup.add(this.rotating);
    this.telMeshes.clear();
    this.lastPoses.clear();

    const R = dome.diameter / 2;
    // 圆墙 (不旋转)
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, dome.slitBottomHeight, 64, 1, true).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x8b949e, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    );
    wall.position.z = dome.slitBottomHeight / 2;
    this.domeGroup.add(wall);

    // 球顶 (狭缝处留缺口, 缺口中心在局部 +X; 随 rotating 组旋转)
    this.slitHalfGap = Math.asin(Math.min(1, dome.slitWidth / 2 / R));
    const domeMat = new THREE.MeshStandardMaterial({
      color: 0x9fb4c8, transparent: true, opacity: 0.28, side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 24, this.slitHalfGap, Math.PI * 2 - 2 * this.slitHalfGap, 0, Math.PI / 2).rotateX(Math.PI / 2),
      domeMat
    );
    shell.position.z = dome.wallHeight;
    this.rotating.add(shell);

    // 挡板: 球面补丁, 几何随位置重建 (见 placeShutters)
    this.lowerShutter = new THREE.Mesh(undefined, new THREE.MeshStandardMaterial({
      color: 0xd2904a, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
    this.upperShutter = new THREE.Mesh(undefined, this.lowerShutter.material);
    this.rotating.add(this.lowerShutter, this.upperShutter);

    // 墩子
    for (const p of dome.piers) {
      const pier = new THREE.Mesh(
        new THREE.CylinderGeometry(p.diameter / 2, p.diameter / 2, p.height, 24).rotateX(Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0x6e7681 })
      );
      pier.position.set(p.x, p.y, p.height / 2);
      this.domeGroup.add(pier);
    }

    // 望远镜
    for (const tel of telescopes) {
      const pier = dome.piers.find(p => p.id === tel.pierId);
      if (!pier) continue;
      const mats = {
        tube: new THREE.MeshStandardMaterial({ color: 0xc9d1d9 }),
        dew: new THREE.MeshStandardMaterial({ color: 0x8b949e, transparent: true, opacity: 0.6 }),
        mount: new THREE.MeshStandardMaterial({ color: 0x4a6fa5 }),
        cw: new THREE.MeshStandardMaterial({ color: 0xb08850 }),
      };
      const g = new THREE.Group();
      const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(tel.tubeDiameter / 2, tel.tubeDiameter / 2, tel.tubeLength, 24).rotateX(Math.PI / 2),
        mats.tube);
      const dew = new THREE.Mesh(
        new THREE.CylinderGeometry(tel.dewShieldDiameter / 2, tel.dewShieldDiameter / 2, tel.dewShieldLength, 24, 1, true).rotateX(Math.PI / 2),
        mats.dew);
      const cwRod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, Math.max(0.01, tel.counterweightArm), 12).rotateX(Math.PI / 2),
        mats.cw);
      const cwWeight = new THREE.Mesh(
        new THREE.CylinderGeometry(tel.counterweightRadius, tel.counterweightRadius, 0.12, 20).rotateX(Math.PI / 2),
        mats.cw);
      const mount = new THREE.Mesh(new THREE.SphereGeometry(tel.mountRadius, 20, 14), mats.mount);
      const raHousing = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.11, Math.max(0.01, tel.mountHeadHeight), 12).rotateX(Math.PI / 2),
        mats.mount);
      g.add(tube, dew, cwRod, cwWeight, mount, raHousing);
      this.domeGroup.add(g);
      this.telMeshes.set(tel.id, {
        group: g, tube, dew, cwRod, cwWeight, mount, raHousing,
        raBaseLen: Math.max(0.01, tel.mountHeadHeight),
        cwBaseLen: Math.max(0.01, tel.counterweightArm),
        mats: [mats.tube, mats.dew, mats.mount, mats.cw],
      });
    }
    this.updateShutters(this.dome.slitBottomHeight, this.dome.wallHeight + R);
  }

  /** 圆顶方位 (deg, 自北向东) */
  setDomeAz(azDeg: number): void {
    this.domeAzRad = (90 - azDeg) * Math.PI / 180;
    this.rotating.rotation.z = this.domeAzRad;
  }

  private lowerZ = 0; private upperZ = 1;
  updateShutters(lowerZ: number, upperZ: number): void {
    // 位置变化超过 1cm 才重建几何
    if (Math.abs(lowerZ - this.lowerZ) > 0.01 || Math.abs(upperZ - this.upperZ) > 0.01) {
      this.lowerZ = lowerZ; this.upperZ = upperZ;
      this.placeShutters();
    }
  }

  private placeShutters(): void {
    if (!this.dome || !this.lowerShutter || !this.upperShutter) return;
    const d = this.dome, R = d.diameter / 2;
    const gap = this.slitHalfGap;
    // 球面补丁: 高度 z0..z1 -> 极角 theta (自天顶)
    const patch = (z0: number, z1: number) => {
      const th1 = Math.acos(Math.max(-1, Math.min(1, (z1 - d.wallHeight) / R)));
      const th0 = Math.acos(Math.max(-1, Math.min(1, (z0 - d.wallHeight) / R)));
      if (th0 - th1 < 0.005) return null;
      return new THREE.SphereGeometry(R + 0.02, 12, 6, -gap, 2 * gap, th1, th0 - th1).rotateX(Math.PI / 2);
    };
    const setGeo = (mesh: THREE.Mesh, z0: number, z1: number) => {
      const g = patch(z0, z1);
      mesh.geometry.dispose?.();
      if (g) { mesh.geometry = g; mesh.visible = true; mesh.position.set(0, 0, d.wallHeight); }
      else mesh.visible = false;
    };
    setGeo(this.lowerShutter, d.slitBottomHeight, Math.max(d.slitBottomHeight + 0.01, this.lowerZ));
    setGeo(this.upperShutter, Math.min(this.upperZ, d.wallHeight + R - 0.01), d.wallHeight + R * 0.98);
  }

  /** 更新一台望远镜姿态 */
  updateTelescope(telId: string, pose: MountPose): void {
    const m = this.telMeshes.get(telId);
    if (!m) return;
    this.lastPoses.set(telId, pose);
    const dir = v3(pose.dir);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);

    const mid = v3(pose.axisPoint);
    m.tube.position.copy(mid);
    m.tube.quaternion.copy(q);

    const dewMid = v3(pose.tubeFront).add(v3(pose.aperture)).multiplyScalar(0.5);
    m.dew.position.copy(dewMid);
    m.dew.quaternion.copy(q);

    m.mount.position.copy(v3(pose.center));

    // RA 轴套筒: pierTop -> center
    const pt = v3(pose.pierTop), c = v3(pose.center);
    const raDir = c.clone().sub(pt);
    const raLen = raDir.length();
    if (raLen > 1e-6) {
      m.raHousing.position.copy(pt.clone().add(c).multiplyScalar(0.5));
      m.raHousing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), raDir.normalize());
      m.raHousing.scale.z = raLen / m.raBaseLen;
    }

    // 配重杆
    const cw = v3(pose.cwEnd);
    const cwDir = cw.clone().sub(c);
    const cwLen = cwDir.length();
    m.cwRod.visible = cwLen > 0.01;
    m.cwWeight.visible = cwLen > 0.01;
    if (cwLen > 0.01) {
      m.cwRod.position.copy(c.clone().add(cw).multiplyScalar(0.5));
      m.cwRod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cwDir.clone().normalize());
      m.cwWeight.position.copy(cw);
      m.cwWeight.quaternion.copy(m.cwRod.quaternion);
    }

    // 镜筒视角相机跟随
    if (this.tubeCamTelId === telId) {
      const ap = v3(pose.aperture);
      this.camera.position.copy(ap);
      this.camera.lookAt(ap.clone().add(dir.multiplyScalar(10)));
    }
  }

  /** 相机模式: 外部环绕 / 镜筒视角 */
  setCameraMode(mode: 'orbit' | 'tube', telId?: string): void {
    if (mode === 'tube' && telId) {
      this.tubeCamTelId = telId;
      this.controls.enabled = false;
      const pose = this.lastPoses.get(telId);
      if (pose) this.updateTelescope(telId, pose);
    } else {
      this.tubeCamTelId = null;
      this.controls.enabled = true;
      const R = this.dome ? this.dome.diameter : 5;
      this.camera.position.set(R * 1.8, -R * 1.8, R * 1.3);
      this.controls.target.set(0, 0, this.dome ? this.dome.wallHeight * 0.8 : 1.5);
    }
  }

  /** 高亮某台望远镜 (碰撞闪烁) */
  highlight(telId: string | null, color = 0xf85149): void {
    for (const [id, m] of this.telMeshes) {
      for (const mat of m.mats) {
        mat.emissive = new THREE.Color(id === telId ? color : 0x000000);
        mat.emissiveIntensity = id === telId ? 0.55 : 0;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}
