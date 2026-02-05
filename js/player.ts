/**
 * 云音乐播放器 - 播放器模块入口
 * 负责聚合子模块并对外提供统一接口
 */

// 重新导出子模块
export * from './player/core';
export * from './player/control';
export * from './player/events';
export * from './player/playlist';
export * from './player/lyrics';
export * from './player/effects';

// NOTE: 初始化函数，保持与旧 API 兼容
import { audioPlayer } from './player/core';
import { bindAudioEvents } from './player/events';
import { initializeFavoritesPlaylist, loadSavedPlaylists, loadPlayHistoryFromStorage } from './player/playlist';
import { loadSavedVolume } from './player/effects';

/**
 * 初始化播放器
 */
export function initPlayer(): void {
    // 1. 设置初始音量
    const savedVolume = loadSavedVolume();
    audioPlayer.volume = savedVolume;

    // 2. 初始化持久化数据
    initializeFavoritesPlaylist();
    loadSavedPlaylists();
    loadPlayHistoryFromStorage();

    // 3. 绑定音频事件
    bindAudioEvents();
}

/**
 * 切换收藏按钮状态 (UI 桥接)
 * NOTE: 保留在 facade 中用于处理复杂的 UI 联动逻辑
 */
import { Song } from './types';
import { toggleFavorite, isSongInFavorites } from './player/playlist';
import * as ui from './ui';

export function toggleFavoriteButton(song: Song): void {
    const isFav = toggleFavorite(song);
    updatePlayerFavoriteButton(isFav);
    ui.showNotification(isFav ? '已添加到收藏' : '已从收藏移除', 'success');
}

export function updatePlayerFavoriteButton(isFavorite: boolean): void {
    const btn = document.getElementById('playerFavoriteBtn');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = isFavorite ? 'fas fa-heart' : 'far fa-heart';
            icon.style.color = isFavorite ? 'var(--primary-color)' : '';
        }
    }
}

/**
 * 获取收藏夹 Key (向后兼容)
 */
export function getFavoritesPlaylistKey(): string {
    return 'favorites';
}
