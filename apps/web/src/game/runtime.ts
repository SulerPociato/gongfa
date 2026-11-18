import actionsJson from '../../../../content/actions.json';
import realmsJson from '../../../../content/realms.json';
import { BASE_BUDGET, TICKS_PER_SEC, Vm, loadContent, makeActionSink, Scheduler, type Program, type StallEvent, type TickResult, type VmSnapshot } from '@gongfa/core';

const content = loadContent({ actions: actionsJson, realms: realmsJson });

// P0 只有炼气一个境界（任务 6.5 才让境界推进）；realmIndex 写死，产出数学全在 core 的 sink 里。
const REALM_INDEX = 0;

export interface RuntimeState {
  readonly qi: number;
  readonly demon: number;
  readonly rate: number;
  readonly ticks: number;
  readonly stall: StallEvent | null;
}

export interface Runtime {
  run(dtMs: number): TickResult[];
  /** 装载一份程序；返回错误列表（空数组表示成功）。失败时回退到上一份可用程序。 */
  load(program: Program): readonly string[];
  state(): RuntimeState;
}

// debug only：?demon=0.49 把心魔种子挪到 0.5 附近，方便当场看分支切换；正式 UI 不出现这个参数。
function seedDemon(): number {
  const raw = Number(new URLSearchParams(window.location.search).get('demon'));
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

export function createRuntime(): Runtime {
  const sink = makeActionSink({ content, realmIndex: REALM_INDEX });
  const state = { qi: 0, demon: seedDemon(), rate: 0, ticks: 0, stall: null as StallEvent | null };

  const vm = new Vm({
    content,
    sink,
    // VM 每 tick 开头读一次快照：宿主的 qi / demon 在这里进 LOAD，分支判断用的就是本 tick 起点的最新值。
    vars: (): VmSnapshot => ({ qi: state.qi, rate: state.rate, demon: state.demon, realm: REALM_INDEX, budget: BASE_BUDGET }),
    onEvent: (event) => {
      if (event.t === 'stall') state.stall = event;
      console.warn('[event]', event);
    },
  });
  const scheduler = new Scheduler({
    vm,
    // 契约 §1：单帧最多补 5 tick，剩余转离线结算（任务 8 接入），这里只报告，不静默快进。
    onOverflowToOffline: (pendingMs) => console.warn(`[补帧溢出] 未补 ${Math.round(pendingMs)} ms，转离线结算`),
  });
  let lastGood: Program | null = null;

  return {
    run: (dtMs) => {
      const results = scheduler.advance(dtMs);
      for (const result of results) {
        state.qi += result.gain;
        // 心魔夹在 0..1；demon ≥ 1 的走火入魔惩罚（qi ×0.7、心魔归 0）在任务 6 实现，本轮只涨不罚。
        state.demon = Math.min(1, Math.max(0, state.demon + result.demonDelta));
        state.rate = result.gain * TICKS_PER_SEC;
        state.ticks += 1;
      }
      return results;
    },
    load: (program) => {
      const result = vm.loadPrograms([program]);
      if (!result.ok) {
        // core 的口径是「装载失败则一批都不装」，会把已装程序清空；宿主在这里退回上一份，玩家拖坏一块不该让数字停住。
        if (lastGood !== null) vm.loadPrograms([lastGood]);
        return result.errors.map((issue) => issue.message);
      }
      lastGood = program;
      // 装上一份合法程序即认为故障已排除，旧的 stall 不该继续挂在 HUD 上。
      state.stall = null;
      return [];
    },
    state: () => ({ ...state }),
  };
}
