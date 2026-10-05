export type RaceStatus = 'scheduled' | 'running' | 'finished' | 'abandoned';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';
export type Role = 'officer' | 'jury' | 'timer';
export type ChangeSource = 'result' | 'protest' | 'publication';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
}

export interface RaceEntry {
  id: string;
  raceId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  resultStatus: ResultStatus;
  note: string;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
}

/**
 * 赛后变更记录：抗议裁决、成绩更正、正式发布共用一份。
 * - source=result：竞赛官记录的基础处罚（每条报名只有一条，覆盖更新）。
 * - source=protest：每条抗议唯一一条处罚记录（protestId），改判按差额调整原记录。
 * - source=publication：一次正式发布；处罚一变即被 void 作废，仲裁重新确认后才能再次发布。
 */
export interface ChangeRecord {
  id: string;
  source: ChangeSource;
  raceId: string;
  entryId: string;
  protestId?: string;
  /** 当前有效的处罚秒数（抗议改判直接改这条，而不是再累加一条） */
  penaltySeconds: number;
  /** 抗议处罚是否已经仲裁确认；每次改判后置为 false */
  confirmed: boolean;
  /** 发布记录是否已被后续处罚变更作废 */
  voided: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'publish' | 'system';
  message: string;
}
