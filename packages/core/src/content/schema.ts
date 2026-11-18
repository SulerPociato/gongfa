import type { Qi } from '../number/bignum';

export type ActionKind = 'gain' | 'calm' | 'other';

export interface ActionDef {
  readonly id: string;
  readonly baseGain: Qi;
  readonly demonDelta: number;
  readonly kind: ActionKind;
}

export interface RealmDef {
  readonly id: number;
  readonly name: { readonly zh: string };
  readonly threshold: Qi;
  readonly passivePerSec: number;
  readonly actionMult: number;
}

export interface Content {
  readonly actions: readonly ActionDef[];
  readonly realms: readonly RealmDef[];
}

export class ContentValidationError extends Error {
  readonly errors: readonly string[];

  constructor(source: string, errors: readonly string[]) {
    super(`${source} 校验失败（${errors.length} 处）:\n  - ${errors.join('\n  - ')}`);
    this.name = 'ContentValidationError';
    this.errors = errors;
  }
}
