// Run with: npm run compile && node --test tests/flash.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');

let config, groups, selected, dialog, confirmation, missing, spawned;
let input, saved, copies, exitCode, dumpLength, tempDump, processText;
const uri = fsPath => ({ fsPath, scheme: 'file' });
const vscode = {
    workspace: {
        workspaceFolders: [{ uri: uri('/project') }],
        getConfiguration: () => ({ get: key => config[key], update: async (key, value) => { config[key] = value; } }),
        findFiles: async pattern => (groups[pattern.base] || []).map(uri),
        fs: { copy: async (from, to) => { copies.push({ from, to, size: fs.statSync(from.fsPath).size }); }, stat: async file => {
            if (file.fsPath === missing) { throw new Error('missing'); }
            return { type: 1 };
        } }
    },
    RelativePattern: class { constructor(base) { this.base = base; } },
    Uri: { file: uri }, FileType: { File: 1 }, ConfigurationTarget: { Workspace: 2 },
    window: {
        showQuickPick: async items => selected === 'browse' ? items.at(-1) : items[selected],
        showOpenDialog: async () => dialog,
        showInputBox: async options => { if (input === 'default') { return options.value; } return input; },
        showSaveDialog: async () => saved,
        showWarningMessage: async () => confirmation
    },
    debug: {}
};
const originalLoad = Module._load;
Module._load = function (id, ...args) {
    if (id === 'vscode') { return vscode; }
    if (id === 'child_process') {
        return { spawn: (command, args) => {
            spawned.push({ command, args });
            const process = new EventEmitter();
            process.stdout = new EventEmitter(); process.stderr = new EventEmitter();
            const dump = args.find(arg => arg.startsWith('dump_image '));
            if (dump) {
                const match = dump.match(/^dump_image "(.+)" 0x08000000 (0x[0-9a-f]+)$/);
                tempDump = match[1].replace(/\\(["$\[\]])/g, '$1');
                fs.writeFileSync(tempDump, Buffer.alloc(dumpLength ?? Number(match[2])));
            }
            setImmediate(() => { process.stderr.emit('data', Buffer.from(processText)); process.emit('close', exitCode); });
            return process;
        } };
    }
    return originalLoad.call(this, id, ...args);
};
const { getSelectedBin, selectBinFile } = require('../out/utils/binSelector');
const { OpenOCDManager } = require('../out/utils/openocdManager');
Module._load = originalLoad;
const output = { appendLine() {}, show() {} };
function reset() {
    config = { buildDirectory: 'build', buildType: 'Debug', selectedChip: 'STM32F103C8', openocdPath: '/tools with spaces/openocd' };
    processText = ''; input = undefined; saved = undefined; copies = []; exitCode = 0; dumpLength = undefined; tempDump = undefined;
    groups = {}; selected = undefined; dialog = undefined; confirmation = undefined;
    missing = undefined; spawned = []; vscode.debug.activeDebugSession = undefined;
}

test('BIN defaults to current build, deterministic ordering, custom build directory', async () => {
    reset();
    groups = { '/project/build/Debug': ['/project/build/Debug/z.bin', '/project/build/Debug/a.bin'], '/project': ['/project/other.bin'] };
    assert.equal(await getSelectedBin(), '/project/build/Debug/a.bin');
    config.buildDirectory = 'output';
    groups['/project/output/Debug'] = ['/project/output/Debug/custom.bin'];
    assert.equal(await getSelectedBin(), '/project/output/Debug/custom.bin');
});

test('selection persists workspace-relative path and cancellation preserves it', async () => {
    reset(); groups['/project'] = ['/project/fw.bin']; selected = 0;
    await selectBinFile(); assert.equal(config.binFile, 'fw.bin');
    selected = undefined; await selectBinFile(); assert.equal(config.binFile, 'fw.bin');
    selected = 'browse'; dialog = [uri('/external/fw.bin')];
    await selectBinFile(); assert.equal(config.binFile, '/external/fw.bin');
});

test('flash uses selected BIN ahead of ELF without opening a picker', async () => {
    reset(); config.binFile = 'firmware $[v1].bin'; config.elfFile = 'other.elf';
    vscode.window.showQuickPick = async () => { throw new Error('unexpected picker'); };
    await new OpenOCDManager(output).flash();
    assert.equal(spawned[0].command, config.openocdPath);
    assert.equal(spawned[0].args.at(-1), 'program "/project/firmware \\$\\[v1\\].bin" verify reset exit 0x08000000');
});

test('flash automatically uses default BIN without opening a picker', async () => {
    reset(); groups['/project/build/Debug'] = ['/project/build/Debug/default.bin'];
    await new OpenOCDManager(output).flash();
    assert.ok(spawned[0].args.at(-1).includes('/project/build/Debug/default.bin'));
});

test('missing explicit BIN fails without falling back or starting OpenOCD', async () => {
    reset(); config.binFile = 'missing.bin'; missing = '/project/missing.bin';
    groups['/project'] = ['/project/other.bin'];
    await assert.rejects(new OpenOCDManager(output).flash(), /重新选择 BIN/);
    assert.equal(spawned.length, 0);
});

test('unlock requires confirmation and selects flash driver, not target name', async () => {
    reset(); const manager = new OpenOCDManager(output);
    assert.equal(await manager.unlockReadProtection(), false);
    assert.equal(spawned.length, 0);
    confirmation = '确认解除读保护';
    for (const [chip, driver] of [['STM32F103C8', 'stm32f1x'], ['STM32F407VG', 'stm32f2x'], ['STM32G431CB', 'stm32l4x'], ['STM32L073RZ', 'stm32lx'], ['STM32H743ZI', 'stm32h7x']]) {
        config.selectedChip = chip;
        assert.equal(await manager.unlockReadProtection(), true);
        assert.ok(spawned.at(-1).args.includes(`${driver} unlock 0`));
        assert.equal(spawned.at(-1).command, config.openocdPath);
    }
    config.selectedChip = 'unknown';
    await assert.rejects(manager.unlockReadProtection(), /请先选择/);
    config.selectedChip = 'STM32F103C8'; vscode.debug.activeDebugSession = {};
    await assert.rejects(manager.unlockReadProtection(), /停止/);
    assert.equal(spawned.length, 5);
});


test('extracts L452 512 KiB over SWD without any erase/write/unlock command', async () => {
    reset(); config.selectedChip = 'STM32L452RET6'; config.debugInterface = 'cmsis-dap';
    input = 'default'; saved = uri('/backup/firmware $[1].bin');
    assert.equal(await new OpenOCDManager(output).extractFirmware(512), saved.fsPath);
    const args = spawned[0].args;
    assert.ok(args.includes('target/stm32l4x.cfg'));
    assert.ok(args.includes('transport select swd'));
    assert.ok(args.includes('adapter speed 1000'));
    assert.ok(args.some(arg => arg.startsWith('dump_image ') && arg.endsWith('0x08000000 0x80000')));
    assert.ok(!args.some(arg => /unlock|erase|program|write_image/.test(arg)));
    assert.equal(copies[0].size, 512 * 1024);
    assert.equal(copies[0].to.fsPath, saved.fsPath);
    assert.equal(fs.existsSync(tempDump), false);
});

test('extract cancellation and invalid lengths do not connect to the chip', async () => {
    reset(); const manager = new OpenOCDManager(output);
    assert.equal(await manager.extractFirmware(64), undefined);
    input = '64'; assert.equal(await manager.extractFirmware(64), undefined);
    for (input of ['0', '-1', '4097', '512; shutdown', '1.5']) {
        await assert.rejects(manager.extractFirmware(), /读取长度/);
    }
    assert.equal(spawned.length, 0);
});

test('failed or incomplete reads never replace the destination and clean up temporary data', async () => {
    for (const scenario of ['failure', 'truncated']) {
        reset(); input = '64'; saved = uri('/backup/existing.bin');
        if (scenario === 'failure') { exitCode = 1; } else { dumpLength = 32; }
        await assert.rejects(new OpenOCDManager(output).extractFirmware(), /读取失败|长度不符/);
        assert.equal(copies.length, 0);
        assert.equal(fs.existsSync(tempDump), false);
    }
});

test('extract rejects unknown chips and active debug sessions', async () => {
    reset(); config.selectedChip = 'unknown';
    await assert.rejects(new OpenOCDManager(output).extractFirmware(), /选择 STM32/);
    config.selectedChip = 'STM32F103C8'; vscode.debug.activeDebugSession = {};
    await assert.rejects(new OpenOCDManager(output).extractFirmware(), /停止/);
    assert.equal(spawned.length, 0);
});


test('lock requires confirmation and uses correct driver without unlock or Level 2 writes', async () => {
    reset(); const manager = new OpenOCDManager(output);
    assert.equal(await manager.lockReadProtection(), false);
    assert.equal(spawned.length, 0);
    confirmation = '确认开启读保护'; config.debugInterface = 'cmsis-dap';
    for (const [chip, driver] of [['STM32F103C8', 'stm32f1x'], ['STM32F407VG', 'stm32f2x'], ['STM32L452RE', 'stm32l4x'], ['STM32L073RZ', 'stm32lx'], ['STM32H743ZI', 'stm32h7x']]) {
        config.selectedChip = chip;
        assert.equal(await manager.lockReadProtection(), true);
        const args = spawned.at(-1).args;
        assert.ok(args.includes(`${driver} lock 0`));
        assert.ok(args.includes('transport select swd'));
        assert.ok(!args.some(arg => /unlock|mass_erase|options?_write|0xcc/i.test(arg)));
        assert.equal(spawned.at(-1).command, config.openocdPath);
    }
    config.selectedChip = 'unknown';
    await assert.rejects(manager.lockReadProtection(), /请先选择/);
    config.selectedChip = 'STM32L452RE'; vscode.debug.activeDebugSession = {};
    await assert.rejects(manager.lockReadProtection(), /停止/);
    assert.equal(spawned.length, 5);
});

test('read protection propagates failure exit codes and legacy zero-exit option errors', async () => {
    reset(); confirmation = '确认开启读保护'; exitCode = 1;
    await assert.rejects(new OpenOCDManager(output).lockReadProtection(), /开启读保护失败/);
    exitCode = 0; processText = 'stm32x failed to lock device';
    await assert.rejects(new OpenOCDManager(output).lockReadProtection(), /开启读保护失败/);
    processText = 'stm32x failed to erase options';
    await assert.rejects(new OpenOCDManager(output).lockReadProtection(), /开启读保护失败/);
    confirmation = '确认解除读保护'; processText = 'stm32x failed to unlock device';
    await assert.rejects(new OpenOCDManager(output).unlockReadProtection(), /解除读保护失败/);
});
