import artifactsJson from '../../../../content/artifacts.json';
import {
  ContentValidationError,
  equipArtifacts,
  loadArtifacts,
  type ArtifactDef,
  type ArtifactEquipment,
  type ModifierTarget,
} from '@gongfa/core';

// 与 game/books.ts 同一口径：core 不碰 fs，谁来读 artifacts.json 由宿主定。
// 新增一件道具 = 改 content/artifacts.json，这里不用动（表是整份 import 进来的）。
export interface ArtifactCatalogue {
  readonly artifacts: readonly ArtifactDef[];
  /** 表读不起来的原因：进 HUD 红字，不静默给一个空目录让玩家以为「没有道具」。 */
  readonly errors: readonly string[];
}

export function readArtifactCatalogue(): ArtifactCatalogue {
  try {
    return { artifacts: loadArtifacts(artifactsJson), errors: [] };
  } catch (error) {
    const detail = error instanceof ContentValidationError ? [...error.errors] : [(error as Error).message];
    return { artifacts: [], errors: [`道具表读不起来：${detail.join('；')}`] };
  }
}

export const ARTIFACT_CATALOGUE: ArtifactCatalogue = readArtifactCatalogue();

// 装备位 → 结算入参。目录本身坏了要一起报：否则面板显示「未装备」，玩家以为是开关没生效。
export function equipmentFor(catalogue: ArtifactCatalogue, equippedIds: readonly string[]): ArtifactEquipment {
  const equipment = equipArtifacts(catalogue.artifacts, equippedIds);
  return { ...equipment, errors: [...catalogue.errors, ...equipment.errors] };
}

const TARGET_LABEL: Record<ModifierTarget, string> = {
  rate: '产出',
  demonRate: '心魔',
  budget: '每 tick 指令预算',
  offlineRate: '离线速率',
  slot: '程序槽',
};

// 面板文案从表里拼，不写死数字：改了 artifacts.json 而 HUD 还在说 ×0.7 / +50，就是又一处两份口径。
export function describeArtifact(artifact: ArtifactDef): string {
  return artifact.effects
    .map((effect) => {
      if (effect.type === 'cache') {
        return `同 tick 重复动作产出 ×${effect.cache.hitGainMultiplier}，那一步计 ${effect.cache.hitStepCost} 步`;
      }
      if (effect.type === 'cacheSlots') {
        return `缓存槽位 +${effect.slots}（玉简可多记一种动作）`;
      }
      const modifier = effect.modifier;
      const amount = modifier.kind === 'add' ? `+${modifier.value}` : `×${modifier.value}`;
      // budget 的单位是「步」，其余目标没有单位可言（7A 也只有 budget 会真的生效）
      return modifier.target === 'budget' ? `${TARGET_LABEL[modifier.target]} ${amount} 步` : `${TARGET_LABEL[modifier.target]} ${amount}`;
    })
    .join('；');
}
