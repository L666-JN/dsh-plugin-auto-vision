# dsh-plugin-auto-vision

自动视觉模型插件：发送（或附加）包含图片的消息时，自动将会话模型切换到支持图片输入的视觉模型；**图片那一轮结束后，自动切回你原来的模型**。纯文本消息完全不受影响。

## 工作原理

```
附加/发送图片
  → client 包装器检测消息含 image
  → RPC autoVision/ensure {provider, model}   （host: 检查 inputModalities，推荐视觉模型）
  → 必要时 session.selectModel 切换（模型选择器同步显示）
  → 原 session.prompt 正常发送（此时模型已支持图片，不再报"当前模型不支持图片"）
  → 该轮结束（running true→false）→ 自动切回原模型
```

- **host 半部**（`lib/index.js`）：`AutoVisionService` 注册 `autoVision/ensure` RPC，纯查询——判断当前模型能否读图，不能则从提供方目录推荐视觉模型（偏好配置 → 同提供方 → 任意）。
- **client 半部**（`lib/client.js`）：包装 `session.prompt` RPC，切换/切回走 DSH 自带的 `selectModel` RPC（与手动切换完全一致）。

## Token 说明（为什么这样最省）

- DSH 的模型 API 是无状态的：每一轮本来就把完整上下文全量发给当前模型。**切换模型不会让历史"重复计费"**。
- 图片必须由视觉模型处理（不可避免）；切回后，`dsh-llm` 会把历史中的图片替换为文本占位符（仅几个 token），后续轮次**不再产生图片 token**。
- 真实增量仅限图片轮一次：`(视觉模型单价 − 原模型单价) × 图片轮历史 token + 图片 token`。

## 安装

在终端执行（将 `desktop` 换成你自己的 profile 名；一般默认就是 `desktop`）：

```bash
dsh plugin --profile desktop add github:L666-JN/dsh-plugin-auto-vision
```

如需指定版本 tag：

```bash
dsh plugin --profile desktop add github:L666-JN/dsh-plugin-auto-vision#v0.1.0
```

然后：

1. 在 profile 的 `cordis.patch.yml`（默认 `C:\Users\<你的用户名>\.dsh\profiles\desktop\cordis.patch.yml`）加入 loader 行：
   ```yaml
   - insert:
       - id: auto-vision
         name: dsh-plugin-auto-vision
   ```
2. 重启 DSH Desktop，在 设置 → 插件 确认出现本插件及配置卡片，即安装完成。

> 若 pnpm 提示需要 allowBuilds，在 `pnpm-workspace.yaml` 的 `allowBuilds` 中加入 pnpm 打印的包名后重新执行安装命令即可（本仓库无构建脚本，通常不会触发）。

## 配置（设置 → 插件 → dsh-plugin-auto-vision）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后插件完全不干预 |
| `preferredModels` | `[]` | 按顺序优先使用的视觉模型，如 `[{ "provider": "deepseek-official", "model": "deepseek-v4-flash-vision-exp" }]`；未配置时自动选择同提供方的视觉模型 |

## 行为说明

- 图片轮结束（running true→false）后自动切回原模型；**队列连发多张图片时，全部处理完才切回一次**。
- 图片轮进行中如果你手动改了模型，切回会被跳过（尊重手动选择）。
- 找不到视觉模型时，发送会给出清晰报错；host 半部缺失或网关不可用等任何异常都会优雅降级为 DSH 原有行为，**不会破坏发送功能**。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-plugin-auto-vision
```
并移除 `cordis.patch.yml` 中的 `auto-vision` 行，重启即可。
