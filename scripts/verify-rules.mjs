// 赛后变更记录规则的端到端验证（纯 store/domain，不依赖 React）
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 输出到工作区内，external 的 RTK 可直接从 ./node_modules 解析
const dir = join(process.cwd(), 'node_modules', '.cache', 'regatta-test');
mkdirSync(dir, { recursive: true });
const outfile = join(dir, 'bundle.mjs');

// store 在模块级读取 localStorage，导入前先打桩
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key)
};

await build({
  entryPoints: ['scripts/test-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
  external: ['@reduxjs/toolkit', 'react', 'react-dom', 'react-redux', 'react-router-dom', 'antd', '@reduxjs/toolkit/query/react']
});

const mod = await import(pathToFileURL(outfile).href);
const {
  store, setRole, setRaceStatus, addProtest, decideProtest,
  confirmProtestChange, saveArrival, saveBasePenalty, publishResult
} = mod;
const domain = mod;

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}
function state() { return store.getState().regatta; }
function entry(id) { return state().entries.find((e) => e.id === id); }
function net(id) { return domain.netSeconds(state().changes, entry(id)); }
function protestPenalties(protestId) {
  return state().changes.filter((c) => c.source === 'protest' && c.protestId === protestId);
}

console.log('初始数据');
// entry-2: elapsed 3194 + 基础处罚 30 = 3224
check('entry-2 初始净用时 = 3194+30 = 3224', net('entry-2') === 3224, `实际 ${net('entry-2')}`);

// ---------- 场景 1：计时员越权处理抗议 / 发布，被挡回 ----------
console.log('\n场景1：计时员越权被挡回');
store.dispatch(setRole('timer'));
const seedProtest = state().protests[0].id;
let r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 30 }));
check('计时员裁决抗议被挡回', r.ok === false && /计时员无权处理抗议/.test(r.reason ?? ''), r.reason);
r = store.dispatch(publishResult('entry-1'));
check('计时员发布成绩被挡回', r.ok === false && /计时员无权发布/.test(r.reason ?? ''), r.reason);
r = store.dispatch(confirmProtestChange(seedProtest));
check('计时员确认裁决被挡回', r.ok === false && /计时员无权确认/.test(r.reason ?? ''), r.reason);
check('净用时未被越权操作改动', net('entry-2') === 3224);

// 竞赛官也不能裁决抗议
store.dispatch(setRole('officer'));
r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 30 }));
check('竞赛官裁决抗议被挡回', r.ok === false && /竞赛官无权处理抗议/.test(r.reason ?? ''), r.reason);

// 仲裁不能发布
store.dispatch(setRole('jury'));
r = store.dispatch(publishResult('entry-1'));
check('仲裁发布成绩被挡回', r.ok === false && /仲裁无权发布/.test(r.reason ?? ''), r.reason);

// ---------- 场景 2：开始比赛；仲裁裁决抗议：一条记录、净用时只取当前值 ----------
console.log('\n场景2：仲裁裁决 30 秒');
store.dispatch(setRole('officer'));
store.dispatch(setRaceStatus('running'));
store.dispatch(setRole('jury'));
r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 30, decision: '接受，30秒' }));
check('仲裁裁决成功', r.ok === true, r.reason);
let recs = protestPenalties(seedProtest);
check('只生成一条 protest 处罚记录', recs.length === 1, `实际 ${recs.length} 条`);
check('记录处罚值为 30', recs[0]?.penaltySeconds === 30);
check('新裁决未确认', recs[0]?.confirmed === false);
// 3194 + 基础30 + 抗议30 = 3254
check('净用时 = 3254（每条抗议按当前有效处罚参与一次）', net('entry-2') === 3254, `实际 ${net('entry-2')}`);

// 发布必须先确认
store.dispatch(setRole('officer'));
r = store.dispatch(publishResult('entry-2'));
check('未确认前发布被挡回', r.ok === false && /重新确认/.test(r.reason ?? ''), r.reason);

store.dispatch(setRole('jury'));
r = store.dispatch(confirmProtestChange(seedProtest));
check('仲裁确认成功', r.ok === true, r.reason);
r = store.dispatch(confirmProtestChange(seedProtest));
check('重复确认被挡回', r.ok === false);

store.dispatch(setRole('officer'));
r = store.dispatch(publishResult('entry-2'));
check('确认后发布成功', r.ok === true, r.reason);
check('发布后状态 official', entry('entry-2').resultStatus === 'official');

// ---------- 场景 3：同一份抗议改判两次，按差额调整、只有一条处罚、发布作废重算 ----------
console.log('\n场景3：改判 30 → 50 → 20');
store.dispatch(setRole('jury'));
r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 50 }));
check('第一次改判成功', r.ok === true, r.reason);
recs = protestPenalties(seedProtest);
check('改判后仍只有一条处罚记录（不累加新记录）', recs.length === 1, `实际 ${recs.length} 条`);
check('记录当前值变为 50', recs[0]?.penaltySeconds === 50);
check('改判后 confirmed 复位为 false', recs[0]?.confirmed === false);
// 3194 + 30 + 50 = 3274
check('净用时重算 = 3274（差额 +20，而非再扣一份）', net('entry-2') === 3274, `实际 ${net('entry-2')}`);
check('原发布被作废，状态回退 corrected', entry('entry-2').resultStatus === 'corrected', entry('entry-2').resultStatus);

store.dispatch(setRole('officer'));
r = store.dispatch(publishResult('entry-2'));
check('改判后重新确认前不能发布', r.ok === false && /重新确认/.test(r.reason ?? ''), r.reason);

store.dispatch(setRole('jury'));
store.dispatch(confirmProtestChange(seedProtest));
store.dispatch(setRole('officer'));
store.dispatch(publishResult('entry-2'));
check('重新确认后可再次发布', entry('entry-2').resultStatus === 'official');

// 第二次改判 50 → 20
store.dispatch(setRole('jury'));
r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 20 }));
recs = protestPenalties(seedProtest);
check('第二次改判仍只有一条处罚记录', recs.length === 1, `实际 ${recs.length} 条`);
check('记录当前值变为 20', recs[0]?.penaltySeconds === 20);
// 3194 + 30 + 20 = 3244
check('净用时 = 3244（差额 -30，没有多扣一份）', net('entry-2') === 3244, `实际 ${net('entry-2')}`);
check('发布再次作废', entry('entry-2').resultStatus === 'corrected');

// 重复点同一个裁决按钮（相同处罚值再提交一次）也不会多一条
r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 20 }));
recs = protestPenalties(seedProtest);
check('相同值重复处理同一份抗议仍只有一条记录', recs.length === 1, `实际 ${recs.length} 条`);
check('净用时不变 = 3244', net('entry-2') === 3244, `实际 ${net('entry-2')}`);

// ---------- 场景 4：驳回撤销处罚，按差额重算 ----------
console.log('\n场景4：驳回抗议');
r = store.dispatch(decideProtest({ id: seedProtest, status: 'rejected', decision: '驳回' }));
check('驳回成功', r.ok === true, r.reason);
check('处罚记录被移除（0 条）', protestPenalties(seedProtest).length === 0);
// 3194 + 基础30 = 3224
check('净用时回退 = 3224（差额 -20）', net('entry-2') === 3224, `实际 ${net('entry-2')}`);

// ---------- 场景 5：比赛结束后不再受理变更，但确认后仍可发布 ----------
console.log('\n场景5：结束比赛关闭变更窗口');
store.dispatch(setRole('officer'));
store.dispatch(setRaceStatus('finished'));
store.dispatch(setRole('jury'));
r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 15 }));
check('结束后仲裁改判被挡回', r.ok === false && /结束|弃权/.test(r.reason ?? ''), r.reason);
r = store.dispatch(addProtest({ entryId: 'entry-1', reason: '结束后再来的抗议事件描述', rule: 'RRS 10' }));
check('结束后新抗议被挡回', r.ok === false && /结束|弃权/.test(r.reason ?? ''), r.reason);
store.dispatch(setRole('timer'));
r = store.dispatch(saveArrival({ id: 'entry-1', elapsedSeconds: 3000, note: 'x' }));
check('结束后到达数据被挡回', r.ok === false, r.reason);
store.dispatch(setRole('officer'));
r = store.dispatch(saveBasePenalty({ id: 'entry-1', penaltySeconds: 10, note: 'x' }));
check('结束后基础处罚被挡回', r.ok === false, r.reason);
store.dispatch(setRole('jury'));
r = store.dispatch(confirmProtestChange(seedProtest));
check('结束后仲裁确认被挡回', r.ok === false && /结束|弃权/.test(r.reason ?? ''), r.reason);
store.dispatch(setRole('officer'));
// entry-2 之前发布已作废（驳回时），无未确认抗议 → 仍可发布
r = store.dispatch(publishResult('entry-2'));
check('结束后仍可发布已确认成绩', r.ok === true, r.reason);
check('净用时不受挡回操作影响 = 3224', net('entry-2') === 3224, `实际 ${net('entry-2')}`);

// ---------- 场景 6：弃权后全部发布作废，一切变更与发布关闭 ----------
console.log('\n场景6：弃权');
store.dispatch(setRaceStatus('abandoned'));
check('entry-2 弃权后 official 被作废', entry('entry-2').resultStatus !== 'official', entry('entry-2').resultStatus);
check('entry-3 初始发布也被作废', entry('entry-3').resultStatus !== 'official', entry('entry-3').resultStatus);
r = store.dispatch(publishResult('entry-2'));
check('弃权后发布被挡回', r.ok === false && /弃权/.test(r.reason ?? ''), r.reason);
store.dispatch(setRole('jury'));
r = store.dispatch(decideProtest({ id: seedProtest, status: 'resolved', penaltySeconds: 15 }));
check('弃权后改判被挡回', r.ok === false, r.reason);
r = store.dispatch(confirmProtestChange(seedProtest));
check('弃权后确认也被挡回', r.ok === false, r.reason);

// ---------- 场景 7：时间线保留改判、差额、作废、重算、确认 ----------
console.log('\n场景7：时间线留痕');
const messages = state().timeline.map((e) => e.message).join('\n');
check('含改判差额记录', /改判.*差额 \+20/.test(messages) && /差额 -30/.test(messages));
check('含作废重算记录', /作废重算/.test(messages));
check('含仲裁确认记录', /仲裁重新确认/.test(messages));
check('含发布记录', /正式成绩已发布/.test(messages));
check('含驳回撤销差额记录', /驳回.*差额 -20/.test(messages));

// ---------- 场景 8：多份抗议各自独立一条，同一船多条抗议各算各的 ----------
console.log('\n场景8：重置比赛后多份抗议独立计数');
store.dispatch(setRole('officer'));
store.dispatch(setRaceStatus('scheduled'));
store.dispatch(setRaceStatus('running'));
// 直接走提交流程（任何角色可提交）
const add1 = store.dispatch(addProtest({ entryId: 'entry-1', reason: '第一次抗议的详细描述', rule: 'RRS 10' }));
const add2 = store.dispatch(addProtest({ entryId: 'entry-1', reason: '第二次抗议的详细描述', rule: 'RRS 11' }));
check('比赛进行中可提交新抗议', add1.ok && add2.ok, `${add1.reason} ${add2.reason}`);
const [p1, p2] = state().protests;
store.dispatch(setRole('jury'));
store.dispatch(decideProtest({ id: p1.id, status: 'resolved', penaltySeconds: 10 }));
store.dispatch(decideProtest({ id: p2.id, status: 'resolved', penaltySeconds: 20 }));
check('两份抗议各一条处罚记录',
  state().changes.filter((c) => c.source === 'protest' && c.entryId === 'entry-1').length === 2);
// entry-1 elapsed 3168，无基础处罚 → +10+20 = 3198
check('净用时 = 3198（两份抗议各按当前值参与一次）', net('entry-1') === 3198, `实际 ${net('entry-1')}`);
// 改判 p1 10→40：差额 +30
store.dispatch(decideProtest({ id: p1.id, status: 'resolved', penaltySeconds: 40 }));
check('p1 改判后仍一条，净用时 = 3228',
  state().changes.filter((c) => c.source === 'protest' && c.protestId === p1.id).length === 1 && net('entry-1') === 3228,
  `实际 ${net('entry-1')}`);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
