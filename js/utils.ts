/**
 * 通用工具函数模块
 * 包含 HTML 转义、防抖、节流等常用工具函数
 */

/**
 * 确保 URL 使用 HTTPS 协议（CSP 要求）
 */
export function ensureHttps(url: string): string {
    return url.replace(/^http:\/\//, 'https://');
}

/**
 * HTML 转义函数，防止 XSS 攻击
 * @param text 需要转义的文本
 * @returns 转义后的安全 HTML 字符串
 */
export function escapeHtml(text: string): string {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 防抖函数
 * @param fn 需要防抖的函数
 * @param delay 延迟时间（毫秒）
 * @returns 防抖包装后的函数
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debounce<T extends (...args: any[]) => unknown>(
    fn: T,
    delay: number
): (...args: Parameters<T>) => void {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    return function (this: unknown, ...args: Parameters<T>): void {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            fn.apply(this, args);
            timeoutId = null;
        }, delay);
    };
}

/**
 * 节流函数
 * @param fn 需要节流的函数
 * @param limit 时间限制（毫秒）
 * @returns 节流包装后的函数
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function throttle<T extends (...args: any[]) => unknown>(
    fn: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle = false;

    return function (this: unknown, ...args: Parameters<T>): void {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => {
                inThrottle = false;
            }, limit);
        }
    };
}

/**
 * 格式化时间为 mm:ss 格式
 * @param seconds 秒数
 * @returns 格式化后的时间字符串
 */
export function formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * 安全获取 DOM 元素
 * @param selector CSS 选择器或元素 ID
 * @param context 上下文元素，默认为 document
 * @returns 元素或 null
 */
export function getElement<T extends HTMLElement = HTMLElement>(
    selector: string,
    context: Document | HTMLElement = document
): T | null {
    // NOTE: 如果 selector 是 ID，优先使用 getElementById
    if (selector.startsWith('#') && context === document) {
        return document.getElementById(selector.slice(1)) as T | null;
    }
    return context.querySelector<T>(selector);
}
