/**
 * 云音乐播放器 - API 模块入口
 * 负责聚合子模块并对外提供统一接口
 */

// 重新导出类型
export type { Song } from './types';

// 导出客户端底层
export {
    PROXY_ENDPOINT,
    toProxyUrl,
    fetchWithRetry
} from './api/client';

// 导出源配置与状态
export {
    API_SOURCES,
    currentAPI,
    isGDStudioApiAvailable,
    markGDStudioApiUnavailable,
    markGDStudioApiAvailable,
    getMetingApiUrl,
    getNecApiUrl,
    getGDStudioApiUrl,
    testAPI,
    findWorkingAPI
} from './api/sources';

// 导出资源解析
export {
    isProbablyPreview,
    getAlbumCoverUrl,
    searchSongFromOtherSources,
    tryGetFullVersionFromOtherSources,
    tryGetFullVersionFromNeteaseUnblock,
    getSongUrl,
    getLyrics
} from './api/music';

// 导出搜索与歌单
export {
    searchMusicAPI,
    exploreRadarAPI,
    parsePlaylistAPI,
    getArtistList,
    getArtistTopSongs,
    getHotRadio,
    getRadioPrograms,
    getRadioCateList,
    getRadioByCategory
} from './api/search';

// 导出工具函数 (如果需要的话)
export {
    calculateSimilarity,
    calculateSongMatchScore,
    getSortedFallbackSources,
    saveSourceStats,
    loadSourceStats
} from './api/utils';

// 初始化
import { loadSourceStats } from './api/utils';
loadSourceStats();
