# STM32 Development Tools for VS Code

一个功能强大的 VS Code 扩展，用于 STM32 微控制器开发，支持 CMake 构建、GCC-ARM 编译和 OpenOCD 调试。

## ✨ 功能特性

### 🔧 编译构建
- **CMake 集成**: 完整的 CMake 项目支持
- **GCC-ARM 工具链**: 支持 arm-none-eabi-gcc 编译器
- **Ninja 构建**: 快速并行编译
- **一键编译**: 编译、清理、重新编译

### 🐛 调试下载
- **OpenOCD 集成**: 支持多种调试器
  - ST-Link V2/V2-1/V3
  - J-Link
  - CMSIS-DAP
- **程序下载**: 一键烧录固件到芯片
- **在线调试**: 支持断点、单步、查看变量

在侧栏「项目信息 → 烧录 BIN」中提前选择文件，选择结果保存在工作区的 `stm32.binFile` 配置中。「烧录程序」会优先烧录该 BIN，无需再次选择；文件丢失时会提示重新选择。未设置时，默认优先使用当前构建类型目录中的 BIN，同目录按路径排序选择；找不到 BIN 时保留原有 ELF/HEX 烧录流程。清空 `stm32.binFile` 可恢复自动选择。

「操作 → 提取固件（BIN）」从当前芯片的 `0x08000000` 读取 Flash，确认长度（KiB）后选择 BIN 保存位置。已收录芯片默认填入数据库容量，STM32L452RET6 默认 512 KiB；其他型号需填写实际容量。使用当前调试器配置，CMSIS-DAP 显式选择 SWD，速度为 1000 kHz。读取会复位并暂停芯片，完成后需复位或重新上电恢复运行。此功能不擦除、不写入、不解除读保护；读取失败不会替换已有备份，只有完整读取后才保存。命令依据 [OpenOCD dump_image 文档](https://www.openocd.org/doc/html/General-Commands.html)。

「操作 → 开启读保护」使用当前芯片对应的 OpenOCD `lock` 命令，执行前需确认并先备份固件。开启后无法正常提取固件，可能限制调试；日后解除保护可能擦除程序和数据。此入口不设置永久保护 Level 2，完成后请断电重启使设置生效。

「操作 → 解除读保护」按当前芯片和调试器执行解锁。操作前需停止调试和 OpenOCD 服务，并确认数据擦除提示；完成后将芯片断电重启再烧录。解除读保护可能擦除全部程序和数据，RDP Level 2 无法解除。命令依据 [OpenOCD Flash Commands](https://www.openocd.org/doc/html/Flash-Commands.html)，实际支持取决于芯片和安装的 OpenOCD 版本。


### 📟 芯片支持
- STM32F0 系列 (Cortex-M0)
- STM32F1 系列 (Cortex-M3)
- STM32F2 系列 (Cortex-M3)
- STM32F3 系列 (Cortex-M4)
- STM32F4 系列 (Cortex-M4)
- STM32F7 系列 (Cortex-M7)
- STM32G0 系列 (Cortex-M0+)
- STM32G4 系列 (Cortex-M4)
- STM32H7 系列 (Cortex-M7)
- STM32L0/L1/L4/L5 系列
- STM32U5 系列
- STM32WB 系列

### 🖥️ 状态栏集成
所有功能都可以通过状态栏快速访问：

```
[芯片型号] [调试器] [构建类型] [编译] [清理] [烧录] [调试]
```

## 📦 安装要求

### 必需工具

1. **GCC ARM 工具链**
   ```
   下载地址: https://developer.arm.com/tools-and-software/open-source-software/developer-tools/gnu-toolchain/gnu-rm
   ```

2. **OpenOCD**
   ```
   下载地址: https://github.com/xpack-dev-tools/openocd-xpack/releases
   ```

3. **CMake**
   ```
   下载地址: https://cmake.org/download/
   ```

4. **Ninja** (推荐)
   ```
   下载地址: https://github.com/ninja-build/ninja/releases
   ```

### 依赖扩展

本扩展依赖以下 VS Code 扩展（会自动安装）：

- [Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug) - ARM 调试支持
- [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) - C/C++ 语言支持
- [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) - CMake 扩展

## 🚀 快速开始

### 1. 自动检测工具链 ✨

扩展支持**自动检测**本地安装的工具链：

1. 首次启动时，扩展会询问是否自动查找工具链
2. 或者按 `Ctrl+Shift+P`，运行 **"STM32: 自动检测工具链"**
3. 扩展会在以下位置搜索：
   - PATH 环境变量
   - 常见安装目录 (C:\, D:\, Program Files 等)
   - STM32CubeIDE 内置工具链
   - xPack 工具链目录
   - Scoop 安装目录

**自动检测的工具：**
- GCC ARM (arm-none-eabi-gcc)
- OpenOCD
- CMake
- Ninja

### 2. 手动配置工具链路径

如果自动检测失败，可以手动配置。打开设置 (`Ctrl+,`)，搜索 "STM32"：

```json
{
    "stm32.toolchainPath": "C:/gcc-arm-none-eabi/bin",
    "stm32.openocdPath": "C:/openocd/bin/openocd.exe",
    "stm32.openocdScriptsPath": "C:/openocd/share/openocd/scripts"
}
```

### 3. 选择芯片型号

1. 点击状态栏的芯片图标，或按 `Ctrl+Shift+P`
2. 输入 "STM32: 选择芯片型号"
3. 先选择芯片系列，再选择具体型号

### 4. 编译项目

1. 确保项目根目录有 `CMakeLists.txt`
2. 点击状态栏的 **编译** 按钮
3. 或按 `Ctrl+Shift+P`，选择 "STM32: 编译项目"

### 5. 下载程序

1. 连接调试器（如 ST-Link）
2. 点击状态栏的 **烧录** 按钮
3. 或按 `Ctrl+Shift+P`，选择 "STM32: 下载程序到芯片"

### 6. 开始调试

1. 点击状态栏的 **调试** 按钮
2. 或按 `F5` 开始调试

## ⚙️ 配置选项

| 设置项 | 描述 | 默认值 |
|--------|------|--------|
| `stm32.toolchainPath` | GCC ARM 工具链路径 | (空，使用 PATH) |
| `stm32.openocdPath` | OpenOCD 可执行文件路径 | openocd |
| `stm32.openocdScriptsPath` | OpenOCD 脚本目录 | (空) |
| `stm32.cmakePath` | CMake 可执行文件路径 | cmake |
| `stm32.selectedChip` | 当前选择的芯片型号 | (空) |
| `stm32.debugInterface` | 调试器接口类型 | stlink |
| `stm32.buildType` | CMake 构建类型 | Debug |
| `stm32.buildDirectory` | 构建输出目录 | build |
| `stm32.elfFile` | ELF 文件路径 | (自动检测) |
| `stm32.svdFile` | SVD 文件路径 | (空) |

## 📋 命令列表

| 命令 | 描述 |
|------|------|
| `STM32: 自动检测工具链` | 🔍 自动查找本地安装的 GCC/OpenOCD/Ninja |
| `STM32: 选择芯片型号` | 选择目标 STM32 芯片 |
| `STM32: 编译项目` | 使用 CMake 编译项目 |
| `STM32: 清理项目` | 清理构建目录 |
| `STM32: 重新编译` | 清理并重新编译 |
| `STM32: 生成 BIN/HEX 文件` | 将 ELF 转换为 BIN/HEX |
| `STM32: 下载程序到芯片` | 使用 OpenOCD 烧录程序 |
| `STM32: 开始调试` | 启动调试会话 |
| `STM32: 启动 OpenOCD 服务` | 启动 OpenOCD 服务器 |
| `STM32: 停止 OpenOCD 服务` | 停止 OpenOCD 服务器 |
| `STM32: 生成调试配置` | 生成 launch.json 配置 |
| `STM32: 选择调试器` | 选择调试器类型 |
| `STM32: 选择构建类型` | 选择 Debug/Release |

## 📁 项目结构示例

```
my-stm32-project/
├── CMakeLists.txt          # CMake 配置文件
├── CMakePresets.json       # CMake 预设（可选）
├── src/
│   ├── main.c              # 主程序
│   └── stm32f1xx_it.c      # 中断处理
├── inc/
│   └── stm32f1xx_hal_conf.h
├── startup/
│   └── startup_stm32f103xb.s
├── STM32F103C8Tx_FLASH.ld  # 链接脚本
├── .vscode/
│   └── launch.json         # 调试配置（自动生成）
└── build/                  # 构建输出目录
```

## 🐞 故障排除

### OpenOCD 无法连接

1. 检查调试器是否正确连接
2. 确认驱动程序已安装
3. 检查 OpenOCD 配置文件路径是否正确
4. 尝试降低调试速度：在 launch.json 中添加 `"openOCDLaunchCommands": ["adapter speed 1000"]`

### 编译错误

1. 检查工具链路径是否正确
2. 确认 CMakeLists.txt 配置正确
3. 检查芯片型号是否匹配

### 无法下载程序

1. 确认 ELF 文件已生成
2. 检查芯片是否被锁定
3. 尝试先擦除芯片

### 找不到工具链

1. 运行 "STM32: 自动检测工具链" 命令
2. 手动在设置中配置路径
3. 确保工具已正确安装

## 📂 代码架构

```
src/
├── extension.ts              # 扩展入口
└── utils/
    ├── chipSelector.ts       # 芯片选择器
    ├── chipUtils.ts          # 芯片工具函数
    ├── cmakeBuilder.ts       # CMake 构建管理
    ├── config.ts             # 配置管理
    ├── debugConfigGenerator.ts # 调试配置生成
    ├── openocdManager.ts     # OpenOCD 管理
    ├── projectDetector.ts    # 项目检测
    └── toolchainDetector.ts  # 工具链检测
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

GitHub: https://github.com/LUXUFENG/stm32-vscode-extension

## 📮 联系方式

如有问题，请在 GitHub Issues 中反馈。
