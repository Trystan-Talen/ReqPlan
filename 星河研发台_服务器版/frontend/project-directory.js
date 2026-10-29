import { esc, badge, personChip } from './ui-kit.js';

// 仅存本浏览器中每个账号的显示偏好，不保存项目内容、搜索词或归档筛选。
export function createProjectLayoutPreferences(storage = () => globalThis.localStorage) {
  const layouts = new Map();
  const key = userId => `xinghe:projects-layout:${encodeURIComponent(userId)}`;
  return {
    get(userId) {
      if (!userId) return 'card';
      if (!layouts.has(userId)) {
        let saved;
        try { saved = storage()?.getItem(key(userId)); } catch (_) {}
        layouts.set(userId, saved === 'list' ? 'list' : 'card');
      }
      return layouts.get(userId);
    },
    set(userId, layout) {
      if (!userId || !['card', 'list'].includes(layout)) return false;
      layouts.set(userId, layout);
      try { storage()?.setItem(key(userId), layout); } catch (_) {}
      return true;
    }
  };
}

// 项目集合、统计和权限均由页面传入，与原卡片使用同一份已授权数据。
export function renderProjectTable(projects, { summaryOf, nameOf, roleOf, projectPath }) {
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="项目目录表格，可横向滚动"><p class="table-scroll-hint">左右滑动查看全部列，最右侧可进入项目。</p><table class="data-table project-directory-table"><caption class="sr-only">可访问项目列表；任务完成率不含已终止任务</caption><thead><tr><th scope="col">项目</th><th scope="col">状态</th><th scope="col">负责人</th><th scope="col">我的角色</th><th scope="col">目标交付</th><th scope="col">需求 / 任务</th><th scope="col">任务完成率</th><th scope="col"><span class="sr-only">进入项目</span></th></tr></thead><tbody>${projects.map(project => {
    const { reqs, tasks, eligible, completed, percent } = summaryOf(project);
    const completion = eligible.length ? `${percent}% · ${completed} / ${eligible.length}` : tasks.length ? '任务均已终止' : '暂无任务';
    return `<tr><td class="project-list-title"><strong>${esc(project.name)}</strong><span class="item-meta" title="${esc(project.description || '尚未填写项目说明')}">${esc(project.description || '尚未填写项目说明')}</span></td><td>${project.status ? badge(project.status) : '未设置'}</td><td>${personChip(project.ownerId, nameOf(project.ownerId))}</td><td>${esc(roleOf(project.id))}</td><td>${esc(project.targetDate ? String(project.targetDate).slice(0, 10) : '未设置')}</td><td class="num-cell">${reqs.length} 项 / ${tasks.length} 个</td><td class="num-cell">${completion}</td><td class="action-cell"><a class="section-link" href="${esc(projectPath(project.id))}" aria-label="进入项目：${esc(project.name)}">进入项目 →</a></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
