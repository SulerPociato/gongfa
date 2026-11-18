export interface HudModel {
  readonly qi: number;
  readonly rate: number;
  readonly errors: readonly string[];
}

export function Hud({ model }: { readonly model: HudModel }) {
  return (
    <aside className="hud">
      <h1>代码修仙</h1>
      <p className="label">灵力</p>
      <p className="qi">{model.qi}</p>
      <p className="rate">{model.rate.toFixed(1)} / 秒</p>
      {model.errors.length > 0 && (
        <ul className="errors">
          {model.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <p className="hint">把工具箱里的「吐纳」拖进「每 tick」下面的凹槽，灵力就开始涨。刷新页面会回到初始状态（任务 4 才有存档）。</p>
    </aside>
  );
}
