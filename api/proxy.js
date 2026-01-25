const fetch = require('node-fetch');

// NOTE: 白名单域名列表，只允许代理到这些可信域名
const ALLOWED_HOSTS = [
    'music-api.gdstudio.xyz',
    'y.qq.com',
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
    'freetyst.nf.migu.cn'
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

        const response = await fetch(decodedUrl, {
            headers: {
                'Referer': 'https://y.qq.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.150 Safari/537.36'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: `API responded with status: ${response.status}` });
        }

        res.setHeader('Content-Type', response.headers.get('content-type'));
        response.body.pipe(res);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).json({ error: 'Failed to proxy request' });
    }
};
