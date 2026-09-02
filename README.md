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

1. 打包：`cd auto-vision && npm pack`（或直接使用目录）。
2. 安装进桌面 profile（开发期可用 `link:`，改动即生效，重启桌面后加载）：
   ```bash
   dsh plugin --profile desktop add link:E:\DSH\Test1\auto-vision
   # 或发布形态：
   dsh plugin --profile desktop add E:\DSH\Test1\auto-vision\dsh-plugin-auto-vision-0.1.0.tgz
   ```
3. 在 `C:\Users\wps\.dsh\profiles\desktop\cordis.patch.yml` 加入 loader 行：
   ```yaml
   - insert:
       - id: auto-vision
         name: dsh-plugin-auto-vision
   ```
4. 重启 DSH Desktop。确认 设置 → 插件 出现本插件及配置卡片。

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

## 后续路线（未实现）

- **描述模式（方案 C）**：把图片交给独立视觉子代理转述、主对话保持原模型——在主会话历史极长且视觉模型明显更贵时节省输入 token，但会损失"模型直接看原图"的质量。计划形态：历史超过阈值时启用，失败自动回退当前方案。
