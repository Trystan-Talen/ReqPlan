---
name: requirements-analysis
version: 1.0.0
description: 需求与算法文档分析、拆解、优先级和区间排期建议。
---

# 需求分析与拆解 Skill

## 原则
- 区分事实、假设、问题、约束与建议。
- 文档未明确内容必须标记为待确认。
- 技术方案不等于产品需求；需求必须有用户价值和验收标准。
- P0：不做会阻塞核心交付、合规或线上事故；P1：近期核心价值；P2：优化或可延后。
- 使用 1/2/3/5/8/13 points；超过 8 必须继续拆分或明确风险。
- 排期是区间建议，不是承诺；默认 1 产品 + 3 全栈，按每周 3 人×4 天有效投入并预留评审返工。

## 输出 JSON
```json
{"documentSummary":"","facts":[],"assumptions":[],"openQuestions":[],"requirements":[{"title":"","userValue":"","description":"","projectSuggestion":"","certainty":"未确定|待评审|已确定","priority":"P0|P1|P2","priorityReason":"","acceptanceCriteria":[],"tasks":[{"title":"","type":"产品|前端|后端|算法|数据|测试|发布","estimatePoints":1,"dependencies":[]}],"totalPoints":1,"risks":[]}],"schedule":{"capacityAssumption":"","sequence":[],"suggestion":"","rangeDays":{"min":0,"max":0}},"reviewChecklist":[]}
```

## 流程
解析文档 → 提取事实 → 识别问题 → 候选需求 → 去重拆分 → 优先级 → 任务估算 → 依赖风险 → 排期区间 → 人工确认。

## 禁止
禁止直接写入已确定需求；禁止编造用户、指标、接口或日期；禁止省略验收标准；禁止把排期建议写成承诺。
