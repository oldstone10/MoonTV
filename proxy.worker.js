/* eslint-disable */

// 全局引入我们精心调校的去广告清洗函数
function filterAdsFromM3U8(m3u8Content, env) {
  if (!m3u8Content) return '';

  // 1. 广告特征黑名单（完美融合开元棋牌、PG电子等）
  let basePatterns = [
    /doubleclick\.net/i, /googlesyndication\.com/i, /googleads/i, /adservice/i,
    /cdn\-ad\./i, /\dadvertisment\b/i, /_ad\.ts/i, /\.ad\./i,
    /kaiyuan/i, /\bky\b/i, /qipai/i, /\bqp\b/i, /kyqp/i,
    /\bpg\b/i, /pgdianz[i]?/i, /pgsoft/i, /pocketgame/i, /slots/i,
    /vnsr/i, /bocai/i, /amvn/i, /bet\d+/i, /casino/i, /\bag\b/i, /\bob\b/i,
    /guanggao/i, /[\/\-_]ad[s]?[\/\-_]/i
  ];

  // 动态读取 Cloudflare 后台配置的 CUSTOM_AD_WORDS 变量
  if (env && env.CUSTOM_AD_WORDS) {
    const customWords = env.CUSTOM_AD_WORDS.split(',');
    customWords.forEach(word => {
      if (word.trim()) {
        basePatterns.push(new RegExp(word.trim(), 'i'));
      }
    });
  }

  // 动态读取开头强制切除时长，没有配置就默认 7.5 秒
  const TARGET_AD_TIME = env && env.TARGET_AD_TIME ? parseFloat(env.TARGET_AD_TIME) : 7.5;

  // 广告流标签黑名单
  const adTags = ['#EXT-X-CUE-OUT', '#EXT-X-CUE-IN', '#EXT-X-CUE', '#EXT-OATCLS-SCTE35', '#EXT-X-DATERANGE'];

  const lines = m3u8Content.split(/\r?\n/);
  const outputLines = [];
  
  let i = 0;
  let skipNextSegment = false; 
  let accumulatedTime = 0;
  let hasSkippedIntro = false;  

  while (i < lines.length) {
    let line = lines[i].trim();
    if (!line) { i++; continue; }

    // 保留 M3U8 必要的基础头部格式标记
    if (line.startsWith('#EXTM3U') || line.startsWith('#EXT-X-VERSION') || line.startsWith('#EXT-X-TARGETDURATION') || line.startsWith('#EXT-X-MEDIA-SEQUENCE') || line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      outputLines.push(lines[i]);
      i++;
      continue;
    }

    // 标签过滤
    let isAdTag = adTags.some(tag => line.startsWith(tag));
    if (isAdTag) {
      if (line.startsWith('#EXT-X-CUE-OUT') || line.startsWith('#EXT-X-DATERANGE')) {
        skipNextSegment = true;
      }
      i++; continue; 
    }

    if (line.startsWith('#EXT-X-CUE-IN')) {
      skipNextSegment = false;
      i++; continue;
    }

    // 处理切片
    if (line.startsWith('#EXTINF:')) {
      const durationMatch = line.match(/#EXTINF:([0-9.]+)/);
      const currentDuration = durationMatch ? parseFloat(durationMatch[1]) : 0;

      let nextLineIndex = i + 1;
      let urlLine = '';
      while (nextLineIndex < lines.length && lines[nextLineIndex].trim().startsWith('#')) {
        nextLineIndex++;
      }
      if (nextLineIndex < lines.length) {
        urlLine = lines[nextLineIndex].trim();
      }

      let isAdUrl = basePatterns.some(pattern => pattern.test(urlLine));
      let isIntroAd = false;                                          

      // 开头7秒强制时间拦截
      if (!hasSkippedIntro) {
        if (accumulatedTime + currentDuration <= TARGET_AD_TIME + 2) {
          accumulatedTime += currentDuration;
          isIntroAd = true; 
        } else {
          hasSkippedIntro = true; 
        }
      }

      if (isAdUrl || isIntroAd || skipNextSegment) {
        i = nextLineIndex + 1; 
        continue;
      }
    }

    // 纯行 URL 兜底过滤
    if (/^https?:\/\//i.test(line) || (!line.startsWith('#') && (line.endsWith('.ts') || line.includes('.m4s') || line.includes('.mp4')))) {
      let isAdUrl = basePatterns.some(pattern => pattern.test(line));
      if (isAdUrl) {
        i++;
        continue;
      }
    }

    outputLines.push(lines[i]);
    i++;
  }

  return outputLines.join('\n');
}

addEventListener('fetch', (event) => {
  // 将全局的 context 绑定带入请求处理器中
  event.respondWith(handleRequest(event.request, typeof globalThis !== 'undefined' ? globalThis : {}));
});

async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);

    // 如果访问根目录，返回HTML
    if (url.pathname === '/') {
      return new Response(getRootHtml(), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
    }

    // 从请求路径中提取目标 URL
    let actualUrlStr = decodeURIComponent(url.pathname.replace('/', ''));

    // 判断用户输入的 URL 是否带有协议
    actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);

    // 保留查询参数
    actualUrlStr += url.search;

    // 创建新 Headers 对象，排除以 'cf-' 开头的请求头
    const newHeaders = filterHeaders(
      request.headers,
      (name) => !name.startsWith('cf-')
    );

    // 创建一个新的请求以访问目标 URL
    const modifiedRequest = new Request(actualUrlStr, {
      headers: newHeaders,
      method: request.method,
      body: request.body,
      redirect: 'manual',
    });

    // 发起对目标 URL 的请求
    const response = await fetch(modifiedRequest);
    let body = response.body;

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      body = response.body;
      return handleRedirect(response, body);
    } 
    
    // 拦截并清洗 M3U8 播放列表
    else if (actualUrlStr.includes('.m3u8') || response.headers.get('Content-Type')?.includes('mpegurl') || response.headers.get('Content-Type')?.includes('application/vnd.apple.mpegurl')) {
      let m3u8Content = await response.text();
      m3u8Content = filterAdsFromM3U8(m3u8Content, env);
      body = m3u8Content;
    } 
    
    else if (response.headers.get('Content-Type')?.includes('text/html')) {
      body = await handleHtmlContent(
        response,
        url.protocol,
        url.host,
        actualUrlStr
      );
    }

    // 创建修改后的响应对象
    const modifiedResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    if (actualUrlStr.includes('.m3u8')) {
      modifiedResponse.headers.delete('content-length');
    }

    // 添加禁用缓存的头部
    setNoCacheHeaders(modifiedResponse.headers);

    // 添加 CORS 头部，允许跨域访问
    setCorsHeaders(modifiedResponse.headers);

    return modifiedResponse;
  } catch (error) {
    return jsonResponse(
      {
        error: error.message,
      },
      500
    );
  }
}

function ensureProtocol(url, defaultProtocol) {
  return url.startsWith('http://') || url.startsWith('https://')
    ? url
    : defaultProtocol + '//' + url;
}

function handleRedirect(response, body) {
  const location = new URL(response.headers.get('location'));
  const modifiedLocation = `/${encodeURIComponent(location.toString())}`;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...response.headers,
      Location: modifiedLocation,
    },
  });
}

async function handleHtmlContent(response, protocol, host, actualUrlStr) {
  const originalText = await response.text();
  const regex = new RegExp('((href|src|action)=["\'])/(?!/)', 'g');
  let modifiedText = replaceRelativePaths(
    originalText,
    protocol,
    host,
    new URL(actualUrlStr).origin
  );

  return modifiedText;
}

function replaceRelativePaths(text, protocol, host, origin) {
  const regex = new RegExp('((href|src|action)=["\'])/(?!/)', 'g');
  return text.replace(regex, `$1${protocol}//${host}/${origin}/`);
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

function setNoCacheHeaders(headers) {
  headers.set('Cache-Control', 'no-store');
}

function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', '*');
}

function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Everything</title>
  <link rel="icon" type="image/png" href="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="Description" content="Proxy Everything with CF Workers.">
  <meta property="og:description" content="Proxy Everything with CF Workers.">
  <meta property="og:image" content="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="robots" content="index, follow">
  <meta http-equiv="Content-Language" content="zh-CN">
  <meta name="copyright" content="Copyright © ymyuuu">
  <meta name="author" content="ymyuuu">
  <link rel="apple-touch-icon-precomposed" sizes="120x120" href="https://img.icons8.com/color/1000/kawaii-bread-1.png">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <style>
      body, html {
          height: 100%;
          margin: 0;
      }
      .background {
          background-image: url('https://imgapi.cn/bing.php');
          background-size: cover;
          background-position: center;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .card {
          background-color: rgba(255, 255, 255, 0.8);
          transition: background-color 0.3s ease, box-shadow 0.3s ease;
      }
      .card:hover {
          background-color: rgba(255, 255, 255, 1);
          box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.3);
      }
      .input-field input[type=text] {
          color: #2c3e50;
      }
      .input-field input[type=text]:focus+label {
          color: #2c3e50 !important;
      }
      .input-field input[type=text]:focus {
          border-bottom: 1px solid #2c3e50 !important;
          box-shadow: 0 1px 0 0 #2c3e50 !important;
      }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align"><i class="material-icons left">link</i>Proxy Everything</span>
                          <form id="urlForm" onsubmit="redirectToProxy(event)">
                              <div class="input-field">
                                  <input type="text" id="targetUrl" placeholder="在此输入目标地址" required>
                                  <label for="targetUrl">目标地址</label>
                              </div>
                              <button type="submit" class="btn waves-effect waves-light teal darken-2 full-width">跳转</button>
                          </form>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
  <script>
      function redirectToProxy(event) {
          event.preventDefault();
          const targetUrl = document.getElementById('targetUrl').value.trim();
          const currentOrigin = window.location.origin;
          window.open(currentOrigin + '/' + encodeURIComponent(targetUrl), '_blank');
      }
  </script>
</body>
</html>`;
}
