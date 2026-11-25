// ---------- 小型 DOM 助手 ----------

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), (v as unknown) as EventListener);
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

export function field(label: string, input: HTMLElement): HTMLElement {
  const l = h('label', { class: 'f' });
  l.append(label, input);
  return l;
}

export function numInput(value: number, step = 0.1, width?: number): HTMLInputElement {
  const i = h('input', { type: 'number', step: String(step), value: String(value) });
  if (width) i.style.width = width + 'px';
  return i;
}

export function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function fmtTime(tSec: number): string {
  const hh = Math.floor(tSec / 3600), mm = Math.floor((tSec % 3600) / 60), ss = Math.floor(tSec % 60);
  return `+${hh}h${String(mm).padStart(2, '0')}m${String(ss).padStart(2, '0')}s`;
}

export function download(filename: string, content: string, mime = 'text/plain'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
