import { useEffect, useRef, useState } from 'react';
import { patternDef, type PatternId } from '@gongfa/core';

// 批次 3：算法发现卡片（右上角玻璃卡，3 秒后自动消失）。
// 文案从 core 的 PATTERNS 表里取，不写死 —— 表改了卡片跟着变，不是第二份口径。

const CARD_MS = 3_000;

export interface AlgorithmCardProps {
  readonly patternId: PatternId;
  readonly onDismiss: () => void;
}

export function AlgorithmCard({ patternId, onDismiss }: AlgorithmCardProps) {
  const [visible, setVisible] = useState(false);
  const def = patternDef(patternId);
  // onDismiss 用 ref 存最新值：父组件每秒重渲染十余次（HUD 状态），
  // 每次都是新函数 → effect 依赖 [onDismiss] 会每帧 cleanup → 清掉 3 秒定时器 → 重新计时。
  // 定时器永远到不了 3 秒，卡片永不自散，队列卡死。
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    // 入场动画：挂载后下一帧淡入。
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      dismissRef.current();
    }, CARD_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={`algorithm-card${visible ? ' is-visible' : ''}`} role="status">
      <p className="algorithm-card-title">恭喜你发现了「{def.name}」</p>
      <p className="algorithm-card-subtitle">这就是计算机里的 {def.algorithm}</p>
      <p className="algorithm-card-footer">已收入功法谱</p>
    </div>
  );
}
