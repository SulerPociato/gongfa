import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { loadContent, makeActionSink, Scheduler, Vm, type Program, type TickResult } from '@gongfa/core';

const content = loadContent({ actions: actionsJson, realms: realmsJson });

// P0 只有炼气一个境界（任务 6.5 才让境界推进）；realmIndex 写死，产出数学全在 core 的 sink 里。
const REALM_INDEX = 0;

export interface Runtime {
  run(dtMs: number): TickResult[];
  /** 装载一份程序；返回错误列表（空数组表示成功）。失败时回退到上一份可用程序。 */
  load(program: Program): readonly string[];
}

export function createRuntime(): Runtime {
  const sink = makeActionSink({ content, realmIndex: REALM_INDEX });
  const vm = new Vm({
    content,
    sink,
    onEvent: (event) => console.warn('[stall]', event),
  });
  const scheduler = new Scheduler({
    vm,
    // 契约 §1：单帧最多补 5 tick，剩余转离线结算（任务 8 接入），这里只报告，不静默快进。
    onOverflowToOffline: (pendingMs) => console.warn(`[补帧溢出] 未补 ${Math.round(pendingMs)} ms，转离线结算`),
  });
  let lastGood: Program | null = null;

  return {
    run: (dtMs) => scheduler.advance(dtMs),
    load: (program) => {
      const result = vm.loadPrograms([program]);
      if (!result.ok) {
        // core 的口径是「装载失败则一批都不装」，会把已装程序清空；宿主在这里退回上一份，玩家拖坏一块不该让数字停住。
        if (lastGood !== null) vm.loadPrograms([lastGood]);
        return result.errors.map((issue) => issue.message);
      }
      lastGood = program;
      return [];
    },
  };
}
