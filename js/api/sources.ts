/**
 * 云音乐播放器 - API 源配置模块
 * 负责 API 来源定义、可用性检测和状态切换
 */

import { ApiSource, ApiDetectionResult } from '../types';
import { NCM_BASE_URL, logger } from '../config';
import { gdstudioCircuit, CircuitState } from '../circuit-breaker';
import { fetchWithRetry } from './client';

/** API 源配置列表 */
export const API_SOURCES: ApiSource[] = [
    {
        name: 'GDStudio API',
        url: 'https://music-api.gdstudio.xyz/api.php',
        type: 'gdstudio',
        supportsSearch: true,
    },
    {
        name: 'NEC API (Docker)',
        url: NCM_BASE_URL,
        type: 'nec',
        supportsSearch: true,
    },
    {
        name: 'Meting API (injahow)',
        url: 'https://api.injahow.cn/meting',
        type: 'meting',
        supportsSearch: true,
    },
    {
        name: 'Meting API (i-meto)',
        url: 'https://api.i-meto.com/meting/api',
        type: 'meting',
        supportsSearch: true,
    },
];

/** 当前正在使用的 API 源 */
export let currentAPI = API_SOURCES[0];

/**
 * 检查 GDStudio API 是否可用（通过断路器）
 */
export function isGDStudioApiAvailable(): boolean {
    return gdstudioCircuit.canExecute();
}

/**
 * 标记 GDStudio API 为不可用
 */
export function markGDStudioApiUnavailable(): void {
    gdstudioCircuit.recordFailure();
    const state = gdstudioCircuit.getState();
    if (state === CircuitState.OPEN) {
        logger.warn('GDStudio API 断路器已断开，将在恢复超时后重试');
    }
}

/**
 * 标记 GDStudio API 为可用
 */
export function markGDStudioApiAvailable(): void {
    gdstudioCircuit.recordSuccess();
}

/**
 * 获取首选的 Meting API URL
 */
export function getMetingApiUrl(): string {
    const meting = API_SOURCES.find(s => s.type === 'meting');
    return meting ? meting.url : 'https://api.i-meto.com/meting/api';
}

/**
 * 获取 NEC API URL
 */
export function getNecApiUrl(): string {
    return NCM_BASE_URL;
}

/**
 * 获取 GDStudio API URL
 */
export function getGDStudioApiUrl(): string {
    return 'https://music-api.gdstudio.xyz/api.php';
}

/**
 * 测试单个 API 的可用性
 */
export async function testAPI(api: ApiSource): Promise<boolean> {
    const testUrl = api.type === 'nec'
        ? `${api.url}/search?keywords=海阔天空&limit=1`
        : api.type === 'gdstudio'
            ? `${api.url}?id=139774&source=netease&type=song`
            : `${api.url}?server=netease&type=search&id=海阔天空`;

    try {
        const response = await fetchWithRetry(testUrl, {}, 0);
        const text = await response.text();
        const data: any = JSON.parse(text);

        if (api.type === 'nec') {
            return data.code === 200 || data.result?.code === 200;
        }
        if (api.type === 'gdstudio') {
            return (Array.isArray(data) && data.length > 0) || (typeof data === 'object' && data !== null && (Object.keys(data).length > 0 || data.url));
        }
        return (Array.isArray(data) && data.length > 0) || (typeof data === 'object' && data !== null && !data.error);
    } catch {
        return false;
    }
}

/**
 * 自动查找并切换到可用的 API
 */
export async function findWorkingAPI(): Promise<ApiDetectionResult> {
    for (const api of API_SOURCES) {
        if (await testAPI(api)) {
            currentAPI = api;
            return { success: true, name: api.name };
        }
    }
    return { success: false };
}
