/**
 * 云音乐播放器 - API 客户端基础模块
 * 负责底层网络请求、重试逻辑和代理转发
 */

import { MusicError, MusicErrorType } from '../types';
import { logger } from '../config';

/** 代理端点路径 */
export const PROXY_ENDPOINT = '/api/proxy';

/**
 * 将外部 URL 转换为代理 URL
 * @param url 原始外部 API URL
 * @returns 代理后的 URL
 */
export function toProxyUrl(url: string): string {
    return `${PROXY_ENDPOINT}?url=${encodeURIComponent(url)}`;
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
                signal: controller.signal,
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
            logger.error(`Request failed (attempt ${i + 1}/${retries + 1}):`, error);
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
    throw new MusicError(MusicErrorType.NETWORK, 'All fetch attempts failed.', '网络请求失败，请稍后重试');
}
