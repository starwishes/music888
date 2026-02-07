import * as api from './api';
import { Song, LyricLine, DOMCache, ScrollState, NotificationType, ArtistInfo, AlbumInfo, RadioStation, RadioProgram } from './types';
import * as player from './player';
import { escapeHtml, formatTime, getElement, ensureHttps } from './utils';
import { APP_CONFIG, logger } from './config';

// --- DOM Element Cache ---

let DOM: DOMCache;

// --- 通知去重 ---
const NOTIFICATION_DEDUP_TIME = 3000; // 3 秒内相同消息不重复
let lastNotificationMessage = '';
let lastNotificationTime = 0;

/**
 * 初始化 UI 模块，缓存 DOM 元素引用
 */
export function init(): void {
    DOM = {
        searchResults: getElement('#searchResults'),
        parseResults: getElement('#parseResults'),
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
        inlineLyricText: getElement('#inlineLyricText'),
    };
}

// --- UI Functions ---

/**
 * 显示通知消息
 * @param message 通知消息内容
 * @param type 通知类型：info/success/warning/error
 */
export function showNotification(message: string, type: NotificationType = 'info'): void {
    // NOTE: 通知去重 - 3 秒内相同消息不重复显示
    const now = Date.now();
    if (message === lastNotificationMessage && now - lastNotificationTime < NOTIFICATION_DEDUP_TIME) {
        logger.debug('通知去重，跳过重复消息:', message);
        return;
    }
    lastNotificationMessage = message;
    lastNotificationTime = now;

    // NOTE: 同步播报到 ARIA Live Region
    announceToScreenReader(message);

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

/**
 * 向屏幕阅读器播报消息
 * @param message 要播报的消息
 */
export function announceToScreenReader(message: string): void {
    const liveRegion = document.getElementById('aria-live-region');
    if (liveRegion) {
        // NOTE: 清空再设置，确保相同消息也能触发播报
        liveRegion.textContent = '';
        requestAnimationFrame(() => {
            liveRegion.textContent = message;
        });
    }
}

// 存储当前的滚动加载状态
let currentScrollState: ScrollState | null = null;
// NOTE: 存储滚动监听器引用和容器，用于正确清理
let currentScrollHandler: (() => void) | null = null;
let currentScrollContainer: HTMLElement | null = null;

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

        // 点击歌曲播放
        songItem.onclick = () => {
            player.playSong(
                index,
                playlistForPlayback,
                currentScrollState ? currentScrollState.containerId : 'searchResults'
            );
        };

        const favoriteBtn = songItem.querySelector('.favorite-btn');
        if (favoriteBtn) {
            favoriteBtn.addEventListener('click', e => {
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
            downloadIconBtn.addEventListener('click', async e => {
                e.stopPropagation();
                const btn = e.currentTarget as HTMLButtonElement;
                if (btn.disabled) return;

                try {
                    btn.disabled = true;
                    btn.classList.add('loading');
                    showNotification('正在解析最佳下载地址...', 'info');

                    const result = await api.getSongUrl(song, '320'); // 默认尝试下载高品质
                    if (result && result.url) {
                        let downloadUrl = result.url.replace(/^http:/, 'https:');
                        // 强制通过代理下载以绕过 CORS
                        downloadUrl = `/api/proxy?url=${encodeURIComponent(downloadUrl)}`;

                        showNotification('已成功获取下载地址，准备下载...', 'success');
                        const link = document.createElement('a');
                        link.href = downloadUrl;
                        link.target = '_blank';
                        link.download = `${song.name} - ${artistText}.mp3`;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                    } else {
                        showNotification('无法获取下载链接', 'error');
                    }
                } catch (error) {
                    logger.error('下载失败:', error);
                    showNotification('下载出错，请重试', 'error');
                } finally {
                    btn.disabled = false;
                    btn.classList.remove('loading');
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
    // NOTE: 清理旧的滚动监听器（从正确的容器移除）
    if (currentScrollHandler && currentScrollContainer) {
        currentScrollContainer.removeEventListener('scroll', currentScrollHandler);
    }

    const scrollHandler = () => {
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

    currentScrollHandler = scrollHandler;
    currentScrollContainer = container;
    container.addEventListener('scroll', scrollHandler);
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

    // 批量操作栏
    const actionBar = document.createElement('div');
    actionBar.className = 'batch-action-bar';
    actionBar.innerHTML = `
        <button class="batch-play-all-btn"><i class="fas fa-play"></i> 播放全部 <span class="batch-count">${songs.length}</span></button>
    `;
    container.appendChild(actionBar);

    const playAllBtn = actionBar.querySelector('.batch-play-all-btn');
    if (playAllBtn) {
        playAllBtn.addEventListener('click', () => {
            player.playSong(0, playlistForPlayback, containerId);
        });
    }

    // 初始化滚动状态
    const batchSize = APP_CONFIG.INFINITE_SCROLL_BATCH_SIZE;
    currentScrollState = {
        songs,
        containerId,
        playlistForPlayback,
        renderedCount: 0,
        batchSize,
    };

    // 初始渲染
    const initialBatch = songs.slice(0, batchSize);
    renderSongItems(initialBatch, 0, container, playlistForPlayback);
    currentScrollState.renderedCount = initialBatch.length;

    // 监听滚动
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
            DOM.currentCover!.src =
                'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjIwIiBoZWlnaHQ9IjIyMCIgdmlld0JveD0iMCAwIDIyMCAyMjAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMjAiIGhlaWdodD0iMjIwIiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU5LDAuMSkiIHJ4PSIyMCIvPgo8cGF0aCBkPSJNMTEwIDcwTDE0MCAxMTBIMTIwVjE1MEg5MFYxMTBINzBMMTEwIDcwWiIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjMpIi8+Cjwvc3ZnPgo=';
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
 * @param lyrics 歌词行数组（可包含翻译歌词）
 * @param currentTime 当前播放时间（秒）
 */
let lastLyricsLength = 0; // 缓存上次歌词数量，用于判断是否需要重新渲染
let lastActiveIndex = -1; // 缓存上次高亮行索引
let lyricsUpdateFrame: number | null = null; // 用于节流歌词更新

export function updateLyrics(lyrics: LyricLine[], currentTime: number): void {
    if (!DOM.lyricsContainer) return;

    // 取消之前的更新请求，避免频繁更新
    if (lyricsUpdateFrame !== null) {
        cancelAnimationFrame(lyricsUpdateFrame);
    }

    lyricsUpdateFrame = requestAnimationFrame(() => {
        const container = DOM.lyricsContainer;
        if (!container) return;

        if (!lyrics.length) {
            container.innerHTML = '<div class="lyric-line">暂无歌词</div>';
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
            container.innerHTML = lyrics
                .map((line, index) => {
                    const isActive = index === activeIndex;
                    const mainText = escapeHtml(line.text);
                    // NOTE: 如果有翻译歌词，在原歌词下方显示
                    const translationHtml = line.ttext
                        ? `<div class="lyric-translation">${escapeHtml(line.ttext)}</div>`
                        : '';
                    return `<div class="lyric-line${isActive ? ' active' : ''}" data-index="${index}" data-time="${line.time}">${mainText}${translationHtml}</div>`;
                })
                .join('');
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
                const oldActive = container.querySelector(`[data-index="${lastActiveIndex}"]`);
                if (oldActive) {
                    oldActive.classList.remove('active');
                }
            }

            // 添加新的高亮
            if (activeIndex >= 0) {
                const newActive = container.querySelector(`[data-index="${activeIndex}"]`);
                if (newActive) {
                    newActive.classList.add('active');
                    // 平滑滚动到高亮行
                    newActive.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }

            lastActiveIndex = activeIndex;
        }
    });
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
    // NOTE: 只在目标容器内移除 active，避免影响其他容器的高亮状态
    const container = getElement(`#${containerId}`);
    if (!container) return;

    container.querySelectorAll('.song-item').forEach(item => item.classList.remove('active'));

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

/**
 * 更新播放器内单行歌词
 * @param lyrics 歌词行数组
 * @param currentTime 当前播放时间（秒）
 */
export function updateInlineLyrics(lyrics: LyricLine[], currentTime: number): void {
    if (!DOM.inlineLyricText) return;

    if (!lyrics.length) {
        DOM.inlineLyricText.textContent = '暂无歌词';
        DOM.inlineLyricText.classList.remove('has-lyric');
        return;
    }

    let activeText = '';
    for (let i = 0; i < lyrics.length; i++) {
        const nextLine = lyrics[i + 1];
        if (currentTime >= lyrics[i].time && (!nextLine || currentTime < nextLine.time)) {
            activeText = lyrics[i].text;
            break;
        }
    }

    if (activeText) {
        DOM.inlineLyricText.textContent = activeText;
        DOM.inlineLyricText.classList.add('has-lyric');
    } else {
        DOM.inlineLyricText.textContent = '暂无歌词';
        DOM.inlineLyricText.classList.remove('has-lyric');
    }
}

/**
 * 渲染歌手网格
 * @param artists 歌手列表
 * @param containerId 容器元素 ID
 * @param onClick 点击歌手回调
 * @param options 追加模式和加载更多选项
 */
export function displayArtistGrid(
    artists: ArtistInfo[],
    containerId: string,
    onClick: (artist: ArtistInfo) => void,
    options?: { append?: boolean; hasMore?: boolean; onLoadMore?: () => void }
): void {
    const container = getElement(`#${containerId}`);
    if (!container) return;

    const append = options?.append ?? false;

    if (!append) {
        container.innerHTML = '';
    } else {
        // 移除旧的"加载更多"按钮
        container.querySelector('.load-more-btn')?.remove();
    }

    if (artists.length === 0 && !append) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-microphone-alt"></i><div>暂无歌手数据</div></div>`;
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const artist of artists) {
        const card = document.createElement('div');
        card.className = 'artist-card';

        const avatarUrl = artist.picUrl
            ? ensureHttps(`${artist.picUrl}?param=120y120`)
            : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIzMiIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjEpIi8+PHRleHQgeD0iMzIiIHk9IjQwIiBmb250LXNpemU9IjI0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMykiPu+ZjjwvdGV4dD48L3N2Zz4=';

        card.innerHTML = `
            <img class="artist-avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(artist.name)}" loading="lazy">
            <div class="artist-name">${escapeHtml(artist.name)}</div>
        `;

        card.addEventListener('click', () => onClick(artist));
        fragment.appendChild(card);
    }

    // 如果还有更多数据，追加"加载更多"按钮
    if (options?.hasMore && options.onLoadMore) {
        const btn = document.createElement('button');
        btn.className = 'load-more-btn';
        btn.innerHTML = '<i class="fas fa-plus-circle"></i> 加载更多';
        btn.addEventListener('click', options.onLoadMore);
        fragment.appendChild(btn);
    }

    container.appendChild(fragment);
}

/**
 * 渲染电台列表
 * @param radios 电台列表
 * @param containerId 容器元素 ID
 * @param onClick 点击电台回调
 * @param options 追加模式和加载更多选项
 */
export function displayRadioList(
    radios: RadioStation[],
    containerId: string,
    onClick: (radio: RadioStation) => void,
    options?: { append?: boolean; hasMore?: boolean; onLoadMore?: () => void }
): void {
    const container = getElement(`#${containerId}`);
    if (!container) return;

    const append = options?.append ?? false;

    if (!append) {
        container.innerHTML = '';
    } else {
        container.querySelector('.load-more-btn')?.remove();
    }

    if (radios.length === 0 && !append) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-podcast"></i><div>暂无电台数据</div></div>`;
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const radio of radios) {
        const item = document.createElement('div');
        item.className = 'radio-item';

        const coverUrl = radio.picUrl
            ? ensureHttps(`${radio.picUrl}?param=100y100`)
            : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHZpZXdCb3g9IjAgMCA1MCA1MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHJ4PSI4IiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMSkiLz48dGV4dCB4PSIyNSIgeT0iMzIiIGZvbnQtc2l6ZT0iMjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4zKSI+8J+OmTwvdGV4dD48L3N2Zz4=';
        const djName = radio.dj?.nickname || '未知主播';
        const meta = radio.programCount ? `${radio.programCount} 期` : '';

        item.innerHTML = `
            <img class="radio-cover" src="${escapeHtml(coverUrl)}" alt="${escapeHtml(radio.name)}" loading="lazy">
            <div class="radio-info">
                <div class="radio-name">${escapeHtml(radio.name)}</div>
                <div class="radio-meta">${escapeHtml(djName)}${meta ? ' · ' + escapeHtml(meta) : ''}</div>
            </div>
        `;

        item.addEventListener('click', () => onClick(radio));
        fragment.appendChild(item);
    }

    // 如果还有更多数据，追加"加载更多"按钮
    if (options?.hasMore && options.onLoadMore) {
        const btn = document.createElement('button');
        btn.className = 'load-more-btn';
        btn.innerHTML = '<i class="fas fa-plus-circle"></i> 加载更多';
        btn.addEventListener('click', options.onLoadMore);
        fragment.appendChild(btn);
    }

    container.appendChild(fragment);
}

/**
 * 渲染电台节目列表为可播放的歌曲项
 * @param programs 电台节目列表
 * @param containerId 容器元素 ID
 * @param onPlay 点击播放回调
 */
export function displayRadioPrograms(programs: RadioProgram[], containerId: string, onPlay: (program: RadioProgram) => void): void {
    const container = getElement(`#${containerId}`);
    if (!container) return;

    container.innerHTML = '';

    if (programs.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-podcast"></i><div>暂无节目</div></div>`;
        return;
    }

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < programs.length; i++) {
        const program = programs[i];
        const songItem = document.createElement('div');
        songItem.className = 'song-item';

        const djName = program.dj?.nickname || '';
        const durationMin = Math.floor(program.duration / 60000);

        songItem.innerHTML = `
            <div class="song-index">${(i + 1).toString().padStart(2, '0')}</div>
            <div class="song-info">
                <div class="song-name">${escapeHtml(program.name)}</div>
                <div class="song-artist">${escapeHtml(djName)}${durationMin > 0 ? ' · ' + durationMin + '分钟' : ''}</div>
            </div>
        `;

        songItem.addEventListener('click', () => onPlay(program));
        fragment.appendChild(songItem);
    }

    container.appendChild(fragment);
}

/**
 * 渲染专辑网格
 * @param albums 专辑列表
 * @param containerId 容器元素 ID
 * @param onClick 点击专辑回调
 * @param options 追加模式和加载更多选项
 */
export function displayAlbumGrid(
    albums: AlbumInfo[],
    containerId: string,
    onClick: (album: AlbumInfo) => void,
    options?: { append?: boolean; hasMore?: boolean; onLoadMore?: () => void }
): void {
    const container = getElement(`#${containerId}`);
    if (!container) return;

    const append = options?.append ?? false;

    if (!append) {
        container.innerHTML = '';
    } else {
        container.querySelector('.load-more-btn')?.remove();
    }

    if (albums.length === 0 && !append) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-compact-disc"></i><div>暂无专辑数据</div></div>`;
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const album of albums) {
        const card = document.createElement('div');
        card.className = 'album-card';

        const coverUrl = album.picUrl
            ? ensureHttps(`${album.picUrl}?param=100y100`)
            : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSI4IiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMSkiLz48dGV4dCB4PSIzMiIgeT0iNDAiIGZvbnQtc2l6ZT0iMjQiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4zKSI+8J6OtTwvdGV4dD48L3N2Zz4=';
        const year = album.publishTime ? new Date(album.publishTime).getFullYear() : '';
        const sizePart = album.size ? `${album.size}首` : '';
        const metaParts = [year, sizePart].filter(Boolean).join(' · ');

        card.innerHTML = `
            <img class="album-cover" src="${escapeHtml(coverUrl)}" alt="${escapeHtml(album.name)}" loading="lazy">
            <div class="album-info">
                <div class="album-name">${escapeHtml(album.name)}</div>
                ${metaParts ? `<div class="album-year">${metaParts}</div>` : ''}
            </div>
        `;

        card.addEventListener('click', () => onClick(album));
        fragment.appendChild(card);
    }

    if (options?.hasMore && options.onLoadMore) {
        const btn = document.createElement('button');
        btn.className = 'load-more-btn';
        btn.innerHTML = '<i class="fas fa-plus-circle"></i> 加载更多';
        btn.addEventListener('click', options.onLoadMore);
        fragment.appendChild(btn);
    }

    container.appendChild(fragment);
}
