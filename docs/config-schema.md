# models.json 配置说明

AgentReader 从 `{userData}/models.json` 读取提供商与模型配置。文件是 **JSONC**：允许 `//` 行注释、`/* */` 块注释和尾逗号，便于人类与 AI 直接编辑。

- macOS 路径：`~/Library/Application Support/@agentreader/app/models.json`
- 应用内「设置 → models.json」可编辑、重新载入、用系统编辑器打开。
- 密钥不要写进本文件。用 `apiKeyEnv` 引用环境变量，或在「设置」里填写（加密存入 `auth.json`）。

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | number | 是 | 配置版本，当前为 `1`。 |
| `defaultModel` | string | 否 | 默认模型，格式 `"<providerId>/<modelId>"`。应用内选择的当前模型会覆盖它。 |
| `providers` | object | 否 | 提供商覆盖/新增，键为 providerId。 |
| `tools` | object | 否 | 工具配置，当前仅 `webSearch`（后续版本）。 |

## providers

内置 providerId：`openai`、`anthropic`、`deepseek`、`opencode`、`opencode-go`。内置提供商只需覆盖字段，不必重复声明模型。

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 显示名。 |
| `baseUrl` | string | API 根地址。**自定义提供商必填**；内置可覆盖。 |
| `api` | string | `openai-completions` 或 `anthropic-messages`。自定义必填。 |
| `apiKey` | string | 内联密钥（不推荐）。 |
| `apiKeyEnv` | string | 从该环境变量读取密钥（推荐）。 |
| `headers` | object | 附加请求头，值为字符串。 |
| `models` | array | 追加或按 `id` 覆盖模型，见下。 |
| `modelOverrides` | object | 对已有模型（含内置）做字段级补丁，键为模型 id。 |
| `disabledModels` | string[] | 隐藏这些模型。 |

### models / modelOverrides 条目字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 模型 id（`models` 中必填）。 |
| `name` | string | 显示名。 |
| `contextWindow` | number | 上下文窗口（token）。仅用于展示。 |
| `maxTokens` | number | 最大输出 token。 |
| `reasoning` | boolean | 是否为推理模型。 |
| `api` | string | 覆盖协议（用于聚合网关中混合协议的模型）。 |
| `hidden` | boolean | 在 `modelOverrides` 中设为 `true` 可隐藏该模型。 |

示例：新增一个本地 OpenAI 兼容服务。

```jsonc
{
  "version": 1,
  "defaultModel": "my-vllm/qwen3-32b",
  "providers": {
    "my-vllm": {
      "name": "本地 vLLM",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "models": [{ "id": "qwen3-32b", "name": "Qwen3 32B", "contextWindow": 131072 }]
    }
  }
}
```

示例：给内置提供商加模型、隐藏旧模型、覆盖参数。

```jsonc
{
  "version": 1,
  "providers": {
    "openai": {
      "apiKeyEnv": "OPENAI_API_KEY",
      "disabledModels": ["gpt-4o-mini"],
      "models": [{ "id": "gpt-5.2", "contextWindow": 400000, "reasoning": true }],
      "modelOverrides": { "gpt-4.1": { "maxTokens": 16384 } }
    }
  }
}
```

## 手动添加的 OpenAI 兼容提供商（GUI）

「设置 → OpenAI 兼容（手动添加提供商）」里添加的提供商会写入同目录下的 `custom-providers.json`，**不会重写本文件**，因此不会丢失注释。运行时把两者合并；若 providerId 冲突，以 `models.json` 为准。

该文件由应用维护，一般无需手改；格式示例：

```json
{
  "my-llm": {
    "name": "本地 vLLM",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "api": "openai-completions",
    "models": [{ "id": "qwen3-32b" }, { "id": "qwen3-8b" }]
  }
}
```

密钥同样存在 `auth.json`，不在这个文件里。

## tools.webSearch（后续版本）

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 是否启用联网搜索工具。 |
| `backend` | string | `native` / `brave` / `tavily` / `exa` / `duckduckgo`。 |
| `apiKey` / `apiKeyEnv` | string | 第三方搜索密钥。 |
| `maxResults` | number | 返回结果条数上限。 |

## 内置提供商默认值

| providerId | 默认 baseUrl | 协议 | 环境变量 |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | openai-completions | `OPENAI_API_KEY` |
| `anthropic` | `https://api.anthropic.com/v1` | anthropic-messages | `ANTHROPIC_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | openai-completions | `DEEPSEEK_API_KEY` |
| `opencode` | `https://opencode.ai/zen/v1` | openai-completions | `OPENCODE_API_KEY` |
| `opencode-go` | `https://opencode.ai/zen/go/v1` | openai-completions | `OPENCODE_API_KEY` |

内置模型目录可能滞后：在「设置 → 刷新模型列表」会调用提供商公开的 `/models` 接口拉取最新列表（仅对 openai-completions 且已配置 baseUrl 的提供商生效），结果缓存到 `models-cache.json`，不写入本文件。

## 常见错误

- `JSON 解析失败`：检查括号、引号；本文件允许注释与尾逗号，但字符串内的 `//` 不会被当作注释。
- `providers.<id>.baseUrl: 自定义提供商必须提供 baseUrl`：非内置提供商必须显式给出 `baseUrl`。
- `providers.<id>.models[n].id: 必填且为非空字符串`：`models` 条目缺少 `id`。
- `providers.<id>.api: 必须是 openai-completions 或 anthropic-messages`：`api` 取值写错。
- `defaultModel: 格式应为 "<providerId>/<modelId>"`：`defaultModel` 缺少 `/`。

配置写坏不会影响阅读功能：解析失败时应用回退到内置提供商，并在设置里显示错误定位。
