// ---------- 全局状态 ----------

import { DomeProfile, ObservingPlan, SimResult, Telescope } from './types';
import { dbAll } from './db';

export const state = {
  domes: [] as DomeProfile[],
  telescopes: [] as Telescope[],
  plans: [] as ObservingPlan[],
  sims: [] as SimResult[],
  currentDomeId: null as string | null,
  currentTelId: null as string | null,
  currentPlanId: null as string | null,
  currentSimId: null as string | null,
};

export async function loadAll(): Promise<void> {
  state.domes = await dbAll('domes');
  state.telescopes = await dbAll('telescopes');
  state.plans = await dbAll('plans');
  state.sims = await dbAll('sims');
  state.currentDomeId ??= state.domes[0]?.id ?? null;
  state.currentTelId ??= state.telescopes[0]?.id ?? null;
  state.currentPlanId ??= state.plans[0]?.id ?? null;
  state.currentSimId ??= state.sims[state.sims.length - 1]?.id ?? null;
}

export function currentPlan(): ObservingPlan | undefined {
  return state.plans.find(p => p.id === state.currentPlanId);
}
export function currentSim(): SimResult | undefined {
  return state.sims.find(s => s.id === state.currentSimId);
}
