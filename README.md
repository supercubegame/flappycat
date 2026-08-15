# FLAPPYCAT

网页版 flappy bird。纯前端、零运行时依赖，一个不碰 I/O 的引擎加一层薄壳 canvas 渲染。

**玩法**：`Space` 或鼠标点击起飞，穿过管道，撞上就死。死了再按一下重开。

## 长什么样

| 开局 | 游戏中 | 结束 |
| --- | --- | --- |
| <img src="docs/shots/ready.svg" width="240" alt="ready screen"> | <img src="docs/shots/play.svg" width="240" alt="gameplay"> | <img src="docs/shots/dead.svg" width="240" alt="game over"> |

这三张是**按引擎几何手画的示意图**，不是浏览器跑出来的截图。真截图每轮 CI 都拍三张
（`shot-ready.png` / `shot-play.png` / `shot-dead.png`），传成 Actions 里的 artifact。
把两边并成一份已经登记在 `docs/OBLIGATIONS.json` 里，过期快闸门会红。

闸门守的不是“这三张图好不好看”，而是两件硬事：SVG 里声明的画布尺寸必须等于引擎的
`WORLD_W × WORLD_H`；`README` 引用的图集合必须等于 `docs/shots/` 下的实际文件集合，
双向。新加一张忘了引会红，删一张而 README 还引着也会红。

## 安装与运行

需要 **Node.js 22 以上**。玩游戏本身不需要装任何东西，装依赖只是为了跑浏览器闸门。

```bash
git clone https://github.com/supercubegame/flappycat.git
cd flappycat

# 1. 只想玩：起一个静态服务器，然后浏览器开 http://127.0.0.1:8080
npm run serve

# 2. 想跑闸门：先装依赖与 Chromium
npm install
npx playwright install --with-deps chromium

# 3. 快闸门，零依赖，几十秒
npm run verify

# 4. 浏览器闸门，真起页面真敲键真数像素
npm run verify:web

# 5. 把两份报告合成一条评论（CI 跑的就是它）
npm run report
```

不想本地装任何东西的话，不用构建：仓库本身就是一个静态站点，`index.html` 直接就是入口。
注意别用 `file://` 打开,ES 模块在那下面加载不了，必须走 HTTP。

### 在线玩

Pages 部署在 `main` 上自动跑：https://supercubegame.github.io/flappycat/

第一次部署需要仓库所有者在 Settings → Pages 把 source 选成 **GitHub Actions**。
流水线里已经带了 `enablement: true` 去试着自动开，但那一步依赖仓库权限，可能需要你手动确认。

## 仓库结构

- `src/engine.mjs` — 纯核心。`step(state, input)` 返回新状态，不改入参，不碰 I/O。
- `src/render.mjs` — 只读状态画图，不做游戏逻辑。
- `src/main.mjs` — 浏览器外壳与 `window.__FLAPPY` 诊断出口。
- `scripts/verify.mjs` — 快闸门。
- `scripts/verify-web.mjs` — 浏览器闸门。
- `docs/OBLIGATIONS.json` — 带期限的义务，过期快闸门就红。

## 闸门到底在证明什么

三条承重的：

1. **机器人能连过十几根管道**，八个种子各跑一遍。一条同时证明关卡可通过、计分在走、碰撞在拦。
2. **像素等号**。管道只用整数坐标的平色矩形画，没有反锥齿，所以“某横带里管体色像素数
   == 从引擎快照推导的应有值”这一条能同时守住三件事：画出来了、画对了几根、
   画面已经跟上状态。菜单页期望值是 0，游戏中弹窗像素期望值也是 0，那是它的负向基准。
3. **翻越高度与关卡间距的耦合**。用引擎自己跑一遍量出“两根管道之间能爬多少”，
   不是拄计划值做乘法。两侧都会红。

另外每一类扫描器（纯度、`| tee` 必须同段有 pipefail、密钥形状、workflow 集合等于目录）
都配了**变异体**，而且先断言“替换真的发生了”，否则得到的是一个静默通过的假变异体。

## 测不出来的

- 好不好玩。全绿不代表好玩，这一条只能人验收。
- 手机触屏的手感。代码里有 `pointerdown`，CI 验不了真机手感。
- 声音。现在根本没做。
- 浏览器闸门里机器人得分下限与帧率下限现在是**拍的**，不是实测值。已登记成义务。
