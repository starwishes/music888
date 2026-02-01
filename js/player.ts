/**
 * 云音乐播放器 - 播放器核心模块
 * 负责音乐播放控制、歌单管理和收藏功能
 */
import * as api from './api';
import { Song, PlaylistData, LyricLine, PlayMode, MusicError } from './types';
import { needsProxy, logger, APP_CONFIG, PREVIEW_DETECTION } from './config';
import * as ui from './ui';

// --- Player State ---
let currentPlaylist: Song[] = [];
let currentIndex: number = -1;
let isPlaying: boolean = false;
// NOTE: 使用 DOM 中的 audio 元素，而非创建新的 Audio 对象
// 延迟初始化，在 DOMContentLoaded 后获取
let audioPlayer: HTMLAudioElement;
let playMode: PlayMode = 'loop';
let playHistory: number[] = [];
let historyPosition: number = -1;
let lastActiveContainer: string = 'searchResults';
let currentLyrics: LyricLine[] = []; // NOTE: 存储当前歌词用于实时更新
let currentPlayRequestId = 0; // 防止播放请求竞态条件
let playHistorySongs: Song[] = []; // NOTE: 存储播放历史歌曲对象，避免索引失效
let savedVolume: number = loadSavedVolume(); // 从 localStorage 恢复音量
let isFading: boolean = false; // NOTE: 防止淡入淡出重入
let isSeekingFullVersion: boolean = false; // NOTE: 防止重复触发跨源搜索
let fullVersionSearchCount = 0; // NOTE: 记录当前歌曲的跨源搜索次数，防止无限循环

// --- Volume Persistence ---

/**
 * 从 localStorage 加载保存的音量
 */
function loadSavedVolume(): number {
    try {
        const saved = localStorage.getItem('musicPlayerVolume');
        if (saved !== null) {
            const vol = parseFloat(saved);
            if (isFinite(vol) && vol >= 0 && vol <= 1) return vol;
        }
    } catch { /* ignore */ }
    return 0.8;
}

/**
 * 保存音量到 localStorage
 */
function persistVolume(volume: number): void {
    try {
        localStorage.setItem('musicPlayerVolume', String(volume));
    } catch { /* ignore */ }
}

// --- Playlist & Favorites State ---

let playlistStorage = new Map<string, PlaylistData>();
let playlistCounter: number = 0;

/**
 * 初始化播放器
 * NOTE: 必须在 DOM 加载完成后调用
 */
export function initPlayer(): void {
    const domAudio = document.getElementById('audioPlayer') as HTMLAudioElement;
    if (domAudio) {
        audioPlayer = domAudio;
    } else {
        audioPlayer = new Audio();
    }

    // 恢复音量
    audioPlayer.volume = savedVolume;
    const volumeSlider = document.getElementById('volumeSlider') as HTMLInputElement;
    if (volumeSlider) {
        volumeSlider.value = String(Math.round(savedVolume * 100));
    }

    // 绑定音频事件
    bindAudioEvents();
}

/**
 * 更新 Media Session 元数据
 * NOTE: 用于系统级媒体控制（锁屏、媒体键等）
 */
function updateMediaSession(song: Song, coverUrl: string): void {
    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: song.name,
                artist: song.artist.join(' / '),
                album: song.album || '未知专辑',
                artwork: coverUrl ? [
                    { src: coverUrl, sizes: '300x300', type: 'image/jpeg' }
                ] : []
            });

            // 注册播放控制回调
            navigator.mediaSession.setActionHandler('play', () => {
                audioPlayer.play();
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                audioPlayer.pause();
            });
            navigator.mediaSession.setActionHandler('previoustrack', () => {
                previousSong();
            });
            navigator.mediaSession.setActionHandler('nexttrack', () => {
                nextSong();
            });
            navigator.mediaSession.setActionHandler('seekto', (details) => {
                if (details.seekTime !== undefined && audioPlayer.duration) {
                    audioPlayer.currentTime = details.seekTime;
                }
            });

            logger.debug('Media Session 已更新:', song.name);
        } catch (e) {
            logger.warn('Media Session 更新失败:', e);
        }
    }
}

/**
 * 音频淡出效果
 * NOTE: 切歌时平滑过渡，提升用户体验
 */
async function fadeOut(): Promise<void> {
    if (!audioPlayer || !audioPlayer.src || audioPlayer.paused) return;

    // NOTE: 如果正在淡入淡出，强制停止
    if (isFading) {
        audioPlayer.pause();
        audioPlayer.volume = 0;
        isFading = false;
        return;
    }

    isFading = true;
    // NOTE: 只在音量正常时保存，避免保存中间状态
    if (audioPlayer.volume > 0.1) {
        savedVolume = audioPlayer.volume;
    }
    const stepTime = APP_CONFIG.FADE_DURATION / APP_CONFIG.FADE_STEPS;
    const volumeStep = savedVolume / APP_CONFIG.FADE_STEPS;

    for (let i = APP_CONFIG.FADE_STEPS; i >= 0; i--) {
        audioPlayer.volume = Math.max(0, volumeStep * i);
        await new Promise(r => setTimeout(r, stepTime));
    }
    audioPlayer.pause();
    isFading = false;
}

/**
 * 音频淡入效果
 * NOTE: 新歌曲开始时平滑过渡
 */
async function fadeIn(): Promise<void> {
    if (isFading) return;

    isFading = true;
    const targetVolume = savedVolume > 0 ? savedVolume : 0.8;
    audioPlayer.volume = 0;

    const stepTime = APP_CONFIG.FADE_DURATION / APP_CONFIG.FADE_STEPS;
    const volumeStep = targetVolume / APP_CONFIG.FADE_STEPS;

    for (let i = 0; i <= APP_CONFIG.FADE_STEPS; i++) {
        audioPlayer.volume = Math.min(targetVolume, volumeStep * i);
        await new Promise(r => setTimeout(r, stepTime));
    }
    isFading = false;
}

export function getCurrentSong(): Song | null {
    if (currentIndex < 0 || currentIndex >= currentPlaylist.length) {
        return null;
    }
    return currentPlaylist[currentIndex];
}

/**
 * 播放指定索引的歌曲
 */
export async function playSong(
    index: number,
    playlist: Song[],
    containerId: string,
    fromHistory: boolean = false
): Promise<void> {
    const requestId = ++currentPlayRequestId; // 获取当前请求ID

    if (!playlist || index < 0 || index >= playlist.length) return;

    // NOTE: 切歌时淡出当前音频
    await fadeOut();

    currentPlaylist = playlist;
    currentIndex = index;
    lastActiveContainer = containerId;
    const song = currentPlaylist[index];

    // NOTE: 重置跨源搜索状态
    isSeekingFullVersion = false;
    fullVersionSearchCount = 0;

    if (song.source === 'kuwo') {
        // NOTE: 酷我音乐源在 GDStudio API 中是稳定的，不再跳过
        console.log('使用酷我音乐源播放:', song.name);
    }

    if (!fromHistory) {
        if (historyPosition < playHistory.length - 1) {
            playHistory = playHistory.slice(0, historyPosition + 1);
            playHistorySongs = playHistorySongs.slice(0, historyPosition + 1);
        }
        // NOTE: 去重 - 如果最近一首是同一首歌，不重复添加
        const lastSong = playHistorySongs[playHistorySongs.length - 1];
        if (!lastSong || lastSong.id !== song.id || lastSong.source !== song.source) {
            playHistory.push(index);
            playHistorySongs.push(song);
        }
        historyPosition = playHistory.length - 1;
        // NOTE: 持久化播放历史
        savePlayHistoryToStorage();
    }

    // 立即更新 UI (Improve UX)
    ui.updateActiveItem(currentIndex, containerId);
    ui.updateCurrentSongInfo(song, ''); // 暂时不显示封面
    updatePlayerFavoriteButton();

    // 异步获取封面并更新 Media Session
    api.getAlbumCoverUrl(song)
        .then(coverUrl => {
            if (requestId === currentPlayRequestId) {
                ui.updateCurrentSongInfo(song, coverUrl);
                // NOTE: 更新 Media Session（系统级媒体控制）
                updateMediaSession(song, coverUrl);
            }
        })
        .catch(err => console.error('Cover load failed', err));

    try {
        ui.showNotification('正在加载音乐...', 'info');

        const qualitySelect = document.getElementById('qualitySelect') as HTMLSelectElement;
        const preferredQuality = qualitySelect ? qualitySelect.value : '128';

        // NOTE: 完整版优先策略 - 先用低音质确保获取完整版，再尝试高音质
        // 从低到高尝试，更容易获取完整版
        const qualityQueue = ['128', '192', '320', '740', '999'];

        let urlData: { url: string; br: string } | null = null;
        let successQuality = '';

        // 依次尝试各个品质（从低到高）
        for (const quality of qualityQueue) {
            if (requestId !== currentPlayRequestId) return;

            try {
                const result = await api.getSongUrl(song, quality);
                if (requestId !== currentPlayRequestId) return;

                if (result && result.url) {
                    urlData = result;
                    successQuality = quality;
                    // 如果获取到完整版且达到用户期望音质，直接使用
                    if (parseInt(quality) >= parseInt(preferredQuality)) {
                        break;
                    }
                    // 否则继续尝试更高音质
                }
            } catch (err) {
                console.warn(`获取品质 ${quality} 失败:`, err);
                continue;
            }
        }

        if (requestId !== currentPlayRequestId) return;

        if (urlData && urlData.url) {
            // 提示品质降级信息
            if (successQuality !== preferredQuality) {
                const qualityNames: { [key: string]: string } = {
                    '128': '标准 128K',
                    '192': '较高 192K',
                    '320': '高品质 320K',
                    '740': '无损 FLAC',
                    '999': 'Hi-Res',
                };
                ui.showNotification(
                    `原品质不可用，已自动切换到 ${qualityNames[successQuality] || successQuality}`,
                    'warning'
                );
            }

            // NOTE: 对于外部 CDN 音频，通过代理转发以绕过 CORS 限制
            let audioUrl = urlData.url.replace(/^http:/, 'https:');

            // NOTE: 使用配置模块的 needsProxy 函数统一检查
            if (needsProxy(audioUrl)) {
                // 使用 Vercel 代理转发音频请求
                audioUrl = `/api/proxy?url=${encodeURIComponent(audioUrl)}`;
                logger.debug('使用代理加载音频');
            }

            audioPlayer.src = audioUrl;
            audioPlayer.load();

            // NOTE: 获取歌词（包含翻译歌词）
            const lyricsData = await api.getLyrics(song);
            if (requestId !== currentPlayRequestId) return;

            // NOTE: 解析双语歌词
            const lyrics = lyricsData.lyric ? parseLyrics(lyricsData.lyric, lyricsData.tlyric) : [];
            currentLyrics = lyrics; // NOTE: 存储歌词供 timeupdate 使用
            ui.updateLyrics(lyrics, 0);

            try {
                await audioPlayer.play();
                // NOTE: 淡入效果（await 防止状态不一致）
                await fadeIn();
                isPlaying = true;
                ui.updatePlayButton(true);
            } catch (error: unknown) {
                // Ignore AbortError if we switched song
                if (requestId !== currentPlayRequestId) return;

                const errorMessage = error instanceof Error ? error.message : String(error);
                const errorName = error instanceof Error ? error.name : '';

                // 区分不同类型的播放错误
                const isCopyrightIssue =
                    error instanceof DOMException ||
                    errorMessage.includes('DOMException') ||
                    errorMessage.includes('NotAllowedError') ||
                    errorName === 'NotAllowedError';

                if (isCopyrightIssue) {
                    console.warn('版权限制或自动播放阻止:', error);
                    ui.showNotification('部分歌曲因版权限制无法播放，尝试播放下一首', 'warning');
                } else {
                    console.error('播放失败:', error);
                    ui.showNotification('播放失败，请手动播放或尝试其他歌曲', 'warning');
                }
                isPlaying = false;
                ui.updatePlayButton(false);
            }
        } else {
            ui.showNotification(`无法获取音乐链接 (${song.name})，可能因版权限制`, 'info');
            console.warn('所有品质尝试均失败，可能是版权限制:', song.name);
            // NOTE: 连续版权问题时不立即切歌，给用户选择
            setTimeout(() => {
                if (requestId === currentPlayRequestId) nextSong();
            }, 2000);
        }
    } catch (error) {
        if (requestId !== currentPlayRequestId) return;

        // 使用 MusicError 提供更友好的错误信息
        let userMessage = '播放失败，将尝试下一首';
        if (error instanceof MusicError) {
            userMessage = error.userMessage;
            console.error(`[${error.type}] ${error.message}`);
        } else {
            console.error('Error playing song:', error);
        }

        ui.showNotification(userMessage, 'error');
        setTimeout(() => {
            if (requestId === currentPlayRequestId) nextSong();
        }, 1500);
    }
}

export function nextSong(): void {
    if (currentPlaylist.length === 0) return;
    let newIndex: number;
    if (playMode === 'random') {
        if (currentPlaylist.length === 1) {
            newIndex = 0;
        } else {
            // NOTE: 确保不会随机到当前同一首歌
            do {
                newIndex = Math.floor(Math.random() * currentPlaylist.length);
            } while (newIndex === currentIndex);
        }
    } else {
        newIndex = (currentIndex + 1) % currentPlaylist.length;
    }
    playSong(newIndex, currentPlaylist, lastActiveContainer);
}

export function previousSong(): void {
    if (playHistorySongs.length > 1 && historyPosition > 0) {
        historyPosition--;
        // NOTE: 使用存储的歌曲对象，避免索引失效问题
        const historySong = playHistorySongs[historyPosition];
        if (historySong) {
            // 在当前播放列表中查找该歌曲
            const indexInPlaylist = currentPlaylist.findIndex(
                s => s.id === historySong.id && s.source === historySong.source
            );
            if (indexInPlaylist >= 0) {
                playSong(indexInPlaylist, currentPlaylist, lastActiveContainer, true);
            } else {
                // 如果歌曲不在当前列表中，创建临时列表播放
                playSong(0, [historySong], lastActiveContainer, true);
            }
            return;
        }
    }
    // 回退到常规上一首逻辑
    if (currentPlaylist.length === 0) return;
    const newIndex = (currentIndex - 1 + currentPlaylist.length) % currentPlaylist.length;
    playSong(newIndex, currentPlaylist, lastActiveContainer);
}

export function togglePlay(): void {
    if (!audioPlayer.src) return;
    if (isPlaying) {
        audioPlayer.pause();
    } else {
        audioPlayer.play();
    }
}

export function setVolume(value: string): void {
    const volume = parseInt(value, 10) / 100;
    audioPlayer.volume = volume;
    savedVolume = volume;
    persistVolume(volume); // NOTE: 持久化音量设置
}

export function seekTo(event: MouseEvent): void {
    // NOTE: 检查 duration 是否有效（NaN 或 0 都无效）
    if (!audioPlayer.duration || !isFinite(audioPlayer.duration)) return;
    const progressBar = event.currentTarget as HTMLElement;
    const clickPosition = (event.clientX - progressBar.getBoundingClientRect().left) / progressBar.offsetWidth;
    audioPlayer.currentTime = clickPosition * audioPlayer.duration;
}

export function togglePlayMode(): void {
    const modes: ('loop' | 'random' | 'single')[] = ['loop', 'random', 'single'];
    const modeIcons = { loop: 'fas fa-repeat', random: 'fas fa-random', single: 'fas fa-redo' };
    const modeTitles = { loop: '列表循环', random: '随机播放', single: '单曲循环' };

    const currentModeIndex = modes.indexOf(playMode);
    playMode = modes[(currentModeIndex + 1) % modes.length];

    const btn = document.getElementById('playModeBtn');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = modeIcons[playMode];
        }
        btn.title = modeTitles[playMode];
    }
    ui.showNotification(`切换到${modeTitles[playMode]}`, 'info');
}

export function downloadSongByData(song: Song | null): void {
    if (!song) return;
    ui.showNotification(`开始下载: ${song.name}`, 'info');
    api.getSongUrl(song, '999')
        .then(urlData => {
            if (urlData && urlData.url) {
                // NOTE: 使用代理服务绕过 CORS 限制
                let downloadUrl = urlData.url.replace(/^http:/, 'https:');

                // NOTE: 使用配置模块的 needsProxy 函数统一检查
                if (needsProxy(downloadUrl)) {
                    downloadUrl = `/api/proxy?url=${encodeURIComponent(downloadUrl)}`;
                }

                fetch(downloadUrl)
                    .then(res => {
                        if (!res.ok) {
                            throw new Error(`下载失败: ${res.status}`);
                        }
                        return res.blob();
                    })
                    .then(blob => {
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `${song.name} - ${Array.isArray(song.artist) ? song.artist.join(',') : song.artist}.mp3`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(a.href);
                        ui.showNotification(`下载完成: ${song.name}`, 'success');
                    })
                    .catch(err => {
                        console.error('下载失败:', err);
                        ui.showNotification(`下载失败: ${err.message}`, 'error');
                    });
            } else {
                ui.showNotification('无法获取下载链接', 'error');
            }
        })
        .catch(err => {
            console.error('获取下载链接失败:', err);
            ui.showNotification('获取下载链接失败', 'error');
        });
}

export function downloadLyricByData(song: Song | null): void {
    if (!song) return;
    ui.showNotification(`开始下载歌词: ${song.name}`, 'info');
    api.getLyrics(song)
        .then(lyricData => {
            if (lyricData && lyricData.lyric) {
                const blob = new Blob([lyricData.lyric], { type: 'text/plain;charset=utf-8' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${song.name} - ${Array.isArray(song.artist) ? song.artist.join(',') : song.artist}.lrc`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
                ui.showNotification(`歌词下载完成: ${song.name}`, 'success');
            } else {
                ui.showNotification('暂无歌词可下载', 'warning');
            }
        })
        .catch(err => {
            console.error('获取歌词失败:', err);
            ui.showNotification('获取歌词失败', 'error');
        });
}

export function loadSavedPlaylists(): void {
    try {
        const saved = localStorage.getItem('musicPlayerPlaylists');
        if (saved) {
            const data = JSON.parse(saved);
            playlistStorage = new Map(data.playlists || []);
            playlistCounter = data.counter || 0;
        }
        initializeFavoritesPlaylist();
        // NOTE: 同时加载播放历史
        loadPlayHistoryFromStorage();
    } catch (error) {
        logger.error('加载我的歌单失败:', error);
    }
}

function initializeFavoritesPlaylist(): void {
    if (!getFavoritesPlaylistKey()) {
        playlistCounter++;
        const newKey = `playlist_${playlistCounter}`;
        playlistStorage.set(newKey, {
            name: '我的喜欢',
            songs: [],
            id: 'favorites',
            createTime: new Date().toISOString(),
            isFavorites: true,
        });
        savePlaylistsToStorage();
    }
}

function getFavoritesPlaylistKey(): string | null {
    for (const [key, playlist] of playlistStorage.entries()) {
        if (playlist.isFavorites) return key;
    }
    return null;
}

export function isSongInFavorites(song: Song): boolean {
    const key = getFavoritesPlaylistKey();
    if (!key) return false;
    const favorites = playlistStorage.get(key);
    if (!favorites) return false;
    return favorites.songs.some((favSong: Song) => favSong.id === song.id && favSong.source === song.source);
}

export function toggleFavoriteButton(song: Song): void {
    const key = getFavoritesPlaylistKey();
    if (!key) return;

    const favorites = playlistStorage.get(key);
    if (!favorites) return;

    const songIndex = favorites.songs.findIndex(
        (favSong: Song) => favSong.id === song.id && favSong.source === song.source
    );

    if (songIndex > -1) {
        favorites.songs.splice(songIndex, 1);
        ui.showNotification(`已从"我的喜欢"中移除`, 'success');
    } else {
        favorites.songs.unshift(song);
        ui.showNotification(`已添加到"我的喜欢"`, 'success');
    }

    savePlaylistsToStorage();
    updatePlayerFavoriteButton();
}

function updatePlayerFavoriteButton(): void {
    const song = getCurrentSong();
    const btn = document.getElementById('playerFavoriteBtn');
    if (!song || !btn) return;

    const icon = btn.querySelector('i');
    if (!icon) return;

    if (isSongInFavorites(song)) {
        icon.className = 'fas fa-heart';
        (icon as HTMLElement).style.color = '#ff6b6b';
    } else {
        icon.className = 'far fa-heart';
        (icon as HTMLElement).style.color = '';
    }
}

/**
 * 获取收藏列表
 */
export function getFavorites(): Song[] {
    const key = getFavoritesPlaylistKey();
    if (!key) return [];
    const favorites = playlistStorage.get(key);
    return favorites?.songs || [];
}

/**
 * 获取所有已保存的歌单（不包括"我的喜欢"）
 */
export function getSavedPlaylists(): Map<string, PlaylistData> {
    const result = new Map<string, PlaylistData>();
    for (const [key, playlist] of playlistStorage.entries()) {
        if (!playlist.isFavorites) {
            result.set(key, playlist);
        }
    }
    return result;
}

/**
 * 清空所有已保存的歌单（保留"我的喜欢"）
 */
export function clearAllSavedPlaylists(): void {
    const keysToRemove: string[] = [];
    for (const [key, playlist] of playlistStorage.entries()) {
        if (!playlist.isFavorites) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => playlistStorage.delete(key));
    savePlaylistsToStorage();
}

/**
 * 获取播放历史
 * NOTE: 返回实际存储的歌曲对象，避免索引失效问题
 */
export function getPlayHistory(): Song[] {
    return [...playHistorySongs].reverse();
}

/**
 * 清空播放历史
 */
export function clearPlayHistory(): void {
    playHistory = [];
    playHistorySongs = [];
    historyPosition = -1;
    // NOTE: 同步清空持久化存储
    savePlayHistoryToStorage();
}

/**
 * 保存播放历史到 localStorage
 * NOTE: 只保存最近 MAX_HISTORY_SIZE 条记录，避免存储过大
 */
function savePlayHistoryToStorage(): void {
    try {
        const historyToSave = playHistorySongs.slice(-APP_CONFIG.MAX_HISTORY_SIZE);
        localStorage.setItem('musicPlayerHistory', JSON.stringify(historyToSave));
    } catch (error) {
        logger.error('保存播放历史失败:', error);
    }
}

/**
 * 从 localStorage 加载播放历史
 */
function loadPlayHistoryFromStorage(): void {
    try {
        const saved = localStorage.getItem('musicPlayerHistory');
        if (saved) {
            playHistorySongs = JSON.parse(saved);
            playHistory = playHistorySongs.map((_, i) => i);
            historyPosition = playHistorySongs.length - 1;
        }
    } catch (error) {
        logger.error('加载播放历史失败:', error);
    }
}

function savePlaylistsToStorage(): void {
    try {
        const data = {
            playlists: Array.from(playlistStorage.entries()),
            counter: playlistCounter,
        };
        localStorage.setItem('musicPlayerPlaylists', JSON.stringify(data));
    } catch (error) {
        logger.error('保存歌单失败:', error);
        // NOTE: 通知用户存储失败
        ui.showNotification('存储空间不足，部分数据可能无法保存', 'warning');
    }
}

// NOTE: 音频事件监听器抽取为函数，在 initPlayer 中调用
function bindAudioEvents(): void {

// NOTE: 监听音频加载错误，提供详细诊断信息
audioPlayer.addEventListener('error', _e => {
    const error = audioPlayer.error;
    let errorMsg = '未知错误';
    if (error) {
        switch (error.code) {
            case MediaError.MEDIA_ERR_ABORTED:
                errorMsg = '播放被中断';
                break;
            case MediaError.MEDIA_ERR_NETWORK:
                errorMsg = '网络错误导致加载失败';
                break;
            case MediaError.MEDIA_ERR_DECODE:
                errorMsg = '音频解码失败';
                break;
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                errorMsg = '音频格式不支持或URL无效';
                break;
        }
    }
    console.error('Audio Error:', errorMsg, 'URL:', audioPlayer.src);
    ui.showNotification(`播放错误: ${errorMsg}`, 'error');
});

audioPlayer.addEventListener('play', () => {
    isPlaying = true;
    ui.updatePlayButton(true);
    document.getElementById('currentCover')?.classList.add('playing');
});

audioPlayer.addEventListener('pause', () => {
    isPlaying = false;
    ui.updatePlayButton(false);
    document.getElementById('currentCover')?.classList.remove('playing');
});

audioPlayer.addEventListener('ended', () => {
    if (playMode === 'single') {
        // NOTE: 单曲循环直接重置播放位置，无需重新加载资源
        audioPlayer.currentTime = 0;
        audioPlayer.play().catch(err => {
            console.warn('单曲循环播放失败:', err);
        });
    } else {
        nextSong();
    }
});

audioPlayer.addEventListener('timeupdate', () => {
    if (audioPlayer.duration) {
        ui.updateProgress(audioPlayer.currentTime, audioPlayer.duration);
        // NOTE: 实时更新歌词高亮和跟随
        if (currentLyrics.length > 0) {
            ui.updateLyrics(currentLyrics, audioPlayer.currentTime);
        }
    }
});

audioPlayer.addEventListener('loadedmetadata', () => {
    if (audioPlayer.duration) {
        ui.updateProgress(audioPlayer.currentTime, audioPlayer.duration);

        // NOTE: 多维度试听检测
        const duration = audioPlayer.duration;
        const song = getCurrentSong();

        // 检查是否在试听时长区间
        const isInPreviewRange = duration >= PREVIEW_DETECTION.MIN_DURATION &&
                                  duration <= PREVIEW_DETECTION.MAX_DURATION;

        // 检查是否接近典型试听时长（30秒/60秒）
        const isNearTypicalDuration = PREVIEW_DETECTION.TYPICAL_DURATIONS.some(
            typical => Math.abs(duration - typical) <= PREVIEW_DETECTION.DURATION_TOLERANCE
        );

        // 综合判断：在区间内且接近典型时长
        const isProbablyPreview = isInPreviewRange && isNearTypicalDuration;

        if (isProbablyPreview && song && !isSeekingFullVersion && fullVersionSearchCount < 2) {
            logger.debug(`检测到可能的短版本 (${Math.round(duration)}秒): ${song.name}`);

            // 标记正在搜索，防止重入
            isSeekingFullVersion = true;
            fullVersionSearchCount++;

            const quality = (document.getElementById('qualitySelect') as HTMLSelectElement)?.value || '320';
            const currentRequestId = currentPlayRequestId; // 保存当前请求ID

            api.tryGetFullVersionFromOtherSources(song, quality).then(result => {
                // 检查是否还是同一首歌（防止用户已切歌）
                if (currentRequestId !== currentPlayRequestId) {
                    logger.debug('用户已切歌，放弃切换完整版');
                    return;
                }

                if (result && result.url) {
                    logger.info('从其他源找到完整版本，自动切换');

                    // 保存当前播放状态
                    const wasPlaying = !audioPlayer.paused;
                    const currentTime = audioPlayer.currentTime;
                    const currentVolume = audioPlayer.volume;

                    // 处理代理 URL
                    let newUrl = result.url.replace(/^http:/, 'https:');
                    if (needsProxy(newUrl)) {
                        newUrl = `/api/proxy?url=${encodeURIComponent(newUrl)}`;
                    }

                    // 无缝切换：淡出 → 换源 → 淡入
                    fadeOut().then(() => {
                        audioPlayer.src = newUrl;
                        audioPlayer.load();

                        audioPlayer.addEventListener('canplay', function onCanPlay() {
                            audioPlayer.removeEventListener('canplay', onCanPlay);
                            // 从相近位置继续（最多 10 秒，避免超出新音频时长）
                            audioPlayer.currentTime = Math.min(currentTime, 10);
                            audioPlayer.volume = 0;

                            if (wasPlaying) {
                                audioPlayer.play().then(() => {
                                    fadeIn();
                                }).catch(e => {
                                    logger.warn('切换完整版播放失败:', e);
                                    audioPlayer.volume = currentVolume;
                                });
                            } else {
                                audioPlayer.volume = currentVolume;
                            }
                        }, { once: true });
                    });
                } else {
                    logger.debug(`未找到更长版本 (${Math.round(duration)}秒)`);
                }
            }).catch(e => {
                logger.debug('跨源搜索失败:', e);
            }).finally(() => {
                isSeekingFullVersion = false;
            });
        }
    }
});

} // end bindAudioEvents

/**
 * 解析 LRC 格式歌词
 * @param lrc LRC 格式歌词字符串
 * @param tlyric 翻译歌词字符串（可选）
 * @returns 解析后的歌词行数组（包含翻译）
 */
function parseLyrics(lrc: string, tlyric?: string): LyricLine[] {
    // NOTE: 优化正则表达式性能 - 使用非捕获组和更精确的匹配
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

    /**
     * 解析单行歌词
     */
    function parseLine(line: string): { time: number; text: string }[] {
        const results: { time: number; text: string }[] = [];

        // 提取所有时间戳
        const timeMatches = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/g);
        if (!timeMatches) return results;

        // 获取歌词文本（移除所有时间戳后的内容）
        const text = line.replace(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/g, '').trim();
        if (!text) return results;

        // 解析每个时间戳
        let match;
        timeRegex.lastIndex = 0; // 重置正则表达式状态
        while ((match = timeRegex.exec(line)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const msStr = match[3];

            // NOTE: 处理精度问题 - 2 位毫秒需要乘以 10
            const ms = msStr.length === 2 ? parseInt(msStr, 10) * 10 : parseInt(msStr, 10);

            const time = minutes * 60 + seconds + ms / 1000;
            results.push({ time, text });
        }

        return results;
    }

    // 解析原歌词
    const lines = lrc.split('\n');
    const result: LyricLine[] = [];

    for (const line of lines) {
        const parsed = parseLine(line);
        for (const item of parsed) {
            result.push({ time: item.time, text: item.text });
        }
    }

    // 如果有翻译歌词，解析并合并
    if (tlyric) {
        const tlines = tlyric.split('\n');
        const translationMap = new Map<number, string>();

        for (const line of tlines) {
            const parsed = parseLine(line);
            for (const item of parsed) {
                // 使用时间戳（取整到0.1秒）作为键
                const timeKey = Math.round(item.time * 10);
                translationMap.set(timeKey, item.text);
            }
        }

        // 将翻译合并到原歌词
        for (const lyric of result) {
            const timeKey = Math.round(lyric.time * 10);
            const translation = translationMap.get(timeKey);
            if (translation) {
                lyric.ttext = translation;
            }
        }
    }

    // 按时间排序
    result.sort((a, b) => a.time - b.time);
    return result;
}
