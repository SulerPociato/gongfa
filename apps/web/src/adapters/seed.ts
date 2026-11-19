// 契约 §5.1 的 seed 是回放与排行榜的口径（§8：正式版由服务端发种子，防挑种子）。
// 本地新档必须先有一个真随机的 uint32：写死 0 会让接上 RNG 之后所有玩家共用同一随机序列。
const UINT32_RANGE = 0x1_0000_0000;

export function randomSeed(): number {
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    source.getRandomValues(buffer);
    return buffer[0] ?? 0;
  }
  // 非安全上下文（http://局域网 IP）拿不到 crypto.getRandomValues：能跑，但要知道种子变弱了
  console.warn('种子退化为 Math.random，可能与其他玩家碰撞');
  return Math.floor(Math.random() * UINT32_RANGE);
}
