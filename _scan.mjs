import fs from 'node:fs';
const p = 'C:/Users/24789/.qoder-cn/projects/D--gongfa/c209f96a-a3d2-4449-a037-987dbb619057.jsonl';
const out = [];
for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
  let j; try { j = JSON.parse(line); } catch { continue; }
  const m = j.message ?? j;
  if (m.role !== 'user') continue;
  const c = m.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : '';
  if (text.includes('批次 2') || text.includes('验收')) out.push(text);
}
console.log('=== 命中', out.length, '条 ===');
for (const t of out.slice(-3)) console.log('\n-----\n', t.slice(0, 6000));
