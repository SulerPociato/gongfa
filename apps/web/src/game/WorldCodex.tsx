import { CODEX_GROUPS } from './world';

/**
 * 世界观图鉴（设置抽屉里，默认折叠）。
 * 每条都带「现实对照」；可玩边界用青点标出，避免玩家以为化神/仙界能玩。
 */
export function WorldCodex() {
  return (
    <div className="codex-world">
      {CODEX_GROUPS.map((group) => (
        <details key={group.title} className="codex-world-group">
          <summary>{group.title}</summary>
          <p className="codex-group-note">{group.note}</p>
          <ul className="codex-world-list">
            {group.entries.map((item) => (
              <li key={item.id} className={`codex-world-item${item.playable === true ? ' is-playable' : ''}`}>
                <p className="codex-world-name">
                  {item.name}
                  {item.playable === true && <span className="codex-playable-dot" title="本作可玩 / 可获得" />}
                </p>
                <p className="codex-world-note">{item.note}</p>
                <p className="codex-world-analog">现实对照：{item.analog}</p>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
