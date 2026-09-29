export const INTERNAL_SCHEDULE_PATH = '/__sub-store-internal/scheduled';

const PUBLIC_API_PATH = /^\/share(\/|$)/;

function unauthorized(message = 'Unauthorized') {
    return new Response(JSON.stringify({ status: 'failed', message }), {
        status: 401,
        headers: {
            'content-type': 'application/json;charset=UTF-8',
            'cache-control': 'no-store',
        },
    });
}

export function authorizeRequest(request, env) {
    const url = new URL(request.url);
    const backendPath = env.SUB_STORE_FRONTEND_BACKEND_PATH;
    const hasValidBackendPath =
        backendPath?.startsWith('/') && !backendPath.endsWith('/');

    if (url.pathname === INTERNAL_SCHEDULE_PATH) {
        return new Response('Not found', { status: 404 });
    }

    if (hasValidBackendPath) {
        if (url.pathname === backendPath) {
            url.pathname = `${backendPath}/`;
            return Response.redirect(url.toString(), 302);
        }
        if (url.pathname.startsWith(`${backendPath}/`)) {
            url.pathname = url.pathname.slice(backendPath.length) || '/';
            if (url.pathname === INTERNAL_SCHEDULE_PATH) {
                return new Response('Not found', { status: 404 });
            }
            return new Request(url.toString(), request);
        }
    }

    const isPublic = PUBLIC_API_PATH.test(url.pathname);
    const isProtected =
        url.pathname === '/api' ||
        url.pathname.startsWith('/api/') ||
        url.pathname === '/download' ||
        url.pathname.startsWith('/download/');

    if (isPublic || !isProtected) return request;
    if (!backendPath) {
        return unauthorized('Management API authentication is not configured');
    }
    if (!hasValidBackendPath) {
        return unauthorized(
            'Invalid management API authentication configuration',
        );
    }
    return unauthorized();
}
