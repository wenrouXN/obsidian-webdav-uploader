import { EditorView, Decoration, ViewPlugin, ViewUpdate, WidgetType, DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { requestUrl } from "obsidian";

interface WebDAVPlugin {
    settings: {
        webdavUrl: string;
        username: string;
        password: string;
    }
}

// 简单的内存缓存: URL -> Base64 Data String
const imageCache = new Map<string, string>();
// 避免重复请求：正在加载的 URL
const pendingRequests = new Set<string>();

class WebDAVImageWidget extends WidgetType {
    constructor(
        readonly url: string,
        readonly alt: string,
        readonly plugin: WebDAVPlugin
    ) {
        super();
    }

    eq(other: WebDAVImageWidget) {
        return other.url === this.url && other.alt === this.alt;
    }

    toDOM(view: EditorView): HTMLElement {
        const img = document.createElement("img");
        img.alt = this.alt;
        img.setAttribute("src", ""); // 初始设置为空
        img.style.maxWidth = "100%";
        img.style.display = "block"; // 块级显示，模仿 Obsidian 行为

        // 如果有缓存，直接使用
        if (imageCache.has(this.url)) {
            img.setAttribute("src", imageCache.get(this.url)!);
            return img;
        }

        // 标记加载状态
        img.style.opacity = "0.5";

        // 启动异步加载
        this.loadImage(img);

        return img;
    }

    async loadImage(img: HTMLImageElement) {
        // 如果相同 URL 已经在请求中，这里我们还是发起请求，或者可以优化为等待 Promise。
        // 简单起见，每个 Widget 实例负责自己的加载，但利用全局 cache 避免后续重绘的请求。

        try {
            const auth = btoa(`${this.plugin.settings.username}:${this.plugin.settings.password}`);
            const response = await requestUrl({
                url: this.url,
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (response.status === 200) {
                const blob = new Blob([response.arrayBuffer], { type: response.headers['content-type'] || 'image/png' });
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64data = reader.result as string;
                    //存入缓存
                    imageCache.set(this.url, base64data);
                    // 更新图片
                    img.setAttribute("src", base64data);
                    img.style.opacity = "1";
                };
                reader.readAsDataURL(blob);
            } else {
                console.error(`[WebDAV] Failed to load image ${this.url}: status ${response.status}`);
                img.alt = `Failed to load: ${this.alt} (${response.status})`;
            }
        } catch (e) {
            console.error(`[WebDAV] Failed to load image ${this.url}`, e);
            img.alt = `Error loading: ${this.alt}`;
        }
    }
}

export function createWebDAVImageExtension(plugin: WebDAVPlugin) {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = this.buildDecorations(view);
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged || update.selectionSet) {
                this.decorations = this.buildDecorations(update.view);
            }
        }

        buildDecorations(view: EditorView): DecorationSet {
            // 检查是否启用了 Live Preview
            // 查找包含编辑器内容的容器，检查是否有 'is-live-preview' 类
            const sourceView = view.dom.closest('.markdown-source-view');
            const isLivePreview = sourceView?.classList.contains('is-live-preview');

            if (!isLivePreview) {
                return Decoration.none;
            }

            const builder = new RangeSetBuilder<Decoration>();
            // 获取 WebDAV 基础路径
            const webdavBase = plugin.settings.webdavUrl.replace(/\/$/, '');
            const webdavBaseHttp = webdavBase.replace('https://', 'http://');

            // 简单的正则匹配：![alt](url)
            // 注意：这只是为了演示，并不完美支持所有 Markdown 边缘情况（如嵌套括号）
            // 如果要完美支持，建议使用 syntaxTree
            const text = view.state.doc.sliceString(0);
            const regex = /!\[(.*?)\]\((https?:\/\/.*?)\)/g;

            // 为了高效，只扫描视口范围？
            // ViewPlugin 通常处理整个文档的装饰器比较方便构建 RangeSet，
            // 但对于大文档，最好只处理 visibleRanges。
            // 简单起见，我们遍历 visibleRanges。

            for (const { from, to } of view.visibleRanges) {
                const rangeText = view.state.doc.sliceString(from, to);
                let match;
                // 重置 lastIndex
                regex.lastIndex = 0;

                // 正则是在 rangeText 上匹配的，所以索引是相对的
                while ((match = regex.exec(rangeText)) !== null) {
                    const start = from + match.index;
                    const end = start + match[0].length;
                    const alt = match[1];
                    const url = match[2];

                    // 检查是否是 WebDAV URL
                    if (!url.startsWith(webdavBase) && !url.startsWith(webdavBaseHttp)) {
                        continue;
                    }

                    // 检查光标是否在链接范围内
                    // 如果光标在范围内，不渲染（显示源码进行编辑）
                    const selection = view.state.selection;
                    let hasCursor = false;
                    for (const range of selection.ranges) {
                        if (range.from >= start && range.to <= end) {
                            hasCursor = true;
                            break;
                        }
                    }

                    if (hasCursor) {
                        continue; // 跳过渲染，显示源码
                    }

                    // 添加装饰器：替换原文
                    builder.add(
                        start,
                        end,
                        Decoration.replace({
                            widget: new WebDAVImageWidget(url, alt, plugin),
                        })
                    );
                }
            }

            return builder.finish();
        }
    }, {
        decorations: v => v.decorations
    });
}
