import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, readSettings, SETTINGS_KEY, writeSettings, type GameSettings } from './settings';
import type { SaveStorage } from '../save/storage';

// 设置走存档同一个 keyed 端口（架构 §2.6）：core 不认 localStorage，web 侧的适配器才认。
function memoryStorage(initial: Record<string, string> = {}): SaveStorage & { dump: () => Record<string, string | null> } {
  const map = new Map(Object.entries(initial));
  return {
    read: (key) => map.get(key) ?? null,
    write: (key, value) => {
      map.set(key, value);
      return true;
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
    dump: () => Object.fromEntries([...map.entries()].map(([key, value]) => [key, value])),
  };
}

describe('parseSettings（契约 §7.1「离线开关默认关闭」）', () => {
  it('没有键就是默认：不报错', () => {
    expect(parseSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, errors: [] });
    expect(DEFAULT_SETTINGS.offlineBreakthrough).toBe(false);
  });

  it('坏 JSON / 非对象：回落默认并留下一句原因', () => {
    expect(parseSettings('{').settings).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{').errors.join(' ')).toContain('不是合法 JSON');
    expect(parseSettings('[true]').errors.join(' ')).toContain('需要对象');
    expect(parseSettings('7').errors.join(' ')).toContain('需要对象');
  });

  it('只认布尔值：非布尔回落默认并说明收到什么', () => {
    expect(parseSettings('{"offlineBreakthrough":"yes"}').settings.offlineBreakthrough).toBe(false);
    expect(parseSettings('{"offlineBreakthrough":"yes"}').errors.join(' ')).toContain('需要 true 或 false');
    expect(parseSettings('{"offlineBreakthrough":null}').errors.length).toBe(1);
  });

  it('认得的值照单收下，认不出的键留一句提示（手改错键名不能静默）', () => {
    expect(parseSettings('{"offlineBreakthrough":true}').settings).toEqual({ offlineBreakthrough: true });
    const odd = parseSettings('{"offlineBreakthrough":true,"offlinBreakthrough":true}');
    expect(odd.settings).toEqual({ offlineBreakthrough: true });
    expect(odd.errors.join(' ')).toContain('未识别的设置项 offlinBreakthrough');
  });
});

describe('readSettings / writeSettings', () => {
  it('读写往返用 gongfa:settings，与存档槽互不干涉', () => {
    const storage = memoryStorage({ 'gongfa:save:A': '{"schemaVersion":1}' });
    expect(SETTINGS_KEY).toBe('gongfa:settings');
    expect(readSettings(storage).settings).toEqual(DEFAULT_SETTINGS);

    const settings: GameSettings = { offlineBreakthrough: true };
    expect(writeSettings(storage, settings)).toBe(true);
    expect(storage.dump()['gongfa:settings']).toBe('{"offlineBreakthrough":true}');
    expect(readSettings(storage).settings).toEqual(settings);
    // 设置绝不写进存档槽：schema v1 没有这个字段，塞进去下次读档就被结构校验整份打回
    expect(storage.dump()['gongfa:save:A']).toBe('{"schemaVersion":1}');
  });

  it('写入失败（配额满 / 隐私模式）返回 false，调用方自己决定怎么提示', () => {
    const broken: SaveStorage = { read: () => null, write: () => false, remove: () => undefined, keys: () => [] };
    expect(writeSettings(broken, DEFAULT_SETTINGS)).toBe(false);
    expect(readSettings(broken).settings).toEqual(DEFAULT_SETTINGS);
  });
});
