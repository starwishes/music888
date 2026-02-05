/**
 * Cloudflare Pages Functions Proxy
 * 适配 Cloudflare Workers 运行时
 */

// NOTE: 速率限制在 Cloudflare 环境下建议使用 KV 存储，这里先实现一个基于内存的简单版本 (不跨实例共享)
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

const ALLOWED_HOSTS = [
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
    'joox.com',
    'api.joox.com',
    // 喜马拉雅 CDN
    'ximalaya.com',
    'fdfs.xmcdn.com',
    'aod.cos.tx.xmcdn.com'
];

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
        const isAllowed = ALLOWED_HOSTS.some(host =>
            parsedTarget.hostname === host || parsedTarget.hostname.endsWith('.' + host)
        );

        if (!isAllowed) {
            return new Response(JSON.stringify({ error: 'URL not allowed' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        }

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
            // 处理部分部署需要 query 传参的情况
            if (parsedTarget.hostname.includes('w7z.indevs.in') ||
                parsedTarget.hostname.includes('i-meto.com') ||
                parsedTarget.hostname.includes('vercel.app')) {
                if (!parsedTarget.searchParams.has('cookie')) {
                    parsedTarget.searchParams.set('cookie', vipCookie);
                }
            }
        }

        // 4. 发起上游请求
        const response = await fetch(parsedTarget.toString(), {
            method: 'GET',
            headers,
            redirect: 'follow'
        });

        // 5. 转发响应
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*'); // Cloudflare 端允许所有
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
        return new Response(JSON.stringify({ error: 'Failed to proxy request', message: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
