import { expect } from 'chai';
import { $httpClient } from '@/platforms/cloudflare/legacy-globals';

function request(method, options) {
    return new Promise((resolve) => {
        $httpClient[method](options, (error, response, body) => {
            resolve({ error, response, body });
        });
    });
}

describe('Cloudflare outbound HTTP adapter', function () {
    let originalFetch;

    beforeEach(function () {
        originalFetch = global.fetch;
    });

    afterEach(function () {
        global.fetch = originalFetch;
    });

    it('keeps the existing HTTP response contract', async function () {
        global.fetch = async () =>
            new Response('response body', {
                status: 201,
                headers: { 'x-test': 'yes' },
            });

        const result = await request('post', {
            url: 'https://example.com/resource',
            headers: { 'content-type': 'text/plain' },
            body: 'request body',
            timeout: 1000,
        });

        expect(result.error).to.equal(null);
        expect(result.response.statusCode).to.equal(201);
        expect(result.response.headers['x-test']).to.equal('yes');
        expect(result.body).to.equal('response body');
    });

    it('converts URL credentials to Basic authorization', async function () {
        let observedUrl;
        let observedHeaders;
        global.fetch = async (url, init) => {
            observedUrl = url;
            observedHeaders = init.headers;
            return new Response('ok');
        };

        const result = await request('get', {
            url: 'https://alice:pa%24%24@example.com/resource',
        });

        expect(result.error).to.equal(null);
        expect(observedUrl).to.equal('https://example.com/resource');
        expect(observedHeaders.get('authorization')).to.equal(
            'Basic YWxpY2U6cGEkJA==',
        );
    });

    it('rejects unsupported proxy selection explicitly', async function () {
        global.fetch = () => {
            throw new Error('fetch must not run');
        };

        const result = await request('get', {
            url: 'https://example.com/resource',
            proxy: 'socks5://127.0.0.1:1080',
        });

        expect(result.error.message).to.include('outbound proxy selection');
    });

    it('rejects disabled TLS verification explicitly', async function () {
        const result = await request('get', {
            url: 'https://example.com/resource',
            strictSSL: false,
        });

        expect(result.error.message).to.include(
            'cannot disable TLS certificate verification',
        );
    });

    it('aborts an outbound request when its timeout expires', async function () {
        global.fetch = (url, init) =>
            new Promise((resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });

        const result = await request('get', {
            url: 'https://example.com/resource',
            timeout: 5,
        });

        expect(result.error.name).to.equal('AbortError');
    });
});
