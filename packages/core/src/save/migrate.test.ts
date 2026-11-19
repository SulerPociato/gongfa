import { describe, expect, it } from 'vitest';
// 契约 §5.3：迁移测试读真实存档，不构造新对象。
// fixtures/save-v1.json 是 2026-11-19 从本机浏览器 localStorage 的活动槽（gongfa:active 指向的那份）原样抓出来的：
// 验收 1 的 6 块程序在 :4173 生产构建里真跑过一段（qi 3993.566666666691、demon 0.3818、playMs 480847.6），
// 由 App 的自动存档写盘，seed 201159834 是脚本种入的 uint32。
// 编译等值断言在 packages/blocks/src/save.test.ts。
import fixture from './fixtures/save-v1.json';
import { MIGRATIONS, migrate } from './migrate';
import { decodeSave } from './storage';

function bumpTo(next: number) {
  return (old: unknown): unknown => ({ ...(old as Record<string, unknown>), schemaVersion: next, state: { ...(old as { state: Record<string, unknown> }).state, schemaVersion: next } });
}

describe('迁移骨架（契约 §5.2 第 1–2 步）', () => {
  it('MIGRATIONS 空表：v1 原样通过，内容一字不改', () => {
    const raw = JSON.parse(JSON.stringify(fixture));
    expect(Object.keys(MIGRATIONS)).toEqual([]);

    const result = migrate(raw);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.from).toBe(1);
    expect(result.to).toBe(1);
    expect(result.value).toEqual(raw);
  });

  it('注入迁移表后按版本连续迁移；缺中间步与超前版本各自报错', () => {
    const raw = JSON.parse(JSON.stringify(fixture));

    const chained = migrate(raw, { 1: bumpTo(2), 2: bumpTo(3) });
    expect(chained.ok).toBe(true);
    expect(chained.to).toBe(3);
    expect((chained.value as { state: { schemaVersion: number } }).state.schemaVersion).toBe(3);

    const gap = migrate(raw, { 2: bumpTo(3) });
    expect(gap.ok).toBe(false);
    expect(gap.errors.join(' ')).toContain('无法从 1 迁到 2');

    const future = migrate({ ...raw, schemaVersion: 2, state: { ...raw.state, schemaVersion: 2 } });
    expect(future.ok).toBe(false);
    expect(future.errors.join(' ')).toContain('比本程序支持的版本新');
  });

  it('真实 v1 fixture 直通：envelope → 迁移 → 校验一次过', () => {
    const result = decodeSave(JSON.stringify(fixture));

    expect(result.ok).toBe(true);
    expect(result.stage).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.save?.schemaVersion).toBe(1);
    expect(result.save?.state.schemaVersion).toBe(1);
    // 真相源在场，且是改名后的 gongfa_* 块型（compile 阶段断言由 packages/blocks 负责）
    const workspace = result.save?.state.workspace as { blocks: { blocks: { type: string }[] } };
    expect(workspace.blocks.blocks[0]?.type).toBe('tick_hat');
    expect(JSON.stringify(workspace)).toContain('gongfa_if');
    expect(JSON.stringify(workspace)).toContain('gongfa_repeat');
    expect(JSON.stringify(workspace)).toContain('gongfa_compare');
  });
});
