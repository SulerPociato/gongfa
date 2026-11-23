import { describe, expect, it } from 'vitest';
import json from '../../../../content/algorithms.json';
import { PATTERNS, PATTERN_TOTAL, patternDef } from './pattern';

// 映射表的唯一真相是 content/algorithms.json。
// 这条测试保证「JSON 的 id 集合 == 代码里的 PatternId 联合类型」：
// 以后加图案只改 JSON 会缺判据、只改代码会缺文案，两边都会在这里红。
describe('算法↔修仙映射表（content/algorithms.json）', () => {
  it('表里的 id 不重复', () => {
    const ids = json.patterns.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条都有名字、算法名、要求与一句教学说明', () => {
    for (const p of json.patterns) {
      expect(p.name.length, p.id).toBeGreaterThan(0);
      expect(p.algorithm.length, p.id).toBeGreaterThan(0);
      expect(p.requires.length, p.id).toBeGreaterThan(0);
      expect(p.teach.length, p.id).toBeGreaterThan(8);
    }
  });

  it('PATTERNS 与 JSON 同源同序', () => {
    expect(PATTERNS.map((p) => p.id)).toEqual(json.patterns.map((p) => p.id));
    expect(PATTERN_TOTAL).toBe(json.patterns.length);
  });

  it('每个 id 都能查到定义（未知 id 抛 RangeError）', () => {
    for (const p of json.patterns) {
      expect(patternDef(p.id as never).name).toBe(p.name);
    }
    expect(() => patternDef('nope' as never)).toThrow(RangeError);
  });
});
