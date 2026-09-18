import { escapeHtml as esc } from './review-ui.js';
import { taskGranularity } from './workflow.js';

export function blankTask(ownerId='') { return {title:'',ownerId,estimateHours:8,startDate:'',dueDate:''}; }
export function readBatchForm(form) {
  return [...form.querySelectorAll('[data-batch-row]')].map(row => Object.fromEntries([...row.querySelectorAll('[data-batch-field]')].map(control => [control.dataset.batchField,control.dataset.batchField==='estimateHours' ? Number(control.value) : control.value])));
}
export function renderBatchRows(tasks,users,{fixedOwner=''}={}) {
  return tasks.map((task,index) => `<fieldset class="batch-task" data-batch-row="${index}"><legend>任务 ${index+1}</legend><div class="form-grid"><div class="form-field full-width"><label for="batch-title-${index}">任务名称 <span class="required">*</span></label><input id="batch-title-${index}" data-batch-field="title" value="${esc(task.title)}" maxlength="200" required></div><div class="form-field"><label for="batch-owner-${index}">负责人</label><select id="batch-owner-${index}" data-batch-field="ownerId"${fixedOwner?' disabled':''}>${!fixedOwner?'<option value="">未分配</option>':''}${users.filter(person=>!fixedOwner||person.id===fixedOwner).map(person=>`<option value="${esc(person.id)}"${(fixedOwner||task.ownerId)===person.id?' selected':''}>${esc(person.name)}</option>`).join('')}</select></div><div class="form-field"><label for="batch-hours-${index}">预估工时（小时） <span class="required">*</span></label><input id="batch-hours-${index}" data-batch-field="estimateHours" type="number" min="0.000001" max="100000" step="any" value="${esc(task.estimateHours)}" required></div><div class="form-field"><label for="batch-start-${index}">开始日期</label><input id="batch-start-${index}" data-batch-field="startDate" type="date" value="${esc(task.startDate)}"></div><div class="form-field"><label for="batch-end-${index}">截止日期</label><input id="batch-end-${index}" data-batch-field="dueDate" type="date" value="${esc(task.dueDate)}"></div></div><div class="batch-row-footer"><span class="field-help">${esc(taskGranularity(task.estimateHours).warnings?.join('；') || '建议每个任务 4–24 小时，超出范围仅提示。')}</span><button type="button" class="text-button danger" data-remove-batch="${index}"${tasks.length===1?' disabled':''}>移除任务</button></div></fieldset>`).join('');
}
export function renderBatchSummary(tasks) {
  const total = tasks.reduce((sum,task)=>sum+(Number.isFinite(Number(task.estimateHours))?Number(task.estimateHours):0),0);
  return `${tasks.length} 个任务 · 合计 ${total} 小时 · 需求点数独立统计`;
}
