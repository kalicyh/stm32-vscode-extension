/**
 * OpenOCD 管理器
 * 负责 OpenOCD 服务的启动、停止和程序烧录
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { getSelectedBin } from './binSelector';
import { CMakeBuilder } from './cmakeBuilder';
import { getSTM32Config } from './config';
import { getOpenOCDTarget, getChipFamily, getInterfaceConfig, getFlashAddress, quotePath, toForwardSlash } from './chipUtils';

export class OpenOCDManager {
    private outputChannel: vscode.OutputChannel;
    private openocdProcess: ChildProcess | null = null;
    private cmakeBuilder: CMakeBuilder;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.cmakeBuilder = new CMakeBuilder(outputChannel);
    }

    /**
     * 启动 OpenOCD 服务
     */
    async start(): Promise<void> {
        if (this.openocdProcess) {
            this.outputChannel.appendLine('OpenOCD 已在运行');
            return;
        }

        const config = getSTM32Config();
        const target = getOpenOCDTarget(config.selectedChip);
        const interfaceConfig = getInterfaceConfig(config.debugInterface);

        const args: string[] = [];

        // 添加脚本路径
        if (config.openocdScriptsPath) {
            args.push('-s', toForwardSlash(config.openocdScriptsPath));
        }

        // 添加接口配置
        args.push('-f', interfaceConfig);

        // 添加目标配置
        args.push('-f', `target/${target}.cfg`);

        const openocdCmd = quotePath(config.openocdPath);
        
        this.outputChannel.appendLine(`启动 OpenOCD: ${quotePath(openocdCmd)} ${args.map(arg => quotePath(arg)).join(' ')}`);

        return new Promise((resolve, reject) => {
            this.openocdProcess = spawn(openocdCmd, args);

            let started = false;

            this.openocdProcess.stdout?.on('data', (data) => {
                const output = data.toString();
                this.outputChannel.appendLine(`[OpenOCD] ${output}`);
                
                if (output.includes('Listening on port') && !started) {
                    started = true;
                    resolve();
                }
            });

            this.openocdProcess.stderr?.on('data', (data) => {
                const output = data.toString();
                this.outputChannel.appendLine(`[OpenOCD] ${output}`);
                
                if (output.includes('Listening on port') && !started) {
                    started = true;
                    resolve();
                }
            });

            this.openocdProcess.on('close', (code) => {
                this.outputChannel.appendLine(`OpenOCD 进程退出，退出码: ${code}`);
                this.openocdProcess = null;
                if (!started) {
                    reject(new Error(`OpenOCD 启动失败，退出码: ${code}`));
                }
            });

            this.openocdProcess.on('error', (err) => {
                this.outputChannel.appendLine(`OpenOCD 错误: ${err.message}`);
                this.openocdProcess = null;
                reject(err);
            });

            // 设置超时
            setTimeout(() => {
                if (!started && this.openocdProcess) {
                    resolve(); // 假设已启动
                }
            }, 3000);
        });
    }

    /**
     * 停止 OpenOCD 服务
     */
    stop(): void {
        if (this.openocdProcess) {
            this.openocdProcess.kill();
            this.openocdProcess = null;
            this.outputChannel.appendLine('OpenOCD 已停止');
        }
    }

    /**
     * 检查 OpenOCD 是否正在运行
     */
    isRunning(): boolean {
        return this.openocdProcess !== null;
    }

    /**
     * 烧录程序到芯片
     */
    async flash(): Promise<void> {
        const config = getSTM32Config();
        
        // 查找可烧录的文件 (ELF, BIN, HEX)
        let flashFile: string | undefined = await getSelectedBin() || config.elfFile;
        if (!flashFile) {
            flashFile = await this.selectFlashFile();
        }

        if (!flashFile) {
            throw new Error('找不到可烧录的文件，请先编译项目');
        }

        // 如果是相对路径，转换为绝对路径
        if (!path.isAbsolute(flashFile)) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders && folders.length > 0) {
                flashFile = path.join(folders[0].uri.fsPath, flashFile);
            }
        }

        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(flashFile));
            if (!(stat.type & vscode.FileType.File)) { throw new Error('不是文件'); }
        } catch {
            throw new Error(`烧录文件不存在或不可读取: ${flashFile}，请在项目信息中重新选择 BIN`);
        }
        this.outputChannel.appendLine(`下载程序: ${flashFile}`);

        const target = getOpenOCDTarget(config.selectedChip);
        const interfaceConfig = getInterfaceConfig(config.debugInterface);

        const args: string[] = [];

        if (config.openocdScriptsPath) {
            args.push('-s', toForwardSlash(config.openocdScriptsPath));
        }

        args.push('-f', interfaceConfig);
        args.push('-f', `target/${target}.cfg`);
        
        // 将路径转换为正斜杠格式
        const flashFilePath = toForwardSlash(flashFile).replace(/["$\[\]]/g, '\\$&');
        
        const ext = path.extname(flashFile).toLowerCase();
        if (ext === '.bin') {
            // BIN 文件需要指定起始地址
            const flashAddress = getFlashAddress(config.selectedChip);
            args.push('-c', `program "${flashFilePath}" verify reset exit ${flashAddress}`);
        } else {
            // HEX 或 ELF 文件
            args.push('-c', `program "${flashFilePath}" verify reset exit`);
        }

        const openocdCmd = config.openocdPath;
        this.outputChannel.appendLine(`执行 OpenOCD 烧录: ${quotePath(openocdCmd)} ${args.map(arg => quotePath(arg)).join(' ')}`);

        return new Promise((resolve, reject) => {
            const flashProcess = spawn(openocdCmd, args);

            flashProcess.stdout?.on('data', (data) => {
                this.outputChannel.appendLine(data.toString());
            });

            flashProcess.stderr?.on('data', (data) => {
                this.outputChannel.appendLine(data.toString());
            });

            flashProcess.on('close', (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine('程序下载成功！');
                    resolve();
                } else {
                    reject(new Error(`程序下载失败，退出码: ${code}`));
                }
            });

            flashProcess.on('error', (err) => {
                reject(err);
            });
        });
    }

    /** Read Flash into a temporary file; publish only a complete dump. Never unlock or erase. */
    async extractFirmware(defaultSizeKiB?: number): Promise<string | undefined> {
        const config = getSTM32Config();
        if (!getChipFamily(config.selectedChip)) {
            throw new Error('请先选择 STM32 芯片型号');
        }
        if (this.isRunning() || vscode.debug.activeDebugSession) {
            throw new Error('请先停止 OpenOCD 服务和调试会话，再提取固件');
        }
        const sizeText = await vscode.window.showInputBox({
            title: `提取 ${config.selectedChip} 固件`,
            prompt: '读取长度（KiB，1 KiB = 1024 字节）。将复位并暂停芯片，不擦除、不写入；读保护无法绕过。',
            value: defaultSizeKiB?.toString(),
            placeHolder: '例如 STM32L452RET6 填 512，STM32F103C8 填 64',
            validateInput: value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 4096
                ? undefined : '请输入 1–4096 的整数，并确保不超过芯片实际 Flash 容量'
        });
        if (sizeText === undefined) { return undefined; }
        if (!/^\d+$/.test(sizeText) || Number(sizeText) < 1 || Number(sizeText) > 4096) {
            throw new Error('读取长度必须为 1–4096 KiB 的整数');
        }
        const size = Number(sizeText) * 1024;
        const destination = await vscode.window.showSaveDialog({
            title: '保存提取的固件', filters: { 'BIN 固件': ['bin'] },
            defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
                `${config.selectedChip}_firmware.bin`))
        });
        if (!destination) { return undefined; }
        if (destination.scheme !== 'file') { throw new Error('请选择本地文件保存位置'); }
        // Recheck after the dialogs, before connecting to hardware.
        if (this.isRunning() || vscode.debug.activeDebugSession) {
            throw new Error('请先停止 OpenOCD 服务和调试会话，再提取固件');
        }
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-dump-'));
        try {
            const tempFile = path.join(tempDir, 'firmware.bin');
            const dumpPath = toForwardSlash(tempFile).replace(/["$\[\]]/g, '\\$&');
            const args: string[] = [];
            if (config.openocdScriptsPath) { args.push('-s', toForwardSlash(config.openocdScriptsPath)); }
            args.push('-f', getInterfaceConfig(config.debugInterface));
            if (config.debugInterface === 'cmsis-dap') { args.push('-c', 'transport select swd'); }
            args.push('-f', `target/${getOpenOCDTarget(config.selectedChip)}.cfg`,
                '-c', 'adapter speed 1000', '-c', 'init', '-c', 'reset halt',
                '-c', `dump_image "${dumpPath}" ${getFlashAddress(config.selectedChip)} 0x${size.toString(16)}`,
                '-c', 'shutdown');
            this.outputChannel.show();
            this.outputChannel.appendLine(`提取固件: ${config.selectedChip}，起始地址 ${getFlashAddress(config.selectedChip)}，${size} 字节 → ${destination.fsPath}`);
            await new Promise<void>((resolve, reject) => {
                const process = spawn(config.openocdPath, args);
                process.stdout?.on('data', data => this.outputChannel.appendLine(data.toString()));
                process.stderr?.on('data', data => this.outputChannel.appendLine(data.toString()));
                process.on('error', reject);
                process.on('close', code => code === 0 ? resolve()
                    : reject(new Error(`OpenOCD 读取失败，退出码: ${code}。请查看日志并检查连接和读保护；为保留原固件，请勿解除读保护。`)));
            });
            if ((await fs.stat(tempFile)).size !== size) {
                throw new Error('读取文件长度不符，未保存不完整固件');
            }
            await vscode.workspace.fs.copy(vscode.Uri.file(tempFile), destination, { overwrite: true });
            this.outputChannel.appendLine(`固件已保存: ${destination.fsPath}。芯片已暂停，可复位或重新上电恢复运行。`);
            return destination.fsPath;
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    }

    async lockReadProtection(): Promise<boolean> {
        return this.setReadProtection(true);
    }

    async unlockReadProtection(): Promise<boolean> {
        return this.setReadProtection(false);
    }

    /** OpenOCD flash driver names differ from target configuration names. */
    private async setReadProtection(enable: boolean): Promise<boolean> {
        const action = enable ? '开启读保护' : '解除读保护';
        const config = getSTM32Config();
        const chip = config.selectedChip.toLowerCase();
        let driver: string;
        if (/^stm32f[013]/.test(chip)) { driver = 'stm32f1x'; }
        else if (/^stm32f[247]/.test(chip)) { driver = 'stm32f2x'; }
        else if (/^stm32h7/.test(chip)) { driver = 'stm32h7x'; }
        else if (/^stm32l[01]/.test(chip)) { driver = 'stm32lx'; }
        else if (/^stm32(g[04]|l[45]|u5|w[bl])/.test(chip)) { driver = 'stm32l4x'; }
        else { throw new Error('请先选择支持读保护操作的 STM32 芯片型号'); }
        if (this.isRunning() || vscode.debug.activeDebugSession) {
            throw new Error(`请先停止 OpenOCD 服务和调试会话，再${action}`);
        }
        const confirmed = await vscode.window.showWarningMessage(
            enable
                ? `即将开启 ${config.selectedChip} 的读保护，之后将无法正常读取或提取固件，并可能限制调试。日后解除保护可能擦除全部程序和数据。请先备份固件。本操作不设置永久保护 Level 2。`
                : `解除 ${config.selectedChip} 的读保护可能擦除芯片内全部程序和数据，且无法恢复。RDP Level 2 无法解除。请确认连接的是目标芯片。`,
            { modal: true }, `确认${action}`
        );
        if (confirmed !== `确认${action}`) { return false; }
        if (this.isRunning() || vscode.debug.activeDebugSession) {
            throw new Error(`请先停止 OpenOCD 服务和调试会话，再${action}`);
        }
        const args: string[] = [];
        if (config.openocdScriptsPath) { args.push('-s', toForwardSlash(config.openocdScriptsPath)); }
        args.push('-f', getInterfaceConfig(config.debugInterface));
        if (config.debugInterface === 'cmsis-dap') { args.push('-c', 'transport select swd'); }
        args.push('-f', `target/${getOpenOCDTarget(config.selectedChip)}.cfg`,
            '-c', 'init', '-c', 'reset halt', '-c', `${driver} ${enable ? 'lock' : 'unlock'} 0`, '-c', 'shutdown');
        this.outputChannel.show();
        this.outputChannel.appendLine(`${action}: ${config.selectedChip} (${driver})`);
        let processOutput = '';
        await new Promise<void>((resolve, reject) => {
            const process = spawn(config.openocdPath, args);
            const log = (data: Buffer) => {
                const text = data.toString();
                processOutput += text;
                this.outputChannel.appendLine(text);
            };
            process.stdout?.on('data', log);
            process.stderr?.on('data', log);
            process.on('error', reject);
            // Some OpenOCD versions print option-byte errors but still exit with code 0.
            process.on('close', code => code === 0 && !/failed to (?:erase options|lock|unlock)/i.test(processOutput) ? resolve()
                : reject(new Error(`OpenOCD ${action}失败，退出码: ${code}，请查看输出日志`)));
        });
        return true;
    }

    /**
     * 复位芯片
     */
    async reset(): Promise<void> {
        const config = getSTM32Config();
        const target = getOpenOCDTarget(config.selectedChip);
        const interfaceConfig = getInterfaceConfig(config.debugInterface);

        const args: string[] = [];

        if (config.openocdScriptsPath) {
            args.push('-s', toForwardSlash(config.openocdScriptsPath));
        }

        args.push('-f', interfaceConfig);
        args.push('-f', `target/${target}.cfg`);
        args.push('-c', 'init');
        args.push('-c', 'reset');
        args.push('-c', 'exit');

        const openocdCmd = quotePath(config.openocdPath);
        this.outputChannel.appendLine(`执行 OpenOCD 复位: ${quotePath(openocdCmd)} ${args.map(arg => quotePath(arg)).join(' ')}`);

        return new Promise((resolve, reject) => {
            const resetProcess = spawn(openocdCmd, args);

            resetProcess.on('close', (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine('芯片已复位');
                    resolve();
                } else {
                    reject(new Error(`复位失败，退出码: ${code}`));
                }
            });

            resetProcess.on('error', (err) => {
                reject(err);
            });
        });
    }

    /**
     * 获取调试配置文件列表
     */
    getDebugConfigFiles(): string[] {
        const config = getSTM32Config();
        const target = getOpenOCDTarget(config.selectedChip);
        const interfaceConfig = getInterfaceConfig(config.debugInterface);
        return [interfaceConfig, `target/${target}.cfg`];
    }

    /**
     * 选择要烧录的文件
     */
    private async selectFlashFile(): Promise<string | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }

        const config = getSTM32Config();
        const buildType = config.buildType;
        const projectName = path.basename(workspaceFolder.uri.fsPath);
        const workspacePath = workspaceFolder.uri.fsPath;

        // 优先在当前构建类型目录下搜索
        const priorityPatterns = [
            `build/${buildType}/*.elf`,
            `build/${buildType}/*.hex`,
            `build/${buildType}/*.bin`,
        ];
        
        // 备选目录
        const fallbackPatterns = [
            'build/**/*.elf',
            'build/**/*.hex',
            'build/**/*.bin',
        ];

        // 先搜索优先目录
        let priorityFiles: vscode.Uri[] = [];
        for (const pattern of priorityPatterns) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(workspaceFolder, pattern),
                null,
                10
            );
            priorityFiles = priorityFiles.concat(files);
        }

        if (priorityFiles.length > 0) {
            // 优先选择与项目同名的 ELF 文件
            const projectElf = priorityFiles.find(f => {
                const baseName = path.basename(f.fsPath, '.elf');
                return baseName.toLowerCase() === projectName.toLowerCase() && f.fsPath.endsWith('.elf');
            });
            if (projectElf) {
                return projectElf.fsPath;
            }

            if (priorityFiles.length === 1) {
                return priorityFiles[0].fsPath;
            }

            return this.promptSelectFlashFile(priorityFiles, workspacePath, buildType);
        }

        // 备选目录搜索
        let allFiles: vscode.Uri[] = [];
        for (const pattern of fallbackPatterns) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(workspaceFolder, pattern),
                null,
                20
            );
            allFiles = allFiles.concat(files);
        }

        if (allFiles.length === 0) {
            const choice = await vscode.window.showWarningMessage(
                `在 build/${buildType} 目录中找不到固件文件，是否先编译项目？`,
                '编译项目',
                '手动选择文件'
            );
            
            if (choice === '编译项目') {
                await vscode.commands.executeCommand('stm32.build');
                return this.selectFlashFile();
            } else if (choice === '手动选择文件') {
                const fileUri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        '固件文件': ['elf', 'bin', 'hex'],
                        '所有文件': ['*']
                    },
                    title: '选择要烧录的固件文件'
                });
                return fileUri?.[0]?.fsPath;
            }
            return undefined;
        }

        // 优先选择当前构建类型目录中的文件
        const buildTypeFiles = allFiles.filter(f => 
            f.fsPath.toLowerCase().includes(buildType.toLowerCase())
        );

        if (buildTypeFiles.length === 1) {
            return buildTypeFiles[0].fsPath;
        }

        if (buildTypeFiles.length > 1) {
            return this.promptSelectFlashFile(buildTypeFiles, workspacePath, buildType);
        }

        if (allFiles.length === 1) {
            return allFiles[0].fsPath;
        }

        return this.promptSelectFlashFile(allFiles, workspacePath, buildType);
    }

    /**
     * 提示用户选择烧录文件
     */
    private async promptSelectFlashFile(
        files: vscode.Uri[],
        workspacePath: string,
        currentBuildType: string
    ): Promise<string | undefined> {
        const items = files.map(f => {
            const ext = path.extname(f.fsPath).toUpperCase().slice(1);
            const relativePath = path.relative(workspacePath, f.fsPath);
            const isCurrentType = relativePath.toLowerCase().includes(currentBuildType.toLowerCase());
            return {
                label: `${isCurrentType ? '$(check) ' : ''}$(file-binary) ${path.basename(f.fsPath)}`,
                description: `[${ext}] ${relativePath}`,
                detail: isCurrentType ? `当前构建类型: ${currentBuildType}` : undefined,
                path: f.fsPath,
                isCurrentType
            };
        });

        // 排序：当前构建类型优先
        items.sort((a, b) => {
            if (a.isCurrentType !== b.isCurrentType) {
                return b.isCurrentType ? 1 : -1;
            }
            const order: Record<string, number> = { '.elf': 0, '.hex': 1, '.bin': 2 };
            const extA = path.extname(a.path).toLowerCase();
            const extB = path.extname(b.path).toLowerCase();
            return (order[extA] || 9) - (order[extB] || 9);
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `选择要烧录的文件 (当前构建类型: ${currentBuildType})`,
            title: '选择固件文件'
        });

        return selected?.path;
    }
}
