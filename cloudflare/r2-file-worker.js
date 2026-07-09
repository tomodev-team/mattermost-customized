const THUMBNAIL = {width: 120, height: 100, fit: 'cover'};
const PREVIEW = {width: 1920, fit: 'scale-down'};
const DERIVATIVE_PREFIX = '_mattermost_derivatives';

function getAllowedOrigin(request, env) {
    const origin = request.headers.get('Origin');
    if (!origin) {
        return '';
    }

    const configuredOrigins = (env.CORS_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (configuredOrigins.length > 0 && !configuredOrigins.includes('*') && !configuredOrigins.includes(origin)) {
        return '';
    }

    return origin;
}

function appendVary(headers, value) {
    const current = headers.get('Vary');
    if (!current) {
        headers.set('Vary', value);
        return;
    }

    const values = current.split(',').map((item) => item.trim().toLowerCase());
    if (!values.includes(value.toLowerCase())) {
        headers.set('Vary', `${current}, ${value}`);
    }
}

function applyCorsHeaders(headers, request, env) {
    const origin = getAllowedOrigin(request, env);
    if (!origin) {
        return headers;
    }

    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Cache-Control, Content-Disposition, Content-Length, Content-Range, Content-Type, ETag');
    appendVary(headers, 'Origin');
    return headers;
}

function withCors(response, request, env) {
    const headers = new Headers(response.headers);
    applyCorsHeaders(headers, request, env);

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function preflightResponse(request, env) {
    const headers = new Headers();
    applyCorsHeaders(headers, request, env);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || 'Authorization, Content-Type, X-Requested-With');
    headers.set('Access-Control-Max-Age', '86400');
    return new Response(null, {status: 204, headers});
}

function base64UrlEncode(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sign(secret, canonical) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        {name: 'HMAC', hash: 'SHA-256'},
        false,
        ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
    return base64UrlEncode(new Uint8Array(signature));
}

function getParams(request) {
    const url = new URL(request.url);
    return {
        key: url.searchParams.get('key') || '',
        variant: url.searchParams.get('variant') || 'file',
        exp: url.searchParams.get('exp') || '',
        download: url.searchParams.get('download') || '0',
        name: url.searchParams.get('name') || 'file',
        mime: url.searchParams.get('mime') || 'application/octet-stream',
        sig: url.searchParams.get('sig') || '',
    };
}

function contentDisposition(name, download) {
    const safeName = name.replace(/[\r\n"\\]/g, '');
    if (download === '1') {
        return `attachment; filename="${safeName}"`;
    }
    return `inline; filename="${safeName}"`;
}

async function verify(request, env) {
    const params = getParams(request);
    if (!params.key || !params.exp || !params.sig || !env.FILE_CDN_SIGNING_SECRET) {
        return {ok: false, params};
    }

    const expiresAt = Number(params.exp);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
        return {ok: false, params};
    }

    const canonical = [
        params.key,
        params.variant,
        params.exp,
        params.download,
        params.name,
        params.mime,
    ].join('\n');
    const expected = await sign(env.FILE_CDN_SIGNING_SECRET, canonical);

    return {ok: expected === params.sig, params};
}

function responseHeaders(params, cacheControl) {
    return {
        'Cache-Control': cacheControl,
        'Content-Disposition': contentDisposition(params.name, params.download),
        'X-Content-Type-Options': 'nosniff',
    };
}

function isImageVariant(params) {
    return params.variant === 'thumbnail' || params.variant === 'preview';
}

function isRangeRequest(request) {
    return request.headers.has('Range');
}

function derivativeKey(params) {
    return `${DERIVATIVE_PREFIX}/${params.variant}/${params.key}.webp`;
}

function buildCacheKey(request, params) {
    const url = new URL(request.url);
    url.pathname = '/__mattermost_file_cache';
    url.search = '';
    url.searchParams.set('key', params.key);
    url.searchParams.set('variant', params.variant);
    url.searchParams.set('download', params.download);
    url.searchParams.set('name', params.name);
    url.searchParams.set('mime', params.mime);

    return new Request(url.toString(), {method: 'GET'});
}

function headResponse(response) {
    return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

function derivativeResponse(object, params, request) {
    const headers = new Headers(responseHeaders(params, 'public, max-age=31536000, immutable'));
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/webp');
    headers.set('ETag', object.httpEtag);
    headers.set('Vary', 'Accept');

    return new Response(request.method === 'HEAD' ? null : object.body, {
        status: 200,
        headers,
    });
}

function originalObjectResponse(object, params, request, options = {}) {
    const headers = new Headers(responseHeaders(params, options.cacheControl || 'private, max-age=300'));
    headers.set('Content-Type', params.mime);
    headers.set('ETag', object.httpEtag);
    headers.set('Accept-Ranges', 'bytes');
    if (options.imageFallback) {
        headers.set('X-Mattermost-CDN-Image-Fallback', 'original');
    }

    let status = 200;
    if (object.range) {
        const range = object.range;
        let start = 0;
        let end = object.size - 1;
        if (typeof range.offset === 'number') {
            start = range.offset;
            if (typeof range.length === 'number') {
                end = Math.min(start + range.length - 1, object.size - 1);
            }
        } else if (typeof range.suffix === 'number') {
            start = Math.max(object.size - range.suffix, 0);
        }

        headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
        headers.set('Content-Length', String(end - start + 1));
        status = 206;
    }

    return new Response(request.method === 'HEAD' ? null : object.body, {
        status,
        headers,
    });
}

async function storeDerivative(env, params, response) {
    if (!response.body) {
        return;
    }

    await env.FILES_BUCKET.put(derivativeKey(params), response.body, {
        httpMetadata: {
            contentType: response.headers.get('Content-Type') || 'image/webp',
            cacheControl: 'public, max-age=31536000, immutable',
        },
    });
}

async function imageResponse(object, env, params) {
    if (!env.IMAGES) {
        return new Response('Images binding is not configured', {status: 501});
    }

    const transform = params.variant === 'thumbnail' ? THUMBNAIL : PREVIEW;
    const output = await env.IMAGES.input(object.body).
        transform(transform).
        output({format: 'image/webp', quality: 82});
    const response = await output.response();
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(responseHeaders(params, 'public, max-age=31536000, immutable'))) {
        headers.set(key, value);
    }
    headers.set('Vary', 'Accept');

    return new Response(response.body, {
        status: response.status,
        headers,
    });
}

async function imageOrOriginalResponse(object, env, params, request) {
    try {
        const response = await imageResponse(object, env, params);
        if (response.ok) {
            return response;
        }
    } catch (error) {
        // Some very large images can exceed the transformer limits. Falling back
        // to the original object is better than rendering a broken attachment.
    }

    const fallbackObject = await env.FILES_BUCKET.get(params.key);
    if (!fallbackObject) {
        return new Response('Not found', {status: 404});
    }

    return originalObjectResponse(fallbackObject, params, request, {
        cacheControl: 'private, max-age=300',
        imageFallback: true,
    });
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return preflightResponse(request, env);
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return withCors(new Response('Method not allowed', {status: 405}), request, env);
        }

        const {ok, params} = await verify(request, env);
        if (!ok) {
            return withCors(new Response('Forbidden', {status: 403}), request, env);
        }

        const cache = caches.default;
        const cacheKey = buildCacheKey(request, params);
        const shouldUseCache = !isRangeRequest(request);
        if (shouldUseCache) {
            const cached = await cache.match(cacheKey);
            if (cached) {
                return withCors(request.method === 'HEAD' ? headResponse(cached) : cached, request, env);
            }
        }

        if (isImageVariant(params)) {
            const derivative = await env.FILES_BUCKET.get(derivativeKey(params));
            if (derivative) {
                const response = derivativeResponse(derivative, params, request);
                if (request.method === 'GET' && params.download !== '1') {
                    ctx.waitUntil(cache.put(cacheKey, response.clone()));
                }
                return withCors(response, request, env);
            }
        }

        const object = await env.FILES_BUCKET.get(params.key, isRangeRequest(request) && !isImageVariant(params) ? {range: request.headers} : undefined);
        if (!object) {
            return withCors(new Response('Not found', {status: 404}), request, env);
        }

        if (request.method === 'HEAD' && isImageVariant(params)) {
            return withCors(originalObjectResponse(object, params, request, {
                cacheControl: 'private, max-age=300',
            }), request, env);
        }

        let response;
        if (isImageVariant(params)) {
            response = await imageOrOriginalResponse(object, env, params, request);
        } else {
            response = originalObjectResponse(object, params, request);
        }

        const isFallbackImage = response.headers.get('X-Mattermost-CDN-Image-Fallback') === 'original';
        if (shouldUseCache && request.method === 'GET' && response.ok && params.download !== '1' && !isFallbackImage) {
            if (isImageVariant(params)) {
                ctx.waitUntil(storeDerivative(env, params, response.clone()));
            }
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }

        return withCors(response, request, env);
    },
};
