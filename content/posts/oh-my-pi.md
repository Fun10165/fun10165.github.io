---
title: "为什么我觉得 Oh My Pi 是当下最好的 Agent Harness"
date: "2026-07-02"
description: "对当前主流 Agent Harness 的横向对比和个人选择。"
tags:
  - Agent
  - Harness
  - OMP
slug: oh-my-pi
---

自 Claude Code 诞生，以及各模型厂商开始专门针对 agent 场景训练模型之后，agent 终于进化到了"可用"的阶段。

可惜现在的 Agent Harness 绝大多数都不太行，所以我可以直接在这里简单地说明为什么 OMP 是我唯一的选择。

## Claude Code

谁想要 Anthropic 这个闭源的东西？Agent 拥有你电脑上至少用户级的工具权限，出于安全考虑应该拒绝使用任何闭源 Agent。同理，Cursor、Trae、ZCode、CodeBuddy/WorkBuddy、Copilot、Qoder、文心快码、Augment 等也是类似的问题。

## Gemini CLI

一坨，Google 大公司病的产物。所以也不推荐衍生的 Qwen Code。

## OpenClaw

纯 slop，认真的吗要用这个？我到现在都不会用他那个前端配置好 gateway。Why not AstrBot？

## Hermes Agent

抄袭中国团队 EvoMap 的东西，然后靠炒作火了。拒绝这种没底线的开发团队。

## OpenCode

看在 OpenCode 对开源 Harness 生态的贡献上骂得轻点。我想问问 Anomalyco 最近在干什么呢——我在 M5 MacBook Air 上的启动时间已经能卡到好几分钟了，内存泄露的 bug 也没修好，含非 ASCII 字符的粘贴依旧格式混乱，稳定性连日常工作也胜任不了。

不过 OpenCode 的 provider/model 中立、OpenCode Go 套餐还是挺好的。但是我觉得基于 OpenCode 基座开发东西不是好主意。

## Crush

没人觉得他们审美很差吗？而且有过和 OpenCode 现开发团队撕逼的历史，我就不想用了。

## Pi

弃用 OpenCode 后尝试的 Agent Harness。说实话这个有点过于简单了，所以必定要自己维护大量的插件。我向来觉得各自维护解耦（不 monorepo）的插件会非常折磨，于是转向使用 Oh My Pi 了。

## Codex

次选项。但是现在默认不显示思考内容让人非常恼火，功能也不齐全，subagent 如同虚设。稳定性很好。

## Oh My Pi

主选项，相当惊喜。稳定性远超 OpenCode，功能相当齐全，性能和可玩性都很好。
