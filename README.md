# Kitty

Kitty is an AI workspace for building hardware. You describe the board you want, and an agent
draws the schematic, lays out the PCB, writes the firmware, and flashes it, while you watch each
step and stay in control of every decision.

Kitty is a fork of [T3 Code](https://github.com/pingdotgg/t3code). It keeps T3 Code's agent
harness (threads, providers, terminals, diffs) and adds the hardware side.

[中文说明](./README.zh-CN.md)

> [!WARNING]
> Kitty is an early preview. One board (an ESP32-S3 breathing LED) has gone through the whole
> flow; no board designed in Kitty has been manufactured yet. Check everything before you order.

## What it does

- **Schematic**: the agent places parts from the JLC catalog, connects pins by net, and tidies the
  sheet into framed blocks with drawn wires. You can edit by hand in the same view, with undo.
  Every edit is read back by KiCad and checked with ERC before it is saved.
- **PCB**: placement, autorouting, copper pours, silkscreen, DRC, a 3D view with a check that
  each 3D model sits on its footprint, and order files for JLCPCB.
- **Firmware**: ESP-IDF projects are built, flashed and monitored from the Hardware panel. Kitty
  can install a pinned ESP-IDF for you.
- **Agents**: works with the coding agents you already use (Claude Code, Codex, Cursor, OpenCode
  and others). The hardware tools are exposed to them over MCP.

Designs are plain KiCad files in your project, so you can open them in KiCad at any time.

## Requirements

- macOS (the platform Kitty is developed and tested on)
- [Node.js](https://nodejs.org) 24 and [Vite+](https://viteplus.dev) (`vp`)
- [KiCad](https://www.kicad.org) 10
- At least one agent CLI, installed and signed in, for example
  [Claude Code](https://claude.com/product/claude-code) or
  [Codex CLI](https://developers.openai.com/codex/cli)
- For firmware: an ESP32-S3 board. ESP-IDF is installed from inside Kitty.

## Run from source

There are no packaged releases yet.

```bash
git clone https://github.com/lintheyoung/kitty.git
cd kitty
vp i
vp run dev
```

This starts the server and opens the web app. `vp run dev:desktop` starts the desktop app
instead. Kitty keeps its data in `~/.kitty` and does not share anything with a T3 Code install on
the same machine.

## Privacy

Kitty collects no usage data, and automatic updates are off. See [privacy](./docs/kitty/privacy.md).

## Documentation

- [Development plan](./docs/kitty/开发计划.md) (Chinese)
- [Board designer: features and interface](./docs/kitty/板图设计器-功能与界面设计.md) (Chinese)
- [T3 Code user docs](./docs/user), which still apply to everything Kitty inherits

## License

[MIT](./LICENSE). Kitty is built on T3 Code, copyright T3 Tools Inc., used under the MIT license.
"T3 Code" and the T3 logo belong to their owners; Kitty is not affiliated with or endorsed by
T3 Tools Inc.
