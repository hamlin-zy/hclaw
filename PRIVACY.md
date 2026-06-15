# 隐私政策 / Privacy Policy

**最后更新：2026-06-15**

## 概述

HClaw 是一款本地运行的桌面应用程序。我们重视您的隐私，本政策说明了我们如何收集、使用和保护您的信息。

## 我们收集的信息

### Google 账户信息（仅在使用 Google OAuth 登录时）

当您通过 Google 账号登录访问 Gemini API 时，我们会获取：

- **电子邮件地址** — 用于标识您的账户
- **姓名** — 用于个性化显示
- **头像** — 用于个性化显示
- **OAuth 访问令牌** — 用于调用 Google Gemini API

### 其他数据

- **对话记录** — 存储在您的本地计算机上，不会上传到任何服务器
- **系统日志** — 仅在本地存储，用于调试目的

## 我们如何使用您的信息

- Google 账户信息仅用于**调用 Gemini API**（您选择的 AI 模型服务）
- 所有对话数据**仅存储在本地**，不会发送到除您选择的 AI 模型服务商之外的任何第三方

## 数据存储

- 所有数据存储在您计算机的本地数据库中
- 位置：`C:\Users\<您的用户名>\.hclaw\`
- 您可以随时删除这些数据

## 第三方服务

- **Google Gemini API** — 当您使用 Google OAuth 登录时，我们会使用您的令牌调用 Google Gemini API。这受 [Google 隐私政策](https://policies.google.com/privacy) 约束。
- **Anthropic API / OpenAI API** — 如果您选择使用这些服务商，您的对话内容会发送给对应的服务商处理。

## 数据安全

我们采用行业标准的安全措施保护您的数据：
- OAuth 2.0 / PKCE 安全认证流程
- 所有 API 通信使用 HTTPS 加密
- 访问令牌自动刷新，降低泄露风险

## 您的权利

作为开源软件，您可以：
- 查看完整源代码：[https://github.com/hamlin-zy/hclaw](https://github.com/hamlin-zy/hclaw)
- 随时删除本地数据
- 撤销 Google 授权（在 Google 账户的安全设置中操作）
- 选择不使用 Google OAuth，改用 API Key 方式连接

## 联系我们

如有隐私相关问题，请通过 GitHub Issues 联系我们：
[https://github.com/hamlin-zy/hclaw/issues](https://github.com/hamlin-zy/hclaw/issues)

---

## Overview

HClaw is a locally-running desktop application. We value your privacy and explain below how we collect, use, and protect your information.

## Information We Collect

### Google Account Information (when using Google OAuth login)

When you sign in with Google to access the Gemini API, we obtain:

- **Email address** — to identify your account
- **Name** — for personalized display
- **Profile picture** — for personalized display
- **OAuth access token** — to call the Google Gemini API

### Other Data

- **Conversation history** — stored locally on your computer, not uploaded to any server
- **System logs** — stored locally for debugging purposes

## How We Use Your Information

- Google account information is used **only to call the Gemini API**
- All conversation data is **stored locally** and is not sent to any third party except the AI model service you choose

## Data Storage

- All data is stored in a local database on your computer
- Location: `C:\Users\<YourUsername>\.hclaw\`
- You can delete this data at any time

## Third-Party Services

- **Google Gemini API** — When you use Google OAuth, your token is used to call the Google Gemini API. This is governed by [Google's Privacy Policy](https://policies.google.com/privacy).
- **Anthropic API / OpenAI API** — If you choose these providers, your conversation content is sent to the respective provider for processing.

## Data Security

We use industry-standard security measures:
- OAuth 2.0 / PKCE secure authentication
- HTTPS encryption for all API communications
- Automatic access token refresh to minimize exposure

## Your Rights

As open-source software, you can:
- View the complete source code: [https://github.com/hamlin-zy/hclaw](https://github.com/hamlin-zy/hclaw)
- Delete local data at any time
- Revoke Google authorization (in your Google Account security settings)
- Choose to use API Key instead of Google OAuth

## Contact

For privacy-related questions, please contact us via GitHub Issues:
[https://github.com/hamlin-zy/hclaw/issues](https://github.com/hamlin-zy/hclaw/issues)
