import * as vscode from 'vscode';
import * as path from 'path';
import { getSTM32Config, getWorkspaceFolder, updateSTM32Config } from './config';

export async function findBinFiles(): Promise<vscode.Uri[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return []; }
    const config = getSTM32Config();
    const buildDir = path.resolve(folder.uri.fsPath, config.buildDirectory);
    const roots = [...new Set([
        path.join(buildDir, config.buildType),
        buildDir,
        path.join(folder.uri.fsPath, 'build', config.buildType),
        folder.uri.fsPath
    ])];
    const groups = await Promise.all(roots.map(root => vscode.workspace.findFiles(
        new vscode.RelativePattern(root, '**/*.[bB][iI][nN]'), '**/node_modules/**'
    )));
    const files = new Map<string, vscode.Uri>();
    for (const group of groups) {
        group.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        for (const file of group) { files.set(file.fsPath, file); }
    }
    return [...files.values()];
}

/** Explicit selection wins, even if missing, so flashing never silently substitutes another BIN. */
export async function getSelectedBin(): Promise<string | undefined> {
    const configured = getSTM32Config().binFile;
    if (configured) {
        return path.isAbsolute(configured) ? configured : path.resolve(getWorkspaceFolder(), configured);
    }
    return (await findBinFiles())[0]?.fsPath;
}

export async function selectBinFile(): Promise<void> {
    const root = getWorkspaceFolder();
    const files = await findBinFiles();
    const items = files.map(file => ({
        label: path.basename(file.fsPath),
        description: path.relative(root, file.fsPath),
        file: file.fsPath
    }));
    const selected = await vscode.window.showQuickPick([
        ...items,
        { label: '浏览 BIN 文件…', description: '从其他目录选择', file: '' }
    ], { title: '选择烧录 BIN 文件', placeHolder: '选择后将保存到当前工作区' });
    if (!selected) { return; }
    let file = selected.file;
    if (!file) {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            filters: { 'BIN 文件': ['bin'] }, title: '选择烧录 BIN 文件'
        });
        file = uris?.[0]?.fsPath || '';
    }
    if (!file) { return; }
    if (path.extname(file).toLowerCase() !== '.bin') { throw new Error('请选择 .bin 文件'); }
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file));
    if (!(stat.type & vscode.FileType.File)) { throw new Error('请选择有效的 BIN 文件'); }
    const relative = path.relative(root, file);
    await updateSTM32Config('binFile', relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        ? file : relative.split(path.sep).join('/'));
}
