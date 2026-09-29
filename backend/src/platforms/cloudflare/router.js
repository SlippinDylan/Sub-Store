import {
    describeCorsPolicy,
    getCorsHeaders,
    isOriginAllowed,
    resolveCorsPolicy,
} from '@/utils/cors';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

export default function createCloudflareRouter({ substore: $ }) {
    const handlers = [];
    const configuredCors = $.workerEnv?.SUB_STORE_CORS_ALLOWED_ORIGINS;
    const corsPolicy = resolveCorsPolicy({
        isNode: false,
        argument: configuredCors ? { cors: configuredCors } : undefined,
    });
    $.info(`[CORS] allowed origins: ${describeCorsPolicy(corsPolicy)}`);

    const app = {
        async handle(request) {
            return dispatch(request);
        },
        start() {
            throw new Error(
                'Cloudflare router requests must be dispatched with app.handle()',
            );
        },
    };

    for (const method of METHODS) {
        app[method.toLowerCase()] = (pattern, callback) => {
            handlers.push({ method, pattern, callback });
            return app;
        };
    }
    app.all = (pattern, callback) => {
        handlers.push({ method: 'ALL', pattern, callback });
        return app;
    };
    app.route = (pattern) => {
        const route = {};
        for (const method of METHODS) {
            route[method.toLowerCase()] = (callback) => {
                handlers.push({ method, pattern, callback });
                return route;
            };
        }
        route.all = (callback) => {
            handlers.push({ method: 'ALL', pattern, callback });
            return route;
        };
        return route;
    };

    return app;

    async function dispatch(request) {
        const method = request.method.toUpperCase();
        const url = new URL(request.url);
        const path = url.pathname || '/';
        const headers = normalizeHeaders(request.headers);
        const cors = applyCors(headers.origin, method);
        const response = createResponse(cors.headers);

        if (!cors.allowed) {
            return response.status(403).send('CORS origin not allowed');
        }
        if (cors.preflight) {
            return response.status(200).end();
        }

        const matched = handlers.find(
            (handler) =>
                (handler.method === 'ALL' ||
                    handler.method === method ||
                    (method === 'HEAD' && handler.method === 'GET')) &&
                matchRoute(handler.pattern, path) !== null,
        );
        if (!matched) {
            return response.status(404).json({
                status: 'failed',
                message: 'ERROR: 404 not found',
            });
        }

        let body;
        try {
            body = parseBody(request.body, headers['content-type']);
        } catch (error) {
            return response.status(400).json({
                status: 'failed',
                message: `Invalid request body: ${error.message}`,
            });
        }

        const params = matchRoute(matched.pattern, path) || {};
        const req = {
            method,
            url: request.url,
            originalUrl: request.url,
            path,
            query: Object.fromEntries(url.searchParams),
            params,
            headers,
            body,
            rawBody: request.body,
            socket: request.socket || {},
            _parsedUrl: { pathname: path },
            route: { path: matched.pattern },
            subStoreShareToken: request.subStoreShareToken,
        };
        response.req = req;

        try {
            await matched.callback(req, response, () => {});
            return response;
        } catch (error) {
            $.error(`Cloudflare route failed: ${error.stack || error}`);
            if (response.finished) return response;
            return response.status(500).json({
                status: 'failed',
                message: 'Internal Server Error',
            });
        }
    }

    function applyCors(origin, method) {
        const allowed = isOriginAllowed(corsPolicy, origin);
        return {
            allowed,
            preflight:
                Boolean(origin) &&
                allowed &&
                method.toUpperCase() === 'OPTIONS',
            headers: allowed ? getCorsHeaders(corsPolicy, origin) : {},
        };
    }
}

function createResponse(corsHeaders) {
    const headers = new Headers({
        'content-type': 'text/plain;charset=UTF-8',
        'access-control-allow-methods':
            'POST,GET,OPTIONS,PATCH,PUT,DELETE,HEAD',
        'access-control-allow-headers':
            'Origin, X-Requested-With, Content-Type, Accept, Authorization',
        'x-powered-by': 'Sub-Store',
        ...corsHeaders,
    });

    return new (class {
        constructor() {
            this.statusCode = 200;
            this.body = '';
            this.finished = false;
            this.req = undefined;
        }

        status(code) {
            this.statusCode = code;
            return this;
        }

        send(body = '') {
            if (this.finished) return this;
            if (body !== null && typeof body === 'object') {
                this.set('content-type', 'application/json;charset=UTF-8');
                this.body = JSON.stringify(body);
            } else {
                this.body = body ?? '';
            }
            this.finished = true;
            return this;
        }

        end(body = '') {
            return this.send(body);
        }

        html(body) {
            return this.set('content-type', 'text/html;charset=UTF-8').send(
                body,
            );
        }

        json(body) {
            return this.set(
                'content-type',
                'application/json;charset=UTF-8',
            ).send(JSON.stringify(body));
        }

        set(key, value) {
            try {
                headers.set(key, normalizeHeaderValue(key, value));
            } catch (error) {
                console.warn(`Invalid response header ignored: ${key}`);
            }
            return this;
        }

        removeHeader(key) {
            headers.delete(key);
            return this;
        }

        getHeaders() {
            return Object.fromEntries(headers);
        }

        toResponseInit() {
            return {
                status: this.statusCode,
                headers: this.getHeaders(),
            };
        }
    })();
}

function normalizeHeaders(headers) {
    return Object.fromEntries(
        Object.entries(headers || {}).map(([key, value]) => [
            key.toLowerCase(),
            value,
        ]),
    );
}

function normalizeHeaderValue(name, value) {
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value !== 'string') return `${value}`;
    if (name.toLowerCase() !== 'profile-web-page-url') return value;
    try {
        return new URL(value).href;
    } catch {
        return value;
    }
}

function parseBody(body, contentType = '') {
    if (body === undefined || body === '') return undefined;
    if (/application\/json/i.test(contentType)) return JSON.parse(body);
    if (/application\/x-www-form-urlencoded/i.test(contentType)) {
        return Object.fromEntries(new URLSearchParams(body));
    }
    return body;
}

function matchRoute(pattern, path) {
    if (pattern instanceof RegExp) {
        pattern.lastIndex = 0;
        return pattern.test(path) ? {} : null;
    }
    if (typeof pattern !== 'string') return null;

    const patternSegments = splitPath(pattern);
    const pathSegments = splitPath(path);
    if (patternSegments.length !== pathSegments.length) return null;

    const params = {};
    for (let index = 0; index < patternSegments.length; index += 1) {
        const expected = patternSegments[index];
        const actual = pathSegments[index];
        if (expected.startsWith(':')) {
            try {
                params[expected.slice(1)] = decodeURIComponent(actual);
            } catch {
                return null;
            }
        } else if (expected !== actual) {
            return null;
        }
    }
    return params;
}

function splitPath(path) {
    if (path === '/') return [];
    return path.replace(/^\/+|\/+$/g, '').split('/');
}
