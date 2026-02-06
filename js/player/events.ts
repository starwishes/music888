/**
 * 云音乐播放器 - 事件与媒体会话模块
 * 负责音频事件监听和系统级媒体控制对接
 */

import * as ui from '../ui';
import * as api from '../api';
import { Song } from '../types';
import { logger, PREVIEW_DETECTION } from '../config';
import {
    audioPlayer,
    isPlaying,
    setPlayingStatus,
    playMode,
    currentLyrics,
    getCurrentSong,
    currentPlayRequestId
} from './core';
import { nextSong } from './control';
import { fadeIn, fadeOut } from './effects';

/** 正在进行的跨源搜索状态 */
let isSeekingFullVersion = false;
let fullVersionSearchCount = 0;
/** 切换完整版时的最大回退播放位置（秒） */
const MAX_SEEK_ON_SWITCH = 10;

/**
 * 绑定音频事件
 */
export function bindAudioEvents(): void {
    audioPlayer.addEventListener('play', () => {
        setPlayingStatus(true);
        ui.updatePlayButton(true);
    });

    audioPlayer.addEventListener('pause', () => {
        setPlayingStatus(false);
        ui.updatePlayButton(false);
    });

    audioPlayer.addEventListener('ended', () => {
        if (playMode === 'single') {
            audioPlayer.currentTime = 0;
            audioPlayer.play();
        } else {
            nextSong();
        }
    });

    audioPlayer.addEventListener('timeupdate', () => {
        if (audioPlayer.duration) {
            ui.updateProgress(audioPlayer.currentTime, audioPlayer.duration);
            if (currentLyrics.length > 0) {
                ui.updateLyrics(currentLyrics, audioPlayer.currentTime);
            }
        }
    });

    audioPlayer.addEventListener('loadedmetadata', handleMetadataLoaded);

    // 新歌曲开始加载时重置试听检测计数
    audioPlayer.addEventListener('loadstart', () => {
        fullVersionSearchCount = 0;
    });

    audioPlayer.addEventListener('error', () => {
        logger.error('Audio Error:', audioPlayer.error?.message);
        ui.showNotification('音频资源加载错误', 'error');
    });
}

/**
 * 处理元数据加载（用于试听检测）
 */
async function handleMetadataLoaded(): Promise<void> {
    const duration = audioPlayer.duration;
    const song = getCurrentSong();

    if (!duration || !song) return;

    // 试听检测逻辑
    const isProbablePreview =
        duration >= PREVIEW_DETECTION.MIN_DURATION &&
        duration <= PREVIEW_DETECTION.MAX_DURATION &&
        PREVIEW_DETECTION.TYPICAL_DURATIONS.some(t => Math.abs(duration - t) <= PREVIEW_DETECTION.DURATION_TOLERANCE);

    if (isProbablePreview && !isSeekingFullVersion && fullVersionSearchCount < 2) {
        isSeekingFullVersion = true;
        fullVersionSearchCount++;

        try {
            const quality = (document.getElementById('qualitySelect') as HTMLSelectElement)?.value || '320';
            const requestId = currentPlayRequestId;

            // 再次尝试获取完整版
            const result = await api.tryGetFullVersionFromNeteaseUnblock(song, quality) ||
                await api.tryGetFullVersionFromOtherSources(song, quality);

            if (requestId === currentPlayRequestId && result?.url) {
                logger.info('发现完整版，执行无缝切换');
                const wasPlaying = isPlaying;
                const currentTime = audioPlayer.currentTime;

                await fadeOut(audioPlayer);
                audioPlayer.src = result.url;
                audioPlayer.load();

                audioPlayer.addEventListener('canplay', () => {
                    audioPlayer.currentTime = Math.min(currentTime, MAX_SEEK_ON_SWITCH);
                    if (wasPlaying) {
                        audioPlayer.play().then(() => fadeIn(audioPlayer));
                    }
                }, { once: true });
            }
        } catch (e) {
            logger.debug('切换完整版失败', e);
        } finally {
            isSeekingFullVersion = false;
        }
    }
}

/**
 * 更新 Media Session (系统媒体控制)
 */
export function updateMediaSession(song: Song, coverUrl: string): void {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.name,
            artist: Array.isArray(song.artist) ? song.artist.join('/') : song.artist,
            album: song.album,
            artwork: [{ src: coverUrl, sizes: '512x512', type: 'image/jpeg' }]
        });
    }
}
