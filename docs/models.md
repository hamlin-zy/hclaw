# HClaw 模型配置

## 概述

HClaw 支持通过配置文件定义多个 AI 模型，供 Agent 在不同场景下使用。

## 配置位置

模型配置文件位于系统配置根目录的 `agents/models/` 目录下。

## 配置示例

```json
{
  "name": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "apiKey": "${ANTHROPIC_API_KEY}",
  "baseUrl": "https://api.anthropic.com/v1"
}
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|-----|------|------|------|
| name | string | 是 | 模型标识名称 |
| provider | string | 是 | 服务商名称 |
| model | string | 是 | 具体模型名称 |
| apiKey | string | 是 | API 密钥 |
| baseUrl | string | 否 | API 端点 |

## 常见模型

| 模型 | 提供商 | 适用场景 |
|-----|--------|---------|
| claude-sonnet-4 | Anthropic | 日常对话和任务 |
| claude-3-5-sonnet-latest | Anthropic | 复杂推理和分析 |
| gpt-4o | OpenAI | 多模态任务 |
| deepseek-chat | DeepSeek | 成本优化场景 |