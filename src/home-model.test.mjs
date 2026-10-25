import assert from 'node:assert/strict';
import test from 'node:test';
import { abyssSummary, dailyProgress, hardSummary, pityValue, progressPercent, theaterSummary } from './home-model.ts';

test('保底计数区分零抽、空存档、未识别星级和异常计数', () => {
  const pool = {total_count:100,total_unknown:0,last_orange_pull:0,last_purple_pull:4,guarantee_orange_threshold:90,guarantee_purple_threshold:10};
  assert.equal(pityValue(pool,5),0);
  assert.equal(pityValue(pool,4),4);
  assert.equal(pityValue({...pool,total_count:0},5),null);
  assert.equal(pityValue({...pool,total_unknown:1},4),null);
  assert.equal(pityValue({...pool,last_orange_pull:91},5),null);
  assert.equal(pityValue(undefined,5),null);
});
test('进度条处理未解锁、边界和无效分母', () => {
  assert.ok(Math.abs(progressPercent(2,3)-200/3)<1e-10);
  assert.equal(progressPercent(5,0),0);
  assert.equal(progressPercent(-1,4),0);
  assert.equal(progressPercent(7,4),100);
  assert.equal(progressPercent(NaN,4),0);
});
test('每日委托兼容新旧字段，派遣按快照时间计算完成', () => {
  const data = {fetched_at_ms:1000,total_task_num:4,finished_task_num:1,is_extra_task_reward_received:false,expeditions:[{status:'Ongoing',remained_time:30},{status:'Finished',remained_time:0}],daily_task:{total_num:4,finished_num:4,is_extra_task_reward_received:false}};
  assert.equal(dailyProgress(data,32000).finished,2);
  assert.equal(dailyProgress(data,1000).finished,1);
  assert.equal(dailyProgress(data,1000).taskCaption,'额外奖励待领取');
  assert.equal(dailyProgress({...data,daily_task:undefined},1000).done,1);
});
test('首页不把历史挑战数据当成本期成绩', () => {
  const old = {start_time:1,end_time:10,total_star:36,is_unlock:true};
  assert.equal(abyssSummary([old],20),undefined);
  assert.equal(abyssSummary([old,{...old,start_time:15,end_time:30,total_star:0}],20).value,'0 / 36 星');
  assert.equal(theaterSummary([{schedule:{start_time:1,end_time:10}}],20),undefined);
  assert.equal(hardSummary([{schedule:{start_time:15,end_time:30,is_valid:false}}],20),undefined);
});
