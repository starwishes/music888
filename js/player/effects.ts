/**
 * 云音乐播放器 - 音效模块
 * 负责音频淡入淡出及平滑音量控制
 */

import { APP_CONFIG } from '../config';

/** 淡入淡出状态 */
let isFading = false;
/** 保存的音量 */
let savedVolume = loadSavedVolume();

/**
 * 从 localStorage 加载保存的音量
 */
export function loadSavedVolume(): number {
    try {
        const volume = localStorage.getItem('music888_volume');
        return volume ? parseFloat(volume) : 0.8;
    } catch {
        return 0.8;
    }
}

/**
 * 保存音量到 localStorage
 */
export function persistVolume(volume: number): void {
    try {
        localStorage.setItem('music888_volume', volume.toString());
    } catch { /* ignore */ }
}

/**
 * 设置保存的音量
 */
export function setSavedVolume(volume: number): void {
    savedVolume = volume;
}

/**
 * 获取保存的音量
 */
export function getSavedVolume(): number {
    return savedVolume;
}

/**
 * 获取淡入淡出状态
 */
export function getIsFading(): boolean {
    return isFading;
}

/**
 * 音频淡出效果
 * @param audio HTMLAudioElement
 */
export async function fadeOut(audio: HTMLAudioElement): Promise<void> {
    if (!audio || !audio.src || audio.paused) return;

    if (isFading) {
        audio.pause();
        audio.volume = 0;
        isFading = false;
        return;
    }

    isFading = true;
    if (audio.volume > 0.1) {
        savedVolume = audio.volume;
    }

    const stepTime = APP_CONFIG.FADE_DURATION / APP_CONFIG.FADE_STEPS;
    const volumeStep = savedVolume / APP_CONFIG.FADE_STEPS;

    for (let i = APP_CONFIG.FADE_STEPS; i >= 0; i--) {
        audio.volume = Math.max(0, volumeStep * i);
        await new Promise(r => setTimeout(r, stepTime));
    }
    audio.pause();
    isFading = false;
}

/**
 * 音频淡入效果
 * @param audio HTMLAudioElement
 */
export async function fadeIn(audio: HTMLAudioElement): Promise<void> {
    if (isFading) return;

    isFading = true;
    const targetVolume = savedVolume > 0 ? savedVolume : 0.8;
    audio.volume = 0;

    const stepTime = APP_CONFIG.FADE_DURATION / APP_CONFIG.FADE_STEPS;
    const volumeStep = targetVolume / APP_CONFIG.FADE_STEPS;

    for (let i = 0; i <= APP_CONFIG.FADE_STEPS; i++) {
        audio.volume = Math.min(targetVolume, volumeStep * i);
        await new Promise(r => setTimeout(r, stepTime));
    }
    isFading = false;
}
