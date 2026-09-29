import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPersonalWork,renderReminders} from '../../frontend/work-ui.js';

test('工作台待安排和排期提醒直达研发任务分组，研发日期与承诺日期分开',()=>{
  const requirement={id:'req-plan',projectId:'p1',title:'导出 <报表>',status:'待排期',assigneeId:'dev',developmentStart:'2026-09-22',developmentEnd:'2026-09-25',developmentScheduleComplete:false,planEnd:'2026-10-01',planningKind:'schedule',planningGates:['请完善 1 项有效任务的开始和截止日期']};
  const result={personal:{isLead:true,splits:[requirement],tasks:[],requirements:[requirement],reviews:[]},unread:1,reminders:[{id:'notice',entityId:requirement.id,entityType:'requirement',projectId:'p1',title:requirement.title,message:requirement.planningGates[0],kind:'schedule',openTasks:true,read:false}]};
  const helpers={projectName:()=>'<项目>',nameOf:id=>id};
  const html=renderPersonalWork(result,helpers);
  assert.match(html,/待我安排的需求/);assert.match(html,/data-open-requirement-tasks="req-plan"/);
  assert.match(html,/研发截止 2026-09-25（部分任务日期待完善）/);assert.match(html,/承诺截止 2026-10-01/);
  assert.match(html,/请完善 1 项有效任务/);assert.doesNotMatch(html,/<报表>|<项目>/);
  const reminders=renderReminders(result,helpers);assert.match(reminders,/data-open-requirement-tasks="req-plan"/);assert.doesNotMatch(reminders,/data-requirement="req-plan"/);
});

test('没有研发日期时仍显示独立承诺，不把承诺当成任务已排期',()=>{
  const html=renderPersonalWork({personal:{isLead:false,tasks:[],reviews:[],requirements:[{id:'r',title:'需求',status:'已确定',planEnd:'2026-10-01'}]}},{projectName:()=>'',nameOf:()=>''});
  assert.match(html,/研发任务尚未排期 · 承诺截止 2026-10-01/);assert.doesNotMatch(html,/研发截止 2026-10-01/);
});
