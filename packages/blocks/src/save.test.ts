import { describe, expect, it } from 'vitest';
import { decodeSave, serializeSave, type GameState } from '@gongfa/core';
import type { Op } from '@gongfa/core/vm';
import fixtureJson from '../../core/src/save/fixtures/save-v1.json';
import { compileWorkspace, type WorkspaceJson } from './compiler';

// 契约 §5.3：迁移测试读真实 fixture，不构造新对象。
// 这份 save-v1.json 是从浏览器 localStorage 里原样抓出来的（gongfa:active=A 指向的那份，2026-11-19 任务 5A 验收），
// workspace 就是验收 1 的 6 块程序（入口 + 如果 + 比较 + 调息 + 循环 + 吐纳），字段类型（THRESHOLD/NUM 是 number）也是 Blockly 原生输出。
// programs 是同一份工作区当场编译出来的缓存：它可以对得上，但读档一律不读它。
const FIXTURE = fixtureJson as unknown as { schemaVersion: number; savedAt: number; state: GameState };
const ACTION_CALM: Op = { op: 'ACTION', actionId: 'calm' };
const ACTION_BREATH: Op = { op: 'ACTION', actionId: 'breath' };

describe('真实 v1 fixture 直通（任务 5A）', () => {
  it('不经任何迁移就能读：stage=null、errors=[]', () => {
    const result = decodeSave(serializeSave({ schemaVersion: 1, savedAt: FIXTURE.savedAt, state: FIXTURE.state }));

    expect(result.ok).toBe(true);
    expect(result.stage).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.save?.state.schemaVersion).toBe(1);
    expect(result.save?.state.realm).toBeTypeOf('number');
  });

  it('fixture 的 workspace 编译结果与验收 1 的 10 条 IR 逐条相等', () => {
    const result = compileWorkspace(FIXTURE.state.workspace as WorkspaceJson);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.program?.code).toEqual([
      { op: 'LOAD', key: 'demon' },
      { op: 'PUSH', value: 0.5 },
      { op: 'CMP', arg: '>' },
      { op: 'JMP_IF_FALSE', target: 6 },
      ACTION_CALM,
      { op: 'JMP', target: 9 },
      { op: 'LOOP_BEGIN', end: 8, count: 3 },
      ACTION_BREATH,
      { op: 'LOOP_END', begin: 6 },
      { op: 'HALT' },
    ]);
    expect(result.program?.code.length).toBe(10);
  });

  it('序列化往返不损精度：qi / stats.totalQi 逐字段回原样', () => {
    const text = serializeSave({ schemaVersion: 1, savedAt: FIXTURE.savedAt, state: FIXTURE.state });
    const reparsed = decodeSave(text);

    expect(reparsed.ok).toBe(true);
    expect(reparsed.save).toEqual({ schemaVersion: 1, savedAt: FIXTURE.savedAt, state: FIXTURE.state });
    expect(reparsed.save?.state.qi).toBe(FIXTURE.state.qi);
    expect(reparsed.save?.state.stats.totalQi).toBe(FIXTURE.state.stats.totalQi);
    expect(reparsed.save?.state.workspace).toEqual(FIXTURE.state.workspace);
  });
});
