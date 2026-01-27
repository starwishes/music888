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
const GDSTUDIO_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

/**
 * 检查 GDStudio API 是否可用（带缓存）
 */
function isGDStudioApiAvailable(): boolean {
    const now = Date.now();
    // 如果缓存过期或未检测，返回 true 让它尝试
    if (gdstudioApiAvailable === null || now - gdstudioApiLastCheck > GDSTUDIO_CACHE_TTL) {
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
    console.warn('GDStudio API 标记为不可用，将在 5 分钟后重试');
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
 * 检测是否需要使用代理
 * 开发环境使用 Vite 代理，生产环境使用 Vercel Serverless Function
 */
function shouldUseProxy(): boolean {
    return true;
}

/**
 * 将外部 URL 转换为代理 URL
 * @param url 原始外部 API URL
 * @returns 代理后的 URL
 */
function toProxyUrl(url: string): string {
    if (!shouldUseProxy()) {
        return url;
    }
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
            console.log(`✅ ${api.name} 可用`);
            return { success: true, name: api.name };
        } else {
            console.log(`❌ ${api.name} 不可用`);
        }
    }
    console.error('所有 API 均不可用');
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

    // 3. 最后尝试 CDN 构造
    try {
        return `https://p1.music.126.net/${song.pic_id}/${song.pic_id}.jpg?param=${size}y${size}`;
    } catch (error) {
        console.error('获取专辑图失败:', error);
        return '';
    }
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
 * NOTE: 试听版本通常包含特定的 URL 模式
 */
function isProbablyPreview(url: string): boolean {
    // 常见的试听版本 URL 特征
    const previewPatterns = [
        /preview/i,
        /trial/i,
        /sample/i,
        /\.30\./,  // 30秒试听
        /\.60\./,  // 60秒试听
    ];
    return previewPatterns.some(pattern => pattern.test(url));
}

/**
 * 备选音乐源列表，用于跨源搜索
 * NOTE: 当主源返回试听版本时，尝试从这些源获取完整版本
 */
const FALLBACK_SOURCES = ['kuwo', 'kugou', 'migu', 'tencent'];

/**
 * 从指定音乐源直接获取歌曲 URL（内部函数）
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
            1  // 减少重试次数
        );
        const data: GDStudioUrlResponse = await response.json();
        
        if (data?.url) {
            markGDStudioApiAvailable();
            return { url: data.url, br: String(data.br || quality) };
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
 * 跨音乐源搜索同名歌曲
 * NOTE: 当主源返回试听版本时，尝试从其他源搜索同名歌曲
 */
async function searchSongFromOtherSources(
    songName: string,
    artistName: string,
    excludeSource: string,
    quality: string
): Promise<SongUrlResult | null> {
    // NOTE: 检查 GDStudio API 是否可用
    if (!isGDStudioApiAvailable()) {
        console.log('GDStudio API 暂时不可用，跳过跨源搜索');
        return null;
    }
    
    const gdstudioUrl = getGDStudioApiUrl();
    const searchKeyword = `${songName} ${artistName}`;
    
    console.log(`尝试从其他音乐源搜索: ${searchKeyword}`);
    
    for (const source of FALLBACK_SOURCES) {
        if (source === excludeSource) continue;
        
        try {
            console.log(`尝试从 ${source} 搜索...`);
            const response = await fetchWithRetry(
                `${gdstudioUrl}?types=search&source=${source}&name=${encodeURIComponent(searchKeyword)}&count=5`,
                {},
                1  // 减少重试次数
            );
            const data = await response.json();
            
            // 解析搜索结果
            let songs: GDStudioSong[] = [];
            if (Array.isArray(data)) {
                songs = data as GDStudioSong[];
            } else if (typeof data === 'object' && data !== null) {
                const values = Object.values(data);
                songs = values.filter((item): item is GDStudioSong => {
                    return !!(item && typeof item === 'object' && 'id' in item && 'name' in item);
                }) as GDStudioSong[];
            }
            
            // 查找匹配的歌曲（名称相似）
            for (const song of songs) {
                // 简单的名称匹配：检查歌曲名是否包含在搜索结果中
                const normalizedSongName = songName.toLowerCase().replace(/\s+/g, '');
                const normalizedResultName = song.name.toLowerCase().replace(/\s+/g, '');
                
                if (normalizedResultName.includes(normalizedSongName) ||
                    normalizedSongName.includes(normalizedResultName)) {
                    // 尝试获取这首歌的 URL
                    const urlResult = await getSongUrlFromSource(song.id, source, quality);
                    if (urlResult && urlResult.url && !isProbablyPreview(urlResult.url)) {
                        console.log(`从 ${source} 找到完整版本:`, urlResult.url.substring(0, 50) + '...');
                        return urlResult;
                    }
                }
            }
        } catch (e) {
            console.warn(`从 ${source} 搜索失败:`, e);
        }
    }
    
    return null;
}

export async function getSongUrl(song: Song, quality: string): Promise<SongUrlResult> {
    const gdstudioUrl = getGDStudioApiUrl();
    const necUrl = currentAPI.type === 'nec' ? currentAPI.url : 'https://nec8.de5.net';
    const metingUrl = getMetingApiUrl();
    const source = song.source || 'netease';

    // NOTE: 存储所有获取到的 URL，最后选择最佳的
    const candidates: SongUrlResult[] = [];

    // 1. 第一优先级：尝试 UnblockNeteaseMusic 解锁（仅网易云）
    // NOTE: 优先使用 Unblock 接口，它更可能返回完整版本
    if (source === 'netease') {
        try {
            console.log('优先尝试 NEC Unblock (match) 解锁灰色/VIP 歌曲...');
            const matchResponse = await fetchWithRetry(
                `${necUrl}/song/url/match?id=${song.id}&randomCNIP=true`
            );
            const matchData: NeteaseSongUrlResponse = await matchResponse.json();

            if (matchData.code === 200 && matchData.data?.[0]?.url) {
                const result: SongUrlResult = {
                    url: matchData.data[0].url,
                    br: String(matchData.data[0].br || quality)
                };
                console.log('NEC Unblock 解锁成功:', result.url.substring(0, 80) + '...');
                // 如果不是试听版本，直接返回
                if (!isProbablyPreview(result.url)) {
                    return result;
                }
                candidates.push(result);
            }
        } catch (e) {
            console.warn('NEC Unblock 请求失败:', e);
        }
    }

    // 2. 第二优先级：尝试 GDStudio API（支持多音乐源）
    // NOTE: 检查 GDStudio API 是否可用
    if (isGDStudioApiAvailable()) {
        try {
            console.log(`尝试使用 GDStudio API (${source}) 获取音频 URL...`);
            const response = await fetchWithRetry(
                `${gdstudioUrl}?types=url&source=${source}&id=${song.id}&br=${quality}`,
                {},
                1  // 减少重试次数
            );
            const data: GDStudioUrlResponse = await response.json();

            if (data?.url) {
                markGDStudioApiAvailable();
                console.log(`GDStudio API 获取成功 (${data.br}K):`, data.url.substring(0, 50) + '...');
                const result = { url: data.url, br: String(data.br || quality) };
                if (!isProbablyPreview(result.url)) {
                    return result;
                }
                candidates.push(result);
            }
        } catch (e) {
            console.warn('GDStudio API 请求失败:', e);
            // 如果是 403 错误，标记 API 不可用
            if (e instanceof MusicError && e.message.includes('403')) {
                markGDStudioApiUnavailable();
            }
        }
    }

    // 3. 第三优先级：NEC 常规接口 (仅网易云)
    if (source === 'netease') {
        const level = quality === '999' ? 'hires' : quality === '740' ? 'lossless' : quality === '320' ? 'exhigh' : 'standard';
        try {
            console.log('尝试 NEC 常规接口...');
            const response = await fetchWithRetry(
                `${necUrl}/song/url/v1?id=${song.id}&level=${level}&randomCNIP=true`
            );
            const data: NeteaseSongUrlResponse = await response.json();

            if (data.code === 200 && data.data?.[0]?.url) {
                const result: SongUrlResult = {
                    url: data.data[0].url,
                    br: String(data.data[0].br || quality)
                };
                console.log('NEC 常规接口获取成功:', result.url.substring(0, 80) + '...');
                if (!isProbablyPreview(result.url)) {
                    return result;
                }
                candidates.push(result);
            }
        } catch (error) {
            console.warn('NEC 常规接口失败:', error);
        }
    }

    // 4. 第四优先级：尝试 Meting API
    try {
        console.log('尝试使用 Meting API 获取音频 URL...');
        const response = await fetchWithRetry(`${metingUrl}/?type=song&id=${song.id}`);
        const data: MetingSong | MetingSong[] = await response.json();

        const result = Array.isArray(data) ? data[0] : data;

        if (result && result.url) {
            console.log('Meting API 获取成功:', result.url.substring(0, 50) + '...');
            const urlResult = { url: result.url, br: quality };
            if (!isProbablyPreview(urlResult.url)) {
                return urlResult;
            }
            candidates.push(urlResult);
        }
    } catch (e) {
        console.warn('Meting API 请求失败:', e);
    }

    // 5. 第五优先级：跨音乐源搜索（当所有候选都是试听版本时）
    // NOTE: 尝试从其他音乐源搜索同名歌曲获取完整版本
    if (candidates.length > 0) {
        console.log('所有候选可能是试听版本，尝试跨源搜索...');
        const artistName = Array.isArray(song.artist) ? song.artist[0] : song.artist;
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

    // 如果所有 URL 都可能是试听版本，返回第一个候选
    if (candidates.length > 0) {
        console.warn('所有获取到的 URL 可能是试听版本，使用第一个候选');
        return candidates[0];
    }

    console.warn('所有方式均无法获取 URL');
    return { url: '', br: quality };
}

/**
 * 获取歌词
 * NOTE: 优先使用 GDStudio API，其次 Meting API，最后 NEC API
 */
export async function getLyrics(song: Song): Promise<LyricResult> {
    const gdstudioUrl = getGDStudioApiUrl();
    const metingUrl = getMetingApiUrl();
    const source = song.source || 'netease';

    // 1. 优先尝试 GDStudio API
    try {
        const response = await fetchWithRetry(
            `${gdstudioUrl}?types=lyric&source=${source}&id=${song.lyric_id || song.id}`
        );
        const data: GDStudioLyricResponse = await response.json();
        if (data?.lyric) {
            return { lyric: data.lyric };
        }
    } catch (e) {
        console.warn('GDStudio API 获取歌词失败，尝试 Meting API:', e);
    }

    // 2. 回退到 Meting API
    try {
        const response = await fetchWithRetry(`${metingUrl}/?type=lrc&id=${song.lyric_id || song.id}`);
        const text = await response.text();

        try {
            const result: { lyric?: string; lrc?: string } = JSON.parse(text);
            if (result && (result.lyric || result.lrc)) {
                return { lyric: result.lyric || result.lrc || '' };
            }
        } catch {
            if (text && text.length > 0) {
                return { lyric: text };
            }
        }
    } catch (e) {
        console.warn('Meting API 获取歌词失败，回退到 NEC API:', e);
    }

    // 3. 最后回退到 NEC API（仅网易云）
    if (source === 'netease') {
        const necUrl = currentAPI.type === 'nec' ? currentAPI.url : 'https://nec8.de5.net';
        try {
            const response = await fetchWithRetry(`${necUrl}/lyric?id=${song.id}`);
            const data: NeteaseLyricResponse = await response.json();
            if (data.code === 200) {
                return { lyric: data.lrc?.lyric || '' };
            }
            return { lyric: '' };
        } catch (error) {
            console.error('获取歌词失败:', error);
            return { lyric: '' };
        }
    }

    return { lyric: '' };
}

/**
 * 将网易云歌曲详情转换为内部 Song 格式
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
        source: 'netease'
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
    try {
        console.log(`使用 GDStudio API 搜索 (${source}): ${keyword}`);
        const response = await fetchWithRetry(
            `${gdstudioUrl}?types=search&source=${source}&name=${encodeURIComponent(keyword)}&count=30`
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

    // 打乱关键词数组，增加随机性
    const shuffled = keywords.sort(() => Math.random() - 0.5);

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
        // Meting API 新格式: /?type=playlist&id=xxx
        const response = await fetchWithRetry(`${currentAPI.url}/?type=playlist&id=${playlistId}`);
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
