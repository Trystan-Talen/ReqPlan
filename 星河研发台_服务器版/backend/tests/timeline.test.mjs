import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineState, resolveTimelineRange, moveTimeline, buildTimelineTicks, taskInterval, timelineBar, filterTimelineTasks, renderTimeline, parseDay, formatDay, resolveTimelineExtent, resolveTimelineZoom, buildTimelineScale, TIMELINE_LIMITS } from '../../frontend/timeline.js';

const today = '2026-09-15';
const state = (values = {}) => ({ ...createTimelineState(today), ...values });
const range = (values, context = {}) => resolveTimelineRange(state(values), { today, ...context });
const task = (values = {}) => ({ id: 't1', title: '任务', status: 'develop', ownerId: 'u1', startDate: '2026-09-01', dueDate: '2026-09-30', ...values });

test('周以周一开始，月份与季度完整覆盖跨年和闰日', () => {
  assert.deepEqual([range({ mode: 'week' }).start, range({ mode: 'week' }).end], ['2026-09-14', '2026-09-20']);
  assert.equal(range({ mode: 'week', anchor: '2027-01-03' }).start, '2026-12-28');
  assert.equal(range({ anchor: '2024-02-29' }).days, 29);
  assert.equal(range({ anchor: '2025-02-28' }).days, 28);
  const q = range({ mode: 'quarter', anchor: '2024-02-29' });
  assert.deepEqual([q.start, q.end, q.days], ['2024-01-01', '2024-03-31', 91]);
});

test('UTC 日历算法拒绝不存在的日期，夏令时切换仍然按整天计算', () => {
  for (const value of ['', '2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-09-15T00:00:00Z']) assert.equal(parseDay(value), null);
  assert.equal(formatDay(parseDay('0099-01-01')), '0099-01-01');
  assert.equal(parseDay('2026-03-09') - parseDay('2026-03-07'), 2);
  assert.equal(parseDay('2026-11-02') - parseDay('2026-10-31'), 2);
});

test('完整项目范围综合任务、项目起止和里程碑，不受负责人筛选缩短', () => {
  const tasks = [task({ startDate: '2025-01-02', dueDate: '2025-03-09' }), task({ id: 'future', startDate: '', dueDate: '2030-12-31' }), task({ archived: true, startDate: '2000-01-01' })];
  const project = { startDate: '2024-02-01', targetDate: '2030-06-30', milestones: [{ label: '最终验收', date: '2031-02-28' }] };
  const result = range({ mode: 'project', owner: 'other' }, { tasks, project });
  assert.deepEqual([result.start, result.end], ['2024-02-01', '2031-02-28']);
  const none = range({ mode: 'project' });
  assert.equal(none.isFallback, true);
  assert.deepEqual([none.start, none.end], ['2026-09-01', '2026-09-30']);
});

test('上一周期和下一周期覆盖月末、跨季度、周与自定义整段', () => {
  let current = state({ anchor: '2024-01-31' });
  current = moveTimeline(current, 1, { today });
  assert.equal(resolveTimelineRange(current, { today }).end, '2024-02-29');
  current = moveTimeline(current, 1, { today });
  assert.equal(resolveTimelineRange(current, { today }).start, '2024-03-01');
  assert.equal(moveTimeline(state({ mode: 'quarter', anchor: '2026-12-31' }), 1, { today }).anchor, '2027-01-01');
  assert.equal(moveTimeline(state({ mode: 'week' }), -1, { today }).anchor, '2026-09-07');
  const custom = moveTimeline(state({ mode: 'custom', start: '2024-02-28', end: '2024-03-02' }), -1, { today });
  assert.deepEqual([custom.start, custom.end], ['2024-02-24', '2024-02-27']);
  assert.equal(moveTimeline(state({ mode: 'project' }), 'today', { today }).mode, 'month');
  assert.deepEqual(moveTimeline(state({ mode: 'project' }), -1, { today }), state({ mode: 'project' }));
});

test('自定义非法范围有明确错误，今天保留自定义跨度', () => {
  assert.match(range({ mode: 'custom', start: '2026-10-01', end: '2026-09-01' }).error, /结束日期不能早于/);
  assert.match(range({ mode: 'custom', start: '', end: '' }).error, /有效/);
  const result = moveTimeline(state({ mode: 'custom', start: '2024-02-28', end: '2024-03-02' }), 'today', { today });
  assert.deepEqual([result.start, result.end], ['2026-09-15', '2026-09-18']);
});

test('刻度自适应日周月与跨多年分组，上限有界且全范围连续覆盖', () => {
  const cases = [['2026-09-01', '2026-09-30', 'day'], ['2026-07-01', '2026-09-30', 'week'], ['2020-01-02', '2030-12-31', 'month'], ['0001-01-01', '9999-12-31', 'month']];
  for (const [start, end, unit] of cases) {
    const r = range({ mode: 'custom', start, end }), result = buildTimelineTicks(r);
    assert.equal(result.unit, unit); assert.ok(result.ticks.length <= 61);
    assert.equal(result.ticks[0].start, start); assert.equal(result.ticks.at(-1).end, end);
    assert.equal(result.ticks.reduce((sum, tick) => sum + tick.endDay - tick.startDay + 1, 0), r.days);
    for (let index = 1; index < result.ticks.length; index++) assert.equal(result.ticks[index].startDay, result.ticks[index - 1].endDay + 1);
    assert.ok(Math.abs(result.ticks.reduce((sum, tick) => sum + tick.width, 0) - 100) < .000001);
  }
});

test('任务条包含首尾日，在窗口两边裁剪且不伪造缺失日期', () => {
  const r = range({ mode: 'custom', start: '2026-09-01', end: '2026-09-10' });
  assert.deepEqual(timelineBar(task({ startDate: '2026-08-01', dueDate: '2026-10-01' }), r), { left: 0, width: 100, clippedStart: true, clippedEnd: true });
  assert.deepEqual(timelineBar(task({ startDate: '2026-09-10', dueDate: '2026-09-10' }), r), { left: 90, width: 10, clippedStart: false, clippedEnd: false });
  assert.equal(timelineBar(task({ startDate: '2026-08-01', dueDate: '2026-08-31' }), r), null);
  assert.equal(taskInterval(task({ startDate: '' })), null);
  assert.equal(taskInterval(task({ startDate: '2026-10-01', dueDate: '2026-09-01' })), null);
});

test('负责人和状态筛选兼容中英文状态，归档不进入排期', () => {
  const tasks = [task({ id: 'zh', status: '已完成' }), task({ id: 'en', status: 'done', ownerId: null }), task({ id: 'archive', status: 'done', archived: true }), task()];
  assert.deepEqual(filterTimelineTasks(tasks, state({ status: 'done' })).map(item => item.id), ['zh', 'en']);
  assert.deepEqual(filterTimelineTasks(tasks, state({ status: '已完成', owner: '' })).map(item => item.id), ['en']);
});

test('渲染全部已排期任务与未排期列表，逾期排除完成和终止，并转义用户内容', () => {
  const tasks = [task({ id: 'near', title: '<script>任务</script>', startDate: '2026-09-01', dueDate: '2026-09-10' }), task({ id: 'far', startDate: '2030-01-01', dueDate: '2030-01-30' }), task({ id: 'missing', startDate: '', dueDate: '' }), task({ id: 'done', status: '已完成', dueDate: '2026-09-10' }), task({ id: 'stop', status: 'terminated', dueDate: '2026-09-10' })];
  const html = renderTimeline({ state: state(), tasks, users: [{ id: 'u1', name: '<成员>' }], today, project: { milestones: [{ name: '<验收>', date: '2026-09-20' }, { name: '未来节点', date: '2030-01-20' }] } });
  const table = html.slice(html.indexOf('<table'));
  for (const item of tasks) assert.ok(table.includes(`data-task="${item.id}"`));
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;任务&lt;/script&gt;'));
  assert.ok(html.includes('&lt;成员&gt;')); assert.ok(html.includes('&lt;验收&gt;'));
  assert.match(html, /逾期未完成<\/span><strong>1<small>/);
  assert.match(html, /待完善日期<\/span><strong>1<small>/);
  assert.match(html, /里程碑<\/span><strong>2<small>/);
  assert.ok(!html.includes('draggable='));
  assert.equal((html.match(/class="schedule-bar /g) || []).length, 4);
});

test('时间线只覆盖项目排期跨度，拖动不会进入无排期的时间', () => {
  const tasks = [task({ startDate: '2026-09-01', dueDate: '2026-09-30' }), task({ id: 'b', startDate: '2026-11-01', dueDate: '2026-12-01' })];
  const extent = resolveTimelineExtent({ tasks, today, project: { milestones: [{ label: '上线', date: '2026-12-15' }] } });
  assert.deepEqual([extent.dataStart, extent.dataEnd], ['2026-09-01', '2026-12-15']);
  assert.ok(extent.start < '2026-09-01' && extent.start >= '2026-08-25');
  assert.ok(extent.end > '2026-12-15' && extent.end <= '2026-12-22');
  const html = renderTimeline({ state: state(), tasks, today, viewportWidth: 1000 });
  const px = Number(html.match(/data-px="([^"]+)"/)[1]), days = Number(html.match(/data-extent-days="(\d+)"/)[1]);
  assert.ok(Math.abs(Number(html.match(/--track:([\d.]+)px/)[1]) - Math.max(1000, days * px)) < .01);
  const none = resolveTimelineExtent({ tasks: [task({ startDate: '', dueDate: '' })], today });
  assert.equal(none.empty, true); assert.deepEqual([none.start, none.end], ['2026-09-01', '2026-09-30']);
});

test('缩放在全局与上限之间，全局一屏显示全部，放大后刻度切换为日并显示短任务文字', () => {
  const tasks = [task({ id: 'short', title: '短任务', startDate: '2026-09-02', dueDate: '2026-09-03' }), task({ id: 'long', startDate: '2026-01-01', dueDate: '2027-12-31' })];
  const extent = resolveTimelineExtent({ tasks, today });
  const fit = resolveTimelineZoom(state({ fit: true }), extent, 1000);
  assert.equal(fit.isFit, true); assert.ok(Math.abs(fit.trackWidth - 1000) < 1e-6);
  assert.equal(resolveTimelineZoom(state({ zoom: 0.0001 }), extent, 1000).px, fit.px);
  const max = resolveTimelineZoom(state({ zoom: 10_000 }), extent, 1000);
  assert.ok(max.px <= TIMELINE_LIMITS.maxDayPx && max.trackWidth <= TIMELINE_LIMITS.maxChartPx + 1);
  assert.equal(buildTimelineScale(extent, fit.px).unit, 'month');
  assert.equal(buildTimelineScale(extent, 30).unit, 'day');
  const zoomedOut = renderTimeline({ state: state({ fit: true }), tasks, today, viewportWidth: 1000 });
  assert.match(zoomedOut, /data-timeline-fit aria-pressed="true"/); assert.match(zoomedOut, /aria-label="缩小" title="[^"]*" disabled/);
  assert.match(zoomedOut, /class="schedule-bar-label/);
  const zoomedIn = renderTimeline({ state: state({ zoom: 96 }), tasks, today, viewportWidth: 1000 });
  assert.ok(zoomedIn.includes('<span>短任务</span>'));
});

test('超长项目全局视图只生成有限刻度，真实开始结束仍完整显示', () => {
  const tasks = [task({ startDate: '1950-01-01', dueDate: '2150-12-31' })];
  const html = renderTimeline({ state: state({ fit: true }), today, tasks });
  assert.ok((html.match(/class="schedule-tick/g) || []).length <= 61);
  assert.ok(html.includes('1950-01-01')); assert.ok(html.includes('2150-12-31'));
  assert.ok(html.length < 50_000);
  const extent = resolveTimelineExtent({ tasks, today });
  for (const zoom of [undefined, 0.5, 5, 96]) {
    const result = resolveTimelineZoom(state({ zoom }), extent, 1200), scale = buildTimelineScale(extent, result.px);
    assert.ok(result.trackWidth <= TIMELINE_LIMITS.maxChartPx + 1); assert.ok(scale.lower.length <= 2000 && scale.upper.length <= 2000);
  }
});

test('搜索任务和负责人仅影响显示内容，排期跨度不随搜索改变', () => {
  const tasks = [task({ id: 'visible', title: '接口开发', ownerId: 'u1' }), task({ id: 'future', title: '上线', ownerId: 'u2', startDate: '2030-01-01', dueDate: '2030-12-31' })];
  const html = renderTimeline({ state: state({ fit: true }), today, tasks, users: [{ id: 'u1', name: '李明' }], query: '李明' });
  assert.ok(html.includes('2030-12-31')); assert.ok(html.includes('data-task="visible"')); assert.ok(!html.includes('data-task="future"'));
  const empty = renderTimeline({ state: state(), today, tasks: [task({ startDate: '', dueDate: '' })] });
  assert.ok(empty.includes('暂无已排期任务')); assert.ok(empty.includes('data-timeline-date="anchor"'));
});

test('公元 1 年到 9999 年边界始终返回有效日期，时间线在边界不越界', () => {
  for (const mode of ['week', 'month', 'quarter', 'custom']) {
    for (const [anchor, direction] of [['0001-01-01', -1], ['9999-12-31', 1]]) {
      const initial = state({ mode, anchor, start: anchor, end: anchor });
      const current = moveTimeline(initial, direction, { today });
      assert.deepEqual(current, initial);
      const r = resolveTimelineRange(current, { today });
      assert.notEqual(parseDay(r.start), null); assert.notEqual(parseDay(r.end), null);
    }
  }
  const extent = resolveTimelineExtent({ today, tasks: [task({ startDate: '0001-01-01', dueDate: '9999-12-31' })] });
  assert.deepEqual([extent.start, extent.end], ['0001-01-01', '9999-12-31']);
  assert.doesNotThrow(() => renderTimeline({ state: state({ fit: true }), today, tasks: [task({ startDate: '0001-01-01', dueDate: '9999-12-31' })] }));
  const shifted = moveTimeline(state({ mode: 'custom', start: '9999-12-20', end: '9999-12-29' }), 1, { today });
  assert.deepEqual([shifted.start, shifted.end], ['9999-12-22', '9999-12-31']);
  const todayShifted = moveTimeline(state({ mode: 'custom', start: '0001-01-01', end: '9999-12-31' }), 'today', { today });
  assert.equal(todayShifted.start, today); assert.equal(todayShifted.end, '9999-12-31');
});

test('手机全局视图按实际剩余轨道宽度适配，不强行扩到 200 像素',()=>{
  const extent=resolveTimelineExtent({project:{startDate:'2026-08-31',targetDate:'2026-12-31'},tasks:[],today});
  for(const width of [1,120,143,190,1094]){
    const zoom=resolveTimelineZoom(state({fit:true}),extent,width);
    assert.equal(zoom.isFit,true);assert.ok(Math.abs(zoom.trackWidth-width)<0.001);
    assert.ok(Math.abs(extent.days*zoom.px-width)<0.001);
  }
});
