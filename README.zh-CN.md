# Kitty

Kitty 是一个做硬件的 AI 工作台。你描述想要的板子，AI 画原理图、布 PCB、写固件并烧录，每一步你都能看到，决定权在你手里。

Kitty 是 [T3 Code](https://github.com/pingdotgg/t3code) 的分支。它保留了 T3 Code 的 AI 编程底座（对话、模型接入、终端、差异对比），在上面加了硬件开发的部分。

[English](./README.md)

> [!WARNING]
> Kitty 还是早期预览版。目前只有一块板（ESP32-S3 呼吸灯）走通过完整流程，还没有任何一块用 Kitty 设计的板子实际打样过。下单前请自行核对所有内容。

## 能做什么

- **原理图**：AI 从嘉立创器件库放器件，按网络连接引脚，并把图纸整理成带外框的模块、画好连线。你可以在同一个界面里手动修改，支持撤销。每次修改都会让 KiCad 读一遍并跑 ERC，通过后才保存。
- **PCB**：摆放、自动布线、铺铜、丝印、DRC、3D 预览（会检查 3D 模型是否对准封装），并导出嘉立创的生产文件。
- **固件**：在 Hardware 面板里编译、烧录、查看串口日志。Kitty 可以替你安装固定版本的 ESP-IDF。
- **AI**：使用你已有的 AI 编程工具（Claude Code、Codex、Cursor、OpenCode 等），硬件工具通过 MCP 提供给它们。

设计文件就是项目里的 KiCad 文件，随时可以用 KiCad 打开。

## 环境要求

- macOS（Kitty 目前只在 macOS 上开发和测试）
- [Node.js](https://nodejs.org) 24 和 [Vite+](https://viteplus.dev)（`vp`）
- [KiCad](https://www.kicad.org) 10
- 至少一个已安装并登录的 AI 命令行工具，例如 [Claude Code](https://claude.com/product/claude-code) 或 [Codex CLI](https://developers.openai.com/codex/cli)
- 做固件需要一块 ESP32-S3 开发板。ESP-IDF 在 Kitty 里安装。

## 从源码运行

目前还没有安装包。

```bash
git clone https://github.com/lintheyoung/kitty.git
cd kitty
vp i
vp run dev
```

这会启动服务并打开网页版。`vp run dev:desktop` 启动桌面版。Kitty 的数据放在 `~/.kitty`，不会和本机的 T3 Code 共用任何数据。

## 隐私

Kitty 不收集使用数据，自动更新默认关闭。详见[隐私说明](./docs/kitty/privacy.md)。

## 文档

- [开发计划](./docs/kitty/开发计划.md)
- [板图设计器：功能与界面设计](./docs/kitty/板图设计器-功能与界面设计.md)
- [T3 Code 用户文档](./docs/user)（英文），Kitty 继承的功能仍然适用

## 致谢

读板、布线和布局审查使用 [Copper for KiCad](https://github.com/claynicholson/copper-kicad-mcp)（MIT 许可），Kitty 在首次使用时下载固定版本。器件来自嘉立创 / LCSC 的器件库。

## 许可

[MIT](./LICENSE)。Kitty 基于 T3 Code（版权归 T3 Tools Inc.，MIT 许可）。“T3 Code”和 T3 标志归其所有者所有；Kitty 与 T3 Tools Inc. 没有关联，也未获其背书。
