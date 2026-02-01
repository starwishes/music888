/**
 * 云音乐播放器 - API 模块
 * 负责与外部音乐 API 通信，包括搜索、获取歌曲信息、歌词等
 */

import {
    Song,
    ApiSource,
    NeteaseSearchResponse,
    NeteaseSongDetailResponse,
    NeteaseSongDetail,
    NeteaseSongUrlResponse,
    NeteaseLyricResponse,
    NeteasePlaylistDetailResponse,
    NeteaseArtist,
    NeteaseAlbum,
    MetingSong,
    MetingErrorResponse,
    GDStudioSong,
    GDStudioUrlResponse,
    GDStudioLyricResponse,
    GDStudioPicResponse,
    SongUrlResult,
    LyricResult,
    PlaylistParseResult,
    ApiDetectionResult,
    MusicError,
    MusicErrorType,
} from './types';

import { logger, APP_CONFIG, PREVIEW_DETECTION } from './config';

// 重新导出 Song 类型供其他模块使用
export type { Song } from './types';

// NOTE: API 源配置 - 按功能和稳定性排列
// IMPORTANT: 只有 NEC API 和 GDStudio API 支持搜索功能，Meting API 已移除搜索支持
const API_SOURCES: ApiSource[] = [
    {
        name: 'GDStudio API',
        url: 'https://music-api.gdstudio.xyz/api.php',
        type: 'gdstudio',
        supportsSearch: true
    },
    {
        name: 'NEC API',
        url: 'https://nec8.de5.net',
        type: 'nec',
        supportsSearch: true
    },
    {
        name: 'NEC API 2',
        url: 'https://netease-cloud-music-api-five-roan.vercel.app',
        type: 'nec',
        supportsSearch: true
    },
    {
        name: 'Meting API (Pro)',
        url: 'https://tktok.de5.net/api',
        type: 'meting',
        supportsSearch: false
    },
    {
        name: 'Meting API 1',
        url: 'https://api.injahow.cn/meting',
        type: 'meting',
        supportsSearch: false
    },
    {
        name: 'Meting API 2',
        url: 'https://meting.qjqq.cn',
        type: 'meting',
        supportsSearch: false
    }
];

let currentAPI = API_SOURCES[0];

// NOTE: GDStudio API 可用性缓存，避免重复请求不可用的 API
let gdstudioApiAvailable: boolean | null = null;
let gdstudioApiLastCheck: number = 0;

/**
 * 检查 GDStudio API 是否可用（带缓存）
 */
function isGDStudioApiAvailable(): boolean {
    const now = Date.now();
    // 如果缓存过期或未检测，返回 true 让它尝试
    if (gdstudioApiAvailable === null || now - gdstudioApiLastCheck > APP_CONFIG.GDSTUDIO_CACHE_TTL) {
        return true;
    }
    return gdstudioApiAvailable;
}

/**
 * 标记 GDStudio API 为不可用
 */
function markGDStudioApiUnavailable(): void {
    gdstudioApiAvailable = false;
    gdstudioApiLastCheck = Date.now();
    logger.warn('GDStudio API 标记为不可用，将在 5 分钟后重试');
}

/**
 * 标记 GDStudio API 为可用
 */
function markGDStudioApiAvailable(): void {
    gdstudioApiAvailable = true;
    gdstudioApiLastCheck = Date.now();
}

// NOTE: 代理端点路径，用于解决 CORS 问题
const PROXY_ENDPOINT = '/api/proxy';

/**
 * 将外部 URL 转换为代理 URL
 * @param url 原始外部 API URL
 * @returns 代理后的 URL
 */
function toProxyUrl(url: string): string {
    return `${PROXY_ENDPOINT}?url=${encodeURIComponent(url)}`;
}

/**
 * 测试 API 可用性（通过代理）
 * NOTE: 根据 API 类型使用不同的测试端点
 */
async function testAPI(api: ApiSource): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        let testUrl: string;
        if (api.type === 'nec') {
            testUrl = `${api.url}/search?keywords=test&limit=1`;
        } else if (api.type === 'gdstudio') {
            // GDStudio API 使用搜索接口测试
            testUrl = `${api.url}?types=search&source=netease&name=test&count=1`;
        } else {
            testUrl = `${api.url}/?type=playlist&id=60198`;
        }

        const proxyUrl = toProxyUrl(testUrl);
        const response = await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.log(`  API 返回状态码: ${response.status}`);
            return false;
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            console.log(`  API 返回 HTML 而非 JSON`);
            return false;
        }

        const text = await response.text();
        try {
            const data: unknown = JSON.parse(text);
            if (api.type === 'nec') {
                const necData = data as NeteaseSearchResponse;
                return necData.code === 200;
            }
            if (api.type === 'gdstudio') {
                // GDStudio API 返回数组或对象
                if (Array.isArray(data) && data.length > 0) {
                    return true;
                }
                // 检查是否为对象格式的搜索结果
                if (typeof data === 'object' && data !== null && Object.keys(data).length > 0) {
                    return true;
                }
                return false;
            }
            if (Array.isArray(data) && data.length > 0) {
                return true;
            }
            const metingData = data as MetingErrorResponse;
            if (metingData.error) {
                console.log(`  Meting API 返回错误: ${metingData.error}`);
                return false;
            }
            return typeof data === 'object' && data !== null;
        } catch {
            console.log(`  API 响应不是有效 JSON: ${text.substring(0, 100)}`);
            return false;
        }
    } catch (error) {
        console.log(`  API 测试失败: ${error}`);
        return false;
    }
}

/**
 * 查找可用的 API
 */
export async function findWorkingAPI(): Promise<ApiDetectionResult> {
    console.log('正在检测可用的 API...');
    for (const api of API_SOURCES) {
        console.log(`测试 ${api.name}...`);
        const isWorking = await testAPI(api);
        if (isWorking) {
            currentAPI = api;
            if (api.type === 'gdstudio') markGDStudioApiAvailable();
            console.log(`✅ ${api.name} 可用`);
            return { success: true, name: api.name };
        } else {
            console.log(`❌ ${api.name} 不可用`);
            // NOTE: GDStudio API 测试失败时立即标记，避免后续重复尝试
            if (api.type === 'gdstudio') markGDStudioApiUnavailable();
        }
    }
    logger.error('所有 API 均不可用');
    return { success: false };
}

/**
 * 带重试的 fetch 请求（自动通过代理）
 * @param url 原始外部 API URL
 * @param options fetch 选项
 * @param retries 重试次数
 * @param useProxy 是否使用代理（默认 true）
 */
export async function fetchWithRetry(
    url: string,
    options: RequestInit = {},
    retries: number = 2,
    useProxy: boolean = true
): Promise<Response> {
    const requestUrl = useProxy ? toProxyUrl(url) : url;

    for (let i = 0; i <= retries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000);
            const response = await fetch(requestUrl, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) {
                return response;
            } else {
                throw new MusicError(
                    MusicErrorType.API,
                    `API returned error: ${response.status}`,
                    `服务器返回错误 (${response.status})`
                );
            }
        } catch (error) {
            console.error(`Request failed (attempt ${i + 1}/${retries + 1}):`, error);
            if (i === retries) {
                if (error instanceof MusicError) {
                    throw error;
                }
                throw new MusicError(
                    MusicErrorType.NETWORK,
                    `All fetch attempts failed: ${error}`,
                    '网络请求失败，请检查网络连接',
                    error instanceof Error ? error : undefined
                );
            }
        }
    }
    throw new MusicError(
        MusicErrorType.NETWORK,
        'All fetch attempts failed.',
        '网络请求失败，请稍后重试'
    );
}

/**
 * 获取首选的 Meting API URL
 */
function getMetingApiUrl(): string {
    const proApi = API_SOURCES.find(api => api.name === 'Meting API (Pro)');
    if (proApi) return proApi.url;

    const metingApi = API_SOURCES.find(api => api.type === 'meting');
    return metingApi ? metingApi.url : 'https://api.injahow.cn/meting';
}

/**
 * 获取 GDStudio API URL
 */
function getGDStudioApiUrl(): string {
    const gdstudioApi = API_SOURCES.find(api => api.type === 'gdstudio');
    return gdstudioApi ? gdstudioApi.url : 'https://music-api.gdstudio.xyz/api.php';
}

/**
 * 获取专辑封面 URL
 * NOTE: 优先使用 GDStudio API，其次 Meting API，最后 CDN 构造
 */
export async function getAlbumCoverUrl(song: Song, size: number = 300): Promise<string> {
    if (song.pic_url) {
        if (song.pic_url.includes('music.126.net')) {
            return song.pic_url + `?param=${size}y${size}`;
        }
        return song.pic_url;
    }

    if (!song.pic_id) {
        return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTUiIGhlaWdodD0iNTUiIHZpZXdCb3g9IjAgMCA1NSA1NSIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjU1IiBoZWlnaHQ9IjU1IiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU5LDAuMSkiIHJ4PSI4Ii8+CjxwYXRoIGQ9Ik0yNy41IDE4TDM1IDI3LjVIMzBWMzdIMjVWMjcuNUgyMEwyNy41IDE4WiIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjMpIi8+Cjwvc3ZnPgo=';
    }

    const gdstudioUrl = getGDStudioApiUrl();
    const metingUrl = getMetingApiUrl();
    const source = song.source || 'netease';

    // 1. 优先尝试 GDStudio API
    try {
        const response = await fetchWithRetry(
            `${gdstudioUrl}?types=pic&source=${source}&id=${song.pic_id}&size=${size >= 500 ? 500 : 300}`
        );
        const data: GDStudioPicResponse = await response.json();
        if (data?.url) {
            return data.url;
        }
    } catch (e) {
        console.warn('GDStudio API 获取封面失败，尝试 Meting API:', e);
    }

    // 2. 回退到 Meting API
    try {
        const response = await fetchWithRetry(`${metingUrl}/?type=pic&id=${song.pic_id}`);
        const data: { url?: string; pic?: string } = await response.json();
        if (data?.url || data?.pic) {
            return data.url || data.pic || '';
        }
    } catch (e) {
        console.warn('Meting API 获取封面失败，尝试使用 CDN 构造:', e);
    }

    // 3. 最后返回空字符串（CDN 构造需要 encrypt_id，无法仅从 pic_id 得到）
    logger.warn('所有方式获取封面均失败');
    return '';
}

/**
 * 获取歌曲播放 URL
 * NOTE: 
 * 1. 优先使用 GDStudio API（支持多音乐源）
 * 2. 其次尝试 NEC Unblock (match) 接口
 * 3. 再尝试 Meting API
 * 4. 最后尝试 NEC 常规接口
 */
/**
 * 检查 URL 是否可能是试听版本
 * NOTE: 多维度检测 - URL 模式 + 文件大小 + 已知时长
 * @param url 音频 URL
 * @param size 文件大小（字节，可选）
 * @param knownDuration 已知歌曲时长（毫秒，可选，来自搜索结果元数据）
 */
function isProbablyPreview(url: string, size?: number, knownDuration?: number): boolean {
    // 维度 1: URL 中明确的试听标记
    const previewPatterns = [
        /preview/i,
        /trial/i,
        /sample/i,
        /freepart/i,
        /clip/i,
    ];
    if (previewPatterns.some(pattern => pattern.test(url))) {
        return true;
    }

    // 维度 2: 文件大小异常小（低于阈值，可能是试听片段）
    if (size && size > 0 && size < PREVIEW_DETECTION.MIN_FILE_SIZE) {
        logger.debug(`文件大小异常小 (${Math.round(size / 1024)}KB)，可能是试听版本`);
        return true;
    }

    // 维度 3: 如果有已知时长（来自 API 元数据），判断是否在试听区间
    if (knownDuration && knownDuration > 0) {
        const durationSec = knownDuration / 1000;
        if (durationSec >= PREVIEW_DETECTION.MIN_DURATION && durationSec <= PREVIEW_DETECTION.MAX_DURATION) {
            // 检查是否接近典型试听时长（30秒/60秒）
            const isNearTypical = PREVIEW_DETECTION.TYPICAL_DURATIONS.some(
                typical => Math.abs(durationSec - typical) <= PREVIEW_DETECTION.DURATION_TOLERANCE
            );
            if (isNearTypical) {
                logger.debug(`已知时长 ${durationSec.toFixed(1)}s 接近典型试听时长`);
                return true;
            }
        }
    }

    return false;
}

/**
 * 备选音乐源列表，按资源丰富度排序
 * kuwo/kugou 国内资源最丰富，tencent QQ音乐资源多
 */
const FALLBACK_SOURCES = ['kuwo', 'kugou', 'migu', 'tencent', 'ximalaya', 'joox'];

// NOTE: 动态源优先级 - 记录各源的成功/失败次数，自动调整优先级
const sourceSuccessCount = new Map<string, number>();
const sourceFailCount = new Map<string, number>();

/**
 * 获取排序后的备选源列表（成功率高的优先）
 */
function getSortedFallbackSources(excludeSource: string): string[] {
    return FALLBACK_SOURCES
        .filter(s => s !== excludeSource)
        .sort((a, b) => {
            const aSuccess = sourceSuccessCount.get(a) || 0;
            const aFail = sourceFailCount.get(a) || 0;
            const bSuccess = sourceSuccessCount.get(b) || 0;
            const bFail = sourceFailCount.get(b) || 0;
            // 计算成功率，新源（无记录）排在中间
            const aRate = (aSuccess + aFail) > 0 ? aSuccess / (aSuccess + aFail) : 0.5;
            const bRate = (bSuccess + bFail) > 0 ? bSuccess / (bSuccess + bFail) : 0.5;
            return bRate - aRate;
        })
        .slice(0, PREVIEW_DETECTION.MAX_CROSS_SOURCE_ATTEMPTS);
}

// NOTE: 存储正在尝试跨源搜索的歌曲ID，避免重复搜索
const crossSourceSearchInProgress = new Set<string>();

/**
 * 使用备用 NEC API 获取歌曲 URL
 */
async function getSongUrlFromNecApi(songId: string, quality: string): Promise<SongUrlResult | null> {
    const necApis = API_SOURCES.filter(api => api.type === 'nec');

    for (const necApi of necApis) {
        try {
            const level = quality === '999' ? 'hires' : quality === '740' ? 'lossless' : quality === '320' ? 'exhigh' : 'standard';
            const response = await fetchWithRetry(
                `${necApi.url}/song/url/v1?id=${songId}&level=${level}&randomCNIP=true`,
                {},
                0
            );
            const data: NeteaseSongUrlResponse = await response.json();

            if (data.code === 200 && data.data?.[0]?.url) {
                return {
                    url: data.data[0].url,
                    br: String(data.data[0].br || quality)
                };
            }
        } catch (e) {
            console.warn(`NEC API (${necApi.name}) 获取 URL 失败:`, e);
        }
    }
    return null;
}

/**
 * 从指定音乐源直接获取歌曲 URL（内部函数）
 * 返回结果包含文件大小用于试听检测
 */
async function getSongUrlFromSource(
    songId: string,
    source: string,
    quality: string
): Promise<SongUrlResult | null> {
    // NOTE: 检查 GDStudio API 是否可用
    if (!isGDStudioApiAvailable()) {
        console.log('GDStudio API 暂时不可用，跳过');
        return null;
    }

    const gdstudioUrl = getGDStudioApiUrl();

    try {
        const response = await fetchWithRetry(
            `${gdstudioUrl}?types=url&source=${source}&id=${songId}&br=${quality}`,
            {},
            0  // NOTE: 不重试，快速失败
        );
        const data: GDStudioUrlResponse = await response.json();

        if (data?.url) {
            markGDStudioApiAvailable();
            return {
                url: data.url,
                br: String(data.br || quality),
                size: data.size ? data.size * 1024 : undefined // API 返回 KB，转为字节
            };
        }
    } catch (e) {
        console.warn(`从 ${source} 获取 URL 失败:`, e);
        // 如果是 403 错误，标记 API 不可用
        if (e instanceof MusicError && e.message.includes('403')) {
            markGDStudioApiUnavailable();
        }
    }
    return null;
}

/**
 * 计算两个字符串的相似度
 * NOTE: 使用 Jaccard + 子串匹配 + 长度比率的综合算法
 */
function calculateSimilarity(str1: string, str2: string): number {
    // 标准化处理：小写、移除空格和常见分隔符
    const normalize = (s: string) => s.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[（）()【】\[\]「」『』]/g, '')
        .replace(/[-_·.]/g, '');

    const normalized1 = normalize(str1);
    const normalized2 = normalize(str2);

    // 完全相同
    if (normalized1 === normalized2) return 1.0;

    // 空字符串处理
    if (!normalized1 || !normalized2) return 0;

    // 子串包含（一个是另一个的子串）
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
        // 根据长度差异调整分数
        const lengthRatio = Math.min(normalized1.length, normalized2.length) /
                           Math.max(normalized1.length, normalized2.length);
        return 0.7 + 0.3 * lengthRatio;
    }

    // Jaccard 相似度（基于字符集合）
    const set1 = new Set(normalized1);
    const set2 = new Set(normalized2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    const jaccard = intersection.size / union.size;

    // 加入长度惩罚，避免短字符串产生高相似度误判
    const lengthPenalty = Math.min(normalized1.length, normalized2.length) >= 3 ? 1 : 0.7;

    return jaccard * lengthPenalty;
}

/**
 * 计算歌曲匹配度（综合歌名和歌手）
 */
function calculateSongMatchScore(
    targetName: string,
    targetArtist: string,
    candidateName: string,
    candidateArtist: string | string[]
): number {
    // 歌名相似度（主要权重）
    const nameSimilarity = calculateSimilarity(targetName, candidateName);

    // 如果歌名相似度太低，直接返回
    if (nameSimilarity < PREVIEW_DETECTION.SIMILARITY_THRESHOLD) {
        return nameSimilarity;
    }

    // 歌手相似度检查
    const candidateArtists = Array.isArray(candidateArtist) ? candidateArtist : [candidateArtist];
    const targetArtistNorm = targetArtist.toLowerCase();

    let artistBonus = 0;
    for (const artist of candidateArtists) {
        const artistSim = calculateSimilarity(targetArtist, artist);
        if (artistSim > 0.6) {
            artistBonus = PREVIEW_DETECTION.ARTIST_MATCH_BONUS;
            break;
        }
        // 部分匹配也给一些加分
        if (artist.toLowerCase().includes(targetArtistNorm) ||
            targetArtistNorm.includes(artist.toLowerCase())) {
            artistBonus = PREVIEW_DETECTION.ARTIST_MATCH_BONUS * 0.5;
        }
    }

    return Math.min(1.0, nameSimilarity + artistBonus);
}

/**
 * 从单个源搜索歌曲（用于并行搜索）
 * NOTE: 完整版优先 - 从低音质开始尝试，更容易获取完整版
 */
async function searchSingleSource(
    source: string,
    songName: string,
    artistName: string,
    quality: string
): Promise<SongUrlResult | null> {
    if (!isGDStudioApiAvailable()) return null;

    const gdstudioUrl = getGDStudioApiUrl();
    const searchKeyword = `${songName} ${artistName}`;

    try {
        const response = await fetchWithRetry(
            `${gdstudioUrl}?types=search&source=${source}&name=${encodeURIComponent(searchKeyword)}&count=10`,
            {},
            0
        );
        const data = await response.json();

        let songs: GDStudioSong[] = [];
        if (Array.isArray(data)) {
            songs = data as GDStudioSong[];
        } else if (typeof data === 'object' && data !== null) {
            const values = Object.values(data);
            songs = values.filter((item): item is GDStudioSong => {
                return !!(item && typeof item === 'object' && 'id' in item && 'name' in item);
            }) as GDStudioSong[];
        }

        const bestMatches = songs
            .map(song => ({
                song,
                score: calculateSongMatchScore(songName, artistName, song.name, song.artist)
            }))
            .filter(match => match.score > PREVIEW_DETECTION.SIMILARITY_THRESHOLD)
            .sort((a, b) => b.score - a.score);

        // 完整版优先：从低音质开始尝试，更容易获取完整版
        const qualityLevels = ['128', '192', '320'];

        for (const match of bestMatches.slice(0, 3)) {
            for (const q of qualityLevels) {
                const urlResult = await getSongUrlFromSource(match.song.id, source, q);
                if (urlResult && urlResult.url && !isProbablyPreview(urlResult.url, urlResult.size)) {
                    return { ...urlResult, source };
                }
            }
        }
    } catch (e) {
        logger.debug(`从 ${source} 搜索失败:`, e);
    }
    return null;
}

/**
 * 跨音乐源搜索同名歌曲（并行版本）
 */
async function searchSongFromOtherSources(
    songName: string,
    artistName: string,
    excludeSource: string,
    quality: string
): Promise<SongUrlResult | null> {
    if (!isGDStudioApiAvailable()) {
        console.log('GDStudio API 暂时不可用，跳过跨源搜索');
        return null;
    }

    const sortedSources = getSortedFallbackSources(excludeSource);
    console.log(`跨源搜索: "${songName}" 尝试源: ${sortedSources.join(', ')}`);

    if (PREVIEW_DETECTION.PARALLEL_SEARCH) {
        // 并行搜索所有源
        const searchPromises = sortedSources.map(source =>
            searchSingleSource(source, songName, artistName, quality)
                .then(result => ({ source, result }))
                .catch(() => ({ source, result: null }))
        );

        const results = await Promise.all(searchPromises);

        // 按源优先级返回第一个有效结果
        for (const { source, result } of results) {
            if (result) {
                console.log(`从 ${source} 找到完整版本`);
                sourceSuccessCount.set(source, (sourceSuccessCount.get(source) || 0) + 1);
                saveSourceStats();
                return result;
            }
            sourceFailCount.set(source, (sourceFailCount.get(source) || 0) + 1);
        }
    } else {
        // 串行搜索（回退模式）
        for (const source of sortedSources) {
            const result = await searchSingleSource(source, songName, artistName, quality);
            if (result) {
                console.log(`从 ${source} 找到完整版本`);
                sourceSuccessCount.set(source, (sourceSuccessCount.get(source) || 0) + 1);
                saveSourceStats();
                return result;
            }
            sourceFailCount.set(source, (sourceFailCount.get(source) || 0) + 1);
        }
    }

    saveSourceStats();
    return null;
}

/**
 * 加载持久化的源成功率数据
 */
function loadSourceStats(): void {
    try {
        const saved = localStorage.getItem('musicSourceStats');
        if (saved) {
            const data = JSON.parse(saved);
            if (data.success) {
                Object.entries(data.success).forEach(([k, v]) =>
                    sourceSuccessCount.set(k, v as number));
            }
            if (data.fail) {
                Object.entries(data.fail).forEach(([k, v]) =>
                    sourceFailCount.set(k, v as number));
            }
        }
    } catch { /* ignore */ }
}

/**
 * 保存源成功率数据
 */
function saveSourceStats(): void {
    try {
        const data = {
            success: Object.fromEntries(sourceSuccessCount),
            fail: Object.fromEntries(sourceFailCount)
        };
        localStorage.setItem('musicSourceStats', JSON.stringify(data));
    } catch { /* ignore */ }
}

// 初始化时加载源统计数据
loadSourceStats();

/**
 * 当检测到试听版本时，尝试从其他源获取完整版本
 * NOTE: 由 player.ts 在 loadedmetadata 检测到试听时调用
 */
export async function tryGetFullVersionFromOtherSources(
    song: Song,
    quality: string
): Promise<SongUrlResult | null> {
    const songKey = `${song.id}_${song.source}`;

    // 避免重复搜索
    if (crossSourceSearchInProgress.has(songKey)) {
        console.log('跨源搜索已在进行中，跳过');
        return null;
    }

    crossSourceSearchInProgress.add(songKey);

    try {
        console.log('尝试从其他音乐源获取更优版本...');
        const artistName = Array.isArray(song.artist) ? song.artist[0] : song.artist;
        const result = await searchSongFromOtherSources(
            song.name,
            artistName,
            song.source || 'netease',
            quality
        );
        return result;
    } finally {
        crossSourceSearchInProgress.delete(songKey);
    }
}

export async function getSongUrl(song: Song, quality: string): Promise<SongUrlResult> {
    const gdstudioUrl = getGDStudioApiUrl();
    const necUrl = currentAPI.type === 'nec' ? currentAPI.url : 'https://nec8.de5.net';
    const metingUrl = getMetingApiUrl();
    const source = song.source || 'netease';

    // NOTE: 存储所有获取到的 URL，最后选择最佳的
    const candidates: SongUrlResult[] = [];

    // NOTE: 预检测 - 提前启动跨源搜索（如果启用）
    let crossSourcePromise: Promise<SongUrlResult | null> | null = null;
    const artistName = Array.isArray(song.artist) ? song.artist[0] : song.artist;

    // 1. 第一优先级：尝试 UnblockNeteaseMusic 解锁（仅网易云）
    if (source === 'netease') {
        try {
            console.log('优先尝试 NEC Unblock (match) 解锁...');
            const matchResponse = await fetchWithRetry(
                `${necUrl}/song/url/match?id=${song.id}&randomCNIP=true`
            );
            const matchData: NeteaseSongUrlResponse = await matchResponse.json();

            if (matchData.code === 200 && matchData.data?.[0]?.url) {
                const result: SongUrlResult = {
                    url: matchData.data[0].url,
                    br: String(matchData.data[0].br || quality),
                    size: matchData.data[0].size
                };
                if (!isProbablyPreview(result.url, result.size)) {
                    return result;
                }
                candidates.push(result);
                // 预检测：第一个候选可能是短版本，提前启动跨源搜索
                if (PREVIEW_DETECTION.PROACTIVE_CHECK && !crossSourcePromise) {
                    crossSourcePromise = searchSongFromOtherSources(song.name, artistName, source, quality);
                }
            }
        } catch (e) {
            console.warn('NEC Unblock 请求失败:', e);
        }
    }

    // 2. 第二优先级：尝试 GDStudio API（支持多音乐源）
    if (isGDStudioApiAvailable()) {
        try {
            console.log(`尝试使用 GDStudio API (${source}) 获取音频 URL...`);
            const response = await fetchWithRetry(
                `${gdstudioUrl}?types=url&source=${source}&id=${song.id}&br=${quality}`,
                {},
                1
            );
            const data: GDStudioUrlResponse = await response.json();

            if (data?.url) {
                markGDStudioApiAvailable();
                const fileSize = data.size ? data.size * 1024 : undefined;
                const result: SongUrlResult = {
                    url: data.url,
                    br: String(data.br || quality),
                    size: fileSize
                };
                if (!isProbablyPreview(result.url, result.size, song.duration)) {
                    // 取消跨源搜索（如果正在进行）
                    return result;
                }
                candidates.push(result);
                // 预检测：启动跨源搜索
                if (PREVIEW_DETECTION.PROACTIVE_CHECK && !crossSourcePromise) {
                    crossSourcePromise = searchSongFromOtherSources(song.name, artistName, source, quality);
                }
            }
        } catch (e) {
            console.warn('GDStudio API 请求失败:', e);
            if (e instanceof MusicError && e.message.includes('403')) {
                markGDStudioApiUnavailable();
            }
        }
    }

    // 3. 第三优先级：NEC 常规接口 (仅网易云)
    if (source === 'netease') {
        const level = quality === '999' ? 'hires' : quality === '740' ? 'lossless' : quality === '320' ? 'exhigh' : 'standard';
        try {
            const response = await fetchWithRetry(
                `${necUrl}/song/url/v1?id=${song.id}&level=${level}&randomCNIP=true`
            );
            const data: NeteaseSongUrlResponse = await response.json();

            if (data.code === 200 && data.data?.[0]?.url) {
                const result: SongUrlResult = {
                    url: data.data[0].url,
                    br: String(data.data[0].br || quality),
                    size: data.data[0].size
                };
                if (!isProbablyPreview(result.url, result.size)) {
                    return result;
                }
                candidates.push(result);
            }
        } catch (error) {
            console.warn('NEC 常规接口失败:', error);
        }

        // 3.5. 尝试备用 NEC API
        const backupResult = await getSongUrlFromNecApi(song.id, quality);
        if (backupResult && !isProbablyPreview(backupResult.url, backupResult.size)) {
            return backupResult;
        } else if (backupResult) {
            candidates.push(backupResult);
        }
    }

    // 4. 第四优先级：尝试 Meting API
    try {
        const response = await fetchWithRetry(`${metingUrl}/?type=song&id=${song.id}`);
        const data: MetingSong | MetingSong[] = await response.json();
        const result = Array.isArray(data) ? data[0] : data;

        if (result && result.url) {
            const urlResult: SongUrlResult = { url: result.url, br: quality };
            if (!isProbablyPreview(urlResult.url)) {
                return urlResult;
            }
            candidates.push(urlResult);
        }
    } catch (e) {
        console.warn('Meting API 请求失败:', e);
    }

    // 5. 等待预检测的跨源搜索结果（如果已启动）
    if (crossSourcePromise) {
        console.log('等待跨源搜索结果...');
        const crossSourceResult = await crossSourcePromise;
        if (crossSourceResult) {
            console.log('跨源搜索找到完整版本');
            return crossSourceResult;
        }
    }

    // 6. 如果预检测未启动或失败，再次尝试跨源搜索
    if (!crossSourcePromise && candidates.length > 0) {
        console.log('尝试跨源搜索更优版本...');
        const crossSourceResult = await searchSongFromOtherSources(
            song.name,
            artistName,
            source,
            quality
        );
        if (crossSourceResult) {
            return crossSourceResult;
        }
    }

    // 返回最佳候选
    if (candidates.length > 0) {
        return candidates[0];
    }

    console.warn('所有方式均无法获取 URL');
    return { url: '', br: quality };
}

/**
 * 获取歌词
 * NOTE: 优先使用 NEC API（最稳定），其次 GDStudio API
 * 同时获取原歌词和翻译歌词以支持双语显示
 */
export async function getLyrics(song: Song): Promise<LyricResult> {
    const source = song.source || 'netease';
    const necUrl = currentAPI.type === 'nec' ? currentAPI.url : 'https://nec8.de5.net';

    // 1. 优先使用 NEC API（仅网易云，最稳定）
    if (source === 'netease') {
        try {
            console.log('尝试 NEC API 获取歌词...');
            const response = await fetchWithRetry(`${necUrl}/lyric?id=${song.id}`, {}, 1);
            const data: NeteaseLyricResponse = await response.json();
            if (data.code === 200 && data.lrc?.lyric) {
                console.log('NEC API 获取歌词成功');
                return {
                    lyric: data.lrc.lyric,
                    tlyric: data.tlyric?.lyric || undefined
                };
            }
        } catch (error) {
            console.warn('NEC API 获取歌词失败:', error);
        }
    }

    // 2. 回退到 GDStudio API（支持多音乐源）
    if (isGDStudioApiAvailable()) {
        const gdstudioUrl = getGDStudioApiUrl();
        try {
            console.log('尝试 GDStudio API 获取歌词...');
            const response = await fetchWithRetry(
                `${gdstudioUrl}?types=lyric&source=${source}&id=${song.lyric_id || song.id}`,
                {},
                1  // 减少重试次数
            );
            const data: GDStudioLyricResponse = await response.json();
            if (data?.lyric) {
                markGDStudioApiAvailable();
                console.log('GDStudio API 获取歌词成功');
                return {
                    lyric: data.lyric,
                    tlyric: data.tlyric || undefined
                };
            }
        } catch (e) {
            console.warn('GDStudio API 获取歌词失败:', e);
            if (e instanceof MusicError && e.message.includes('403')) {
                markGDStudioApiUnavailable();
            }
        }
    }

    // 3. 返回空歌词
    console.log('无法获取歌词');
    return { lyric: '', tlyric: undefined };
}

/**
 * 将网易云歌曲详情转换为内部 Song 格式
 * NOTE: 保留时长信息用于试听检测
 */
function convertNeteaseDetailToSong(song: NeteaseSongDetail): Song {
    const album: NeteaseAlbum = song.al || { id: 0, name: '' };
    const artists: NeteaseArtist[] = song.ar || [];

    return {
        id: String(song.id),
        name: song.name,
        artist: artists.map(a => a.name),
        album: album.name || '',
        pic_id: String(album.picId || album.id || ''),
        pic_url: album.picUrl || '',
        lyric_id: String(song.id),
        source: 'netease',
        duration: song.dt // 保留时长信息（毫秒）
    };
}

/**
 * 搜索音乐
 * NOTE: 优先使用 GDStudio API（支持多音乐源），回退到 NEC API
 * @param keyword 搜索关键词
 * @param source 音乐源（默认 netease，可选：tencent/kuwo/kugou/migu/joox/spotify/apple/ytmusic/tidal/qobuz/deezer/ximalaya）
 */
export async function searchMusicAPI(keyword: string, source: string = 'netease'): Promise<Song[]> {
    const gdstudioUrl = getGDStudioApiUrl();
    const necUrl = currentAPI.type === 'nec' ? currentAPI.url : 'https://nec8.de5.net';

    // 1. 优先尝试 GDStudio API（支持多音乐源）
    // NOTE: 检查 GDStudio API 是否可用
    if (isGDStudioApiAvailable()) {
        try {
            console.log(`使用 GDStudio API 搜索 (${source}): ${keyword}`);
            const response = await fetchWithRetry(
                `${gdstudioUrl}?types=search&source=${source}&name=${encodeURIComponent(keyword)}&count=30`,
                {},
                0  // NOTE: 不重试，403 错误直接标记为不可用
            );
            const data = await response.json();

            // GDStudio API 返回数组或对象格式
            let songs: GDStudioSong[] = [];
            if (Array.isArray(data)) {
                songs = data as GDStudioSong[];
            } else if (typeof data === 'object' && data !== null) {
                // 对象格式，提取所有歌曲
                const values = Object.values(data);
                songs = values.filter((item): item is GDStudioSong => {
                    return !!(item && typeof item === 'object' && 'id' in item && 'name' in item);
                }) as GDStudioSong[];
            }

            if (songs.length > 0) {
                markGDStudioApiAvailable();
                console.log(`GDStudio API 搜索成功，找到 ${songs.length} 首歌曲`);
                return songs.map(song => ({
                    id: song.id,
                    name: song.name,
                    artist: Array.isArray(song.artist) ? song.artist : [song.artist],
                    album: song.album || '',
                    pic_id: song.pic_id || '',
                    pic_url: '',
                    lyric_id: song.lyric_id || song.id,
                    source: song.source || source
                }));
            }
        } catch (e) {
            console.warn('GDStudio API 搜索失败，回退到 NEC API:', e);
            if (e instanceof MusicError && e.message.includes('403')) {
                markGDStudioApiUnavailable();
            }
        }
    } else {
        console.log('GDStudio API 暂时不可用，直接使用 NEC API');
    }

    // 2. 回退到 NEC API（仅支持网易云）
    if (source === 'netease') {
        try {
            const response = await fetchWithRetry(`${necUrl}/search?keywords=${encodeURIComponent(keyword)}&limit=30`);
            const data: NeteaseSearchResponse = await response.json();

            if (data.code === 200 && data.result?.songs) {
                const searchSongs = data.result.songs;

                // NOTE: 搜索结果中缺少 picUrl，需要调用 /song/detail 获取详情
                try {
                    const ids = searchSongs.map(s => s.id).join(',');
                    if (ids) {
                        const detailResponse = await fetchWithRetry(`${necUrl}/song/detail?ids=${ids}`);
                        const detailData: NeteaseSongDetailResponse = await detailResponse.json();

                        if (detailData.code === 200 && detailData.songs) {
                            const detailMap = new Map<number, NeteaseSongDetail>(
                                detailData.songs.map(s => [s.id, s])
                            );

                            return searchSongs.map(song => {
                                const detail = detailMap.get(song.id);
                                if (detail) {
                                    return convertNeteaseDetailToSong(detail);
                                }
                                // 回退到搜索结果的基本信息
                                const album = song.album || { id: 0, name: '' };
                                const artists = song.artists || [];
                                return {
                                    id: String(song.id),
                                    name: song.name,
                                    artist: artists.map(a => a.name),
                                    album: album.name || '',
                                    pic_id: String(album.picId || album.id || ''),
                                    pic_url: album.picUrl || '',
                                    lyric_id: String(song.id),
                                    source: 'netease'
                                };
                            });
                        }
                    }
                } catch (detailError) {
                    console.warn('获取歌曲详情失败，使用基本信息:', detailError);
                }

                // 如果详情获取失败，回退到基本信息
                return searchSongs.map(song => {
                    const album = song.album || { id: 0, name: '' };
                    const artists = song.artists || [];
                    return {
                        id: String(song.id),
                        name: song.name,
                        artist: artists.map(a => a.name),
                        album: album.name || '',
                        pic_id: String(album.picId || album.id || ''),
                        pic_url: album.picUrl || '',
                        lyric_id: String(song.id),
                        source: 'netease'
                    };
                });
            }
        } catch (error) {
            console.error('NEC API 搜索失败:', error);
            throw new MusicError(
                MusicErrorType.API,
                `NEC API search failed: ${error}`,
                '搜索失败，请稍后重试',
                error instanceof Error ? error : undefined
            );
        }
    }

    return [];
}

/**
 * 探索雷达 - 获取热门推荐歌曲
 * NOTE: 包含多层回退机制，确保用户能看到内容
 */
export async function exploreRadarAPI(): Promise<Song[]> {
    const keywords = ['周杰伦', '林俊杰', '邓紫棋', '薛之谦', '陈奕迅', '五月天', '华晨宇', 'TFBOYS'];

    // 打乱关键词数组，使用 Fisher-Yates 洗牌算法
    const shuffled = [...keywords];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // 依次尝试不同关键词，直到成功获取数据
    for (const keyword of shuffled.slice(0, 3)) {
        try {
            const songs = await searchMusicAPI(keyword, 'netease');
            if (songs && songs.length > 0) {
                console.log(`探索雷达成功获取 ${songs.length} 首歌曲 (关键词: ${keyword})`);
                return songs;
            }
        } catch (error) {
            console.warn(`探索雷达请求失败 (关键词: ${keyword}):`, error);
        }
    }

    console.error('探索雷达: 所有关键词尝试均失败');
    return [];
}

/**
 * 解析歌单
 */
export async function parsePlaylistAPI(playlistUrlOrId: string): Promise<PlaylistParseResult> {
    let playlistId = playlistUrlOrId.trim();

    console.log('开始解析歌单:', playlistUrlOrId);

    // 支持多种URL格式
    if (playlistId.includes('music.163.com') || playlistId.includes('163cn.tv')) {
        const patterns = [/id=(\d+)/, /playlist\/(\d+)/, /\/(\d+)\?/, /\/(\d+)$/];
        let matched = false;
        for (const pattern of patterns) {
            const idMatch = playlistId.match(pattern);
            if (idMatch?.[1]) {
                playlistId = idMatch[1];
                matched = true;
                break;
            }
        }
        if (!matched) {
            throw new MusicError(
                MusicErrorType.PARSE,
                'Cannot extract playlist ID from URL',
                '无法从URL中提取歌单ID'
            );
        }
    } else if (!/^\d+$/.test(playlistId)) {
        throw new MusicError(
            MusicErrorType.PARSE,
            'Invalid playlist ID format',
            '歌单ID格式无效，请输入纯数字ID'
        );
    }

    if (currentAPI.type === 'nec') {
        // NEC API: /playlist/detail
        const response = await fetchWithRetry(`${currentAPI.url}/playlist/detail?id=${playlistId}`);
        const data: NeteasePlaylistDetailResponse = await response.json();

        if (data.code === 200 && data.playlist) {
            const trackIds = data.playlist.trackIds?.map(t => t.id).slice(0, 100) || [];

            // 获取歌曲详情
            const detailResponse = await fetchWithRetry(`${currentAPI.url}/song/detail?ids=${trackIds.join(',')}`);
            const detailData: NeteaseSongDetailResponse = await detailResponse.json();

            if (detailData.code === 200 && detailData.songs) {
                const songs = detailData.songs.map(convertNeteaseDetailToSong);

                return {
                    songs,
                    name: data.playlist.name,
                    count: songs.length
                };
            }
        }
        throw new MusicError(
            MusicErrorType.API,
            'Failed to parse playlist',
            '歌单解析失败，请检查歌单ID是否正确'
        );
    } else {
        // NOTE: 始终使用 Meting API URL 解析歌单，而非 currentAPI（可能是 GDStudio）
        const metingUrl = getMetingApiUrl();
        const response = await fetchWithRetry(`${metingUrl}/?type=playlist&id=${playlistId}`);
        const playlistData: MetingSong[] | MetingErrorResponse = await response.json();

        if (!playlistData) {
            throw new MusicError(
                MusicErrorType.API,
                'API returned empty data',
                'API返回空数据'
            );
        }

        if ('error' in playlistData || 'msg' in playlistData) {
            const errorData = playlistData as MetingErrorResponse;
            throw new MusicError(
                MusicErrorType.API,
                errorData.error || errorData.msg || 'Unknown error',
                errorData.error || errorData.msg || '未知错误'
            );
        }

        let songs: Song[] = [];
        const playlistName = '未命名歌单';

        if (Array.isArray(playlistData)) {
            songs = playlistData.map(song => ({
                id: song.id,
                name: song.name,
                artist: Array.isArray(song.artist) ? song.artist : [song.artist],
                album: song.album || '',
                pic_id: '',
                pic_url: song.pic || '',
                lyric_id: song.id,
                source: 'netease'
            }));
        }

        return { songs, name: playlistName, count: songs.length };
    }
}
