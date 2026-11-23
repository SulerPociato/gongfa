import { useEffect, useState } from 'react';
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

  useEffect(() => {
    // 入场动画：挂载后下一帧淡入。
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      onDismiss();
    }, CARD_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className={`algorithm-card${visible ? ' is-visible' : ''}`} role="status">
      <p className="algorithm-card-title">恭喜你发现了「{def.name}」</p>
      <p className="algorithm-card-subtitle">这就是计算机里的 {def.algorithm}</p>
      <p className="algorithm-card-footer">已收入功法谱</p>
    </div>
  );
}
