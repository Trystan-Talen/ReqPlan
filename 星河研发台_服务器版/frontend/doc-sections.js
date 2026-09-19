// Section codes shared by the server (coverage, change detection) and the browser (anchors, chips).
// PRD headings carry a code in 〔…〕; technical specs use their numbering as §n.n;
// Gherkin acceptance files use the first @tag of each scenario (e.g. GW-AC-07).

export const DOCUMENT_TYPES = Object.freeze(['PRD', '原型', '技术方案', '验收用例', '其他']);
export const DOCUMENT_EXTENSIONS = Object.freeze({ '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.feature': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json' });

const BRACKET = /〔([A-Za-z0-9][\w.-]*)〕/;
const NUMBERED = /^(\d+(?:\.\d+)*)(?:\.|\s|$)/;
const headingOf = line => /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
const plainTitle = title => title.replace(BRACKET, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

export const isFeature = name => /\.feature$/i.test(String(name || ''));
export const isMarkdown = name => /\.(md|markdown)$/i.test(String(name || ''));

// Markdown documents whose headings carry 〔codes〕 are coded only by them, so numbered
// chapters such as "1. 目标" do not show up as uncovered sections.
export function markdownMode(text) { return String(text || '').split('\n').some(line => { const match = headingOf(line); return match && BRACKET.test(match[2]); }) ? 'bracket' : 'numbered'; }
export function headingCode(title, mode) {
  if (mode === 'bracket') return BRACKET.exec(title)?.[1] || '';
  const number = NUMBERED.exec(String(title).trim())?.[1];
  return number ? '§' + number : '';
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619) >>> 0; }
  return value.toString(16).padStart(8, '0');
}

/** 返回 [{ code, title, level, hash }]；hash 覆盖该章节及其子章节，用于判断新版本改了哪些章节。 */
export function parseSections(name, text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const found = [];
  if (isFeature(name)) {
    for (let index = 0; index < lines.length; index++) {
      const tags = lines[index].trim().split(/\s+/);
      if (!tags[0]?.startsWith('@') || !/^\s*Scenario/.test(lines[index + 1] || '')) continue;
      const code = tags[0].slice(1), reqs = tags.filter(tag => tag.startsWith('@req:')).map(tag => tag.slice(5));
      let end = index + 2; while (end < lines.length && !lines[end].trim().startsWith('@')) end++;
      found.push({ code, title: (lines[index + 1] || '').replace(/^\s*Scenario( Outline)?:\s*/, '').trim(), level: 2, reqs, hash: hash(lines.slice(index, end).join('\n')) });
    }
    return found;
  }
  if (!isMarkdown(name)) return found;
  const mode = markdownMode(source);
  let fence = false;
  const headings = [];
  lines.forEach((line, index) => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    const match = !fence && headingOf(line);
    if (match) headings.push({ index, level: match[1].length, title: match[2] });
  });
  headings.forEach((heading, position) => {
    const code = headingCode(heading.title, mode); if (!code) return;
    const next = headings.slice(position + 1).find(item => item.level <= heading.level);
    found.push({ code, title: plainTitle(heading.title.replace(/^\d+(?:\.\d+)*[a-z]?\.?(?:\s+|$)/, '')) || plainTitle(heading.title), level: heading.level, hash: hash(lines.slice(heading.index, next ? next.index : lines.length).join('\n')) });
  });
  const seen = new Set();
  return found.filter(item => !seen.has(item.code) && seen.add(item.code));
}

/** 与上一版比较：新增、删除或内容变化的章节编号。 */
export function changedSections(previous = [], current = []) {
  const before = new Map(previous.map(item => [item.code, item.hash]));
  const after = new Map(current.map(item => [item.code, item.hash]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(code => before.get(code) !== after.get(code));
}

/** 需求在某份文档里引用的章节（验收用例文档按用例编号匹配）。 */
export function referencedSections(requirement, document) {
  const refs = (requirement.docRefs || []).filter(ref => ref.document === document.name);
  if (!refs.length) return [];
  if (document.type === '验收用例') {
    const cases = new Set(requirement.acceptanceCases || []);
    return (document.sections || []).map(item => item.code).filter(code => cases.has(code));
  }
  return [...new Set(refs.flatMap(ref => ref.sections || []))];
}

// A section counts as covered when a requirement references it, one of its sub-sections
// (GW-3 ← GW-3.1, §9 ← §9.1) or its parent (a reference to §9 includes §9.1).
const related = (code, reference) => code === reference || code.startsWith(reference + '.') || reference.startsWith(code + '.');
/** Map(章节编号 → 引用它的需求[])；文档没有被任何需求引用时返回空 Map。 */
export function sectionCoverage(document, requirements) {
  const coverage = new Map((document.sections || []).map(item => [item.code, []]));
  for (const requirement of requirements) {
    const references = referencedSections(requirement, document); if (!references.length) continue;
    for (const [code, list] of coverage) if (references.some(reference => related(code, reference))) list.push(requirement);
  }
  return [...coverage.values()].some(list => list.length) ? coverage : new Map();
}
/**
 * 需求引用的章节中，本版有修改的那些（引用章节自身或其子章节有变化）。
 * 父章节的哈希包含子章节，所以不能反过来按父章节判断，否则改一个子章节会提醒所有兄弟章节的需求。
 */
export function affectedSections(requirement, document) {
  const changed = document.changedSections || [];
  return referencedSections(requirement, document).filter(reference => changed.some(code => code === reference || code.startsWith(reference + '.')));
}
