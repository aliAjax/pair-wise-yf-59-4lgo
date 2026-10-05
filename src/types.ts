export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';
export type Role = 'raceOfficer' | 'arbitrator' | 'timer';

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
  /** 手动处罚秒数（非抗议来源）；抗议处罚不计入此字段，按抗议当前有效处罚值统一计算 */
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
  /** 弃权：弃权后不再受理该船的成绩/抗议变更 */
  retired: boolean;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  /** 当前有效处罚值（每份抗议只保留这一条，改判直接覆盖，不参与累加） */
  penaltySeconds: number;
  /** 当前处罚值是否已经仲裁确认；改判后需重新确认才能发布成绩 */
  confirmed: boolean;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}
