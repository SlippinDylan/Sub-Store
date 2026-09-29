export function authorizeShareRequest({
    request,
    consumeShareToken,
    readSettings,
    settingsKey,
    agePublicKey,
}) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/share/')) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return {
            statusCode: 405,
            body: 'Method not allowed',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
        };
    }

    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        return {
            statusCode: 400,
            body: 'Invalid share path',
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
        };
    }
    const token = consumeShareToken({
        token: url.searchParams.get('token'),
        pathname,
    });
    if (token) {
        request.subStoreShareToken = token;
        if (token[agePublicKey]) {
            request.headers['x-sub-store-share-age-public-key'] =
                token[agePublicKey];
        }
        return null;
    }

    const settings = readSettings(settingsKey) || {};
    if (settings.appearanceSetting?.invalidShareFakeNode) {
        url.pathname = url.pathname.replace(/^\/share\/[^/]+\//, '/share/sub/');
        url.searchParams.set('_fakeNode', 'true');
        request.url = url.toString();
        return null;
    }

    return {
        statusCode: 404,
        body: JSON.stringify({
            status: 'failed',
            message: 'Share token is invalid or expired',
        }),
        headers: {
            'content-type': 'application/json;charset=UTF-8',
            'cache-control': 'no-store',
        },
    };
}
