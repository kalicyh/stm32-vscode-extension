// Run with: npm run compile && node --test tests/flash.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

let config, groups, selected, dialog, confirmation, missing, spawned;
const uri = fsPath => ({ fsPath });
const vscode = {
    workspace: {
        workspaceFolders: [{ uri: uri('/project') }],
        getConfiguration: () => ({ get: key => config[key], update: async (key, value) => { config[key] = value; } }),
        findFiles: async pattern => (groups[pattern.base] || []).map(uri),
        fs: { stat: async file => {
            if (file.fsPath === missing) { throw new Error('missing'); }
            return { type: 1 };
        } }
    },
    RelativePattern: class { constructor(base) { this.base = base; } },
    Uri: { file: uri }, FileType: { File: 1 }, ConfigurationTarget: { Workspace: 2 },
    window: {
        showQuickPick: async items => selected === 'browse' ? items.at(-1) : items[selected],
        showOpenDialog: async () => dialog,
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
            setImmediate(() => process.emit('close', 0));
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
