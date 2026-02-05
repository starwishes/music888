/**
 * 云音乐播放器 - 音乐资源模块
 * 负责音频 URL、歌词、封面等资源的解析与获取
 */

import {
    Song,
    SongUrlResult,
    LyricResult,
    GDStudioPicResponse,
    GDStudioUrlResponse,
    GDStudioLyricResponse,
    NeteaseSongUrlResponse,
    NeteaseLyricResponse,
    GDStudioSong,
    MusicError
} from '../types';

import { logger, PREVIEW_DETECTION } from '../config';
import { fetchWithRetry } from './client';
import {
    getGDStudioApiUrl,
    getNecApiUrl,
    getMetingApiUrl,
    isGDStudioApiAvailable,
    markGDStudioApiAvailable,
    markGDStudioApiUnavailable
} from './sources';
import {
    calculateSongMatchScore,
    getSortedFallbackSources,
    saveSourceStats,
    sourceFailCount,
    sourceSuccessCount
} from './utils';

/** 正在进行的跨源搜索计数，避免重复请求 */
const crossSourceSearchInProgress = new Set<string>();

/**
 * 检查 URL 是否可能是试听版本
 */
export function isProbablyPreview(url: string, size?: number, knownDuration?: number): boolean {
    if (!url) return true;
    const previewPatterns = [/preview/i, /trial/i, /sample/i, /freepart/i, /clip/i, /m-trial/i];
    if (previewPatterns.some(pattern => pattern.test(url))) return true;

    if (size && size > 0 && size < PREVIEW_DETECTION.MIN_FILE_SIZE) {
        logger.debug(`文件大小异常小 (${Math.round(size / 1024)}KB)，判定为试听版本`);
        return true;
    }

    if (knownDuration && knownDuration > 0) {
        const durationSec = knownDuration / 1000;
        if (durationSec >= PREVIEW_DETECTION.MIN_DURATION && durationSec <= PREVIEW_DETECTION.MAX_DURATION) {
            const isNearTypical = PREVIEW_DETECTION.TYPICAL_DURATIONS.some(
                typical => Math.abs(durationSec - typical) <= PREVIEW_DETECTION.DURATION_TOLERANCE
            );
            if (isNearTypical) {
                logger.debug(`元数据时长 ${durationSec.toFixed(1)}s 为典型试听时长`);
                return true;
            }
        }
    }
    return false;
}

/**
 * 获取专辑封面 URL
 */
export async function getAlbumCoverUrl(song: Song, size: number = 300): Promise<string> {
    if (song.pic_url) {
        if (song.pic_url.includes('music.126.net')) return song.pic_url + `?param=${size}y${size}`;
        return song.pic_url;
    }
    if (!song.pic_id) return '';

    const gdstudioUrl = getGDStudioApiUrl();
    const metingUrl = getMetingApiUrl();

    // 1. 优先尝试 GDStudio
    try {
        const response = await fetchWithRetry(`${gdstudioUrl}?types=pic&source=${song.source || 'netease'}&id=${song.pic_id}&size=300`);
        const data: GDStudioPicResponse = await response.json();
        if (data?.url) return data.url;
    } catch (e) {
        logger.warn('GDStudio 获取封面失败');
    }

    // 2. 回退到 Meting
    try {
        const response = await fetchWithRetry(`${metingUrl}/?type=pic&id=${song.pic_id}`);
        const data = await response.json();
        if (data?.url || data?.pic) return data.url || data.pic || '';
    } catch (e) {
        logger.warn('Meting 获取封面失败');
    }
    return '';
}

/**
 * 从指定子源获取歌曲 URL
 */
async function getSongUrlFromSource(songId: string, source: string, quality: string): Promise<SongUrlResult | null> {
    if (!isGDStudioApiAvailable()) return null;
    try {
        const response = await fetchWithRetry(`${getGDStudioApiUrl()}?types=url&source=${source}&id=${songId}&br=${quality}`, {}, 0);
        const data: GDStudioUrlResponse = await response.json();
        if (data?.url) {
            markGDStudioApiAvailable();
            return {
                url: data.url,
                br: data.br || quality,
                size: data.size ? data.size * 1024 : undefined
            };
        }
    } catch (e) {
        if (e instanceof MusicError && e.message.includes('403')) markGDStudioApiUnavailable();
    }
    return null;
}

/**
 * 单个源并行搜索辅助函数
 */
async function searchSingleSource(source: string, songName: string, artistName: string): Promise<SongUrlResult | null> {
    if (!isGDStudioApiAvailable()) return null;
    try {
        const keyword = `${songName} ${artistName}`;
        const response = await fetchWithRetry(`${getGDStudioApiUrl()}?types=search&source=${source}&name=${encodeURIComponent(keyword)}&count=5`, {}, 0);
        const data = await response.json();
        let songs: GDStudioSong[] = Array.isArray(data) ? data : Object.values(data || {});

        const bestMatch = songs
            .map(s => ({ s, score: calculateSongMatchScore(songName, artistName, s.name, s.artist) }))
            .filter(m => m.score > PREVIEW_DETECTION.SIMILARITY_THRESHOLD)
            .sort((a, b) => b.score - a.score)[0];

        if (bestMatch) {
            // 尝试获取 URL (优先低码率以保证完整性)
            for (const q of ['128', '320']) {
                const res = await getSongUrlFromSource(bestMatch.s.id, source, q);
                if (res && res.url && !isProbablyPreview(res.url, res.size)) return { ...res, source };
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

/**
 * 跨源搜索逻辑
 */
export async function searchSongFromOtherSources(songName: string, artistName: string, excludeSource: string, _quality: string): Promise<SongUrlResult | null> {
    const sources = getSortedFallbackSources(excludeSource);
    const promises = sources.map(source =>
        searchSingleSource(source, songName, artistName)
            .then(res => ({ source, res }))
            .catch(() => ({ source, res: null }))
    );

    const results = await Promise.all(promises);
    for (const { source, res } of results) {
        if (res) {
            sourceSuccessCount.set(source, (sourceSuccessCount.get(source) || 0) + 1);
            saveSourceStats();
            return res;
        }
        sourceFailCount.set(source, (sourceFailCount.get(source) || 0) + 1);
    }
    saveSourceStats();
    return null;
}

/**
 * 当检测到试听版本时，优先再次尝试 NEC Unblock 以获取完整版本（仅网易云）
 */
export async function tryGetFullVersionFromNeteaseUnblock(song: Song, quality: string): Promise<SongUrlResult | null> {
    if ((song.source || 'netease') !== 'netease') return null;

    const brQueue = Array.from(new Set(['128', '192', '320', quality]));

    for (let attempt = 0; attempt < 2; attempt++) {
        for (const br of brQueue) {
            try {
                const url = `${getNecApiUrl()}/song/url/match?id=${song.id}&br=${encodeURIComponent(br)}&randomCNIP=true&t=${Date.now()}`;
                const response = await fetchWithRetry(url, {}, 0);
                const data: NeteaseSongUrlResponse = await response.json();

                if (data.code === 200 && data.data?.[0]?.url) {
                    return {
                        url: data.data[0].url,
                        br: String(data.data[0].br || br || quality),
                        size: data.data[0].size,
                    };
                }
            } catch (e) { /* ignore */ }
        }
    }
    return null;
}

/**
 * 尝试获取完整版本
 */
export async function tryGetFullVersionFromOtherSources(song: Song, quality: string): Promise<SongUrlResult | null> {
    const key = `${song.id}_${song.source}`;
    if (crossSourceSearchInProgress.has(key)) return null;
    crossSourceSearchInProgress.add(key);
    try {
        const artist = Array.isArray(song.artist) ? song.artist[0] : song.artist;
        return await searchSongFromOtherSources(song.name, artist, song.source || 'netease', quality);
    } finally {
        crossSourceSearchInProgress.delete(key);
    }
}

/**
 * 获取歌曲播放 URL
 */
export async function getSongUrl(song: Song, quality: string): Promise<SongUrlResult> {
    const source = song.source || 'netease';
    const candidates: SongUrlResult[] = [];
    const artist = Array.isArray(song.artist) ? song.artist[0] : song.artist;
    let crossSourcePromise: Promise<SongUrlResult | null> | null = null;

    // 1. 尝试网易云解析
    if (source === 'netease') {
        try {
            const matchRes = await fetchWithRetry(`${getNecApiUrl()}/song/url/match?id=${song.id}&randomCNIP=true`);
            const matchData: NeteaseSongUrlResponse = await matchRes.json();
            if (matchData.code === 200 && matchData.data?.[0]?.url) {
                const res = { url: matchData.data[0].url, br: String(matchData.data[0].br), size: matchData.data[0].size };
                if (!isProbablyPreview(res.url, res.size)) return res;
                candidates.push(res);
                if (PREVIEW_DETECTION.PROACTIVE_CHECK) crossSourcePromise = searchSongFromOtherSources(song.name, artist, source, quality);
            }
        } catch (e) { /* ignore */ }
    }

    // 2. 尝试 GDStudio
    if (isGDStudioApiAvailable()) {
        try {
            const res = await getSongUrlFromSource(song.id, source, quality);
            if (res) {
                if (!isProbablyPreview(res.url, res.size, song.duration)) return res;
                candidates.push(res);
                if (!crossSourcePromise && PREVIEW_DETECTION.PROACTIVE_CHECK) {
                    crossSourcePromise = searchSongFromOtherSources(song.name, artist, source, quality);
                }
            }
        } catch (e) { /* ignore */ }
    }

    // 3. 回退逻辑
    if (crossSourcePromise) {
        const res = await crossSourcePromise;
        if (res) return res;
    }

    if (candidates.length > 0) return candidates[0];
    return { url: '', br: quality };
}

/**
 * 获取歌词
 */
export async function getLyrics(song: Song): Promise<LyricResult> {
    const source = song.source || 'netease';

    // 优先 NEC
    if (source === 'netease') {
        try {
            const res = await fetchWithRetry(`${getNecApiUrl()}/lyric?id=${song.id}`);
            const data: NeteaseLyricResponse = await res.json();
            if (data.code === 200 && data.lrc?.lyric) return { lyric: data.lrc.lyric, tlyric: data.tlyric?.lyric };
        } catch (e) { /* ignore */ }
    }

    // 回退 GDStudio
    if (isGDStudioApiAvailable()) {
        try {
            const res = await fetchWithRetry(`${getGDStudioApiUrl()}?types=lyric&source=${source}&id=${song.lyric_id || song.id}`);
            const data: GDStudioLyricResponse = await res.json();
            if (data?.lyric) return { lyric: data.lyric, tlyric: data.tlyric };
        } catch (e) { /* ignore */ }
    }

    return { lyric: '' };
}
