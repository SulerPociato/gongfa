import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps 那一栏是任务 8 P0-D 扩的：引导步骤机放在 web 层（它不是游戏规则，契约 §2/§7 里没有它），
    // 但必须是纯函数才能测。include 不含 apps 就等于「这段逻辑永远没人测」，所以扩 glob 而不是把步骤机塞进 core。
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
  },
});
