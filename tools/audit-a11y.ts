// 可访问性与视觉规范体检：对比度、焦点样式、reduced-motion、语义
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/web/src/global.css', import.meta.url), 'utf8');

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: readonly number[]): number => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
const ratio = (a: readonly number[], b: readonly number[]): number => {
  const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi! + 0.05) / (lo! + 0.05);
};
/** 把 rgba 叠到不透明底色上 */
const over = (fg: readonly number[], alpha: number, bg: readonly number[]): number[] =>
  [0, 1, 2].map((i) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha)));

const card = [0x11, 0x1a, 0x20];
const sheet = [0x16, 0x23, 0x2b];

const checks: { name: string; fg: number[]; bg: number[]; min: number }[] = [
  { name: '正文 #e9f6f3 / 卡片', fg: [0xe9, 0xf6, 0xf3], bg: card, min: 4.5 },
  { name: '次要文字 68% / 卡片', fg: over([0xe9, 0xf6, 0xf3], 0.68, card), bg: card, min: 4.5 },
  { name: '标签 60% / 卡片', fg: over([0xe9, 0xf6, 0xf3], 0.6, card), bg: card, min: 4.5 },
  { name: '金色 #e8c978 / 卡片', fg: [0xe8, 0xc9, 0x78], bg: card, min: 4.5 },
  { name: '青色 #35e0c8 / 卡片', fg: [0x35, 0xe0, 0xc8], bg: card, min: 4.5 },
  { name: '故障条 #ffb4a8 / 红底', fg: [0xff, 0xb4, 0xa8], bg: over([0xff, 0x5a, 0x46], 0.1, card), min: 4.5 },
  { name: '主按钮文字 #04211d / 青色', fg: [0x04, 0x21, 0x1d], bg: [0x35, 0xe0, 0xc8], min: 4.5 },
  { name: '气泡正文 / 气泡底', fg: [0xe9, 0xf6, 0xf3], bg: [0x08, 0x0e, 0x12], min: 4.5 },
  { name: '面板标题 / 面板底', fg: [0xe9, 0xf6, 0xf3], bg: sheet, min: 4.5 },
];

let failures = 0;
for (const check of checks) {
  const value = ratio(check.fg, check.bg);
  const ok = value >= check.min;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check.name} = ${value.toFixed(2)}:1 (需 ${check.min})`);
}

const counts = {
  focusVisible: (css.match(/:focus-visible/g) ?? []).length,
  reducedMotion: (css.match(/prefers-reduced-motion/g) ?? []).length,
  outlineNone: (css.match(/outline:\s*none/g) ?? []).length,
  ariaInCss: 0,
};
console.log('CSS:', JSON.stringify(counts));
console.log(`对比度失败 ${failures} 项`);
