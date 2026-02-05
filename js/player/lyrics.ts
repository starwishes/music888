/**
 * 云音乐播放器 - 歌词解析模块
 * 负责 LRC 格式歌词的解析与处理
 */

import { LyricLine } from '../types';

/**
 * 解析 LRC 格式歌词
 * @param lrc LRC 格式歌词字符串
 * @param tlyric 翻译歌词字符串（可选）
 * @returns 解析后的歌词行数组（包含翻译）
 */
export function parseLyrics(lrc: string, tlyric?: string): LyricLine[] {
    if (!lrc) return [];

    /**
     * 解析单行歌词
     * 格式如: [00:12.34]歌词内容
     */
    const parseLine = (line: string): { time: number; text: string }[] => {
        // 匹配多个时间标签，例如 [00:12.34][00:24.56]歌词内容
        const timeTags = line.match(/\[\d{2}:\d{2}\.\d{2,3}\]/g);
        if (!timeTags) return [];

        const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
        if (!text) return [];

        return timeTags.map(tag => {
            const match = tag.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
            if (!match) return { time: 0, text: '' };
            const m = parseInt(match[1], 10);
            const s = parseInt(match[2], 10);
            const ms = parseInt(match[3], 10);
            // 毫秒可能是 2 位或 3 位
            const msValue = match[3].length === 2 ? ms * 10 : ms;
            return {
                time: m * 60 + s + msValue / 1000,
                text
            };
        });
    };

    const lines = lrc.split('\n');
    let lyricData: LyricLine[] = [];

    lines.forEach(line => {
        const parsed = parseLine(line);
        parsed.forEach(p => {
            lyricData.push({
                time: p.time,
                text: p.text
            });
        });
    });

    // 排序
    lyricData.sort((a, b) => a.time - b.time);

    // 解析翻译歌词
    if (tlyric) {
        const tLines = tlyric.split('\n');
        tLines.forEach(line => {
            const parsed = parseLine(line);
            parsed.forEach(tp => {
                // 查找对应时间点的原歌词并合并
                const original = lyricData.find(l => Math.abs(l.time - tp.time) < 0.1);
                if (original) {
                    original.ttext = tp.text;
                }
            });
        });
    }

    return lyricData;
}
