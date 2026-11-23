/**
 * 任务 10：参考程序数值调平。
 * 
 * 目标：证明「参考程序按契约能跑出 1:40 / 4:12 / 7:04 / 11:09」（输出-only 累计 11:09）。
 * 
 * 做法：
 * - 两条路径对照：
 *   1. VM 路径：手写 4 段参考程序的 IR（含 if demon>0.5 条件分支）→ verifier → VM → sink
 *   2. Sink 直算：直接调用 makeActionSink，绕过 VM（原实现，作为对照列）
 * - 用真 makeActionSink（packages/core/src/modifier/settle.ts）
 * - 用真 content/realms.json + content/artifacts.json + content/actions.json
 * - 从 qi=0、realm=0 开始跑，跨境界自动切换 sink（模拟玩家按推荐配置推进）
 * - 每 tick 检查 demon > 0.5 → slot 1 = 调息，其余 slot = 吐纳（契约 §3 假设 4）
 * - demon ≥ 1 → qi × 0.7, demon = 0, fires += 1（契约 §3 假设 5 + Python 原型 line 23）
 * - 突破 → qi = 0, demon = 0（契约 §3 假设 5 + Python 原型 line 26）
 * 
 * 输出：
 * - 两列对比（VM 路径 vs Sink 直算），四境界都要有
 * - 任意一行偏差 > 0.1% 就停下报数，说明两条路径有分歧
 * - 与契约 §3 目标表逐行对比，打印偏差百分比
 * - 若偏差 > 20%，输出「建议阈值 = 实测速率 × 契约阶段耗时」
 * 
 * 验收：
 * a) 贴两列对比（VM 路径 vs sink 直算），四行都要有
 * b) 任意一行偏差 > 0.1% 时停下来报数，不要调参数凑
 * c) pnpm typecheck && pnpm test && pnpm sim ×3
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeActionSink } from '../packages/core/src/modifier/settle';
import { Vm } from '../packages/core/src/vm/interpreter';
import type { Content } from '../packages/core/src/content/schema';
import type { JadeCacheSpec } from '../packages/core/src/content/artifacts';
import type { ActionRequest } from '../packages/core/src/vm/interpreter';
import type { Program, Op } from '../packages/core/src/vm/program';
import { Qi } from '../packages/core/src/number/bignum';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

function loadContent(): Content {
  const actions = JSON.parse(readFileSync(join(ROOT, 'content/actions.json'), 'utf-8'));
  const realms = JSON.parse(readFileSync(join(ROOT, 'content/realms.json'), 'utf-8'));
  return { actions, realms };
}

function loadJadeCache(): JadeCacheSpec | null {
  const artifacts = JSON.parse(readFileSync(join(ROOT, 'content/artifacts.json'), 'utf-8'));
  const jade = artifacts.find((a: any) => a.id === 'jade');
  if (!jade) return null;
  const cacheEffect = jade.effects.find((e: any) => e.type === 'cache');
  return cacheEffect?.cache ?? null;
}

/**
 * 构造参考程序的 IR（含 if demon>0.5 条件分支）。
 * 
 * 对于 N 次吐纳的程序：
 * - if demon > 0.5: [calm, loop N-1 breath]
 * - else: [loop N breath]
 * 
 * IR 结构（以 N=3 为例）：
 * pc=0: LOAD demon
 * pc=1: PUSH 0.5
 * pc=2: CMP >
 * pc=3: JMP_IF_FALSE else_branch (pc=9)
 * pc=4: ACTION calm
 * pc=5: LOOP_BEGIN end=7 count=2
 * pc=6: ACTION breath
 * pc=7: LOOP_END begin=5
 * pc=8: JMP end (pc=12)
 * pc=9: LOOP_BEGIN end=11 count=3  (else_branch)
 * pc=10: ACTION breath
 * pc=11: LOOP_END begin=9
 * pc=12: HALT  (end)
 */
function buildReferenceProgram(realmIndex: number, acts: number): Program {
  const id = `reference-realm-${realmIndex}`;
  const code: Op[] = [];
  
  if (acts === 1) {
    // 炼气：无循环，无条件分支，直接吐纳
    code.push({ op: 'ACTION', actionId: 'breath' });
    code.push({ op: 'HALT' });
  } else {
    // 筑基/金丹/元婴：含条件分支
    // if demon > 0.5
    code.push({ op: 'LOAD', key: 'demon' });        // pc=0
    code.push({ op: 'PUSH', value: 0.5 });          // pc=1
    code.push({ op: 'CMP', arg: '>' });             // pc=2
    
    const jmpIfFalseIdx = code.length;              // pc=3
    code.push({ op: 'JMP_IF_FALSE', target: 0 });   // placeholder
    
    // then: calm, loop (acts-1) breath
    code.push({ op: 'ACTION', actionId: 'calm' });  // pc=4
    const loopBeginThenIdx = code.length;           // pc=5
    code.push({ op: 'LOOP_BEGIN', end: 0, count: acts - 1 }); // placeholder for end
    code.push({ op: 'ACTION', actionId: 'breath' }); // pc=6
    const loopEndThenIdx = code.length;             // pc=7
    code.push({ op: 'LOOP_END', begin: loopBeginThenIdx });
    
    const jmpIdx = code.length;                     // pc=8
    code.push({ op: 'JMP', target: 0 });            // placeholder
    
    // else: loop acts breath
    const elseIdx = code.length;                    // pc=9
    code[jmpIfFalseIdx] = { op: 'JMP_IF_FALSE', target: elseIdx };
    
    const loopBeginElseIdx = code.length;           // pc=9
    code.push({ op: 'LOOP_BEGIN', end: 0, count: acts }); // placeholder for end
    code.push({ op: 'ACTION', actionId: 'breath' }); // pc=10
    const loopEndElseIdx = code.length;             // pc=11
    code.push({ op: 'LOOP_END', begin: loopBeginElseIdx });
    
    // end
    const endIdx = code.length;                     // pc=12
    code[jmpIdx] = { op: 'JMP', target: endIdx };
    code[loopBeginThenIdx] = { op: 'LOOP_BEGIN', end: loopEndThenIdx, count: acts - 1 };
    code[loopBeginElseIdx] = { op: 'LOOP_BEGIN', end: loopEndElseIdx, count: acts };
    
    code.push({ op: 'HALT' });
  }
  
  return { id, code };
}

interface RealmPlan {
  readonly realmIndex: number;
  readonly acts: number;
  readonly jade: boolean;
}

const PLANS: RealmPlan[] = [
  { realmIndex: 0, acts: 1, jade: false }, // 炼气: 吐纳 only
  { realmIndex: 1, acts: 3, jade: true },  // 筑基: 循环3次 吐纳 + jade
  { realmIndex: 2, acts: 5, jade: true },  // 金丹: 循环5次 吐纳 + jade
  { realmIndex: 3, acts: 8, jade: true },  // 元婴: 循环8次 吐纳 + jade
];

const TICK = 0.1;
const DEMON_THRESHOLD_CALM = 0.5;
const DEMON_THRESHOLD_FIRE = 1.0;
const FIRE_PENALTY = 0.7;

interface TickResult {
  readonly qi: number;
  readonly demon: number;
  readonly fired: boolean;
}

function runTick(
  sink: ReturnType<typeof makeActionSink>,
  plan: RealmPlan,
  demon: number,
  loopDepth: number,
): TickResult {
  const actions: ActionRequest[] = [];
  
  // 契约 §3 假设 4：心魔 > 0.5 → slot 1 = 调息，其余 = 吐纳
  if (demon > DEMON_THRESHOLD_CALM && plan.acts >= 2) {
    actions.push({ actionId: 'calm', k: 1, pc: 0, loopDepth });
    for (let k = 2; k <= plan.acts; k++) {
      actions.push({ actionId: 'breath', k, pc: 0, loopDepth });
    }
  } else {
    for (let k = 1; k <= plan.acts; k++) {
      actions.push({ actionId: 'breath', k, pc: 0, loopDepth });
    }
  }
  
  let qi = 0;
  let newDemon = demon;
  
  for (const req of actions) {
    const outcome = sink.execute(req);
    qi += outcome.qi;
    newDemon += outcome.demonDelta;
  }
  
  // 契约 §3 假设 5：demon ≥ 1 → qi × 0.7, demon = 0
  const fired = newDemon >= DEMON_THRESHOLD_FIRE;
  if (fired) {
    qi *= FIRE_PENALTY;
    newDemon = 0;
  }
  
  return { qi, demon: newDemon, fired };
}

interface RealmResult {
  readonly realmIndex: number;
  readonly realmName: string;
  readonly stageTicks: number;
  readonly totalTicks: number;
  readonly rate: number;
  readonly fires: number;
  readonly maxDemon: number;
}

function runRealm(
  content: Content,
  plan: RealmPlan,
  jadeCache: JadeCacheSpec | null,
  demonBase: number,
  startTotalTicks: number,
  daoRate = 1,
): RealmResult {
  const realm = content.realms[plan.realmIndex]!;
  const sink = makeActionSink({
    content,
    realmIndex: plan.realmIndex,
    jadeCache: plan.jade ? jadeCache : null,
    demonBase,
    bookDecay: 1, // 契约 §3 假设 2：筑基起固化
    modifiers: [], // 参考程序无书
  });
  
  let qi = 0;
  let demon = 0;
  let ticks = 0;
  let fires = 0;
  let maxDemon = 0;
  const loopDepth = plan.realmIndex === 0 ? 0 : 1; // 炼气无循环，其余有
  
  while (qi < realm.threshold) {
    const result = runTick(sink, plan, demon, loopDepth);
    qi += (result.qi + realm.passivePerSec * TICK) * daoRate;
    demon = result.demon;
    maxDemon = Math.max(maxDemon, demon);
    if (result.fired) fires++;
    ticks++;
    
    if (ticks > 1_000_000) {
      throw new Error(`Realm ${realm.name.zh} exceeded 1M ticks, qi=${qi}, threshold=${realm.threshold}`);
    }
  }
  
  const stageTicks = ticks;
  const totalTicks = startTotalTicks + ticks;
  const rate = qi / (stageTicks * TICK);
  
  return {
    realmIndex: plan.realmIndex,
    realmName: realm.name.zh,
    stageTicks,
    totalTicks,
    rate,
    fires,
    maxDemon,
  };
}

/**
 * VM 路径：用真 VM 跑参考程序，每 tick 调用 vm.tick() 获取产出。
 * VM 内部会执行 IR、调用 sink、处理循环和条件分支。
 */
function runRealmVm(
  content: Content,
  plan: RealmPlan,
  jadeCache: JadeCacheSpec | null,
  demonBase: number,
  startTotalTicks: number,
  daoRate = 1,
): RealmResult {
  const realm = content.realms[plan.realmIndex]!;
  const sink = makeActionSink({
    content,
    realmIndex: plan.realmIndex,
    jadeCache: plan.jade ? jadeCache : null,
    demonBase,
    bookDecay: 1,
    modifiers: [],
  });
  
  // 构造参考程序的 IR
  const program = buildReferenceProgram(plan.realmIndex, plan.acts);
  
  // 状态：qi, demon 由我们维护（VM 只负责执行 IR 并调用 sink）
  let qi = 0;
  let demon = 0;
  let ticks = 0;
  let fires = 0;
  let maxDemon = 0;
  
  // 创建 VM 实例
  const vm = new Vm({
    content,
    sink,
    vars: () => ({
      qi: Qi.of(qi),
      rate: Qi.of(0), // 参考程序不关心 rate
      demon,
      realm: plan.realmIndex,
      budget: 200, // BASE_BUDGET
    }),
  });
  
  // 装载程序（走 verifier）
  const verifyResult = vm.loadPrograms([program]);
  if (!verifyResult.ok) {
    throw new Error(`Program verification failed: ${verifyResult.errors.map(e => e.message).join(', ')}`);
  }
  
  while (qi < realm.threshold) {
    // 跑一个 tick
    const tickResult = vm.tick();
    
    // 累加 qi 和 demon
    qi += (tickResult.gain + realm.passivePerSec * TICK) * daoRate;
    demon += tickResult.demonDelta;
    maxDemon = Math.max(maxDemon, demon);
    
    // 检查走火入魔
    if (demon >= DEMON_THRESHOLD_FIRE) {
      qi *= FIRE_PENALTY;
      demon = 0;
      fires++;
    }
    
    ticks++;
    
    if (ticks > 1_000_000) {
      throw new Error(`Realm ${realm.name.zh} exceeded 1M ticks, qi=${qi}, threshold=${realm.threshold}`);
    }
  }
  
  const stageTicks = ticks;
  const totalTicks = startTotalTicks + ticks;
  const rate = qi / (stageTicks * TICK);
  
  return {
    realmIndex: plan.realmIndex,
    realmName: realm.name.zh,
    stageTicks,
    totalTicks,
    rate,
    fires,
    maxDemon,
  };
}

function formatTime(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

interface ContractRow {
  readonly realm: string;
  readonly threshold: number;
  readonly rate: number;
  readonly stageTime: number;
  readonly totalTime: number;
}

const CONTRACT_TABLE: ContractRow[] = [
  { realm: '炼气', threshold: 1e3, rate: 10, stageTime: 100, totalTime: 100 },
  { realm: '筑基', threshold: 1e4, rate: 66, stageTime: 152, totalTime: 252 },
  { realm: '金丹', threshold: 1.2e5, rate: 696, stageTime: 172, totalTime: 424 },
  { realm: '元婴', threshold: 8e5, rate: 3271, stageTime: 245, totalTime: 669 },
];

function main() {
  // 道途对照（批次 9）：DAO=orthodox → 全产出 ×1.08；DAO=heretic → ×1.20 且心魔基础 ×1.40。
  // 参考程序本身不含道途，所以默认 none 时输出必须仍是 11:09。
  const dao = (process.env.DAO ?? 'none') as 'none' | 'orthodox' | 'heretic';
  const daoRate = dao === 'orthodox' ? 1.08 : dao === 'heretic' ? Number(process.env.DAO_RATE ?? 1.2) : 1;
  const daoDemon = dao === 'heretic' ? Number(process.env.DAO_DEMON ?? 1.4) : 1;
  console.log(`DAO = ${dao}（rate ×${daoRate}，demonBase ×${daoDemon}）`);

  const demonBases = [0.00004, 0.00005];
  
  for (const demonBase of demonBases) {
    console.log(`\n========== demonBase = ${demonBase} ==========`);
    const content = loadContent();
    const jadeCache = loadJadeCache();
    
    // Sink 直算路径
    const sinkResults: RealmResult[] = [];
    let sinkTotalTicks = 0;
    for (const plan of PLANS) {
      const result = runRealm(content, plan, jadeCache, demonBase * daoDemon, sinkTotalTicks, daoRate);
      sinkResults.push(result);
      sinkTotalTicks = result.totalTicks;
    }
    
    // VM 路径
    const vmResults: RealmResult[] = [];
    let vmTotalTicks = 0;
    for (const plan of PLANS) {
      const result = runRealmVm(content, plan, jadeCache, demonBase * daoDemon, vmTotalTicks, daoRate);
      vmResults.push(result);
      vmTotalTicks = result.totalTicks;
    }
    
    // 两列对比
    console.log('\n--- 两列对比：VM 路径 vs Sink 直算 ---');
    console.log('境界\tVM 阶段\tSink 阶段\t阶段偏差%\tVM 累计\tSink 累计\t累计偏差%\tVM 速率\tSink 速率\t速率偏差%');
    
    let hasDivergence = false;
    for (let i = 0; i < sinkResults.length; i++) {
      const vm = vmResults[i]!;
      const sink = sinkResults[i]!;
      
      const vmStage = vm.stageTicks * TICK;
      const sinkStage = sink.stageTicks * TICK;
      const stageDev = ((vmStage - sinkStage) / sinkStage) * 100;
      
      const vmTotal = vm.totalTicks * TICK;
      const sinkTotal = sink.totalTicks * TICK;
      const totalDev = ((vmTotal - sinkTotal) / sinkTotal) * 100;
      
      const rateDev = ((vm.rate - sink.rate) / sink.rate) * 100;
      
      console.log(
        `${vm.realmName}\t${formatTime(vmStage)}\t${formatTime(sinkStage)}\t${stageDev.toFixed(3)}%\t${formatTime(vmTotal)}\t${formatTime(sinkTotal)}\t${totalDev.toFixed(3)}%\t${vm.rate.toFixed(2)}\t${sink.rate.toFixed(2)}\t${rateDev.toFixed(3)}%`
      );
      
      if (Math.abs(stageDev) > 0.1 || Math.abs(totalDev) > 0.1 || Math.abs(rateDev) > 0.1) {
        hasDivergence = true;
        console.log(`  ⚠️  ${vm.realmName} 偏差 > 0.1%：两条路径有分歧，停下报数`);
      }
    }
    
    if (hasDivergence) {
      console.log('\n❌ 两条路径分歧，不继续与契约对比');
      continue;
    }
    
    console.log('\n✓ 两条路径一致（偏差 < 0.1%），继续与契约 §3 对比');
    
    // 与契约对比（用 VM 路径的结果）
    console.log('\n--- 与契约 §3 对比（VM 路径） ---');
    console.log('境界\t契约阶段\tVM 阶段\t偏差%\t契约累计\tVM 累计\t偏差%');
    for (let i = 0; i < vmResults.length; i++) {
      const r = vmResults[i]!;
      const c = CONTRACT_TABLE[i]!;
      const stageTime = r.stageTicks * TICK;
      const totalTime = r.totalTicks * TICK;
      const stageDev = ((stageTime - c.stageTime) / c.stageTime) * 100;
      const totalDev = ((totalTime - c.totalTime) / c.totalTime) * 100;
      console.log(
        `${r.realmName}\t${formatTime(c.stageTime)}\t${formatTime(stageTime)}\t${stageDev.toFixed(1)}%\t${formatTime(c.totalTime)}\t${formatTime(totalTime)}\t${totalDev.toFixed(1)}%`
      );
      
      if (Math.abs(stageDev) > 20) {
        const suggestedThreshold = r.rate * c.stageTime;
        console.log(`  ⚠️  偏差 > 20%：建议阈值 = ${r.rate.toFixed(1)} × ${c.stageTime} = ${suggestedThreshold.toFixed(0)} (当前 ${c.threshold})`);
      }
    }
    
    const finalTotal = vmResults[vmResults.length - 1]!.totalTicks * TICK;
    console.log(`\n累计输出时长: ${formatTime(finalTotal)} (${finalTotal.toFixed(1)}s)`);
    console.log(`契约 §3 目标: 11:09 (669s)`);
    if (Math.abs(finalTotal - 669) < 1) {
      console.log('✓ 累计输出时长匹配契约目标');
    } else {
      console.log('✗ 累计输出时长偏差');
    }
  }
}

main();
