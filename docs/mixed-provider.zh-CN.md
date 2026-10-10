# 自定义 API 与 ChatGPT Web 混合使用

这是本 Fork 的可选功能。它保留 Codex 的 API Key 登录和当前自定义提供方名称，在同一个 Codex 模型列表里添加 `chatgpt-web/…` 模型。

| 选择的模型 | 请求去向 |
| --- | --- |
| 原有 API 模型 | 当前自定义提供方原来的 API 地址 |
| `chatgpt-web/…` 模型 | 启动器中的 ChatGPT 网页 |

连接期间，自定义提供方的 `base_url` 指向本地桥，桥把普通模型请求转发到原地址。`auth.json` 不需要改成 ChatGPT 登录；安装器不写入登录凭据。使用原有环境变量或 API Key 的方式继续生效。关闭连接或移除集成会恢复此前的路由和模型目录设置。

## 启动器安装

1. 启动本 Fork 的启动器，在浏览器中登录 ChatGPT，并完成浏览器测试。网页登录与 Codex 的 API Key 登录分别使用，不互相替换。
2. 在“初始设置／Setup”页面启用“保留现有 API 提供方”，再点击“安装模型”。不要把 Codex 提供方先改为 `openai`。
3. 安装会读取当前自定义提供方，保存原路由，并生成包含 API 与 Web 模型的本地目录。完成后彻底退出并重新打开 Codex。
4. 在模型选择器中分别选择一个原 API 模型和一个 Web 模型，验证两条路线。首次安装的“本地模型目录已验证”只表示本地文件有效，不表示 Codex 已经加载、网页已响应或工具已执行。
5. 要让网页模型读取项目、修改代码和运行命令，继续完成 MCP 的 Full harness 设置并点击“验证运行时”。Browser-only 模式不提供完整本地工具。

重新安装、账户能力刷新、MCP 设置与运行时更新都会保留已安装的混合模式。安装完成后提供方模式开关锁定；需要改变模式时，先移除 Codex 集成，再安装另一模式，避免在重装时静默切换提供方。

## 命令行安装

在仓库根目录安装依赖后，运行以下命令。按实际需求补充现有的浏览器和 MCP 参数：

```powershell
bun run src/cli.ts setup --mixed-provider --browser-only --browser-host-descriptor 'C:\path\to\launcher-browser.json' --acknowledge-unofficial
```

如果自动发现不到 Codex 可执行文件，使用 `--codex-executable` 指定实际路径：

```powershell
bun run src/cli.ts setup --mixed-provider --browser-only --browser-host-descriptor 'C:\path\to\launcher-browser.json' --codex-executable 'C:\path\to\codex.exe' --acknowledge-unofficial
```

`--mixed-provider` 是首次安装的明确选择，后续设置会读取已安装配置并保留模式。不要直接用未修改的上游安装器或自动更新覆盖这个 Fork，它们不支持这里的自定义提供方路由。

Windows/Linux 的正常用法是启动图形启动器；上述高级命令中的描述文件必须来自正在运行的启动器，不能自行创建。macOS 的终端浏览器部署沿用上游流程。构建使用仓库锁定的 Bun 1.4.0；在仓库根目录与 `launcher` 目录分别执行 `bun install --frozen-lockfile`，然后从根目录运行 `bun run app`，或在 Windows 执行 `bun run --cwd launcher package:win` 生成安装包。

## 使用与限制

- 混合模式仍需要保持启动器运行。连接期间普通 API 模型也经过本地桥；退出前关闭桥连接或移除集成，以恢复直连。
- 断开连接或移除集成前，先把任务模型切回一个原 API 模型。恢复后的上游 API 不认识 `chatgpt-web/…` 模型名称。
- 模型名称以 `chatgpt-web/` 开头时才走网页。原模型保留原有 API 的额度和认证方式，网页模式仍受对应 ChatGPT 账户可用模型及限制影响。
- Codex 保存任务和工具记录，但不能自动导入你在 ChatGPT 网页单独创建的其他聊天。长任务仍可能压缩上下文。
- 如果原 API 模型已经生成不可解码的压缩上下文，切换到网页模型时不能还原其中的隐藏内容。桥会明确拒绝这种切换，避免静默丢失上下文；将目标、约束、进度和测试结果写成可读交接摘要，再在新任务中使用 Web 模型接续。
- `model_catalog_json` 是本地模型目录。API Key 模式可能不请求桥的 `/models`，因此启动器将本地目录验证与“Codex 已请求并加载模型列表”分开显示。
- 支持范围是已有自定义提供方的 Responses 路线。接口兼容性、网页响应和 Full harness 工具执行需要分别验证；配置检查成功不等于三者全部可用。

安装前请保存当前 Codex 配置。CC Switch 等配置管理器如果在连接期间重新改写提供方地址或模型目录，需要先停用相应自动切换；集成遇到用户新增修改会拒绝覆盖，以保留你的新设置。

本次构建的检查结果与尚未验证的部分见[验证记录](mixed-provider-validation.zh-CN.md)。
