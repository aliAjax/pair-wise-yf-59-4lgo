import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Protest, ProtestStatus, Race, RaceEntry, Role, TimelineEvent } from './types';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  currentRole: Role;
}

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', raceId: 'race-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '', retired: false },
  { id: 'entry-2', raceId: 'race-1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 0, resultStatus: 'provisional', note: '', retired: false },
  { id: 'entry-3', raceId: 'race-1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '', retired: false }
];

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialState: AppState = {
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled' }],
  entries: initialEntries,
  protests: [
    { id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', penaltySeconds: 0, confirmed: false, createdAt: now.toISOString() }
  ],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  currentRole: 'arbitrator'
};

/** 某条抗议当前有效的处罚值（唯一来源） */
export function protestPenaltyFor(protests: Protest[], entryId: string): number {
  return protests
    .filter((item) => item.entryId === entryId && item.status === 'resolved')
    .reduce((sum, item) => sum + item.penaltySeconds, 0);
}

/** 净用时 = 航行用时 + 手动处罚 + 抗议处罚（抗议处罚按当前有效值计算，不做累加） */
export function netTimeFor(entry: RaceEntry, protests: Protest[]): number {
  return entry.elapsedSeconds + entry.penaltySeconds + protestPenaltyFor(protests, entry.id);
}

function block(state: AppState, message: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'system', message });
}

function raceOf(state: AppState, entry: RaceEntry): Race | undefined {
  return state.races.find((item) => item.id === entry.raceId);
}

/** 成绩重算：按抗议当前有效处罚值重新计算净用时，并保留重算记录 */
function recalculateEntry(state: AppState, entryId: string, reason: string) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;
  const protestPenalty = protestPenaltyFor(state.protests, entryId);
  const net = entry.elapsedSeconds + entry.penaltySeconds + protestPenalty;
  state.timeline.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    type: 'result',
    message: `${entry.boat} 成绩重算（${reason}）：净用时 ${net}s（航行 ${entry.elapsedSeconds}s + 手动处罚 ${entry.penaltySeconds}s + 抗议处罚 ${protestPenalty}s）`
  });
}

/** 处罚一变就作废：成绩标记为待更正，等待仲裁重新确认 */
function invalidateEntry(state: AppState, entry: RaceEntry) {
  entry.resultStatus = 'corrected';
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setCurrentRole(state, action: PayloadAction<Role>) {
      state.currentRole = action.payload;
    },
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string; official: boolean }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      if (action.payload.official && state.currentRole !== 'arbitrator') {
        block(state, state.currentRole === 'timer' ? '计时员越权发布成绩，已挡回' : '竞赛官无权发布成绩，已挡回');
        return;
      }
      const race = raceOf(state, entry);
      if (race?.status === 'finished') {
        block(state, '比赛已结束，不再受理成绩变更');
        return;
      }
      if (entry.retired) {
        block(state, '该船已弃权，不再受理成绩变更');
        return;
      }
      if (action.payload.official) {
        const hasUnconfirmed = state.protests.some((item) => item.entryId === entry.id && item.status === 'resolved' && !item.confirmed);
        if (hasUnconfirmed) {
          block(state, '成绩尚未经仲裁确认，无法发布');
          return;
        }
      }
      const changed = entry.elapsedSeconds !== action.payload.elapsedSeconds || entry.penaltySeconds !== action.payload.penaltySeconds;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      if (action.payload.official) {
        entry.resultStatus = 'official';
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'result', message: `${entry.boat} 成绩已发布为正式成绩` });
      } else {
        entry.resultStatus = changed ? 'corrected' : 'provisional';
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'result', message: `${entry.boat} 成绩更正为 ${netTimeFor(entry, state.protests)} 秒` });
      }
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (race?.status === 'finished') {
        block(state, '比赛已结束，不再受理抗议');
        return;
      }
      const entry = state.entries.find((item) => item.id === action.payload.entryId);
      if (entry?.retired) {
        block(state, '该船已弃权，不再受理抗议');
        return;
      }
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', penaltySeconds: 0, confirmed: false, createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
    },
    transitionProtest(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>) {
      if (state.currentRole !== 'arbitrator') {
        block(state, state.currentRole === 'timer' ? '计时员越权处理抗议，已挡回' : '竞赛官无权处理抗议，已挡回');
        return;
      }
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      const race = state.races.find((item) => item.id === protest.raceId);
      if (race?.status === 'finished') {
        block(state, '比赛已结束，不再受理抗议变更');
        return;
      }
      const entry = state.entries.find((item) => item.id === protest.entryId);
      if (entry?.retired) {
        block(state, '该船已弃权，不再受理抗议变更');
        return;
      }
      const wasResolved = protest.status === 'resolved';
      const oldPenalty = protest.penaltySeconds;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.status === 'resolved') {
        const newPenalty = action.payload.penaltySeconds ?? 0;
        const delta = newPenalty - oldPenalty;
        protest.penaltySeconds = newPenalty;
        protest.confirmed = false;
        if (wasResolved) {
          state.timeline.unshift({
            id: crypto.randomUUID(),
            time: new Date().toISOString(),
            type: 'protest',
            message: `抗议 ${protest.id.slice(0, 6)} 改判：处罚 ${oldPenalty}s → ${newPenalty}s（差额 ${delta >= 0 ? '+' : ''}${delta}s）`
          });
        } else {
          state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 裁决：处罚 ${newPenalty}s` });
        }
        if (entry) {
          invalidateEntry(state, entry);
          recalculateEntry(state, entry.id, wasResolved ? '抗议改判' : '抗议裁决');
        }
      } else if (action.payload.status === 'rejected') {
        const hadPenalty = wasResolved && oldPenalty > 0;
        protest.penaltySeconds = 0;
        protest.confirmed = false;
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 驳回：${protest.decision || '维持原成绩'}` });
        if (entry && hadPenalty) {
          invalidateEntry(state, entry);
          recalculateEntry(state, entry.id, '抗议驳回');
        }
      } else {
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 更新为 ${action.payload.status}` });
      }
    },
    confirmResult(state, action: PayloadAction<{ entryId: string }>) {
      if (state.currentRole !== 'arbitrator') {
        block(state, state.currentRole === 'timer' ? '计时员越权确认成绩，已挡回' : '竞赛官无权确认成绩，已挡回');
        return;
      }
      const entry = state.entries.find((item) => item.id === action.payload.entryId);
      if (!entry) return;
      const race = raceOf(state, entry);
      if (race?.status === 'finished') {
        block(state, '比赛已结束，不再受理成绩确认');
        return;
      }
      if (entry.retired) {
        block(state, '该船已弃权，不再受理成绩确认');
        return;
      }
      let count = 0;
      state.protests.forEach((item) => {
        if (item.entryId === entry.id && item.status === 'resolved' && !item.confirmed) {
          item.confirmed = true;
          count += 1;
        }
      });
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        type: 'protest',
        message: count > 0
          ? `${entry.boat} 成绩已经仲裁确认（${count} 项抗议处罚），可发布`
          : `${entry.boat} 成绩已经仲裁确认，可发布`
      });
    },
    recalculateResult(state, action: PayloadAction<{ entryId: string }>) {
      const entry = state.entries.find((item) => item.id === action.payload.entryId);
      if (!entry) return;
      const race = raceOf(state, entry);
      if (race?.status === 'finished') {
        block(state, '比赛已结束，不再受理重算');
        return;
      }
      if (entry.retired) {
        block(state, '该船已弃权，不再受理重算');
        return;
      }
      recalculateEntry(state, entry.id, '手动重算');
    },
    retireEntry(state, action: PayloadAction<{ entryId: string }>) {
      if (state.currentRole === 'timer') {
        block(state, '计时员越权标记弃权，已挡回');
        return;
      }
      const entry = state.entries.find((item) => item.id === action.payload.entryId);
      if (!entry || entry.retired) return;
      entry.retired = true;
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'race', message: `${entry.boat} 弃权，成绩冻结` });
    }
  }
});

const STORAGE_KEY = 'regatta-control-v2';
const stored = localStorage.getItem(STORAGE_KEY);
const preloadedState = stored ? JSON.parse(stored) as AppState : initialState;

export const { setCurrentRole, setRaceStatus, saveResult, addProtest, transitionProtest, confirmResult, recalculateResult, retireEntry } = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
