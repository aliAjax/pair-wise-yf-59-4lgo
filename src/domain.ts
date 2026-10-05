import type { ChangeRecord, Race, RaceEntry, Role } from './types';

/** 赛后变更记录上的权限/门禁上下文：抗议裁决、成绩、发布共用同一份记录 */
export interface GuardCtx {
  races: Race[];
  changes: ChangeRecord[];
  role: Role;
}

export const ROLE_LABEL: Record<Role, string> = {
  officer: '竞赛官',
  jury: '仲裁',
  timer: '计时员'
};

export function activeRaceStatus(ctx: Pick<GuardCtx, 'races'>): Race['status'] | undefined {
  return ctx.races[0]?.status;
}

/** 比赛结束或弃权后，不再受理任何变更 */
export const isStatusClosed = (status?: Race['status']): boolean => status === 'finished' || status === 'abandoned';

export function changeWindowClosed(ctx: Pick<GuardCtx, 'races'>): boolean {
  return isStatusClosed(activeRaceStatus(ctx));
}

function denyRole(ctx: GuardCtx, allowed: Role[], action: string): string | null {
  if (allowed.includes(ctx.role)) return null;
  return `${ROLE_LABEL[ctx.role]}无权${action}，请切换为${allowed.map((role) => ROLE_LABEL[role]).join(' / ')}账号`;
}

const WINDOW_CLOSED = '比赛已结束或弃权，不再受理变更';

export const guardRaceControl = (ctx: GuardCtx): string | null => denyRole(ctx, ['officer'], '切换比赛状态');

export const guardProtestSubmission = (ctx: GuardCtx): string | null =>
  changeWindowClosed(ctx) ? WINDOW_CLOSED : null;

export const guardProtestDecision = (ctx: GuardCtx): string | null =>
  denyRole(ctx, ['jury'], '处理抗议') ?? (changeWindowClosed(ctx) ? WINDOW_CLOSED : null);

export const guardArrival = (ctx: GuardCtx): string | null =>
  denyRole(ctx, ['timer', 'officer'], '提交到达数据') ?? (changeWindowClosed(ctx) ? WINDOW_CLOSED : null);

export const guardBasePenalty = (ctx: GuardCtx): string | null =>
  denyRole(ctx, ['officer'], '记录基础处罚') ?? (changeWindowClosed(ctx) ? WINDOW_CLOSED : null);

/** 确认裁决也是赛后变更：结束或弃权后均关闭 */
export const guardConfirm = (ctx: GuardCtx): string | null =>
  denyRole(ctx, ['jury'], '确认裁决') ?? (changeWindowClosed(ctx) ? WINDOW_CLOSED : null);

export function guardPublish(ctx: GuardCtx, entryId: string): string | null {
  return denyRole(ctx, ['officer'], '发布正式成绩')
    ?? (activeRaceStatus(ctx) === 'abandoned' ? '比赛已弃权，不能发布成绩' : null)
    ?? (hasUnconfirmedProtest(ctx.changes, entryId) ? '抗议处罚改判后尚未经仲裁重新确认，不能发布' : null);
}

/** 每条抗议对应一条 protest 记录，净用时只取该记录当前有效的处罚值 */
export function protestChangesFor(changes: ChangeRecord[], entryId: string): ChangeRecord[] {
  return changes.filter((change) => change.entryId === entryId && change.source === 'protest');
}

export function changeForProtest(changes: ChangeRecord[], protestId: string): ChangeRecord | undefined {
  return changes.find((change) => change.source === 'protest' && change.protestId === protestId);
}

export function basePenaltyFor(changes: ChangeRecord[], entryId: string): number {
  return changes.find((change) => change.entryId === entryId && change.source === 'result')?.penaltySeconds ?? 0;
}

export interface PenaltyBreakdown {
  base: number;
  protestTotal: number;
  protestChanges: ChangeRecord[];
  total: number;
}

/** 净用时派生：基础处罚 + 每条抗议当前有效处罚（重复处理同一份抗议只算一条） */
export function penaltyBreakdown(changes: ChangeRecord[], entryId: string): PenaltyBreakdown {
  const protestChanges = protestChangesFor(changes, entryId);
  const protestTotal = protestChanges.reduce((sum, change) => sum + change.penaltySeconds, 0);
  const base = basePenaltyFor(changes, entryId);
  return { base, protestTotal, protestChanges, total: base + protestTotal };
}

export function netSeconds(changes: ChangeRecord[], entry: RaceEntry): number {
  return entry.elapsedSeconds + penaltyBreakdown(changes, entry.id).total;
}

/** 改判后处罚记录处于未确认状态，仲裁重新确认前禁止发布 */
export function hasUnconfirmedProtest(changes: ChangeRecord[], entryId: string): boolean {
  return protestChangesFor(changes, entryId).some((change) => !change.confirmed);
}

export function latestPublication(changes: ChangeRecord[], entryId: string): ChangeRecord | undefined {
  // 记录按 unshift 头插，数组最前为最新
  return changes.find((change) => change.entryId === entryId && change.source === 'publication');
}
