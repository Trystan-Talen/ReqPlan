// A deliberately small document reader, not a complete Markdown implementation.
// Raw HTML is always text; only markup assembled here reaches the document.
const MAX_CHARACTERS=200000,MAX_LINES=4000,MAX_OUTPUT=1000000,MAX_HEADINGS=200;
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const indent=line=>(/^\s*/.exec(line)?.[0]||'').replace(/\t/g,'    ').length;
function removeIndent(line,count) {
  let index=0,width=0;while(index<line.length&&width<count&&/[ \t]/.test(line[index])){width+=line[index]==='\t'?4:1;index++;}return line.slice(index);
}
function safeLink(raw) {
  const match=/^(?:<([^<>]+)>|(\S+))(?:\s+["'][^"']*["'])?$/.exec(raw.trim());
  const value=match?.[1]||match?.[2];if(!value||/[\u0000-\u0020\u007f]/.test(value))return null;
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
function inline(source,state,depth=0,links=true) {
  if(depth>5)return escape(source);
  let output='',position=0,steps=0;
  while(position<source.length) {
    if(++steps>10000){state.notices.add('复杂格式超过处理限制，剩余部分按原文显示。');output+=escape(source.slice(position));break;}
    const rest=source.slice(position);let match;
    if(rest[0]==='\\'&&rest.length>1&&/[\\`*_[\]{}()#+.!|>-]/.test(rest[1])){output+=escape(rest[1]);position+=2;continue;}
    if(rest[0]==='`') {
      const fence=/^`+/.exec(rest)[0];const end=source.indexOf(fence,position+fence.length);
      if(end>=0){output+=`<code>${escape(source.slice(position+fence.length,end))}</code>`;position=end+fence.length;continue;}
      output+=escape(fence);position+=fence.length;continue;
    }
    if((match=/^!\[([^\]\n]{0,500})\]\(([^)\n]{0,2000})\)/.exec(rest))) {
      output+=`<span class="document-image">[图片：${escape(match[1]||'未命名图片')}；预览不加载图片]</span>`;position+=match[0].length;continue;
    }
    if(links&&(match=/^\[([^\]\n]{1,500})\]\(([^)\n]{1,2000})\)/.exec(rest))) {
      const href=safeLink(match[2]),label=inline(match[1],state,depth+1,false);
      output+=href?`<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`:`<span class="document-inactive-link">${label}（链接未启用）</span>`;
      position+=match[0].length;continue;
    }
    const strong=rest.startsWith('**')?'**':rest.startsWith('__')?'__':null;
    if(strong){const end=source.indexOf(strong,position+2);if(end>position+2){output+=`<strong>${inline(source.slice(position+2,end),state,depth+1,links)}</strong>`;position=end+2;continue;}}
    // Consume ordinary text together, keeping malformed input processing linear
    // apart from bounded 500-character label / 2000-character URL scans.
    const ordinary=/^[^\\`!\[*_]+/.exec(rest)?.[0];
    if(ordinary){output+=escape(ordinary);position+=ordinary.length;}else{output+=escape(rest[0]);position++;}
  }
  return output;
}
function tableCells(line) {
  let text=line.trim();if(text.startsWith('|'))text=text.slice(1);if(/(?<!\\)\|$/.test(text))text=text.slice(0,-1);
  const cells=[];let current='',code=0;
  for(let index=0;index<text.length;index++) {
    if(text[index]==='\\'&&index+1<text.length){current+=text[index]+text[++index];continue;}
    if(text[index]==='`'){const fence=/^`+/.exec(text.slice(index))[0];if(!code)code=fence.length;else if(code===fence.length)code=0;current+=fence;index+=fence.length-1;continue;}
    if(text[index]==='|'&&!code){cells.push(current.trim());current='';}else current+=text[index];
  }
  cells.push(current.trim());return cells;
}
const listMatch=line=>/^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
const fenceMatch=line=>/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const headingMatch=line=>/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
const divider=line=>tableCells(line).every(cell=>/^:?-{3,}:?$/.test(cell));
const startsBlock=line=>Boolean(headingMatch(line)||fenceMatch(line)||listMatch(line)||/^ {0,3}>/.test(line));
function headingText(value){return value.replace(/!\[([^\]]*)\]\([^)]*\)/g,'图片：$1').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[`*_]/g,'').slice(0,160);}
function blocks(lines,state,depth=0) {
  if(depth>8){state.notices.add('缩进或引用超过 8 层，深层内容按原文显示。');return `<pre>${escape(lines.join('\n'))}</pre>`;}
  const output=[];let index=0;
  while(index<lines.length) {
    const line=lines[index];if(!line.trim()){index++;continue;}
    let match;
    if((match=fenceMatch(line))) {
      const fence=match[1],label=match[2].trim().slice(0,80),content=[];index++;
      const closing=new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
      while(index<lines.length&&!closing.test(lines[index]))content.push(lines[index++]);if(index<lines.length)index++;
      output.push(`<div class="document-code">${label?`<p class="document-code-label">${escape(label)}</p>`:''}<pre><code>${escape(content.join('\n'))}</code></pre></div>`);continue;
    }
    if((match=headingMatch(line))) {
      const level=match[1].length,title=match[2].replace(/\s+#+\s*$/,'');const id=`doc-heading-${++state.headingCount}`;
      if(state.headings.length<MAX_HEADINGS)state.headings.push({level,id,title:headingText(title)});else state.notices.add('目录仅列出前 200 个标题，正文仍可继续阅读。');
      output.push(`<h${level} id="${id}" tabindex="-1">${inline(title,state)}</h${level}>`);index++;continue;
    }
    if(/^ {0,3}>/.test(line)) {
      const quote=[];while(index<lines.length&&/^ {0,3}>/.test(lines[index]))quote.push(lines[index++].replace(/^ {0,3}>[ \t]?/,''));
      output.push(`<blockquote>${blocks(quote,state,depth+1)}</blockquote>`);continue;
    }
    if((match=listMatch(line))) {
      const base=indent(match[1]),ordered=/^\d/.test(match[2]),start=ordered?parseInt(match[2],10):null,items=[];
      while(index<lines.length) {
        const item=listMatch(lines[index]);if(!item||indent(item[1])!==base||/^\d/.test(item[2])!==ordered)break;
        const content=[item[3]],padding=base+item[2].length+1;index++;
        while(index<lines.length) {
          if(!lines[index].trim()){content.push('');index++;continue;}
          if(indent(lines[index])<=base)break;
          content.push(removeIndent(lines[index++],padding));
        }
        items.push(`<li>${blocks(content,state,depth+1)}</li>`);
      }
      const tag=ordered?'ol':'ul';output.push(`<${tag}${ordered&&start!==1?` start="${start}"`:''}>${items.join('')}</${tag}>`);continue;
    }
    if(index+1<lines.length&&line.includes('|')&&divider(lines[index+1])) {
      const allHeaders=tableCells(line),headers=allHeaders.slice(0,32),alignments=tableCells(lines[index+1]).slice(0,32).map(cell=>cell.startsWith(':')&&cell.endsWith(':')?'center':cell.endsWith(':')?'right':'left');
      if(allHeaders.length>32)state.notices.add('宽表格仅展示前 32 列，请下载查看完整表格。');
      const tableRows=[];index+=2;
      while(index<lines.length&&lines[index].trim()&&lines[index].includes('|')&&!startsBlock(lines[index])) {
        const row=tableCells(lines[index++]);if(row.length>32)state.notices.add('宽表格仅展示前 32 列，请下载查看完整表格。');
        tableRows.push(`<tr>${headers.map((_header,column)=>`<td class="document-align-${alignments[column]||'left'}">${inline(row[column]||'',state)}</td>`).join('')}</tr>`);
      }
      output.push(`<div class="table-wrap"><table><thead><tr>${headers.map((header,column)=>`<th scope="col" class="document-align-${alignments[column]||'left'}">${inline(header,state)}</th>`).join('')}</tr></thead><tbody>${tableRows.join('')}</tbody></table></div>`);continue;
    }
    const paragraph=[line];index++;
    while(index<lines.length&&lines[index].trim()&&!startsBlock(lines[index])&&!(index+1<lines.length&&lines[index].includes('|')&&divider(lines[index+1])))paragraph.push(lines[index++]);
    output.push(`<p>${inline(paragraph.join('\n'),state)}</p>`);
  }
  return output.join('\n');
}
function compose(source,limited) {
  const state={headings:[],headingCount:0,notices:new Set()};const body=blocks(source.split('\n'),state);
  if(limited)state.notices.add('文档较长，当前仅展示部分内容。预览最多处理 20 万字符、4000 行，生成内容最多 100 万字符；请下载原文件查看全文。');
  const notices=[...state.notices].map(text=>`<p class="document-preview-notice" role="note">${escape(text)}</p>`).join('');
  const toc=state.headings.length?`<nav class="document-toc" aria-label="文档目录"><h2>文档目录</h2><ol>${state.headings.map(heading=>`<li class="document-toc-level-${heading.level}"><button type="button" data-document-anchor="${heading.id}">${escape(heading.title||'未命名标题')}</button></li>`).join('')}</ol></nav>`:'';
  return `<div class="document-preview">${notices}${toc}<div class="document-body">${body||'<p>文档为空。</p>'}</div></div>`;
}

export function renderDocumentPreview(text) {
  if(text===null||text===undefined)text='';
  if(typeof text!=='string')return '<div class="document-preview"><p>无法预览：文件内容不是文本。</p></div>';
  const normalized=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\u0000/g,'\ufffd');
  let source=normalized.slice(0,MAX_CHARACTERS).split('\n').slice(0,MAX_LINES).join('\n');let limited=source.length!==normalized.length;
  let html=compose(source,limited);
  // Re-render a shorter source instead of slicing HTML, so every truncation
  // preserves complete tags, safe attributes and valid navigation targets.
  while(html.length>MAX_OUTPUT){source=source.slice(0,Math.floor(source.length*0.75));limited=true;html=compose(source,limited);}
  return html;
}
