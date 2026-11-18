// 契约 §1 要求灵力存量为 BigNumber；P0 不引库，先用 number 包一层，日后换实现只改本文件。
// Number.MAX_SAFE_INTEGER = 9.007e15 > 契约内最大量级 1e15，在此范围内整数运算精确，超出后只保证相对精度。
export type Qi = number;

export const MAX_EXACT_QI = Number.MAX_SAFE_INTEGER;

const MAX_PLAIN_DIGITS = 1e6;
const SIGNIFICANT_DIGITS = 3;

function finite(label: string, value: number): Qi {
  if (!Number.isFinite(value)) throw new RangeError(`Qi.${label}: 需要有限数，收到 ${value}`);
  return value;
}

export const Qi = {
  zero: 0 as Qi,

  of(value: number): Qi {
    return finite('of', value);
  },

  add(a: Qi, b: Qi): Qi {
    return finite('add', a + b);
  },

  sub(a: Qi, b: Qi): Qi {
    return finite('sub', a - b);
  },

  mul(a: Qi, b: Qi): Qi {
    return finite('mul', a * b);
  },

  div(a: Qi, b: Qi): Qi {
    if (b === 0) throw new RangeError('Qi.div: 除数为 0');
    return finite('div', a / b);
  },

  cmp(a: Qi, b: Qi): -1 | 0 | 1 {
    return a < b ? -1 : a > b ? 1 : 0;
  },

  lt(a: Qi, b: Qi): boolean {
    return Qi.cmp(a, b) < 0;
  },

  gte(a: Qi, b: Qi): boolean {
    return Qi.cmp(a, b) >= 0;
  },

  exceedsExact(value: Qi): boolean {
    return Math.abs(value) > MAX_EXACT_QI;
  },

  format(value: Qi): string {
    finite('format', value);
    if (Number.isInteger(value) && Math.abs(value) < MAX_PLAIN_DIGITS) return String(value);
    return value.toExponential(SIGNIFICANT_DIGITS);
  },

  parse(text: string): Qi {
    const trimmed = text.trim();
    if (trimmed === '') throw new RangeError('Qi.parse: 空字符串');
    return finite('parse', Number(trimmed));
  },
};
