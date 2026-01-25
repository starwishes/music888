/**
 * 云音乐播放器 - 播放器核心模块
 * 负责音乐播放控制、歌单管理和收藏功能
 */
import * as api from './api';
import { Song } from './api';
import * as ui from './ui';
import { getElement, safeStorage } from './utils';

// --- Player State ---
let currentPlaylist: Song[] = [];
let currentIndex: number = -1;
let isPlaying: boolean = false;
let audioPlayer: HTMLAudioElement = new Audio();
let playMode: 'loop' | 'random' | 'single' = 'loop';
let playHistory: number[] = [];
let historyPosition: number = -1;
let lastActiveContainer: string = 'searchResults';
let currentLyrics: { time: number; text: string }[] = []; // NOTE: 存储当前歌词用于实时更新
let currentPlayRequestId = 0; // 防止播放请求竞态条件

// --- Playlist & Favorites State ---

/**
 * 歌单数据结构
 */
interface PlaylistData {
    name: string;
    songs: Song[];
    id: string;
    createTime: string;
    isFavorites?: boolean;
}

let playlistStorage = new Map<string, PlaylistData>();
let playlistCounter: number = 0;

export function getCurrentSong(): Song | null {
    return currentPlaylist[currentIndex] || null;
}

/**
 * 播放指定索引的歌曲
 */
export async function playSong(index: number, playlist: Song[], containerId: string, fromHistory: boolean = false): Promise<void> {
    const requestId = ++currentPlayRequestId; // 获取当前请求ID

    if (!playlist || index < 0 || index >= playlist.length) return;

    currentPlaylist = playlist;
    currentIndex = index;
    lastActiveContainer = containerId;
    const song = currentPlaylist[index];

    if (song.source === 'kuwo') {
        ui.showNotification('酷我音乐源暂不支持，跳到下一首', 'warning');
        setTimeout(() => { if (requestId === currentPlayRequestId) nextSong(); }, 500);
        return;
    }

    if (!fromHistory) {
        if (historyPosition < playHistory.length - 1) {
            playHistory = playHistory.slice(0, historyPosition + 1);
        }
        playHistory.push(index);
        historyPosition = playHistory.length - 1;
    }

    // 立即更新 UI (Improve UX)
    ui.updateActiveItem(currentIndex, containerId);
    ui.updateCurrentSongInfo(song, ''); // 暂时不显示封面
    updatePlayerFavoriteButton();

    // 异步获取封面
    api.getAlbumCoverUrl(song).then(coverUrl => {
        if (requestId === currentPlayRequestId) {
            ui.updateCurrentSongInfo(song, coverUrl);
        }
    }).catch(err => console.error('Cover load failed', err));

    try {
        ui.showNotification('正在加载音乐...', 'info');

        // 品质降级队列：按优先级尝试
        const qualitySelect = document.getElementById('qualitySelect') as HTMLSelectElement;
        const preferredQuality = qualitySelect ? qualitySelect.value : '128';
        const qualityFallback = ['999', '740', '320', '192', '128'];

        // 确保首选品质在队列首位
        const qualityQueue = [preferredQuality, ...qualityFallback.filter(q => q !== preferredQuality)];

        let urlData: { url: string; br: string } | null = null;
        let successQuality = '';

        // 依次尝试各个品质
        for (const quality of qualityQueue) {
            if (requestId !== currentPlayRequestId) return; // Check race condition

            try {
                const result = await api.getSongUrl(song, quality);
                if (requestId !== currentPlayRequestId) return; // Check again after await

                if (result && result.url) {
                    urlData = result;
                    successQuality = quality;
                    break;
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
                    '999': 'Hi-Res'
                };
                ui.showNotification(
                    `原品质不可用，已自动切换到 ${qualityNames[successQuality] || successQuality}`,
                    'warning'
                );
            }

            // NOTE: 对于外部 CDN 音频，通过代理转发以绕过 CORS 限制
            let audioUrl = urlData.url.replace(/^http:/, 'https:');

            // 检查是否是外部 CDN 域名（需要代理）
            const needsProxy = audioUrl.includes('music.126.net') ||
                audioUrl.includes('stream.qqmusic.qq.com') ||
                audioUrl.includes('kugou.com') ||
                audioUrl.includes('migu.cn');

            if (needsProxy) {
                // 使用 Vercel 代理转发音频请求
                audioUrl = `/api/proxy?url=${encodeURIComponent(audioUrl)}`;
                console.log('使用代理加载音频');
            }

            audioPlayer.src = audioUrl;
            audioPlayer.load();

            const lyricsData = await api.getLyrics(song);
            if (requestId !== currentPlayRequestId) return;

            const lyrics = lyricsData.lyric ? parseLyrics(lyricsData.lyric) : [];
            currentLyrics = lyrics; // NOTE: 存储歌词供 timeupdate 使用
            ui.updateLyrics(lyrics, 0);

            try {
                await audioPlayer.play();
                isPlaying = true;
                ui.updatePlayButton(true);
            } catch (error) {
                // Ignore AbortError if we switched song
                if (requestId !== currentPlayRequestId) return;

                console.error('Playback failed:', error);
                ui.showNotification('播放失败，请点击页面以允许自动播放', 'warning');
                isPlaying = false;
                ui.updatePlayButton(false);
            }
        } else {
            ui.showNotification(`无法获取音乐链接 (${song.name})，将尝试下一首`, 'error');
            console.error('所有品质尝试均失败:', song);
            setTimeout(() => { if (requestId === currentPlayRequestId) nextSong(); }, 1500);
        }
    } catch (error) {
        if (requestId !== currentPlayRequestId) return;

        console.error('Error playing song:', error);
        ui.showNotification('播放失败，将尝试下一首', 'error');
        setTimeout(() => { if (requestId === currentPlayRequestId) nextSong(); }, 1500);
    }
}

export function nextSong(): void {
    if (currentPlaylist.length === 0) return;
    let newIndex: number;
    if (playMode === 'random') {
        newIndex = Math.floor(Math.random() * currentPlaylist.length);
    } else {
        newIndex = (currentIndex + 1) % currentPlaylist.length;
    }
    playSong(newIndex, currentPlaylist, lastActiveContainer);
}

export function previousSong(): void {
    if (playHistory.length > 1 && historyPosition > 0) {
        historyPosition--;
        playSong(playHistory[historyPosition], currentPlaylist, lastActiveContainer, true);
    } else {
        if (currentPlaylist.length === 0) return;
        const newIndex = (currentIndex - 1 + currentPlaylist.length) % currentPlaylist.length;
        playSong(newIndex, currentPlaylist, lastActiveContainer);
    }
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
    audioPlayer.volume = parseInt(value, 10) / 100;
}

export function seekTo(event: MouseEvent): void {
    if (!audioPlayer.duration) return;
    const progressBar = event.currentTarget as HTMLElement;
    const clickPosition = (event.clientX - progressBar.getBoundingClientRect().left) / progressBar.offsetWidth;
    audioPlayer.currentTime = clickPosition * audioPlayer.duration;
}

export function togglePlayMode(): void {
    const modes: ('loop' | 'random' | 'single')[] = ['loop', 'random', 'single'];
    const modeIcons = { 'loop': 'fas fa-repeat', 'random': 'fas fa-random', 'single': 'fas fa-redo' };
    const modeTitles = { 'loop': '列表循环', 'random': '随机播放', 'single': '单曲循环' };

    const currentModeIndex = modes.indexOf(playMode);
    playMode = modes[(currentModeIndex + 1) % modes.length];

    const btn = document.getElementById('playModeBtn')!;
    btn.querySelector('i')!.className = modeIcons[playMode];
    btn.title = modeTitles[playMode];
    ui.showNotification(`切换到${modeTitles[playMode]}`, 'info');
}

export function downloadSongByData(song: Song | null): void {
    if (!song) return;
    ui.showNotification(`开始下载: ${song.name}`, 'info');
    api.getSongUrl(song, '999').then(urlData => {
        if (urlData && urlData.url) {
            fetch(urlData.url)
                .then(res => res.blob())
                .then(blob => {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${song.name} - ${Array.isArray(song.artist) ? song.artist.join(',') : song.artist}.mp3`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(a.href);
                    ui.showNotification(`下载完成: ${song.name}`, 'success');
                });
        }
    });
}

export function downloadLyricByData(song: Song | null): void {
    if (!song) return;
    ui.showNotification(`开始下载歌词: ${song.name}`, 'info');
    api.getLyrics(song).then(lyricData => {
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
        }
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
    } catch (error) {
        console.error('加载我的歌单失败:', error);
    }
}

function initializeFavoritesPlaylist(): void {
    if (!getFavoritesPlaylistKey()) {
        playlistCounter++;
        const newKey = `playlist_${playlistCounter}`;
        playlistStorage.set(newKey, {
            name: "我的喜欢",
            songs: [],
            id: "favorites",
            createTime: new Date().toISOString(),
            isFavorites: true
        });
        savePlaylistsToStorage();
    }
}

function getFavoritesPlaylistKey(): string | null {
    for (let [key, playlist] of playlistStorage.entries()) {
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

    const songIndex = favorites.songs.findIndex((favSong: Song) => favSong.id === song.id && favSong.source === song.source);

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
 * 获取播放历史
 */
export function getPlayHistory(): Song[] {
    return [...playHistory].reverse().map(index => currentPlaylist[index]).filter(Boolean);
}

/**
 * 清空播放历史
 */
export function clearPlayHistory(): void {
    playHistory = [];
    historyPosition = -1;
}

function savePlaylistsToStorage(): void {
    try {
        const data = {
            playlists: Array.from(playlistStorage.entries()),
            counter: playlistCounter
        };
        localStorage.setItem('musicPlayerPlaylists', JSON.stringify(data));
    } catch (error) {
        console.error('保存歌单失败:', error);
    }
}

// NOTE: 监听音频加载错误，提供详细诊断信息
audioPlayer.addEventListener('error', (e) => {
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
        playSong(currentIndex, currentPlaylist, lastActiveContainer);
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
    }
});

interface LyricLine {
    time: number;
    text: string;
}

/**
 * 解析 LRC 格式歌词
 * @param lrc LRC 格式歌词字符串
 * @returns 解析后的歌词行数组
 */
function parseLyrics(lrc: string): LyricLine[] {
    const lines = lrc.split('\n');
    const result: LyricLine[] = [];
    // NOTE: 支持 2 位和 3 位毫秒格式
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
        const match = line.match(timeRegex);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const msStr = match[3];

            // NOTE: 处理精度问题 - 2 位毫秒需要乘以 10
            const ms = msStr.length === 2
                ? parseInt(msStr, 10) * 10
                : parseInt(msStr, 10);

            const time = minutes * 60 + seconds + ms / 1000;
            const text = line.replace(timeRegex, '').trim();

            if (text) {
                result.push({ time, text });
            }
        }
    }

    return result;
}
