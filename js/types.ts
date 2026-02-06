/**
 * 云音乐播放器 - 类型定义模块
 * 包含所有 API 响应和内部数据结构的类型定义
 */

// ============================================
// Window 扩展类型
// ============================================

/**
 * 扩展 Window 接口，添加自定义全局函数
 */
declare global {
    interface Window {
        /** 移动端页面切换函数 */
        switchMobilePage?: (pageIndex: number) => void;
    }
}

// ============================================
// 内部数据结构
// ============================================

/**
 * 歌曲数据结构
 */
export interface Song {
    /** 歌曲 ID */
    id: string;
    /** 歌曲名称 */
    name: string;
    /** 歌手列表 */
    artist: string[];
    /** 专辑名称 */
    album: string;
    /** 封面图片 ID 或 URL */
    pic_id: string;
    /** 歌词 ID */
    lyric_id: string;
    /** 音乐源标识 */
    source: string;
    /** 封面 URL（用于 NEC API） */
    pic_url?: string;
    /** 歌曲时长（毫秒）- 用于试听检测 */
    duration?: number;
}

/**
 * 歌词行数据结构
 */
export interface LyricLine {
    /** 时间戳（秒） */
    time: number;
    /** 歌词文本 */
    text: string;
    /** 翻译歌词文本（可选） */
    ttext?: string;
}

/**
 * 歌单数据结构
 */
export interface PlaylistData {
    /** 歌单名称 */
    name: string;
    /** 歌曲列表 */
    songs: Song[];
    /** 歌单 ID */
    id: string;
    /** 创建时间 */
    createTime: string;
    /** 是否为收藏歌单 */
    isFavorites?: boolean;
}

/**
 * 播放模式
 */
export type PlayMode = 'loop' | 'random' | 'single';

// ============================================
// API 配置类型
// ============================================

/**
 * API 源类型
 */
export type ApiType = 'nec' | 'meting' | 'gdstudio';

/**
 * API 源配置
 */
export interface ApiSource {
    /** API 名称 */
    name: string;
    /** API 基础 URL */
    url: string;
    /** API 类型 */
    type: ApiType;
    /** 是否支持搜索功能 */
    supportsSearch: boolean;
}

// ============================================
// 网易云音乐 API 响应类型
// ============================================

/**
 * 网易云音乐艺术家信息
 */
export interface NeteaseArtist {
    /** 艺术家 ID */
    id: number;
    /** 艺术家名称 */
    name: string;
    /** 艺术家别名 */
    alias?: string[];
    /** 艺术家头像 URL */
    picUrl?: string;
}

/**
 * 网易云音乐专辑信息
 */
export interface NeteaseAlbum {
    /** 专辑 ID */
    id: number;
    /** 专辑名称 */
    name: string;
    /** 封面图片 ID */
    picId?: number;
    /** 封面图片 URL */
    picUrl?: string;
    /** 发布时间 */
    publishTime?: number;
}

/**
 * 网易云音乐歌曲信息（搜索结果格式）
 */
export interface NeteaseSongSearch {
    /** 歌曲 ID */
    id: number;
    /** 歌曲名称 */
    name: string;
    /** 艺术家列表（搜索结果格式） */
    artists?: NeteaseArtist[];
    /** 专辑信息（搜索结果格式） */
    album?: NeteaseAlbum;
    /** 歌曲时长（毫秒） */
    duration?: number;
    /** 是否有 MV */
    mvid?: number;
}

/**
 * 网易云音乐歌曲信息（详情格式）
 */
export interface NeteaseSongDetail {
    /** 歌曲 ID */
    id: number;
    /** 歌曲名称 */
    name: string;
    /** 艺术家列表（详情格式） */
    ar?: NeteaseArtist[];
    /** 专辑信息（详情格式） */
    al?: NeteaseAlbum;
    /** 歌曲时长（毫秒） */
    dt?: number;
    /** 是否有 MV */
    mv?: number;
}

/**
 * 网易云音乐搜索 API 响应
 */
export interface NeteaseSearchResponse {
    /** 响应状态码 */
    code: number;
    /** 搜索结果 */
    result?: {
        /** 歌曲列表 */
        songs?: NeteaseSongSearch[];
        /** 歌曲总数 */
        songCount?: number;
    };
}

/**
 * 网易云音乐歌曲详情 API 响应
 */
export interface NeteaseSongDetailResponse {
    /** 响应状态码 */
    code: number;
    /** 歌曲详情列表 */
    songs?: NeteaseSongDetail[];
}

/**
 * 网易云音乐歌曲 URL API 响应
 */
export interface NeteaseSongUrlResponse {
    /** 响应状态码 */
    code: number;
    /** URL 数据列表 */
    data?: {
        /** 歌曲 ID */
        id: number;
        /** 播放 URL */
        url: string | null;
        /** 比特率 */
        br: number;
        /** 文件大小 */
        size: number;
        /** 音质类型 */
        type: string;
    }[];
}

/**
 * 网易云音乐歌词 API 响应
 */
export interface NeteaseLyricResponse {
    /** 响应状态码 */
    code: number;
    /** 原版歌词 */
    lrc?: {
        /** 歌词内容 */
        lyric: string;
    };
    /** 翻译歌词 */
    tlyric?: {
        /** 歌词内容 */
        lyric: string;
    };
}

/**
 * 网易云音乐歌单详情 API 响应
 */
export interface NeteasePlaylistDetailResponse {
    /** 响应状态码 */
    code: number;
    /** 歌单信息 */
    playlist?: {
        /** 歌单 ID */
        id: number;
        /** 歌单名称 */
        name: string;
        /** 歌曲 ID 列表 */
        trackIds?: { id: number }[];
        /** 歌曲数量 */
        trackCount?: number;
    };
}

// ============================================
// Meting API 响应类型
// ============================================

/**
 * Meting API 歌曲信息
 */
export interface MetingSong {
    /** 歌曲 ID */
    id: string;
    /** 歌曲名称 */
    name: string;
    /** 艺术家 */
    artist: string | string[];
    /** 专辑名称 */
    album?: string;
    /** 封面 URL */
    pic?: string;
    /** 歌词 URL */
    lrc?: string;
    /** 播放 URL */
    url?: string;
    /** URL ID (用于搜索结果回退) */
    url_id?: string;
    /** 封面图片 ID */
    pic_id?: string;
    /** 歌词 ID */
    lyric_id?: string;
    /** 音乐源 */
    source?: string;
}

/**
 * Meting API 错误响应
 */
export interface MetingErrorResponse {
    /** 错误信息 */
    error?: string;
    /** 错误消息 */
    msg?: string;
}

// ============================================
// GDStudio API 响应类型
// ============================================

/**
 * GDStudio API 搜索响应
 */
export interface GDStudioSearchResponse {
    /** 搜索结果列表 */
    [key: string]: GDStudioSong;
}

/**
 * GDStudio API 歌曲信息
 */
export interface GDStudioSong {
    /** 歌曲 ID */
    id: string;
    /** 歌曲名称 */
    name: string;
    /** 歌手列表 */
    artist: string | string[];
    /** 专辑名称 */
    album?: string;
    /** 封面图片 ID */
    pic_id?: string;
    /** 歌词 ID */
    lyric_id?: string;
    /** 音乐源 */
    source: string;
}

/**
 * GDStudio API 歌曲响应
 */
export interface GDStudioUrlResponse {
    /** 播放 URL */
    url: string;
    /** 实际音质 */
    br: string;
    /** 文件大小 (KB) */
    size?: number;
}

/**
 * GDStudio API 歌词响应
 */
export interface GDStudioLyricResponse {
    /** LRC 格式歌词 */
    lyric?: string;
    /** 翻译歌词 */
    tlyric?: string;
}

/**
 * GDStudio API 封面响应
 */
export interface GDStudioPicResponse {
    /** 封面 URL */
    url: string;
}

// ============================================
// 通用 API 响应类型
// ============================================

/**
 * 歌曲 URL 结果
 */
export interface SongUrlResult {
    /** 播放 URL */
    url: string;
    /** 比特率 */
    br: string;
    /** 文件大小（字节）*/
    size?: number;
    /** 音乐源标识 */
    source?: string;
}

/**
 * 歌词结果
 */
export interface LyricResult {
    /** 歌词内容 */
    lyric: string;
    /** 翻译歌词内容（可选） */
    tlyric?: string;
}

/**
 * 歌单解析结果
 */
export interface PlaylistParseResult {
    /** 歌曲列表 */
    songs: Song[];
    /** 歌单名称 */
    name?: string;
    /** 歌曲数量 */
    count?: number;
}

/**
 * API 检测结果
 */
export interface ApiDetectionResult {
    /** 是否成功 */
    success: boolean;
    /** API 名称 */
    name?: string;
}

// ============================================
// 错误类型
// ============================================

/**
 * 音乐播放器错误类型
 */
export enum MusicErrorType {
    /** 网络错误 */
    NETWORK = 'NETWORK',
    /** API 错误 */
    API = 'API',
    /** 播放错误 */
    PLAYBACK = 'PLAYBACK',
    /** 解析错误 */
    PARSE = 'PARSE',
    /** 未知错误 */
    UNKNOWN = 'UNKNOWN',
}

/**
 * 音乐播放器错误
 */
export class MusicError extends Error {
    /** 错误类型 */
    type: MusicErrorType;
    /** 原始错误 */
    cause?: Error;
    /** 用户友好的错误消息 */
    userMessage: string;

    constructor(type: MusicErrorType, message: string, userMessage: string, cause?: Error) {
        super(message);
        this.name = 'MusicError';
        this.type = type;
        this.userMessage = userMessage;
        this.cause = cause;
    }
}

// ============================================
// UI 相关类型
// ============================================

/**
 * 通知类型
 */
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

/**
 * DOM 缓存接口
 */
export interface DOMCache {
    searchResults: HTMLElement | null;
    parseResults: HTMLElement | null;
    currentCover: HTMLImageElement | null;
    currentTitle: HTMLElement | null;
    currentArtist: HTMLElement | null;
    playBtn: HTMLElement | null;
    progressFill: HTMLElement | null;
    currentTime: HTMLElement | null;
    totalTime: HTMLElement | null;
    lyricsContainer: HTMLElement | null;
    downloadSongBtn: HTMLButtonElement | null;
    downloadLyricBtn: HTMLButtonElement | null;
    inlineLyricText: HTMLElement | null;
}

/**
 * 滚动状态接口
 */
export interface ScrollState {
    songs: Song[];
    containerId: string;
    playlistForPlayback: Song[];
    renderedCount: number;
    batchSize: number;
}

// ============================================
// 歌手与电台类型
// ============================================

/**
 * 歌手信息
 */
export interface ArtistInfo {
    id: number;
    name: string;
    picUrl?: string;
    albumSize?: number;
    musicSize?: number;
}

/**
 * 歌手列表 API 响应
 */
export interface ArtistListResponse {
    code: number;
    more: boolean;
    artists?: ArtistInfo[];
}

/**
 * 歌手热门歌曲 API 响应
 */
export interface ArtistTopSongResponse {
    code: number;
    songs?: NeteaseSongDetail[];
}

/**
 * 电台信息
 */
export interface RadioStation {
    id: number;
    name: string;
    picUrl?: string;
    dj?: { nickname: string };
    desc?: string;
    programCount?: number;
    subCount?: number;
    categoryName?: string;
}

/**
 * 热门电台 API 响应
 */
export interface RadioHotResponse {
    code: number;
    djRadios?: RadioStation[];
}

/**
 * 电台节目
 */
export interface RadioProgram {
    id: number;
    name: string;
    mainTrackId: number;
    description?: string;
    duration: number;
    coverUrl?: string;
    dj?: { nickname: string };
}

/**
 * 电台节目 API 响应
 */
export interface RadioProgramResponse {
    code: number;
    programs?: RadioProgram[];
    more?: boolean;
}

/**
 * 电台分类
 */
export interface RadioCategory {
    id: number;
    name: string;
}

/**
 * 电台分类列表 API 响应
 */
export interface RadioCateListResponse {
    code: number;
    categories?: RadioCategory[];
}

/**
 * 电台推荐 API 响应（按分类）
 */
export interface RadioRecommendResponse {
    code: number;
    djRadios?: RadioStation[];
}
