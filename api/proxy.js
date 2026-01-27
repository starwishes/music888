const fetch = require('node-fetch');

// NOTE: 白名单域名列表，只允许代理到这些可信域名
const ALLOWED_HOSTS = [
    // 音乐 API 源
    'music-api.gdstudio.xyz',
    'api.injahow.cn',
    'meting.qjqq.cn',
    'nec8.de5.net',
    'tktok.de5.net',
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

/**
 * 验证 URL 是否在白名单中
 * @param {string} url 需要验证的 URL
 * @returns {boolean} 是否允许访问
 */
function isUrlAllowed(url) {
    try {
        const parsed = new URL(url);
        // NOTE: 只允许 http 和 https 协议，禁止 file:// 等其他协议
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return false;
        }
        return ALLOWED_HOSTS.some(host =>
            parsed.hostname === host || parsed.hostname.endsWith('.' + host)
        );
    } catch {
        return false;
    }
}

module.exports = async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    // NOTE: 安全检查 - 验证 URL 是否在白名单中
    const decodedUrl = decodeURIComponent(url);
    if (!isUrlAllowed(decodedUrl)) {
        console.warn(`Blocked proxy request to unauthorized URL: ${decodedUrl}`);
        return res.status(403).json({ error: 'URL not allowed' });
    }

    try {
        const parsedUrl = new URL(decodedUrl);

        // NOTE: 根据目标域名动态设置 Referer 和其他请求头
        let referer = 'https://music.163.com/';
        let extraHeaders = {};
        
        if (parsedUrl.hostname.includes('gdstudio.xyz')) {
            // GDStudio API 需要特殊的请求头
            referer = 'https://music-api.gdstudio.xyz/';
            extraHeaders = {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
            };
        } else if (parsedUrl.hostname.includes('qq.com')) {
            referer = 'https://y.qq.com/';
        } else if (parsedUrl.hostname.includes('kugou.com')) {
            referer = 'https://www.kugou.com/';
        } else if (parsedUrl.hostname.includes('migu.cn')) {
            referer = 'https://music.migu.cn/';
        } else if (parsedUrl.hostname.includes('kuwo.cn')) {
            referer = 'https://www.kuwo.cn/';
        } else if (parsedUrl.hostname.includes('joox.com')) {
            referer = 'https://www.joox.com/';
        } else if (parsedUrl.hostname.includes('ximalaya.com') || parsedUrl.hostname.includes('xmcdn.com')) {
            referer = 'https://www.ximalaya.com/';
        }

        const response = await fetch(decodedUrl, {
            headers: {
                'Referer': referer,
                'Origin': referer.replace(/\/$/, ''),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...extraHeaders
            }
        });

        if (!response.ok) {
            console.error(`Proxy upstream error: ${response.status} for ${decodedUrl.substring(0, 100)}`);
            return res.status(response.status).json({ error: `Upstream API responded with status: ${response.status}` });
        }

        // NOTE: 获取响应类型和长度
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const contentLength = response.headers.get('content-length');

        // NOTE: 设置 CORS 头，允许跨域访问
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        // NOTE: 根据响应类型设置不同的响应头
        res.setHeader('Content-Type', contentType);

        if (contentType.includes('audio') || contentType.includes('octet-stream')) {
            // 音频流响应
            res.setHeader('Accept-Ranges', 'bytes');
        }

        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }

        // NOTE: 将响应流管道传输到客户端
        response.body.pipe(res);

    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).json({ error: 'Failed to proxy request', details: error.message });
    }
};
