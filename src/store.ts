import { configureStore, createSlice, type PayloadAction, type ThunkAction, type ThunkDispatch, type UnknownAction } from '@reduxjs/toolkit';
import type { ChangeRecord, Protest, ProtestStatus, Race, RaceEntry, Role, TimelineEvent } from './types';
import {
  basePenaltyFor,
  changeForProtest,
  guardArrival,
  guardBasePenalty,
  guardConfirm,
  guardProtestDecision,
  guardProtestSubmission,
  guardPublish,
  guardRaceControl,
  latestPublication,
  type GuardCtx
} from './domain';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  changes: ChangeRecord[];
  timeline: TimelineEvent[];
  role: Role;
}

export interface ThunkResult {
  ok: boolean;
  reason?: string;
}

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', raceId: 'race-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', raceId: 'race-1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', raceId: 'race-1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, resultStatus: 'official', note: '' }
];

const initialChanges: ChangeRecord[] = [
  { id: 'change-seed-base', source: 'result', raceId: 'race-1', entryId: 'entry-2', penaltySeconds: 30, confirmed: true, voided: false, note: '起航争议标记的基础处罚', createdAt: now.toISOString(), updatedAt: now.toISOString() },
  { id: 'change-seed-pub', source: 'publication', raceId: 'race-1', entryId: 'entry-3', penaltySeconds: 0, confirmed: true, voided: false, note: '正式成绩发布', createdAt: now.toISOString(), updatedAt: now.toISOString() }
];

const initialState: AppState = {
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled' }],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
  changes: initialChanges,
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  role: 'officer'
};

function pushEvent(state: AppState, type: TimelineEvent['type'], message: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type, message });
}

function boatName(state: AppState, entryId: string): string {
  return state.entries.find((entry) => entry.id === entryId)?.boat ?? entryId;
}

/** 处罚变更后作废已发布成绩；根据当前是否仍有有效发布记录重算成绩状态 */
function recomputeStatus(state: AppState, entry: RaceEntry, changed: boolean) {
  const publication = latestPublication(state.changes, entry.id);
  const published = !!publication && !publication.voided;
  entry.resultStatus = published ? 'official' : changed ? 'corrected' : 'provisional';
}

/** 处罚一变：发布记录作废 + 净用时重算 + 时间线留痕 */
function invalidateAfterPenaltyChange(state: AppState, entryId: string, reason: string) {
  for (const change of state.changes) {
    if (change.entryId === entryId && change.source === 'publication' && !change.voided) {
      change.voided = true;
      change.updatedAt = new Date().toISOString();
    }
  }
  const entry = state.entries.find((item) => item.id === entryId);
  if (entry) {
    recomputeStatus(state, entry, true);
    pushEvent(state, 'result', `净用时作废重算：${entry.boat}，${reason}`);
  }
}

function ctxOf(state: AppState): GuardCtx {
  return { races: state.races, changes: state.changes, role: state.role };
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
    },
    setRaceStatusInternal(state, action: PayloadAction<{ status: Race['status'] }>) {
      const race = state.races[0];
      race.status = action.payload.status;
      if (action.payload.status === 'abandoned') {
        for (const change of state.changes) {
          if (change.source === 'publication' && !change.voided) change.voided = true;
        }
        for (const entry of state.entries) recomputeStatus(state, entry, false);
        pushEvent(state, 'race', `${race.name} 弃权：全部成绩与发布作废，后续变更不再受理`);
      } else {
        pushEvent(state, 'race', `${race.name} 状态更新为 ${action.payload.status}`);
      }
    },
    saveArrivalInternal(state, action: PayloadAction<{ id: string; elapsedSeconds: number; note: string }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const changed = entry.elapsedSeconds !== action.payload.elapsedSeconds || entry.note !== action.payload.note;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.note = action.payload.note;
      recomputeStatus(state, entry, changed);
      if (changed) pushEvent(state, 'result', `${entry.boat} 到达数据更新为 ${action.payload.elapsedSeconds} 秒，净用时已重算`);
    },
    saveBasePenaltyInternal(state, action: PayloadAction<{ id: string; penaltySeconds: number; note: string }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const previous = basePenaltyFor(state.changes, entry.id);
      const next = action.payload.penaltySeconds;
      const at = new Date().toISOString();
      let record = state.changes.find((change) => change.entryId === entry.id && change.source === 'result');
      if (record) {
        record.penaltySeconds = next;
        record.note = action.payload.note || record.note;
        record.updatedAt = at;
      } else {
        record = { id: crypto.randomUUID(), source: 'result', raceId: entry.raceId, entryId: entry.id, penaltySeconds: next, confirmed: true, voided: false, note: action.payload.note, createdAt: at, updatedAt: at };
        state.changes.unshift(record);
      }
      entry.note = action.payload.note || entry.note;
      if (previous !== next) {
        invalidateAfterPenaltyChange(state, entry.id, `基础处罚 ${previous} 秒调整为 ${next} 秒（差额 ${next - previous >= 0 ? '+' : ''}${next - previous} 秒），已发布成绩作废`);
      } else {
        recomputeStatus(state, entry, false);
      }
    },
    addProtestInternal(state, action: PayloadAction<{ id: string; raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      pushEvent(state, 'protest', `收到 ${boatName(state, protest.entryId)} 的 ${protest.rule} 抗议，等待复核`);
    },
    decideProtestInternal(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      const at = new Date().toISOString();
      const existing = changeForProtest(state.changes, protest.id);

      if (action.payload.status === 'resolved') {
        const next = Math.max(0, Math.floor(action.payload.penaltySeconds ?? existing?.penaltySeconds ?? 0));
        protest.status = 'resolved';
        protest.decision = action.payload.decision ?? protest.decision ?? `接受抗议，处以 ${next} 秒处罚`;

        if (existing) {
          // 改判：同一份抗议只保留一条处罚，按差额调整，原记录作废重算
          const previous = existing.penaltySeconds;
          existing.penaltySeconds = next;
          existing.confirmed = false;
          existing.note = protest.decision;
          existing.updatedAt = at;
          invalidateAfterPenaltyChange(state, protest.entryId, `抗议 ${protest.rule} 改判，处罚 ${previous} 秒调整为 ${next} 秒（差额 ${next - previous >= 0 ? '+' : ''}${next - previous} 秒），等待仲裁重新确认`);
        } else {
          state.changes.unshift({
            id: crypto.randomUUID(), source: 'protest', raceId: protest.raceId, entryId: protest.entryId, protestId: protest.id,
            penaltySeconds: next, confirmed: false, voided: false, note: protest.decision, createdAt: at, updatedAt: at
          });
          invalidateAfterPenaltyChange(state, protest.entryId, `抗议 ${protest.rule} 裁决 ${next} 秒，等待仲裁确认`);
        }
      } else {
        protest.status = action.payload.status;
        protest.decision = action.payload.decision ?? protest.decision;
        if (action.payload.status === 'rejected' && existing) {
          // 驳回曾经裁决过的抗议：移除其唯一处罚记录并按差额（-原值）重算
          const previous = existing.penaltySeconds;
          state.changes = state.changes.filter((change) => change.id !== existing.id);
          invalidateAfterPenaltyChange(state, protest.entryId, `抗议 ${protest.rule} 驳回，撤销 ${previous} 秒处罚（差额 -${previous} 秒），等待仲裁重新确认`);
        } else {
          pushEvent(state, 'protest', `抗议 ${protest.rule} 更新为 ${action.payload.status}`);
        }
      }
    },
    confirmProtestChangeInternal(state, action: PayloadAction<{ id: string }>) {
      const change = changeForProtest(state.changes, action.payload.id);
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!change || !protest) return;
      change.confirmed = true;
      change.updatedAt = new Date().toISOString();
      pushEvent(state, 'protest', `仲裁重新确认 ${boatName(state, protest.entryId)} 的 ${protest.rule} 抗议处罚 ${change.penaltySeconds} 秒，可以发布正式成绩`);
    },
    publishResultInternal(state, action: PayloadAction<{ id: string }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const at = new Date().toISOString();
      state.changes.unshift({
        id: crypto.randomUUID(), source: 'publication', raceId: entry.raceId, entryId: entry.id,
        penaltySeconds: 0, confirmed: true, voided: false, note: '正式成绩发布', createdAt: at, updatedAt: at
      });
      recomputeStatus(state, entry, false);
      pushEvent(state, 'publish', `${entry.boat} 正式成绩已发布（净用时按当前全部有效变更记录计算）`);
    }
  }
});

const STORAGE_KEY = 'regatta-control-v2';

const stored = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...initialState,
      ...parsed,
      changes: parsed.changes ?? [],
      timeline: parsed.timeline ?? [],
      role: parsed.role ?? 'officer'
    } as AppState;
  } catch {
    return undefined;
  }
})();

export const {
  setRole,
  setRaceStatusInternal,
  saveArrivalInternal,
  saveBasePenaltyInternal,
  addProtestInternal,
  decideProtestInternal,
  confirmProtestChangeInternal,
  publishResultInternal
} = slice.actions;

export function setRaceStatus(status: Race['status']) {
  return (dispatch: AppDispatch, getState: () => RootState): ThunkResult => {
    const state = getState().regatta;
    if (status !== 'scheduled' && status !== 'running' && status !== 'finished' && status !== 'abandoned') return { ok: false, reason: '未知比赛状态' };
    const reason = guardRaceControl(ctxOf(state));
    if (reason) return { ok: false, reason };
    dispatch(setRaceStatusInternal({ status }));
    return { ok: true };
  };
}

export function addProtest(payload: { entryId: string; reason: string; rule: string }) {
  return (dispatch: AppDispatch, getState: () => RootState): ThunkResult => {
    const state = getState().regatta;
    const reason = guardProtestSubmission(ctxOf(state));
    if (reason) return { ok: false, reason };
    dispatch(addProtestInternal({ id: crypto.randomUUID(), raceId: state.races[0].id, ...payload }));
    return { ok: true };
  };
}

export function decideProtest(payload: { id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }) {
  return (dispatch: AppDispatch, getState: () => RootState): ThunkResult => {
    const state = getState().regatta;
    const reason = guardProtestDecision(ctxOf(state));
    if (reason) return { ok: false, reason };
    dispatch(decideProtestInternal(payload));
    return { ok: true };
  };
}

export function confirmProtestChange(id: string) {
  return (dispatch: AppDispatch, getState: () => RootState): ThunkResult => {
    const state = getState().regatta;
    const reason = guardConfirm(ctxOf(state));
    if (reason) return { ok: false, reason };
    const change = changeForProtest(state.changes, id);
    if (!change) return { ok: false, reason: '该抗议没有待确认的处罚变更' };
    if (change.confirmed) return { ok: false, reason: '该裁决已经确认过' };
    dispatch(confirmProtestChangeInternal({ id }));
    return { ok: true };
  };
}

export function saveArrival(payload: { id: string; elapsedSeconds: number; note: string }) {
  return (dispatch: AppDispatch, getState: () => RootState): ThunkResult => {
    const state = getState().regatta;
    const reason = guardArrival(ctxOf(state));
    if (reason) return { ok: false, reason };
    dispatch(saveArrivalInternal(payload));
    return { ok: true };
  };
}

export function saveBasePenalty(payload: { id: string; penaltySeconds: number; note: string }) {
  return (dispatch: AppDispatch, getState: () => RootState): ThunkResult => {
    const state = getState().regatta;
    const reason = guardBasePenalty(ctxOf(state));
    if (reason) return { ok: false, reason };
    dispatch(saveBasePenaltyInternal(payload));
    return { ok: true };
  };
}

export function publishResult(id: string) {
  return (dispatch: AppDispatch, getState: () => RootState): ThunkResult => {
    const state = getState().regatta;
    const reason = guardPublish(ctxOf(state), id);
    if (reason) return { ok: false, reason };
    dispatch(publishResultInternal({ id }));
    return { ok: true };
  };
}

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppThunk<ReturnType = ThunkResult> = ThunkAction<ReturnType, RootState, unknown, UnknownAction>;
export type AppDispatch = ThunkDispatch<RootState, unknown, UnknownAction>;
