import { expect } from 'chai';
import createCloudflareRouter from '@/platforms/cloudflare/router';

function createSubStore() {
    return {
        workerEnv: {},
        info() {},
        error() {},
    };
}

function request(path, init = {}) {
    return {
        method: init.method || 'GET',
        url: `https://worker.example${path}`,
        headers: init.headers || {},
        body: init.body,
        socket: { remoteAddress: '203.0.113.1' },
        subStoreShareToken: init.subStoreShareToken,
    };
}

describe('Cloudflare route adapter', function () {
    it('preserves the request and response contract used by REST handlers', async function () {
        const app = createCloudflareRouter({ substore: createSubStore() });
        app.post('/api/item/:name', (req, res) => {
            expect(req.params.name).to.equal('demo');
            expect(req.query.view).to.equal('full');
            expect(req.body).to.deep.equal({ enabled: true });
            expect(req.socket.remoteAddress).to.equal('203.0.113.1');
            expect(req.route.path).to.equal('/api/item/:name');
            expect(res.req).to.equal(req);
            res.status(201).set('x-test', 'yes').json({ ok: true });
        });

        const response = await app.handle(
            request('/api/item/demo?view=full', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: true }),
            }),
        );

        expect(response.statusCode).to.equal(201);
        expect(response.getHeaders()['x-test']).to.equal('yes');
        expect(JSON.parse(response.body)).to.deep.equal({ ok: true });
    });

    it('matches complete paths rather than route prefixes', async function () {
        const app = createCloudflareRouter({ substore: createSubStore() });
        app.get('/api/items', (_, res) => res.send('matched'));

        const response = await app.handle(request('/api/items/extra'));

        expect(response.statusCode).to.equal(404);
    });

    it('returns a stable client error for malformed JSON', async function () {
        const app = createCloudflareRouter({ substore: createSubStore() });
        app.post('/api/items', (_, res) => res.send('unreachable'));

        const response = await app.handle(
            request('/api/items', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{bad',
            }),
        );

        expect(response.statusCode).to.equal(400);
        expect(JSON.parse(response.body).status).to.equal('failed');
    });

    it('forwards consumed share-token metadata to route handlers', async function () {
        const app = createCloudflareRouter({ substore: createSubStore() });
        const token = { token: 'secret', type: 'sub', name: 'demo' };
        app.get('/share/sub/:name', (req, res) => {
            expect(req.subStoreShareToken).to.equal(token);
            res.send('ok');
        });

        const response = await app.handle(
            request('/share/sub/demo?token=secret', {
                subStoreShareToken: token,
            }),
        );

        expect(response.statusCode).to.equal(200);
        expect(response.body).to.equal('ok');
    });
});
