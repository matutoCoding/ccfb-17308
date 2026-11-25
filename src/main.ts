// ---------- 应用入口 ----------

import { seedIfEmpty } from './seed';
import { loadAll } from './state';
import { renderDomes } from './pages/domes';
import { renderTelescopes } from './pages/telescopes';
import { renderPlan } from './pages/plan';
import { renderSimulate } from './pages/simulate';
import { renderReview } from './pages/review';

const pages: Record<string, (root: HTMLElement) => Promise<void>> = {
  domes: renderDomes,
  telescopes: renderTelescopes,
  plan: renderPlan,
  simulate: renderSimulate,
  review: renderReview,
};

async function route(): Promise<void> {
  const page = location.hash.replace('#/', '') || 'domes';
  const render = pages[page] ?? renderDomes;
  document.querySelectorAll('nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-page') === (pages[page] ? page : 'domes'));
  });
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  await render(app);
}

async function main(): Promise<void> {
  const seeded = await seedIfEmpty();
  if (seeded) console.log('已生成测试数据: 2 个圆顶, 6 台设备, 1 个计划');
  await loadAll();
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/domes';
  await route();
}

main();
