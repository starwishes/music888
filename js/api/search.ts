/**
 * 云音乐播放器 - 搜索与歌单模块
 * 负责歌曲搜索、歌单解析和发现功能
 */

import {
    Song,
    NeteaseSearchResponse,
    NeteaseSongDetailResponse,
    NeteaseSongDetail,
    NeteaseArtist,
    NeteaseAlbum,
    GDStudioSong,
    PlaylistParseResult,
    NeteasePlaylistDetailResponse,
    MusicError,
    ArtistInfo,
    ArtistListResponse,
    ArtistTopSongResponse,
    RadioStation,
    RadioHotResponse,
    RadioProgram,
    RadioProgramResponse,
    RadioCategory,
    RadioCateListResponse,
    RadioRecommendResponse
} from '../types';

import { fetchWithRetry } from './client';
import {
    getGDStudioApiUrl,
    getNecApiUrl,
    getMetingApiUrl,
    isGDStudioApiAvailable,
    markGDStudioApiAvailable,
    markGDStudioApiUnavailable,
    currentAPI
} from './sources';

/**
 * 将网易云详情映射为内部 Song
 */
export function convertNeteaseDetailToSong(song: NeteaseSongDetail): Song {
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
        duration: song.dt
    };
}

/**
 * 搜索音乐
 */
export async function searchMusicAPI(keyword: string, source: string = 'netease'): Promise<Song[]> {
    // 1. GDStudio 优先
    if (isGDStudioApiAvailable()) {
        try {
            const res = await fetchWithRetry(`${getGDStudioApiUrl()}?types=search&source=${source}&name=${encodeURIComponent(keyword)}&count=20`, {}, 0);
            const data = await res.json();
            const songs: GDStudioSong[] = Array.isArray(data) ? data : Object.values(data || {});

            if (songs.length > 0) {
                markGDStudioApiAvailable();
                return songs.map(s => ({
                    id: s.id,
                    name: s.name,
                    artist: Array.isArray(s.artist) ? s.artist : [s.artist],
                    album: s.album || '',
                    pic_id: s.pic_id || '',
                    pic_url: '',
                    lyric_id: s.lyric_id || s.id,
                    source: s.source || source
                }));
            }
        } catch (e) {
            if (e instanceof MusicError && e.message.includes('403')) markGDStudioApiUnavailable();
        }
    }

    // 2. NEC 回退
    if (source === 'netease') {
        try {
            const res = await fetchWithRetry(`${getNecApiUrl()}/search?keywords=${encodeURIComponent(keyword)}&limit=30`);
            const data: NeteaseSearchResponse = await res.json();
            if (data.code === 200 && data.result?.songs) {
                // 获取详情以补全封面
                const ids = data.result.songs.map(s => s.id).join(',');
                const detailRes = await fetchWithRetry(`${getNecApiUrl()}/song/detail?ids=${ids}`);
                const detailData: NeteaseSongDetailResponse = await detailRes.json();
                if (detailData.code === 200 && detailData.songs) {
                    return detailData.songs.map(convertNeteaseDetailToSong);
                }
            }
        } catch (e) { /* ignore */ }
    }

    return [];
}

/**
 * 发现雷达
 */
export async function exploreRadarAPI(): Promise<Song[]> {
    const keywords = ['周杰伦', '陈奕迅', '林俊杰', '邓紫棋'];
    const keyword = keywords[Math.floor(Math.random() * keywords.length)];
    return await searchMusicAPI(keyword);
}

/**
 * 解析歌单
 */
export async function parsePlaylistAPI(playlistUrlOrId: string): Promise<PlaylistParseResult> {
    let id = playlistUrlOrId.trim();
    const idMatch = id.match(/id=(\d+)/) || id.match(/playlist\/(\d+)/);
    if (idMatch) id = idMatch[1];

    // 验证歌单 ID 必须为纯数字，防止参数注入
    if (!/^\d+$/.test(id)) {
        throw new Error('无效的歌单ID，请输入纯数字ID或包含ID的链接');
    }

    if (currentAPI.type === 'nec') {
        const res = await fetchWithRetry(`${getNecApiUrl()}/playlist/detail?id=${id}`);
        const data: NeteasePlaylistDetailResponse = await res.json();
        if (data.code === 200 && data.playlist) {
            const trackIds = data.playlist.trackIds?.map(t => t.id).slice(0, 50).join(',') || '';
            const detailRes = await fetchWithRetry(`${getNecApiUrl()}/song/detail?ids=${trackIds}`);
            const detailData: NeteaseSongDetailResponse = await detailRes.json();
            if (detailData.code === 200 && detailData.songs) {
                return { songs: detailData.songs.map(convertNeteaseDetailToSong), name: data.playlist.name };
            }
        }
    } else {
        const res = await fetchWithRetry(`${getMetingApiUrl()}/?type=playlist&id=${id}`);
        const data = await res.json();
        if (Array.isArray(data)) {
            return {
                songs: data.map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    artist: Array.isArray(s.artist) ? s.artist : [s.artist],
                    album: s.album || '',
                    pic_id: '',
                    pic_url: s.pic || '',
                    lyric_id: s.id,
                    source: 'netease'
                })),
                name: '网易云歌单'
            };
        }
    }
    throw new Error('歌单解析失败');
}

/**
 * 获取歌手列表
 */
export async function getArtistList(area = -1, type = -1, initial: string | number = -1, limit = 60, offset = 0): Promise<{ artists: ArtistInfo[], more: boolean }> {
    const res = await fetchWithRetry(`${getNecApiUrl()}/artist/list?type=${type}&area=${area}&initial=${initial}&limit=${limit}&offset=${offset}`);
    const data: ArtistListResponse = await res.json();
    return {
        artists: data.code === 200 && data.artists ? data.artists : [],
        more: data.more ?? false
    };
}

/**
 * 获取歌手热门歌曲
 */
export async function getArtistTopSongs(id: number): Promise<Song[]> {
    const res = await fetchWithRetry(`${getNecApiUrl()}/artist/top/song?id=${id}`);
    const data: ArtistTopSongResponse = await res.json();
    return data.code === 200 && data.songs ? data.songs.map(convertNeteaseDetailToSong) : [];
}

/**
 * 获取热门电台
 */
export async function getHotRadio(limit = 60, offset = 0): Promise<{ radios: RadioStation[], hasMore: boolean }> {
    const res = await fetchWithRetry(`${getNecApiUrl()}/dj/hot?limit=${limit}&offset=${offset}`);
    const data: RadioHotResponse = await res.json();
    const radios = data.code === 200 && data.djRadios ? data.djRadios : [];
    return { radios, hasMore: radios.length >= limit };
}

/**
 * 获取电台节目列表
 */
export async function getRadioPrograms(rid: number, limit = 50, offset = 0): Promise<{ programs: RadioProgram[], more: boolean }> {
    const res = await fetchWithRetry(`${getNecApiUrl()}/dj/program?rid=${rid}&limit=${limit}&offset=${offset}`);
    const data: RadioProgramResponse = await res.json();
    return {
        programs: data.code === 200 && data.programs ? data.programs : [],
        more: data.more ?? false
    };
}

/**
 * 获取电台分类列表
 */
export async function getRadioCateList(): Promise<RadioCategory[]> {
    const res = await fetchWithRetry(`${getNecApiUrl()}/dj/catelist`);
    const data: RadioCateListResponse = await res.json();
    return data.code === 200 && data.categories ? data.categories : [];
}

/**
 * 按分类获取电台
 */
export async function getRadioByCategory(cateId: number, limit = 60, offset = 0): Promise<{ radios: RadioStation[], hasMore: boolean }> {
    const res = await fetchWithRetry(`${getNecApiUrl()}/dj/recommend/type?type=${cateId}&limit=${limit}&offset=${offset}`);
    const data: RadioRecommendResponse = await res.json();
    const radios = data.code === 200 && data.djRadios ? data.djRadios : [];
    return { radios, hasMore: radios.length >= limit };
}
