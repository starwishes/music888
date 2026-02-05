/**
 * 云音乐播放器 - API 工具模块
 * 包含相似度计算、数据统计与持久化等辅助功能
 */

import { logger } from '../config';

/**
 * 计算两个字符串的相似度 (综合算法)
 */
export function calculateSimilarity(str1: string, str2: string): number {
    const normalize = (s: string) => s.toLowerCase().replace(/[\s\-\_\(\)\[\]（）]/g, '');
    const s1 = normalize(str1);
    const s2 = normalize(str2);

    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // 简单的 Jaccard 相似度实现
    const set1 = new Set(s1);
    const set2 = new Set(s2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
}

/**
 * 计算歌曲匹配得分
 */
export function calculateSongMatchScore(
    targetName: string,
    targetArtist: string,
    candidateName: string,
    candidateArtist: string | string[]
): number {
    const nameScore = calculateSimilarity(targetName, candidateName);
    const candidateArtistStr = Array.isArray(candidateArtist) ? candidateArtist.join('/') : candidateArtist;
    const artistScore = calculateSimilarity(targetArtist, candidateArtistStr);

    // 歌名权重 0.6，歌手权重 0.4
    return nameScore * 0.6 + artistScore * 0.4;
}

/** 备选源数据统计 */
export const sourceSuccessCount = new Map<string, number>();
export const sourceFailCount = new Map<string, number>();

/**
 * 获取排序后的备选源
 */
export function getSortedFallbackSources(excludeSource: string): string[] {
    const FALLBACK_SOURCES = ['kuwo', 'kugou', 'migu', 'tencent', 'ximalaya', 'joox'];

    return FALLBACK_SOURCES
        .filter(s => s !== excludeSource)
        .sort((a, b) => {
            const successA = sourceSuccessCount.get(a) || 0;
            const successB = sourceSuccessCount.get(b) || 0;
            return successB - successA;
        });
}

/**
 * 保存源统计数据
 */
export function saveSourceStats(): void {
    try {
        const stats = {
            success: Object.fromEntries(sourceSuccessCount),
            fail: Object.fromEntries(sourceFailCount)
        };
        localStorage.setItem('api_source_stats', JSON.stringify(stats));
    } catch (e) {
        logger.error('保存源统计失败', e);
    }
}

/**
 * 加载源统计数据
 */
export function loadSourceStats(): void {
    try {
        const data = localStorage.getItem('api_source_stats');
        if (data) {
            const stats = JSON.parse(data);
            Object.entries(stats.success || {}).forEach(([k, v]) => sourceSuccessCount.set(k, v as number));
            Object.entries(stats.fail || {}).forEach(([k, v]) => sourceFailCount.set(k, v as number));
        }
    } catch (e) {
        logger.debug('加载源统计失败', e);
    }
}
