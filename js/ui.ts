import { Song, getSongUrl } from './api';
import * as player from './player';
import { LyricLine } from './player';
import { escapeHtml, formatTime, getElement } from './utils';

// --- DOM Element Cache ---
interface DOMCache {
    searchResults: HTMLElement | null;
    parseResults: HTMLElement | null;
    savedResults: HTMLElement | null;
    currentCover: HTMLImageElement | null;
    currentTitle: HTMLElement | null;
    currentArtist: HTMLElement | null;
    playBtn: HTMLElement | null;
    progressFill: HTMLElement | null;
    currentTime: HTMLElement | null;
    totalTime: HTMLElement | null;
    lyricsContainer: HTMLElement | null;
    downloadSongBtn: HTMLButtonElement | null;
    downloadLyricBtn: HTMLButtonElement | null;
}

let DOM: DOMCache;

/**
 * 初始化 UI 模块，缓存 DOM 元素引用
 */
export function init(): void {
    DOM = {
        searchResults: getElement('#searchResults'),
        parseResults: getElement('#parseResults'),
        savedResults: getElement('#savedResults'),
        currentCover: getElement<HTMLImageElement>('#currentCover'),
        currentTitle: getElement('#currentTitle'),
        currentArtist: getElement('#currentArtist'),
        playBtn: getElement('#playBtn'),
        progressFill: getElement('#progressFill'),
        currentTime: getElement('#currentTime'),
        totalTime: getElement('#totalTime'),
        lyricsContainer: getElement('#lyricsContainer'),
        downloadSongBtn: getElement<HTMLButtonElement>('#downloadSongBtn'),
        downloadLyricBtn: getElement<HTMLButtonElement>('#downloadLyricBtn'),
    };
}

// --- UI Functions ---

/**
 * 显示通知消息
 * @param message 通知消息内容
 * @param type 通知类型：info/success/warning/error
 */
export function showNotification(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    // NOTE: 使用 textContent 而非 innerHTML，防止 XSS
    notification.textContent = message;
    document.body.appendChild(notification);

    // NOTE: 使用 requestAnimationFrame 确保过渡动画正常
    requestAnimationFrame(() => {
        notification.classList.add('notification-show');
    });

    setTimeout(() => {
        notification.classList.remove('notification-show');
        notification.classList.add('notification-hide');
        setTimeout(() => notification.remove(), 500);
    }, 3000);
}

// 存储当前的滚动加载状态
interface ScrollState {
    songs: Song[];
    containerId: string;
    playlistForPlayback: Song[];
    renderedCount: number;
    batchSize: number;
}
let currentScrollState: ScrollState | null = null;

/**
 * 渲染歌曲列表项
 */
function renderSongItems(songs: Song[], startIndex: number, container: HTMLElement, playlistForPlayback: Song[]): void {
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < songs.length; i++) {
        const index = startIndex + i;
        const song = songs[i];
        const songItem = document.createElement('div');
        songItem.className = 'song-item';
        songItem.dataset.index = index.toString(); // 用于查找

        const isFavorite = player.isSongInFavorites(song);
        const favoriteIconClass = isFavorite ? 'fas fa-heart' : 'far fa-heart';
        const favoriteStyle = isFavorite ? 'color: #ff6b6b;' : '';
        const artistText = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist;

        songItem.innerHTML = `
            <div class="song-index">${(index + 1).toString().padStart(2, '0')}</div>
            <div class="song-info">
                <div class="song-name">${escapeHtml(song.name)}</div>
                <div class="song-artist">${escapeHtml(artistText)} · ${escapeHtml(song.album)}</div>
            </div>
            <div class="song-actions">
                <button class="action-btn favorite-btn" title="添加到我的喜欢" aria-label="添加到我的喜欢">
                    <i class="${favoriteIconClass}" style="${favoriteStyle}"></i>
                </button>
                <button class="action-btn download-icon-btn" title="下载" aria-label="下载">
                    <i class="fas fa-download"></i>
                </button>
            </div>
        `;

        // 点击歌曲播放，移动端跳转到播放器栏
        songItem.onclick = () => {
            player.playSong(index, playlistForPlayback, currentScrollState ? currentScrollState.containerId : 'searchResults');
            // 移动端跳转到播放器栏（第二栏）
            if (window.innerWidth <= 768 && (window as any).switchMobilePage) {
                (window as any).switchMobilePage(1);
            }
        };

        const favoriteBtn = songItem.querySelector('.favorite-btn');
        if (favoriteBtn) {
            favoriteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                player.toggleFavoriteButton(song);
                // 乐观更新 UI
                const icon = favoriteBtn.querySelector('i');
                if (icon) {
                    if (player.isSongInFavorites(song)) {
                        icon.className = 'fas fa-heart';
                        (icon as HTMLElement).style.color = '#ff6b6b';
                    } else {
                        icon.className = 'far fa-heart';
                        (icon as HTMLElement).style.color = '';
                    }
                }
            });
        }

        const downloadIconBtn = songItem.querySelector('.download-icon-btn');
        if (downloadIconBtn) {
            downloadIconBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                // 简单的防止重复点击
                const btn = e.currentTarget as HTMLButtonElement;
                if (btn.disabled) return;

                try {
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                    showNotification('正在获取下载链接...', 'info');

                    const result = await getSongUrl(song, '320000'); // 默认尝试下载高品质
                    if (result && result.url) {
                        // 创建临时链接下载
                        // NOTE: 由于跨域问题，可能无法直接触发下载，而是打开新窗口
                        const link = document.createElement('a');
                        link.href = result.url;
                        link.target = '_blank';
                        // 尝试设置下载文件名 (仅同源有效)
                        link.download = `${song.name} - ${Array.isArray(song.artist) ? song.artist.join(',') : song.artist}.mp3`;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        showNotification('已开始下载/打开链接', 'success');
                    } else {
                        showNotification('无法获取下载链接', 'error');
                    }
                } catch (error) {
                    console.error('下载失败:', error);
                    showNotification('下载出错，请重试', 'error');
                } finally {
                    btn.disabled = false;
                    btn.style.opacity = '';
                }
            });
        }

        fragment.appendChild(songItem);
    }

    container.appendChild(fragment);
}

/**
 * 监听滚动以加载更多
 */
function setupInfiniteScroll(container: HTMLElement): void {
    container.onscroll = () => {
        if (!currentScrollState) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        // 如果滚动到距离底部 100px
        if (scrollHeight - scrollTop - clientHeight < 100) {
            const { songs, renderedCount, batchSize, playlistForPlayback } = currentScrollState;

            if (renderedCount < songs.length) {
                const nextBatch = songs.slice(renderedCount, renderedCount + batchSize);
                renderSongItems(nextBatch, renderedCount, container, playlistForPlayback);
                currentScrollState.renderedCount += nextBatch.length;
            }
        }
    };
}

/**
 * 显示搜索结果列表
 * @param songs 歌曲列表
 * @param containerId 容器元素 ID
 * @param playlistForPlayback 用于播放的完整歌单
 */
export function displaySearchResults(songs: Song[], containerId: string, playlistForPlayback: Song[]): void {
    const container = getElement(`#${containerId}`);
    if (!container) return;

    container.innerHTML = '';

    // 清除之前的滚动状态（如果是同一个容器）
    if (currentScrollState && currentScrollState.containerId === containerId) {
        currentScrollState = null;
    }

    if (songs.length === 0) {
        container.innerHTML = `<div class="empty-state"><div>未找到相关歌曲</div></div>`;
        return;
    }

    // 初始化滚动状态
    const batchSize = 30;
    currentScrollState = {
        songs,
        containerId,
        playlistForPlayback,
        renderedCount: 0,
        batchSize
    };

    // 初始渲染
    const initialBatch = songs.slice(0, batchSize);
    renderSongItems(initialBatch, 0, container, playlistForPlayback);
    currentScrollState.renderedCount = initialBatch.length;

    // 监听滚动
    container.onscroll = null; // 简单的重置
    setupInfiniteScroll(container);
}

/**
 * 更新播放按钮状态
 * @param isPlaying 是否正在播放
 */
export function updatePlayButton(isPlaying: boolean): void {
    const icon = DOM.playBtn?.querySelector('i');
    if (icon) {
        icon.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
    }
}

/**
 * 更新当前歌曲信息显示
 * @param song 歌曲对象
 * @param coverUrl 封面图片 URL
 */
export function updateCurrentSongInfo(song: Song, coverUrl: string): void {
    if (DOM.currentTitle) {
        // NOTE: 使用 textContent 而非 innerHTML，防止 XSS
        DOM.currentTitle.textContent = song.name;
    }
    if (DOM.currentArtist) {
        const artistText = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist;
        DOM.currentArtist.textContent = `${artistText} · ${song.album}`;
    }
    if (DOM.currentCover && coverUrl) {
        // NOTE: 只有当封面 URL 有效时才更新，避免显示空白或 alt 文本
        DOM.currentCover.src = coverUrl;
        DOM.currentCover.onerror = () => {
            // 封面加载失败时使用默认占位图
            DOM.currentCover!.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjIwIiBoZWlnaHQ9IjIyMCIgdmlld0JveD0iMCAwIDIyMCAyMjAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMjAiIGhlaWdodD0iMjIwIiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU5LDAuMSkiIHJ4PSIyMCIvPgo8cGF0aCBkPSJNMTEwIDcwTDE0MCAxMTBIMTIwVjE1MEg5MFYxMTBINzBMMTEwIDcwWiIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjMpIi8+Cjwvc3ZnPgo=';
        };
    }
    if (DOM.downloadSongBtn) {
        DOM.downloadSongBtn.disabled = false;
    }
    if (DOM.downloadLyricBtn) {
        DOM.downloadLyricBtn.disabled = false;
    }
}

/**
 * 更新播放进度条
 * @param currentTime 当前播放时间（秒）
 * @param duration 总时长（秒）
 */
export function updateProgress(currentTime: number, duration: number): void {
    const progressPercent = (currentTime / duration) * 100;
    if (DOM.progressFill) {
        DOM.progressFill.style.width = `${progressPercent}%`;
    }
    if (DOM.currentTime) {
        DOM.currentTime.textContent = formatTime(currentTime);
    }
    if (DOM.totalTime) {
        DOM.totalTime.textContent = formatTime(duration);
    }
}

/**
 * 更新歌词显示
 * @param lyrics 歌词行数组
 * @param currentTime 当前播放时间（秒）
 */
let lastLyricsLength = 0; // 缓存上次歌词数量，用于判断是否需要重新渲染
let lastActiveIndex = -1; // 缓存上次高亮行索引

export function updateLyrics(lyrics: LyricLine[], currentTime: number): void {
    if (!DOM.lyricsContainer) return;

    if (!lyrics.length) {
        DOM.lyricsContainer.innerHTML = '<div class="lyric-line">暂无歌词</div>';
        lastLyricsLength = 0;
        lastActiveIndex = -1;
        return;
    }

    // 计算当前应该高亮的行
    let activeIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
        const nextLine = lyrics[i + 1];
        if (currentTime >= lyrics[i].time && (!nextLine || currentTime < nextLine.time)) {
            activeIndex = i;
            break;
        }
    }

    // NOTE: 只有歌词数量变化时才重新渲染整个 HTML
    if (lyrics.length !== lastLyricsLength) {
        DOM.lyricsContainer.innerHTML = lyrics.map((line, index) =>
            `<div class="lyric-line${index === activeIndex ? ' active' : ''}" data-index="${index}" data-time="${line.time}">${escapeHtml(line.text)}</div>`
        ).join('');
        lastLyricsLength = lyrics.length;
        lastActiveIndex = activeIndex;

        // 滚动到高亮行
        if (activeIndex >= 0) {
            scrollToActiveLine();
        }
        return;
    }

    // NOTE: 只有高亮行变化时才更新类名
    if (activeIndex !== lastActiveIndex) {
        // 移除旧的高亮
        if (lastActiveIndex >= 0) {
            const oldActive = DOM.lyricsContainer.querySelector(`[data-index="${lastActiveIndex}"]`);
            if (oldActive) {
                oldActive.classList.remove('active');
            }
        }

        // 添加新的高亮
        if (activeIndex >= 0) {
            const newActive = DOM.lyricsContainer.querySelector(`[data-index="${activeIndex}"]`);
            if (newActive) {
                newActive.classList.add('active');
                // 平滑滚动到高亮行
                newActive.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        lastActiveIndex = activeIndex;
    }
}

/**
 * 滚动到当前高亮的歌词行
 */
function scrollToActiveLine(): void {
    if (!DOM.lyricsContainer) return;
    const activeLine = DOM.lyricsContainer.querySelector('.active');
    if (activeLine) {
        activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

/**
 * 更新当前播放歌曲的高亮状态
 * @param currentIndex 当前歌曲索引
 * @param containerId 容器元素 ID
 */
export function updateActiveItem(currentIndex: number, containerId: string): void {
    document.querySelectorAll('.song-item').forEach(item => item.classList.remove('active'));

    const container = getElement(`#${containerId}`);
    if (container) {
        // 使用 data-index 查找
        let activeItem = container.querySelector(`.song-item[data-index="${currentIndex}"]`);

        // 如果未渲染（在无限滚动后面），则需要处理
        if (!activeItem && currentScrollState && currentScrollState.containerId === containerId) {
            // 如果目标索引超出了当前渲染范围，强制渲染到那个位置
            if (currentIndex >= currentScrollState.renderedCount) {
                const { songs, renderedCount, playlistForPlayback } = currentScrollState;
                // 确保我们要渲染的范围是有效的
                if (renderedCount < songs.length) {
                    const neededBatch = songs.slice(renderedCount, currentIndex + 20); // 多渲染一点
                    renderSongItems(neededBatch, renderedCount, container, playlistForPlayback);
                    currentScrollState.renderedCount += neededBatch.length;
                    activeItem = container.querySelector(`.song-item[data-index="${currentIndex}"]`);
                }
            }
        }

        if (activeItem) {
            activeItem.classList.add('active');
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

/**
 * 显示加载状态
 * @param containerId 容器元素 ID
 */
export function showLoading(containerId: string = 'searchResults'): void {
    const container = getElement(`#${containerId}`);
    if (container) {
        container.innerHTML = `<div class="loading"><i class="fas fa-spinner"></i><div>正在加载...</div></div>`;
    }
}

/**
 * 显示错误信息
 * @param message 错误消息
 * @param containerId 容器元素 ID
 */
export function showError(message: string, containerId: string = 'searchResults'): void {
    const container = getElement(`#${containerId}`);
    if (container) {
        // NOTE: 使用 escapeHtml 转义错误消息
        container.innerHTML = `<div class="error"><i class="fas fa-exclamation-triangle"></i><div>${escapeHtml(message)}</div></div>`;
    }
}

