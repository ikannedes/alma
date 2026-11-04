# 3D 骰子游戏 · 大话骰 & 明牌

[English](./README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/crper/dice-game/actions/workflows/deploy.yml/badge.svg)](https://github.com/crper/dice-game/actions/workflows/deploy.yml)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6.svg)
![Vite](https://img.shields.io/badge/Vite-8-646cff.svg)
![Three.js](https://img.shields.io/badge/Three.js-0.185-000000.svg)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38bdf8.svg)

<div align="center">
  <sub>📱 微信公众号 · <strong>黑白汤</strong> &nbsp;—&nbsp; 微信搜索即可关注，不定期写点 AI 与前端的折腾记录</sub>
  <!-- 拿到公众号二维码后，放到 docs/wechat-mp.png 并解开下一行注释即可变成扫码关注 -->
  <!-- <img src="docs/wechat-mp.png" width="150" alt="黑白汤 公众号二维码" /> -->
</div>

一个跑在浏览器里的 3D 骰子游戏，两种玩法：**大话骰**（每人一副暗骰，轮流叫骰，随时可以开盅揭盅）与**明牌**（一次掷出全部骰子，直接公布结果）。同一时间界面上只呈现一种玩法。

骰子不是贴图，也不是 CSS 拼出来的。每一颗都是圆角立方体网格，背后跑着一套轻量的刚体近似模拟——重力、落地与撞墙反弹、摩擦、自旋阻尼——最后收敛到一个精确的静止姿态。所以游戏报出的点数，就是你在桌面上真正能看到的点数。

<!-- 开启 GitHub Pages 后，把这里换成你的线上地址。 -->
> **在线试玩：** https://crper.github.io/dice-game/

## 功能

- **骰子数量可调** —— 每人 1 到 10 颗，随时可在「牌桌设置」里增减。改动会立即重开本局，保证桌面上的骰子始终和当前规则一致。
- **两种完整玩法**
  - *大话骰*：暗骰、轮流叫骰、严格加叫校验、开盅判定、按局计分，并且「1 为万能」这条地方规矩可以开关。
  - *明牌*：一次掷出一副骰子并当场公布，给出点数和、大小判定、顺子／豹子识别，以及六面点数分布图。
- **桌面永远看得懂** —— 骰子之间留有真实间距，每一方的骰子都放在带标签的绒面托盘里，归属一目了然。
- **真正的 3D 牌桌** —— 圆角骰体、程序化绘制的凹陷点数贴图、基于图像的环境光照、柔和阴影，以及烘焙了光池的绒面桌布。
- **投掷物理** —— 先自由翻滚，再收敛落定，每一颗骰子最终朝向都经过证明是正确的。
- **交互不会添乱** —— 相机转动的范围不足以把对面一方转到前面来；三个固定视角按钮取代「只能拖拽」；移动端纵向翻页不会被画布吞掉；明牌模式里桌面本身就是投掷按钮。
- **响应式** —— 手机单列、笔记本「桌面 + 操作台」、宽屏再加侧栏。相机取景会主动给浮层留出空间，骰子不会被按钮压住；在 800px 高的视口里主要操作按钮依然在首屏之内。
- **双语界面** —— 默认简体中文，顶栏一键切换英文，偏好会记住；连桌布上的托盘标签都会跟着语言重绘。
- **看得懂的反馈** —— 按钮状态明确、桌面上有实时阶段提示、胜负横幅的措辞由实际判定推导、开盅有动效，以及合成音效（不携带任何音频文件，可静音）。
- **可访问性** —— 基于 Radix 的 shadcn/ui 原语（对话框、滑杆、开关、切换组）、`role="status"` 播报、可见的焦点环，并尊重 `prefers-reduced-motion`（直接跳过滚动动画）。
- **降级兜底** —— 若设备不支持 WebGL，桌面会退化为平面骰面展示同样的结果，而不是抛出错误页。

## 规则速览

### 大话骰

1. 每人拿到相同数量的骰子，只能看自己的点数。
2. 轮流叫骰，格式为「至少 N 颗骰子是 F 点」。后手必须严格大于前手：数量更大，或数量相同而点数更大。
3. 轮到你时可以不叫，改为**开盅**质疑上一手，全场揭盅数骰。
4. 实际数量达到叫出的数量，叫骰**成立**，开盅方受罚；否则叫骰**不成立**，叫骰方受罚。
5. 开启「1 为万能」后，每颗 1 点都能计入任意点数（叫 1 点时除外）。

### 明牌

一次掷出一副骰子并当场公布。结果会给出称号——豹子（全部同点）、顺子（点数各不相同且连续）、或者按「每颗骰子理论均值 3.5」判定的大／小——并用柱状图展示六个点数的分布。

## 快速开始

```bash
git clone https://github.com/crper/dice-game.git
cd dice-game
npm install
npm run dev          # http://localhost:5173
```

需要 Node.js 20.19 或更高版本。

## 可用脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 启动带热更新的开发服务器。 |
| `npm run build` | 类型检查并构建生产包到 `dist/`。 |
| `npm run preview` | 本地预览生产构建结果。 |
| `npm run typecheck` | 对三个 tsconfig 工程执行完整类型检查。 |
| `npm run lint` | 运行 Oxlint（预期 0 警告）。 |
| `npm run test` | 用 Vitest 跑规则引擎与状态机的单元测试。 |
| `npm run verify:faces` | 校验骰面与贴图的对应关系。 |
| `npm run check` | 依次执行 `typecheck`、`lint`、`test`、`verify:faces`。 |

### 为什么需要 `verify:faces`

3D 骰子有一种很隐蔽的错法：屏幕上显示一个点数，游戏却报另一个点数。给立方体贴六张材质很容易出错——材质槽顺序必须和几何体的面顺序一致，相对面点数必须相加为 7，而「把某个面转到朝上」的旋转又必须同时满足前两条。

这个脚本通过 Vite 的解析器加载真实源码，对全部六个点数、多个自旋角度断言：把 *v* 点转到朝上后，*v* 的材质确实落在顶面槽位；同时校验相对面之和为 7，以及圆角立方体确实暴露了六个覆盖全部顶点的材质组。它会在每次部署前于 CI 中运行。

## 目录结构

```
src/
├── components/           # 展示型与容器型组件
│   ├── ui/               # shadcn/ui 基础组件（button、dialog、slider、switch 等）
│   │                     # 以及游戏专属件（PipFace、图标统一出口）
│   ├── DiceStage.tsx     # WebGL 画布宿主、HUD 与桌面上的操作台
│   ├── TableConsole.tsx  # 上桌控制台：大话骰叫骰 / 明牌数量 + 掷骰
│   ├── ResultCard.tsx    # 开盅后的判定详情
│   └── OpenRollCard.tsx  # 明牌模式的结果报告
├── hooks/
│   ├── useDiceGame.ts    # 回合编排：计时、AI 出牌、音效、偏好持久化
│   └── useDiceScene.ts   # 把 React 状态桥接到命令式的 Three.js 场景
├── i18n/                 # react-i18next 配置与中/英文案树（默认中文）
├── lib/                  # 纯逻辑，不含 React、Three.js 与界面文案
│   ├── constants.ts      # 调参值与上限
│   ├── dice.ts           # 掷骰、统计、随机数
│   ├── liarDice.ts       # 叫骰校验、概率估算、AI 决策
│   ├── sound.ts          # 合成音效（WebAudio）
│   └── stats.ts          # 明牌模式的结构化判定与分布
├── state/
│   └── gameReducer.ts    # 纯函数游戏状态机
├── three/                # 全部 Three.js 代码
│   ├── DiceScene.ts      # 渲染器、相机、渲染循环、对外 API
│   ├── diceFace.ts       # 骰面与材质槽的映射及「朝上」旋转
│   ├── layout.ts         # 骰位、绒面托盘与桌面所需尺寸
│   ├── pipTexture.ts     # 程序化绘制的骰面
│   ├── table.ts          # 桌面、座位托盘、边框、灯光、环境
│   └── tumble.ts         # 投掷模拟
├── types/
│   └── game.ts           # 共享领域类型
├── App.tsx               # 布局外壳
├── index.css             # Tailwind 主题变量与动画
└── main.tsx              # 入口
```

## 实现要点

**游戏状态是一个纯 reducer。** `state/gameReducer.ts` 里没有计时器、没有 DOM，除了发牌之外也没有随机性。开局、叫骰、开盅、揭晓、下一局，每一次状态迁移都是「旧状态 + 一个 action」的纯函数——这正是规则能被单独测试的原因。

**时间轴由 `useDiceGame` 掌握。** reducer 是瞬时的，而场景在播动画。因此每一个带动画的阶段都有**两条**出口：骰子停稳时来自 3D 场景的事件，以及一个足够宽松的兜底定时器。WebGL 上下文卡住、标签页被切到后台、掉帧，都不会让这一局卡死。

**场景从不自己猜。** `DiceScene` 会被告知该落到哪些点数上。模拟先经历带重力、反弹、摩擦和自旋阻尼的混沌阶段，再把每颗骰子融合到一个精确的静止姿态——位置来自布局，四元数来自 `quaternionForFaceUp(value, spin)`。随机性让投掷看起来真实，落定阶段让结果真实可信。

**骰面朝向是被证明的，不是被假设的。** Three.js 给 `BoxGeometry` 的六个材质槽顺序是固定的（`+X, -X, +Y, -Y, +Z, -Z`），而 `RoundedBoxGeometry` 在转为非索引几何体后依然保留这六个分组。点数排布在 180° 旋转和镜像下都不变，因此绕 Y 轴任意自旋都不可能让一个面被读成别的点数——这正是翻滚动画可以随便转的原因。这一切由 `npm run verify:faces` 锁定。

**桌子的尺寸由「必须放得下什么」反推。** 骰子布局、托盘轮廓、桌面半径全部来自同一次 `computeLayout` 计算。托盘的圆角比例是固定的，而这个圆角不是装饰：矩形的角是它离圆心最远的点，尖角托盘在每人 10 颗时会直接溢出圆形桌布。`trayReach()` 把圆角后的实际外沿反馈给桌面半径，相机取景再据此采样桌沿与每个骰位，并且两个轴使用不同的填充系数，给上下浮层留出空间。

**按需渲染。** 场景只在有变化时绘制：骰子落定、开盅动效、相机阻尼、尺寸变化都会把当前帧标记为脏帧；阴影只会在骰子真正运动时重算。

## 部署到 GitHub Pages

仓库自带 `.github/workflows/deploy.yml`：先通过 [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) 安装 [Vite+](https://viteplus.dev) 工具链（含依赖缓存），再依次做类型检查、lint、单元测试、骰面校验、构建，并发布 `dist/`。

1. 把项目推送到 GitHub。
2. 在仓库的 **Settings → Pages** 里，把 **Source** 设为 **GitHub Actions**。
3. 推送到 `main`，或者在 **Actions** 标签页手动触发一次。

`base` 从环境变量 `VITE_BASE` 读取，工作流会依据 Pages 配置自动填入——因此项目站点（`https://<user>.github.io/<repo>/`）无需改任何代码即可工作，而本地开发仍然从 `/` 提供服务。

手动构建子路径部署：

```bash
VITE_BASE=/your-repo/ npm run build
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 界面 | React 19 |
| 组件 | shadcn/ui（Radix 原语）—— button、dialog、slider、switch、toggle group、card、badge |
| 语言 | TypeScript 7（严格模式、`verbatimModuleSyntax`、`erasableSyntaxOnly`） |
| 构建 | Vite 8（Rolldown），CI 使用 Vite+ 工具链 |
| 3D | Three.js 0.186 |
| 样式 | Tailwind CSS 4，`cn` 类名合并工具 |
| 多语言 | i18next + react-i18next（默认简体中文，一键切英文） |
| 图标 | lucide-react |
| 测试 | Vitest |
| 代码检查 | Oxlint |

## 开源协议

[MIT](./LICENSE) © dice-game-3d contributors

骰子点数、桌布与音效全部在运行时生成——项目不携带任何第三方美术或音频素材。

---

<div align="center">
  <sub>📱 <strong>微信公众号 · 黑白汤</strong><br/>微信搜索即可关注 · <a href="https://crper.github.io/dice-game/">在线试玩</a> · <a href="./README.md">English docs</a></sub>
</div>
