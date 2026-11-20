import { useEffect, useRef } from 'react';

/**
 * 灵力粒子（任务 8 P1 第 d 项）：叠在 Blockly 画布上方的 Canvas，rate>0 时从下往上飘。
 * 只借用 --spirit 一种颜色，不参与任何数值口径 —— 数字仍然只由 HUD 的 rate 说了算。
 */

interface Particle {
  x: number;
  y: number;
  /** px/秒 */
  vx: number;
  /** px/秒，向上为负 */
  vy: number;
  /** 已存活毫秒 */
  ageMs: number;
  /** 本次寿命毫秒 */
  lifeMs: number;
}

interface ViewSize {
  width: number;
  height: number;
}

const MAX_PARTICLES = 60;
const RADIUS = 2;
const SPIRIT_RGB = '53, 224, 200';
// 发射区是底部一条横带（宽 100%、高 15%），不是底部一条线：起点分散开，静帧才不像贴地的一线珠。
const EMIT_BAND = 0.15;
// 80–160 px/s × 2.5–4.5 s ⇒ 单颗最多升 720px，够飘到画面中上部（验收：最高点超过视口高度 40%）。
const RISE_MIN = 80;
const RISE_SPAN = 80;
const LIFE_MIN_MS = 2500;
const LIFE_SPAN_MS = 2000;
// 发射率跟随 qi/s，但上限被 60 的池卡住：60 ÷ 平均寿命 3.5s ≈ 17 颗/秒是「不发散旧粒子」的天花板，
// 再快就会把还没飘起来的粒子挤出局（实测 36 颗/秒时平均驻留 1.7 秒，画面只剩底部一层）。
const EMIT_PER_QI = 2;
const EMIT_MIN = 2;
const EMIT_MAX = 16;

function spawn(pool: Particle[], view: ViewSize): void {
  const next: Particle = {
    x: Math.random() * view.width,
    y: view.height * (1 - EMIT_BAND * Math.random()),
    vx: (Math.random() - 0.5) * 40,
    vy: -(RISE_MIN + Math.random() * RISE_SPAN),
    ageMs: 0,
    lifeMs: LIFE_MIN_MS + Math.random() * LIFE_SPAN_MS,
  };
  // 池满先挤掉最老的一只，长度恒定 ≤ MAX_PARTICLES（不是「满了就不发」）。
  if (pool.length >= MAX_PARTICLES) pool.shift();
  pool.push(next);
}

export function QiParticles({ rate }: { readonly rate: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rateRef = useRef(0);
  const poolRef = useRef<Particle[]>([]);

  // rate 走 ref 而不是 effect 依赖：换程序时 effect 不重建，粒子才不会整池消失。
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const view: ViewSize = { width: 0, height: 0 };
    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      view.width = rect.width;
      view.height = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    // ResizeObserver 只在「尺寸变化」时回调，首帧不量一次就会停在 canvas 默认的 300×150。
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pool = poolRef.current;
    let emitAcc = 0;
    let prev = 0;
    let frame = 0;

    const step = (now: number): void => {
      const dt = prev === 0 ? 16 : Math.min(100, now - prev);
      prev = now;
      // 每帧无条件擦：池空了也要擦掉上一帧的残留。
      ctx.clearRect(0, 0, view.width, view.height);
      if (reduceMotion.matches) {
        pool.length = 0;
      } else {
        const live = rateRef.current;
        if (live > 0) {
          emitAcc += (dt / 1000) * Math.min(EMIT_MAX, Math.max(EMIT_MIN, live * EMIT_PER_QI));
          while (emitAcc >= 1) {
            emitAcc -= 1;
            spawn(pool, view);
          }
        } else {
          emitAcc = 0;
        }
        let keep = 0;
        for (const p of pool) {
          p.ageMs += dt;
          p.x += p.vx * (dt / 1000);
          p.y += p.vy * (dt / 1000);
          if (p.ageMs >= p.lifeMs || p.y < -RADIUS) continue;
          pool[keep] = p;
          keep += 1;
          const alpha = (1 - p.ageMs / p.lifeMs) * 0.85;
          ctx.fillStyle = `rgba(${SPIRIT_RGB}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, RADIUS, 0, Math.PI * 2);
          ctx.fill();
        }
        pool.length = keep;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    // 验收用的粒子计数句柄：DEV 判定与 App.tsx 的 __gongfa_debug 同一套（Vite 类型入口不在本项目 tsconfig 里）
    const devHandle = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
    if (devHandle) {
      (window as unknown as Record<string, unknown>).__gongfa_particles = {
        count: (): number => pool.length,
      };
    }

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (devHandle) delete (window as unknown as Record<string, unknown>).__gongfa_particles;
    };
  }, []);

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute',
        inset: 0,
        // Blockly 注入后的画布比视口高（实测 1440×900 下 1165×1213），
        // 不夹住就会在玩家看不见的下沿 300 多像素里发粒子。
        maxHeight: '100vh',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <canvas
        ref={canvasRef}
        className="qi-particles"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
}
