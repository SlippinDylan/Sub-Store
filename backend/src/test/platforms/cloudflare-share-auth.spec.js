import { expect } from 'chai';
import { authorizeShareRequest } from '@/platforms/cloudflare/share-auth';

function createRequest(path, method = 'GET') {
    return {
        method,
        url: `https://worker.example${path}`,
        headers: {},
    };
}

function authorize(request, token, settings = {}) {
    return authorizeShareRequest({
        request,
        consumeShareToken: () => token,
        readSettings: () => settings,
        settingsKey: 'settings',
        agePublicKey: 'age-public-key',
    });
}

describe('Cloudflare share authorization', function () {
    it('attaches a consumed token to the routed request', function () {
        const request = createRequest('/share/sub/demo?token=secret');
        const token = {
            token: 'secret',
            type: 'sub',
            name: 'demo',
            'age-public-key': 'age1demo',
        };

        expect(authorize(request, token)).to.equal(null);
        expect(request.subStoreShareToken).to.equal(token);
        expect(request.headers['x-sub-store-share-age-public-key']).to.equal(
            'age1demo',
        );
    });

    it('matches share-token paths after URL decoding', function () {
        const request = createRequest('/share/sub/demo%20name?token=secret');
        let consumed;

        authorizeShareRequest({
            request,
            consumeShareToken: (query) => {
                consumed = query;
                return { token: 'secret', type: 'sub', name: 'demo name' };
            },
            readSettings: () => ({}),
            settingsKey: 'settings',
            agePublicKey: 'age-public-key',
        });

        expect(consumed.pathname).to.equal('/share/sub/demo name');
    });

    it('rejects a missing, invalid, or expired token', function () {
        const response = authorize(
            createRequest('/share/sub/demo?token=invalid'),
            null,
        );

        expect(response.statusCode).to.equal(404);
        expect(JSON.parse(response.body).status).to.equal('failed');
    });

    it('preserves the upstream fake-node fallback when configured', function () {
        const request = createRequest('/share/col/demo?token=invalid');

        expect(
            authorize(request, null, {
                appearanceSetting: { invalidShareFakeNode: true },
            }),
        ).to.equal(null);
        const url = new URL(request.url);
        expect(url.pathname).to.equal('/share/sub/demo');
        expect(url.searchParams.get('_fakeNode')).to.equal('true');
    });

    it('does not apply share-token rules to management routes', function () {
        expect(authorize(createRequest('/api/settings'), null)).to.equal(null);
    });
});
