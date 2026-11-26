/**
 * 世界观图鉴（2026-11-26）：境界、界域、宗门、丹药、法宝、灵根。
 *
 * 两条硬约束：
 * 1) **不抄检索原文**：只取「境界名/界域名/宗门名」这类通用设定，描述全部重写；
 * 2) **每条都要有现实算法/计算机对照**——这是《代码修仙》和普通修仙设定的区别。
 *
 * 可玩范围是契约 §5.1 的 9 境（炼气→渡劫）；图鉴与 content/realms.json 同一条阶梯。
 * 丹药/法宝仍是背景图谱：本作可服丹是 pills.ts 的 8 种，可装备法宝是 artifacts.json 的 8 件。
 */
export interface CodexEntry {
  readonly id: string;
  readonly name: string;
  /** 一句话设定（原创）。 */
  readonly note: string;
  /** 现实算法 / 计算机对照。 */
  readonly analog: string;
  /** 本作是否可玩/可获得；缺省 false（纯背景）。 */
  readonly playable?: boolean;
}

const entry = (
  id: string,
  name: string,
  note: string,
  analog: string,
  playable = false,
): CodexEntry => ({ id, name, note, analog, playable });

/** 这些组里的每一条都有实际机制（可选/可服/可装备），图鉴统一点青点。 */
const allPlayable = (items: readonly CodexEntry[]): readonly CodexEntry[] => items.map((item) => ({ ...item, playable: true }));

/** 9 大境界 + 仙界 5 级；前 9 条都是本作可玩境界。 */
export const REALM_LADDER: readonly CodexEntry[] = [
  entry('qiRefining', '练气', '纳灵气入体，分十三层；寿元仍与凡人相近。', '单线程脚本：一次只做一件事，靠循环把同一段逻辑跑很多遍。', true),
  entry('foundation', '筑基', '丹田液化，可炼丹炼器；寿元约两百年。', '模块化 + 依赖注入：把动作拆成可复用的块，靠接口组合。', true),
  entry('goldenCore', '结丹（金丹）', '凝液成丹，可御空飞行、炼制本命法宝。', '微服务 / 容器化：每个能力独立部署，靠预算和调度器编排。', true),
  entry('nascentSoul', '元婴', '丹破婴生，可夺舍；需避雷劫求长生。', '分布式副本 + 主备切换：多一份副本，代价是要处理一致性与故障。', true),
  entry('spiritTransformation', '化神', '肉身不灭，初步调用天地元气。', '云原生 / 弹性伸缩：资源按需申请，不再只靠单机堆算力。', true),
  entry('voidRefining', '炼虚', '元婴化元神，可身外化身，寿元近五千岁。', '异地多活：多个副本同时服务，靠路由与同步保持一致。', true),
  entry('unity', '合体', '分身与本体合一，掌神通，寿元上万年。', '共识算法（Raft/Paxos）：多个副本先投票，再对外承诺。', true),
  entry('mahayana', '大乘', '可引动飞升之劫，法则之力初成。', '自治系统 / 自愈：系统能自己发现异常并收敛回目标状态。', true),
  entry('tribulation', '渡劫', '渡过五行、心魔、真雷三劫，飞升仙界。', '混沌工程 / 灰度发布：主动制造故障，验证系统在坏情况下仍能活。', true),
  entry('heavenlyImmortal', '天仙', '仙界初阶，掌一方天域。', 'CDN / 边缘计算：把计算推到离用户最近的一层。'),
  entry('mysticImmortal', '玄仙', '玄之又玄，可演化小世界。', '多级缓存：L1/L2/L3 分层，越近越快、越贵。'),
  entry('goldenImmortal', '金仙', '金性不朽，万劫不磨。', '编译优化 / JIT：把热点路径编译成更快的形态。'),
  entry('taiyiImmortal', '太乙金仙', '太乙者，近乎大道。', '形式化验证：用证明代替抽样测试，承诺没有反例。'),
  entry('daluoImmortal', '大罗金仙', '大罗之上，超脱时空。', '停机问题 / 计算极限：再强的系统也有不可判定的边界。'),
];

/** 三界七域（10 个界域）。 */
export const DOMAINS: readonly CodexEntry[] = allPlayable([
  entry('voidHeaven', '九天虚无界', '最高仙域，界主掌虚无。', '控制平面：不直接干活，只决定谁在什么地方干活。'),
  entry('cloudDharma', '云之法界', '以阵法构成的界域，规则即代码。', '服务网格 / SDN：网络规则集中下发，流量按策略走。'),
  entry('heavenCapital', '天之都', '仙界最繁华的门面。', 'CDN / 前端：玩家最先看到、也最容易被缓存的一层。'),
  entry('jadePond', '瑶池', '仙门派，掌身份与宴席。', 'IAM / 身份认证：谁能进、能做什么，都在这一层判。'),
  entry('cultivationWorld', '修真界', '五派六院、洞天福地，修真者的主战场。', '应用层：业务逻辑真正跑起来的地方。'),
  entry('mortalWorld', '世俗界', '凡人的世界，灵气稀薄。', '客户端 / 终端：算力有限，但离用户最近。'),
  entry('seaRealm', '海域', '东海定天宫等水族势力。', '边缘节点：延迟低、覆盖广，但单点能力弱。'),
  entry('ghostDomain', '鬼域', '煞血阎罗统治，亡魂与煞气聚集。', '故障域：坏掉的节点、丢失的包、没有返回的请求。'),
  entry('demonDomain', '魔域', '魔天尊主统治，以吞噬与掠夺为道。', '攻击面 / 红队：专找系统最薄的那块板。'),
  entry('beastDomain', '妖域', '妖皇裂天统治，万妖横行。', '未受控流量 / 野流量：量大、形状不规则、不能假设它会守规矩。'),
]);

/** 正道、魔道、中立势力（9 个）。 */
export const SECTS: readonly CodexEntry[] = allPlayable([
  entry('swordGate', '仙剑门', '以剑入道，一剑破万法。', '编译器 / 优化器：把一段笨代码变成更短、更快的指令。'),
  entry('buddhaTemple', '万佛宗', '以愿力护持，香火不灭。', '容错 / 冗余：多一份备份，坏一份也还有人念经。'),
  entry('wuweiSect', '无为道派', '不争而善胜，顺势而为。', '事件驱动 / 声明式：不写每一步，只写「要什么状态」。'),
  entry('heavenSwordAcademy', '天剑院', '剑阵成院，规矩森严。', '静态分析 / Lint：在运行之前就把不合规的写法挑出来。'),
  entry('bodhiAcademy', '菩提学院', '以问心为课，以证道为业。', '测试 / 形式化：先证明它对，再让它上线。'),
  entry('celestialPavilion', '天机阁', '卖情报，也算天机。', '监控 / 可观测性：指标、日志、链路，先看见才能修。'),
  entry('artifactSect', '器宗', '天下法宝，半出器宗。', '构建工具 / 包管理：把零件组装成能交付的产物。'),
  entry('demonSect', '魔神宗', '以力证道，弱肉强食。', '性能压榨 / 逆向：把每一滴性能都榨出来，不管代价。'),
  entry('heavenDemonCult', '天魔教', '以乱为道，专攻心魔。', '混沌工程 / 红队：主动把系统打坏，看它能不能自己站起来。'),
]);

/** 丹药图谱（8 种，背景）。 */
export const PILLS: readonly CodexEntry[] = allPlayable([
  entry('foundationPill', '筑基丹', '突破筑基瓶颈的入门丹。', '迁移脚本：把旧状态安全地搬到新结构。'),
  entry('marrowPill', '洗髓丹', '洗髓伐骨，改易根骨。', '重构：不改行为，只把内部结构理顺。'),
  entry('returnYangPill', '还阳丹', '起死回生，续一线生机。', '灾难恢复：从备份和日志把系统拉回来。'),
  entry('silencePill', '寂灭丹', '渡劫第一宝丹，压住心魔。', '混沌演练：提前把最坏情况跑一遍。'),
  entry('renewPill', '结续丹', '断肢重接，续筋接骨。', '热修复：不停机换掉坏掉的那一段。'),
  entry('originYangPill', '元阳丹', '元婴初结时的大补。', '水平扩容：多给一份资源，扛住当下。'),
  entry('clearPill', '清蕴丹', '解百毒，清杂蕴。', '依赖审计：把带毒的依赖清出去。'),
  entry('jadeMarrowPill', '碧髓丸', '灵兽提升功力的口粮。', '性能剖析：先量出热点，再决定喂谁。'),
]);

/** 法宝图谱（3 件，背景）。 */
export const TREASURES: readonly CodexEntry[] = allPlayable([
  entry('skyBottle', '掌天瓶', '可催熟灵药，夺天地造化。', '定时任务 / 批处理：把等待变成可调度的批量工作。'),
  entry('meteorTear', '流星泪', '修复身体，提升修炼速度。', '链路追踪：告诉你时间到底花在哪一段。'),
  entry('heavenPearl', '天逆珠', '炼丹辅助，修炼奇遇。', '编译器：把原料（源码）变成可执行的东西，还能顺手优化。'),
]);

/** 灵根（6 种；本作命格 6 种都可玩，天/变异更稀有）。 */
export const ROOTS: readonly CodexEntry[] = [
  entry('heavenRoot', '天灵根', '无瓶颈，修炼速度极快。', '专用硬件 / ASIC：为一种负载定做，快，但不通用。', true),
  entry('variantRoot', '变异灵根', '两三属性融合，万中无一。', '混合架构：把两种范式拼在一起，取长补短。', true),
  entry('upperRoot', '上品灵根', '心魔涨得慢，命格上佳。', '高配机器 / 低噪声环境：同样的代码，跑得更稳。', true),
  entry('middleRoot', '中品灵根', '中正平和，最常见。', '标准配置：没有惊喜，也没有短板。', true),
  entry('fiveElementsRoot', '五行灵根', '金木水火土俱全，杂而不精。', '多语言 / 多范式：什么都能写，但没有一项极致。', true),
  entry('lowerRoot', '下品灵根', '心魔涨得快，需更早学会刹车。', '低配机器 / 高噪声环境：不优化算法，很快撞墙。', true),
];

/** 给图鉴 UI 用的分组标题。 */
export const CODEX_GROUPS: readonly { readonly title: string; readonly note: string; readonly entries: readonly CodexEntry[] }[] = [
  { title: '境界 · 练气到渡劫', note: '前 9 境本作可玩；仙界 5 级为世界观与后续版本。', entries: REALM_LADDER },
  { title: '界域 · 三界七域', note: '10 个界域都可选（面板「宗门·界域」），改产出/心魔。', entries: DOMAINS },
  { title: '宗门 · 正魔中立', note: '9 个宗门都可选，每个都有一条数值修正。', entries: SECTS },
  { title: '丹药 · 背景图谱', note: '8 种都可获取、可服用（面板「丹药袋」）。', entries: PILLS },
  { title: '法宝 · 背景图谱', note: '3 件都可掉落、可装备（化神/炼虚/合体）。', entries: TREASURES },
  { title: '灵根 · 命格', note: '6 种灵根都由种子决定，心魔倍率 0.75–1.1。', entries: ROOTS },
];

/** 本作可玩境界名（与 content/realms.json 对齐）。 */
export const PLAYABLE_REALMS = REALM_LADDER.filter((item) => item.playable === true).map((item) => item.name);
