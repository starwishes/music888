/**
 * Cloudflare Pages Functions Proxy
 * 适配 Cloudflare Workers 运行时
 */

// NOTE: Cloudflare Pages Functions 是无状态的，内存速率限制无法跨实例共享。
// 生产环境应使用 Cloudflare Rate Limiting Rules（在 Dashboard 中配置）
// 或 Cloudflare KV / Durable Objects 实现分布式速率限制。
// 此内存版本仅作为单实例内的基本防护。
const rateLimitStore = new Map();
const RATE_LIMIT = {
    windowMs: 60 * 1000,
    maxRequests: 60,
};

function checkRateLimit(ip) {
    const now = Date.now();
    let data = rateLimitStore.get(ip);

    if (!data || now - data.windowStart > RATE_LIMIT.windowMs) {
        data = { windowStart: now, count: 1 };
        rateLimitStore.set(ip, data);
        return { allowed: true, remaining: RATE_LIMIT.maxRequests - 1, reset: now + RATE_LIMIT.windowMs };
    }

    data.count++;
    return {
        allowed: data.count <= RATE_LIMIT.maxRequests,
        remaining: Math.max(0, RATE_LIMIT.maxRequests - data.count),
        reset: data.windowStart + RATE_LIMIT.windowMs
    };
}

/** 允许的前端来源（CORS） */
const ALLOWED_ORIGINS = [
    'https://music.weny888.com',
    'http://localhost:5173',
    'http://localhost:4173',
];

/** 精确匹配的主机名 */
const ALLOWED_HOSTS_EXACT = new Set([
    // 音乐 API 源
    'music-api.gdstudio.xyz',
    'api.injahow.cn',
    'api.i-meto.com',
    'w7z.indevs.in',
    'netease-cloud-music-api-psi-three.vercel.app',
    'netease-cloud-music-api-five-roan.vercel.app',
    // QQ 音乐
    'y.qq.com',
    // 网易云音乐
    'music.163.com',
    'interface.music.163.com',
    // 网易云音乐 CDN (音频流)
    'music.126.net',
    'm7.music.126.net',
    'm8.music.126.net',
    'm701.music.126.net',
    'm801.music.126.net',
    'p1.music.126.net',
    'p2.music.126.net',
    // QQ 音乐 CDN
    'dl.stream.qqmusic.qq.com',
    'ws.stream.qqmusic.qq.com',
    'isure.stream.qqmusic.qq.com',
    // 酷狗音乐 CDN
    'trackercdn.kugou.com',
    'webfs.tx.kugou.com',
    // 咪咕音乐 CDN
    'freetyst.nf.migu.cn',
    // 酷我音乐 CDN
    'sycdn.kuwo.cn',
    'other.web.nf01.sycdn.kuwo.cn',
    'other.web.ra01.sycdn.kuwo.cn',
    // JOOX CDN
    'api.joox.com',
    // 喜马拉雅 CDN
    'fdfs.xmcdn.com',
    'aod.cos.tx.xmcdn.com',
]);

/** 允许子域名匹配的后缀（仅限已知 CDN 模式） */
const ALLOWED_HOST_SUFFIXES = [
    '.music.126.net',
    '.stream.qqmusic.qq.com',
    '.kugou.com',
    '.sycdn.kuwo.cn',
    '.xmcdn.com',
    '.nf.migu.cn',
];

function isHostAllowed(hostname) {
    if (ALLOWED_HOSTS_EXACT.has(hostname)) return true;
    return ALLOWED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

const NETEASE_COOKIE_HOSTS = [
    'music.163.com',
    'netease-cloud-music-api-psi-three.vercel.app',
    'netease-cloud-music-api-five-roan.vercel.app',
    'w7z.indevs.in',
];

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const targetUrlParam = url.searchParams.get('url');

    if (!targetUrlParam) {
        return new Response(JSON.stringify({ error: 'URL parameter is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const decodedUrl = decodeURIComponent(targetUrlParam);
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

    // 1. 速率限制
    const rate = checkRateLimit(clientIp);
    if (!rate.allowed) {
        return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
            status: 429,
            headers: {
                'Content-Type': 'application/json',
                'X-RateLimit-Reset': Math.ceil(rate.reset / 1000).toString()
            }
        });
    }

    // 2. 安全检查
    try {
        const parsedTarget = new URL(decodedUrl);

        // 协议验证：仅允许 http/https
        if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
            return new Response(JSON.stringify({ error: 'Invalid protocol' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (!isHostAllowed(parsedTarget.hostname)) {
            return new Response(JSON.stringify({ error: 'URL not allowed' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // CORS 来源验证
        const requestOrigin = request.headers.get('Origin') || '';
        const corsOrigin = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];

        // 3. 构建请求头
        const refererMap = {
            'gdstudio.xyz': 'https://music-api.gdstudio.xyz/',
            'qq.com': 'https://y.qq.com/',
            'kugou.com': 'https://www.kugou.com/',
            'migu.cn': 'https://music.migu.cn/',
            'kuwo.cn': 'https://www.kuwo.cn/',
            'api.i-meto.com': 'https://api.i-meto.com/',
            'ximalaya.com': 'https://www.ximalaya.com/',
            'xmcdn.com': 'https://www.ximalaya.com/'
        };

        let referer = 'https://music.163.com/';
        for (const [key, val] of Object.entries(refererMap)) {
            if (parsedTarget.hostname.includes(key)) {
                referer = val;
                break;
            }
        }

        const headers = new Headers({
            'Referer': referer,
            'Origin': referer.replace(/\/$/, ''),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        });

        // 针对 GDStudio API 的特殊处理
        if (parsedTarget.hostname.includes('gdstudio.xyz')) {
            headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
            headers.set('Cache-Control', 'no-cache');
            headers.set('Sec-Fetch-Dest', 'empty');
            headers.set('Sec-Fetch-Mode', 'cors');
            headers.set('Sec-Fetch-Site', 'same-site');
        }

        const vipCookie = env.NETEASE_VIP_COOKIE;
        const isNeteaseHost = NETEASE_COOKIE_HOSTS.some(host =>
            parsedTarget.hostname === host || parsedTarget.hostname.endsWith('.' + host)
        );

        if (vipCookie && isNeteaseHost) {
            headers.set('Cookie', vipCookie);
        }

        // 4. 发起上游请求
        const response = await fetch(parsedTarget.toString(), {
            method: 'GET',
            headers,
            redirect: 'follow'
        });

        // 5. 转发响应
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', corsOrigin);
        newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        newHeaders.set('Access-Control-Allow-Headers', 'Content-Type');

        // 音频流处理适配
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('audio') || contentType.includes('octet-stream')) {
            newHeaders.set('Accept-Ranges', 'bytes');
        }

        return new Response(response.body, {
            status: response.status,
            headers: newHeaders
        });

    } catch (error) {
        console.error('[proxy] Request failed:', error.message);
        return new Response(JSON.stringify({ error: 'Failed to proxy request' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
