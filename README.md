# delta-craft

《三角洲行动》手游 · 特勤处每日收菜与下单的自动化探索。

两条实现路线，按可靠性排序：

## 1. skill（推荐，跑在 DSH Go 本机引擎上）

`skills/delta-craft/SKILL.md` 是一份给 agent 看的流程说明，不依赖任何坐标：

- 状态表：生产中的台跳过、有成品先收、材料不足点「一键补齐」、余额不足停、概率性登录页停
- 硬约束：不输密码验证码、不碰支付、每次点前先读屏、认不出来就停
- 组装方式：DSH Go 本体引擎 + 手机操控（无障碍读屏 + 点按）

装到手机的 `$DSH_HOME/skills/delta-craft/SKILL.md` 即可。它的好处是能处理"每次都不太一样"的情况——因为 agent 每步都在看图。

## 2. adb 脚本（PC 驱动，兜底）

`phone.mjs` 用 PC 上的 adb 直接驱动手机，确定性点击，不依赖视觉模型。

```bash
node phone.mjs devices
node phone.mjs wake
node phone.mjs unlock-pin            # DSH_PIN 环境变量，只试一次，验证 keyguard 真消失才继续
node phone.mjs cycle --game <包名> --flow flows/craft.json --settle 45000
```

`watch.mjs` 是采集器：手机上正常操作一遍，PC 每 1.2 秒截一帧，事后按帧还原流程。

```bash
node watch.mjs --dir shots/session-01 --interval 1200 --minutes 10
```

### 已知限制

- `wm dismiss-keyguard` 只对**没有**安全锁屏的手机有效。设了 PIN/图案，adb 解不开；要么用「信任地点 / 延长解锁」，要么整夜保持唤醒。
- 关屏就等于上锁。所以"跑完关屏"与"下次还能自动解锁"在设了密码时冲突。
- 三角洲是 GPU 渲染，无障碍树里没有文字，只有截图可用。
- 生产是 8 小时一轮，一天三次。

## 风险

腾讯 ACE 反作弊。`input tap` 本身是标准输入事件，但固定时刻、零误差、一天三次的点击序列是典型判定特征。账号风险自担。

## 目录

| 路径 | 作用 |
|---|---|
| `skills/delta-craft/SKILL.md` | 给 agent 的流程与状态表 |
| `phone.mjs` | adb 控制手机的 CLI |
| `watch.mjs` | 定时截帧采集器 |
| `shots/` | 采集与留证截图（不入库） |
