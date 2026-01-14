import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFolder, TFile, requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

interface PathMapping {
    localPath: string;
    remotePath: string;
}

interface WebDAVUploaderSettings {
    webdavUrl: string;
    username: string;
    password: string;
    rootFolder: string;
    pathMappings: PathMapping[];
    // 新增：本地同步文件夹设置
    localSyncFolder: string;  // 本地同步文件夹的绝对路径
    remoteSyncFolder: string; // 对应的 WebDAV 远程路径
    pathMode: 'note' | 'local'; // 路径决定模式：note=笔记路径，local=文件本地路径
    preferExistingLink: boolean; // 如果文件已存在于云端，优先插入链接而不上传
}

const DEFAULT_SETTINGS: WebDAVUploaderSettings = {
    webdavUrl: '',
    username: '',
    password: '',
    rootFolder: '/',
    pathMappings: [],
    localSyncFolder: '',
    remoteSyncFolder: '',
    pathMode: 'note',
    preferExistingLink: true
}

export default class WebDAVUploaderPlugin extends Plugin {
    settings: WebDAVUploaderSettings;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new WebDAVUploaderSettingTab(this.app, this));

        this.registerDomEvent(document, 'drop', async (evt: DragEvent) => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) return;

            if (evt.dataTransfer?.files && evt.dataTransfer.files.length > 0) {
                // Prevent default to stop Obsidian from embedding the file immediately
                // Note: Obsidian's default drag-drop might need more aggressive prevention
                // or we just handle it and let Obsidian do its thing too?
                // User wants "drag local file/folder... automatic upload... create hyperlink"
                // If we listen to 'drop', we can intercept.

                // We need to check if the drop happened inside the editor.
                // For simplicity, we assume if it's on the document and a MarkdownView is active.

                // Wait for user configuration check
                if (!this.settings.webdavUrl || !this.settings.username || !this.settings.password) {
                    new Notice('WebDAV 未配置，无法上传。请检查设置。');
                    return;
                }

                this.initializeClient();

                evt.preventDefault();
                evt.stopPropagation();

                const files = evt.dataTransfer.files;
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    await this.uploadFile(file, view);
                }
            }
        });
    }

    onunload() {

    }

    // Custom simple WebDAV client to bypass CORS using Obsidian's requestUrl
    async request(method: string, path: string, headers: Record<string, string> = {}, data?: any): Promise<any> {
        const url = this.settings.webdavUrl.replace(/\/$/, '') + path;

        const auth = btoa(`${this.settings.username}:${this.settings.password}`);
        const reqHeaders: Record<string, string> = {
            'Authorization': `Basic ${auth}`,
            ...headers
        };

        const requestParams: any = {
            url: url,
            method: method,
            headers: reqHeaders,
            body: data
        };

        try {
            const response = await requestUrl(requestParams);
            return response;
        } catch (error: any) {
            console.error(`WebDAV Request Failed: ${method} ${url}`, error);
            if (error.status === 404) return null; // Handle 404 explicitly for checks
            throw error;
        }
    }

    async webdavExists(path: string): Promise<boolean> {
        try {
            // PROPFIND with Depth: 0 to check existence
            const response = await this.request('PROPFIND', path, {
                'Depth': '0'
            });
            return response != null && response.status >= 200 && response.status < 300;
        } catch (error) {
            if (error.status === 404) return false;
            return false;
        }
    }

    async webdavCreateDirectory(path: string) {
        // Recursive creation is harder with simple MKCOL, but we can try simple MKCOL first.
        // If user needs recursive, we might need a loop. 
        // For now, let's assume we create the specific folder.
        // To be robust, we should probably check/create parents, but let's start with single level 
        // or matching what the library did (library did recursive).
        // A simple recursive implementation:

        const parts = path.split('/').filter(p => p);
        let currentPath = '';

        for (const part of parts) {
            currentPath += '/' + part;
            const exists = await this.webdavExists(currentPath);
            if (!exists) {
                await this.request('MKCOL', currentPath);
            }
        }
    }

    async webdavPut(path: string, data: ArrayBuffer) {
        await this.request('PUT', path, {
            'Content-Type': 'application/octet-stream'
        }, data);
    }

    initializeClient() {
        // No-op, we use methods directly now.
    }

    async uploadFile(file: File, view: MarkdownView) {
        try {
            const activeFile = view.file;
            if (!activeFile) return;

            // 获取文件的本地路径 (来自 File 对象的 path 属性)
            const filePath = (file as any).path || '';
            const normalizedFilePath = filePath.replace(/\\/g, '/');

            let remoteFilePath: string = '';
            let shouldUpload = true;
            let isLocalLink = false;

            // 根据模式处理
            if (this.settings.pathMode === 'local') {
                // ===== 文件路径模式 =====
                if (this.settings.localSyncFolder && this.settings.remoteSyncFolder && filePath) {
                    // 标准化并统一转小写进行比较 (Windows)
                    const normalizedLocalSync = this.settings.localSyncFolder
                        .replace(/[\\\/]+$/, '')
                        .replace(/\\/g, '/')
                        .toLowerCase();
                    const lowerFilePath = normalizedFilePath.toLowerCase();

                    // 检查文件是否在同步目录内
                    if (lowerFilePath.startsWith(normalizedLocalSync)) {
                        // 计算文件在同步目录内的相对路径 (保留原始大小写用于路径)
                        // 注意：我们需要从原始 normalizedFilePath 中截取，长度需基于原始配置，但由于大小写问题，长度可能不一致？
                        // 最好是用 slice，因为我们确认 startsWith 了。
                        // 我们需要知道 localSyncFolder 的长度。这里假设长度是一致的。
                        const syncFolderLength = this.settings.localSyncFolder.replace(/[\\\/]+$/, '').length;
                        // 为了安全，重新标准化一次原始配置不做小写转换来获取长度？或者直接搜索索引
                        // 简单做法：
                        const relativePath = normalizedFilePath.slice(this.settings.localSyncFolder.replace(/[\\\/]+$/, '').length).replace(/^[\/\\]/, '');

                        // 计算远程路径
                        const remoteBase = this.settings.remoteSyncFolder.replace(/\/$/, '');
                        remoteFilePath = path.posix.join(remoteBase, relativePath);
                        if (!remoteFilePath.startsWith('/')) remoteFilePath = '/' + remoteFilePath;

                        // 检查远程文件是否存在
                        if (this.settings.preferExistingLink && await this.webdavExists(remoteFilePath)) {
                            new Notice(`文件已存在于云端: ${file.name}`);
                            shouldUpload = false;
                        }
                    } else {
                        // 文件不在同步目录 -> 插入本地链接，不上传
                        isLocalLink = true;
                        shouldUpload = false;
                        new Notice(`文件不在同步目录内，已插入本地链接`);
                    }
                } else {
                    // 未配置同步目录，回退到映射检查 (兼容这是原本的 calculateRemotePath 逻辑的一部分，但通常 local 模式主要用同步目录)
                    // 如果用户只用映射而没用同步目录？
                    // 以前的逻辑是 calculateRemotePath 会处理 local 模式的映射
                    remoteFilePath = await this.calculateRemotePath(file, activeFile, filePath);
                }
            } else {
                // ===== 笔记路径模式 =====
                remoteFilePath = await this.calculateRemotePath(file, activeFile, filePath);
            }

            // 执行操作
            if (isLocalLink) {
                // 插入本地文件链接
                const editor = view.editor;
                const fileUrl = 'file:///' + normalizedFilePath; // 简单处理，或者用 Obsidian 的 file path 格式
                // 更好的方式是使用 Obsidian 的链接格式，或者 file:///
                // 这里使用 file:/// 用于外部文件，或者 <file path>
                // 如果是 file link： [name](file:///path)
                editor.replaceSelection(`[${file.name}](file:///${encodeURI(normalizedFilePath)})\n`);
                return;
            }

            // 上传处理
            if (shouldUpload && remoteFilePath) {
                // 确保远程文件夹存在
                const remoteFolder = path.posix.dirname(remoteFilePath);
                if (!await this.webdavExists(remoteFolder)) {
                    await this.webdavCreateDirectory(remoteFolder);
                }

                const fileBuffer = await file.arrayBuffer();
                new Notice(`正在上传 ${file.name} 到 WebDAV...`);
                await this.webdavPut(remoteFilePath, fileBuffer);
                new Notice(`上传成功: ${file.name}`);
            }

            // 生成并插入 WebDAV 链接 (如果上传了或者跳过上传但仍是 WebDAV 链接)
            if (remoteFilePath) {
                const baseUrl = this.settings.webdavUrl.endsWith('/') ? this.settings.webdavUrl.slice(0, -1) : this.settings.webdavUrl;
                const cleanRemoteFilePath = remoteFilePath.startsWith('/') ? remoteFilePath : '/' + remoteFilePath;
                // 转义路径中的特殊字符
                const encodedPath = cleanRemoteFilePath.split('/').map(encodeURIComponent).join('/');
                const linkUrl = `${baseUrl}${encodedPath}`;
                const linkText = `[${file.name}](${linkUrl})`;

                const editor = view.editor;
                editor.replaceSelection(linkText + '\n');
            }

        } catch (error) {
            console.error('WebDAV Upload Error:', error);
            new Notice(`上传失败: ${error.message}`);
        }
    }

    // 辅助方法：根据路径模式计算远程路径
    async calculateRemotePath(file: File, activeFile: TFile, filePath: string): Promise<string> {
        let remoteFolder: string;

        if (this.settings.pathMode === 'local' && filePath) {
            // 使用文件本地路径模式
            const fileDir = path.dirname(filePath).replace(/\\/g, '/');

            // 检查是否匹配路径映射
            let bestMatch: PathMapping | null = null;
            for (const mapping of this.settings.pathMappings) {
                const normalizedMapping = mapping.localPath.replace(/\\/g, '/');

                if (fileDir.includes(normalizedMapping)) {
                    if (!bestMatch || mapping.localPath.length > bestMatch.localPath.length) {
                        bestMatch = mapping;
                    }
                }
            }

            if (bestMatch) {
                remoteFolder = bestMatch.remotePath;
            } else {
                remoteFolder = this.settings.rootFolder;
            }
        } else {
            // 使用笔记路径模式（原有逻辑）
            const noteParentPath = activeFile.parent ? activeFile.parent.path : '/';

            let bestMatch: PathMapping | null = null;
            for (const mapping of this.settings.pathMappings) {
                if (noteParentPath.startsWith(mapping.localPath)) {
                    if (!bestMatch || mapping.localPath.length > bestMatch.localPath.length) {
                        bestMatch = mapping;
                    }
                }
            }

            if (bestMatch) {
                const relativePath = noteParentPath.slice(bestMatch.localPath.length);
                const cleanRelative = relativePath.replace(/^[\/\\]/, '').replace(/[\/\\]/g, '/');
                const cleanRemote = bestMatch.remotePath.replace(/\/$/, '');
                remoteFolder = `${cleanRemote}/${cleanRelative}`;
            } else {
                remoteFolder = path.posix.join(this.settings.rootFolder, noteParentPath);
            }
        }

        // Fix remoteFolder to always start with /
        if (!remoteFolder.startsWith('/')) remoteFolder = '/' + remoteFolder;

        return path.posix.join(remoteFolder, file.name);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class WebDAVUploaderSettingTab extends PluginSettingTab {
    plugin: WebDAVUploaderPlugin;

    constructor(app: App, plugin: WebDAVUploaderPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'WebDAV 上传设置' });

        // 基础连接设置
        new Setting(containerEl)
            .setName('WebDAV 地址')
            .setDesc('WebDAV 服务器的完整 URL，插件将以此作为根目录进行所有操作')
            .addText(text => text
                .setPlaceholder('https://dav.example.com/')
                .setValue(this.plugin.settings.webdavUrl)
                .onChange(async (value) => {
                    this.plugin.settings.webdavUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('用户名')
            .setDesc('WebDAV 用户名')
            .addText(text => text
                .setValue(this.plugin.settings.username)
                .onChange(async (value) => {
                    this.plugin.settings.username = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('密码')
            .setDesc('WebDAV 密码')
            .addText(text => text
                .setPlaceholder('密码')
                .setValue(this.plugin.settings.password)
                .onChange(async (value) => {
                    this.plugin.settings.password = value;
                    await this.plugin.saveSettings();
                }));
        const passwordSetting = containerEl.lastElementChild;
        const passwordInput = passwordSetting?.querySelector('input');
        if (passwordInput) passwordInput.type = 'password';

        // 上传行为配置（提前）
        containerEl.createEl('h3', { text: '上传行为' });

        new Setting(containerEl)
            .setName('路径决定方式')
            .setDesc('选择使用哪个路径来决定上传目录')
            .addDropdown(dropdown => dropdown
                .addOption('note', '笔记路径 - 根据当前笔记所在位置')
                .addOption('local', '文件路径 - 根据被拖入文件的本地位置')
                .setValue(this.plugin.settings.pathMode)
                .onChange(async (value) => {
                    this.plugin.settings.pathMode = value as 'note' | 'local';
                    await this.plugin.saveSettings();
                    this.display(); // 重新渲染以更新显示的配置项
                }));

        new Setting(containerEl)
            .setName('优先使用已存在文件')
            .setDesc('如果文件已存在于云端，直接插入链接而不重新上传')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.preferExistingLink)
                .onChange(async (value) => {
                    this.plugin.settings.preferExistingLink = value;
                    await this.plugin.saveSettings();
                }));

        // 根据模式显示不同的配置
        if (this.plugin.settings.pathMode === 'note') {
            // 笔记路径模式：显示路径映射
            containerEl.createEl('h3', { text: '笔记路径映射 (必填)' });

            const mappingsContainer = containerEl.createDiv();

            const renderMappings = () => {
                mappingsContainer.empty();

                if (this.plugin.settings.pathMappings.length === 0) {
                    mappingsContainer.createEl('p', {
                        text: '⚠️ 请至少添加一条映射规则',
                        attr: { style: 'color: var(--text-warning); font-style: italic;' }
                    });
                }

                this.plugin.settings.pathMappings.forEach((mapping, index) => {
                    const div = mappingsContainer.createEl('div', {
                        cls: 'mapping-row',
                        attr: { style: 'display: flex; gap: 10px; margin-bottom: 10px; align-items: center;' }
                    });

                    // 本地路径选择器（文件夹）
                    const localSelect = div.createEl('select', {
                        attr: { style: 'flex: 1; padding: 6px; border-radius: 4px; border: 1px solid var(--background-modifier-border);' }
                    });

                    // 填充文件夹列表
                    const folders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
                    localSelect.createEl('option', { text: '(选择笔记文件夹)', value: '' });
                    // 添加根目录选项
                    const rootOption = localSelect.createEl('option', { text: '/ (根目录)', value: '/' });
                    if (mapping.localPath === '/') rootOption.selected = true;

                    folders.sort((a, b) => a.path.localeCompare(b.path));
                    folders.forEach((folder) => {
                        if (folder.path) { // 排除根目录（已单独添加）
                            const option = localSelect.createEl('option', { text: folder.path, value: folder.path });
                            if (folder.path === mapping.localPath) option.selected = true;
                        }
                    });

                    localSelect.onchange = async () => {
                        this.plugin.settings.pathMappings[index].localPath = localSelect.value;
                        await this.plugin.saveSettings();
                    };

                    // 箭头
                    div.createSpan({ text: '→', attr: { style: 'font-size: 1.2em;' } });

                    // 远程路径输入
                    const remoteInput = div.createEl('input', {
                        type: 'text',
                        value: mapping.remotePath,
                        placeholder: 'WebDAV 路径 (例如: /Sync)',
                        attr: { style: 'flex: 1; padding: 6px;' }
                    });
                    remoteInput.onchange = async () => {
                        this.plugin.settings.pathMappings[index].remotePath = remoteInput.value;
                        await this.plugin.saveSettings();
                    };

                    // 删除按钮
                    const delBtn = div.createEl('button', { text: '✕', attr: { style: 'padding: 4px 8px;' } });
                    delBtn.onclick = async () => {
                        this.plugin.settings.pathMappings.splice(index, 1);
                        await this.plugin.saveSettings();
                        renderMappings();
                    };
                });
            };

            renderMappings();

            new Setting(containerEl)
                .addButton(btn => btn
                    .setButtonText('+ 添加映射')
                    .setCta()
                    .onClick(async () => {
                        this.plugin.settings.pathMappings.push({ localPath: '', remotePath: '' });
                        await this.plugin.saveSettings();
                        renderMappings();
                    }));

        } else {
            // 文件路径模式：显示本地同步文件夹配置
            containerEl.createEl('h3', { text: '本地同步文件夹 (必填)' });

            new Setting(containerEl)
                .setName('本地同步文件夹路径')
                .setDesc('本地文件夹的绝对路径 (例如: C:\\Users\\Name\\secondbrain)')
                .addText(text => text
                    .setPlaceholder('C:\\Users\\...')
                    .setValue(this.plugin.settings.localSyncFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.localSyncFolder = value;
                        await this.plugin.saveSettings();
                    }));

            // 添加警告提示
            if (!this.plugin.settings.localSyncFolder) {
                const warningDiv = containerEl.createDiv({
                    text: '⚠️ 请填写本地同步文件夹路径',
                    attr: { style: 'color: var(--text-warning); font-style: italic; margin-bottom: 15px;' }
                });
            }

            new Setting(containerEl)
                .setName('对应的 WebDAV 远程路径')
                .setDesc('该文件夹在 WebDAV 上的对应路径 (例如: / 或 /secondbrain)')
                .addText(text => text
                    .setPlaceholder('/')
                    .setValue(this.plugin.settings.remoteSyncFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.remoteSyncFolder = value;
                        await this.plugin.saveSettings();
                    }));
        }

        // 配置测试工具
        containerEl.createEl('h3', { text: '测试与预览' });

        new Setting(containerEl)
            .setName('测试 WebDAV 连接')
            .setDesc('点击按钮测试 WebDAV 服务器连接是否正常')
            .addButton(btn => btn
                .setButtonText('测试连接')
                .onClick(async () => {
                    btn.setButtonText('测试中...');
                    btn.setDisabled(true);
                    try {
                        const testResult = await this.plugin.webdavExists('/');
                        if (testResult) {
                            new Notice('✅ WebDAV 连接成功！');
                        } else {
                            new Notice('❌ WebDAV 连接失败，请检查配置');
                        }
                    } catch (error) {
                        new Notice(`❌ 连接错误: ${error.message}`);
                    } finally {
                        btn.setButtonText('测试连接');
                        btn.setDisabled(false);
                    }
                }));

        // 路径模拟工具
        const simulationDiv = containerEl.createDiv({ cls: 'path-simulation' });
        simulationDiv.createEl('h3', { text: '路径模拟器' });
        // simulationDiv.createEl('p', { text: '输入文件路径，选择笔记位置，查看将被上传到的 WebDAV 路径' }); // 移除未对齐的说明文本

        // 文件路径输入
        new Setting(simulationDiv)
            .setName('文件路径')
            .setDesc('要检查的本地文件完整路径')
            .addText(text => text
                .setPlaceholder('例如: C:\\Users\\...\\secondbrain\\docs\\file.pdf')
                .then(input => {
                    input.inputEl.id = 'sim-file-path';
                    input.inputEl.style.width = '100%';
                }));

        // 笔记选择下拉 - 使用 Setting 组件
        new Setting(simulationDiv)
            .setName('目标笔记')
            .setDesc('选择将插入链接的笔记（仅在"笔记路径"模式下影响结果）')
            .addDropdown(dropdown => {
                dropdown.selectEl.id = 'sim-note-select';
                dropdown.selectEl.style.width = '250px';

                // 填充笔记列表
                dropdown.addOption('', '(选择笔记)');
                const files = this.app.vault.getMarkdownFiles();
                files.sort((a, b) => a.path.localeCompare(b.path));
                files.forEach(file => {
                    // 显示简短名称，值为完整路径
                    const displayName = file.basename + ' (' + (file.parent?.path || '/') + ')';
                    dropdown.addOption(file.path, displayName);
                });
            })
            .addExtraButton(btn => {
                btn.setIcon('rotate-cw');
                btn.setTooltip('刷新笔记列表');
                btn.onClick(() => {
                    this.display(); // 重新渲染整个设置页面
                });
            });

        const simulationResultDiv = simulationDiv.createDiv({
            attr: {
                style: 'padding: 12px; background: var(--background-secondary); border-radius: 6px; border-left: 4px solid var(--interactive-accent); display: none; margin-top: 10px;'
            }
        });

        new Setting(simulationDiv)
            .addButton(btn => btn
                .setButtonText('🔍 模拟检查')
                .setCta()
                .onClick(async () => {
                    const filePathInput = simulationDiv.querySelector('#sim-file-path') as HTMLInputElement;
                    const noteSelectEl = simulationDiv.querySelector('#sim-note-select') as HTMLSelectElement;
                    const testPath = filePathInput?.value.trim();
                    const selectedNotePath = noteSelectEl?.value || '';

                    if (!testPath) {
                        new Notice('请输入文件路径');
                        return;
                    }

                    simulationResultDiv.style.display = 'block';
                    simulationResultDiv.innerHTML = '<strong>⏳ 检查中...</strong>';

                    try {
                        const normalizedPath = testPath.replace(/\\/g, '/');
                        const fileName = normalizedPath.split('/').pop() || 'file';

                        let mockActiveFile: TFile | null = null;
                        if (selectedNotePath) {
                            mockActiveFile = this.app.vault.getAbstractFileByPath(selectedNotePath) as TFile;
                        }

                        let remotePath = '';
                        let calculationMethod = '';
                        let isLocalLink = false; // 是否插入本地链接（不上传）

                        if (this.plugin.settings.pathMode === 'note') {
                            // ===== 笔记路径模式 =====
                            if (!mockActiveFile) {
                                calculationMethod = '⚠️ 未选择笔记，无法计算路径';
                                remotePath = '';
                            } else {
                                const noteParentPath = mockActiveFile.parent ? mockActiveFile.parent.path : '';

                                // 检查是否匹配到映射
                                let bestMatch: PathMapping | null = null;
                                for (const mapping of this.plugin.settings.pathMappings) {
                                    if (mapping.localPath && noteParentPath.startsWith(mapping.localPath)) {
                                        if (!bestMatch || mapping.localPath.length > bestMatch.localPath.length) {
                                            bestMatch = mapping;
                                        }
                                    }
                                    // 根目录特殊处理
                                    if (mapping.localPath === '/' && noteParentPath === '') {
                                        bestMatch = mapping;
                                    }
                                }

                                if (bestMatch) {
                                    // 匹配到映射
                                    let relativePath = '';
                                    if (bestMatch.localPath === '/') {
                                        relativePath = noteParentPath;
                                    } else {
                                        relativePath = noteParentPath.slice(bestMatch.localPath.length).replace(/^\//, '');
                                    }
                                    const cleanRemote = bestMatch.remotePath.replace(/\/$/, '');
                                    remotePath = `${cleanRemote}/${relativePath}/${fileName}`.replace(/\/+/g, '/');
                                    calculationMethod = `✅ 匹配映射: ${bestMatch.localPath} → ${bestMatch.remotePath}`;
                                } else {
                                    // 未匹配到映射，根据笔记路径在 WebDAV 根目录创建对应目录
                                    remotePath = `/${noteParentPath}/${fileName}`.replace(/\/+/g, '/');
                                    calculationMethod = `📁 未匹配映射，使用笔记路径: /${noteParentPath || '(根目录)'}`;
                                }
                            }
                        } else {
                            // ===== 文件路径模式 =====
                            if (!this.plugin.settings.localSyncFolder || !this.plugin.settings.remoteSyncFolder) {
                                calculationMethod = '⚠️ 未配置本地同步文件夹';
                                isLocalLink = true;
                            } else {
                                // 标准化路径：统一使用正斜杠，转小写（Windows不区分大小写）
                                const normalizedSync = this.plugin.settings.localSyncFolder
                                    .replace(/\\/g, '/')
                                    .replace(/\/$/, '')
                                    .toLowerCase();
                                const normalizedFilePath = normalizedPath.toLowerCase();

                                if (normalizedFilePath.startsWith(normalizedSync)) {
                                    // 文件在同步目录内
                                    const relativePath = normalizedPath.slice(this.plugin.settings.localSyncFolder.length).replace(/^[\/\\]/, '');
                                    const remoteBase = this.plugin.settings.remoteSyncFolder.replace(/\/$/, '');
                                    remotePath = `${remoteBase}/${relativePath}`.replace(/\\/g, '/').replace(/\/+/g, '/');
                                    if (!remotePath.startsWith('/')) remotePath = '/' + remotePath;
                                    calculationMethod = `✅ 匹配到本地同步文件夹 (${this.plugin.settings.localSyncFolder})`;
                                } else {
                                    // 文件不在同步目录内 -> 插入本地链接
                                    calculationMethod = `📂 不在同步目录内，将插入本地文件链接
文件路径: ${normalizedFilePath}
配置的同步目录: ${normalizedSync}`;
                                    isLocalLink = true;
                                }
                            }
                        }

                        if (remotePath && !remotePath.startsWith('/')) remotePath = '/' + remotePath;

                        // 显示结果
                        const baseUrl = this.plugin.settings.webdavUrl.replace(/\/$/, '');

                        if (isLocalLink) {
                            // 插入本地链接
                            simulationResultDiv.innerHTML = `
                                <div style="line-height: 1.8;">
                                    <strong>🎯 计算方式:</strong> ${calculationMethod}<br>
                                    <strong>📂 本地路径:</strong> <code style="background: var(--background-primary-alt); padding: 2px 6px; border-radius: 3px;">${testPath}</code><br>
                                    <strong>🚀 预期行为:</strong> 🔗 直接插入本地文件链接（不上传到 WebDAV）
                                </div>
                            `;
                        } else if (remotePath) {
                            // 检查云端是否存在
                            const exists = await this.plugin.webdavExists(remotePath);
                            const willUpload = !exists || !this.plugin.settings.preferExistingLink;

                            simulationResultDiv.innerHTML = `
                                <div style="line-height: 1.8;">
                                    <strong>🎯 计算方式:</strong> ${calculationMethod}<br>
                                    <strong>📂 本地路径:</strong> <code style="background: var(--background-primary-alt); padding: 2px 6px; border-radius: 3px;">${testPath}</code><br>
                                    <strong>📝 目标笔记:</strong> ${selectedNotePath || '(未选择)'}<br>
                                    <strong>☁️ 远程路径:</strong> <code style="background: var(--background-primary-alt); padding: 2px 6px; border-radius: 3px;">${remotePath}</code><br>
                                    <strong>🌐 WebDAV URL:</strong> <code style="background: var(--background-primary-alt); padding: 2px 6px; border-radius: 3px; font-size: 0.9em;">${baseUrl}${remotePath}</code><br>
                                    <strong>✨ 云端状态:</strong> ${exists ? '✅ 文件已存在' : '❌ 文件不存在'}<br>
                                    <strong>🚀 预期行为:</strong> ${willUpload ? (exists ? '⬆️ 将重新上传（优先使用已存在文件=关）' : '⬆️ 将上传文件') : '🔗 仅插入链接（文件已存在）'}
                                </div>
                            `;
                        } else {
                            simulationResultDiv.innerHTML = `
                                <div style="line-height: 1.8;">
                                    <strong>🎯 计算方式:</strong> ${calculationMethod}<br>
                                    <strong>📂 本地路径:</strong> <code style="background: var(--background-primary-alt); padding: 2px 6px; border-radius: 3px;">${testPath}</code><br>
                                    <strong>⚠️ 无法计算远程路径</strong>
                                </div>
                            `;
                        }
                    } catch (error) {
                        simulationResultDiv.innerHTML = `<strong>❌ 检查失败:</strong> ${error.message}`;
                    }
                }));
    }
}
