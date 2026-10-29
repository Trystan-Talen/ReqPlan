import { transaction, writeAudit } from './database.mjs';
import { DELIVERY_REQUIREMENT_STATUSES, requirementDeliveryState } from '../frontend/workflow.js';

const MIGRATION = 'delivery_workflow_v1';
const OPEN_STATUSES = new Set(DELIVERY_REQUIREMENT_STATUSES.filter(status => !['已完成', '已终止'].includes(status)));

/** Adopt automatic delivery before serving requests, including restored legacy data.
 * Repeated starts are a no-op once the persisted stage agrees with the tasks.
 * Only the stage and workflow flag change; historical content and commitments stay intact.
 */
export function reconcileDeliveryWorkflow(db) {
  return transaction(db, () => {
    const rows = db.prepare('SELECT * FROM requirements ORDER BY id').all();
    const activeProjects = new Set(db.prepare('SELECT id FROM projects WHERE archived=0').all().map(row => row.id));
    const requirements = new Map(rows.map(row => [row.id, {
      ...JSON.parse(row.data), id: row.id, projectId: row.project_id, archived: Boolean(row.archived)
    }]));
    const candidates = rows.filter(row => activeProjects.has(row.project_id) && !row.archived && OPEN_STATUSES.has(requirements.get(row.id).status));
    const result = { updated: 0, transitions: 0 };
    if (!candidates.length) return result;

    const tasksByRequirement = new Map();
    for (const row of db.prepare('SELECT * FROM tasks WHERE archived=0 AND requirement_id IS NOT NULL').all()) {
      const requirement = requirements.get(row.requirement_id);
      if (!requirement || requirement.projectId !== row.project_id) continue;
      const tasks = tasksByRequirement.get(row.requirement_id) || [];
      tasks.push({ ...JSON.parse(row.data), id: row.id, requirementId: row.requirement_id, archived: false });
      tasksByRequirement.set(row.requirement_id, tasks);
    }

    const update = db.prepare('UPDATE requirements SET data=?,version=version+1,updated_at=? WHERE id=? AND version=?');
    const stamp = new Date().toISOString();
    for (const row of candidates) {
      const original = JSON.parse(row.data), before = requirements.get(row.id);
      const dependencyIds = Array.isArray(before.dependencyIds) ? before.dependencyIds : [];
      const dependencies = dependencyIds.map(id => requirements.get(id)).filter(item => item?.projectId === row.project_id);
      const state = requirementDeliveryState({ ...before, dependencyIds, deliveryWorkflow: true }, tasksByRequirement.get(row.id) || [], dependencies);
      if (original.deliveryWorkflow === true && original.status === state.status) continue;
      const after = { ...original, deliveryWorkflow: true, status: state.status };
      if (update.run(JSON.stringify(after), stamp, row.id, row.version).changes !== 1) throw new Error('旧需求状态校准遇到版本冲突，已回滚本次校准。');
      const transitioned = original.status !== after.status;
      writeAudit(db, null, transitioned ? 'transition' : 'update', 'requirement', row.id, {
        projectId: row.project_id, actorName: '系统升级', automatic: true, migration: MIGRATION,
        reason: '服务启动时按关联任务校准旧需求阶段；最终验收仍由人工确认。',
        before: { ...before, version: row.version, updatedAt: row.updated_at },
        after: { ...after, id: row.id, projectId: row.project_id, archived: false, version: row.version + 1, updatedAt: stamp }
      });
      result.updated++;
      if (transitioned) result.transitions++;
    }
    return result;
  });
}
