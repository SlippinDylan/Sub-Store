import { expect } from 'chai';
import {
    authorizeRequest,
    INTERNAL_SCHEDULE_PATH,
} from '@/platforms/cloudflare/request-auth';

describe('Cloudflare request authorization', function () {
    const managementPath = '/private-backend-path';

    it('strips the configured management path before forwarding', function () {
        const request = new Request(
            `https://worker.example${managementPath}/api/settings?view=full`,
        );
        const authorized = authorizeRequest(request, {
            SUB_STORE_FRONTEND_BACKEND_PATH: managementPath,
        });

        expect(authorized).to.be.instanceOf(Request);
        expect(new URL(authorized.url).pathname).to.equal('/api/settings');
        expect(new URL(authorized.url).search).to.equal('?view=full');
    });

    it('rejects direct management API access', async function () {
        const response = authorizeRequest(
            new Request('https://worker.example/api/settings'),
            { SUB_STORE_FRONTEND_BACKEND_PATH: managementPath },
        );

        expect(response.status).to.equal(401);
        expect(await response.json()).to.include({
            status: 'failed',
            message: 'Unauthorized',
        });
    });

    it('rejects unprefixed download routes', function () {
        const response = authorizeRequest(
            new Request('https://worker.example/download/private-sub'),
            { SUB_STORE_FRONTEND_BACKEND_PATH: managementPath },
        );

        expect(response.status).to.equal(401);
    });

    it('keeps tokenized share routes public', function () {
        const request = new Request(
            'https://worker.example/share/sub/example?token=share-token',
        );

        expect(
            authorizeRequest(request, {
                SUB_STORE_FRONTEND_BACKEND_PATH: managementPath,
            }),
        ).to.equal(request);
    });

    it('fails closed when management authentication is not configured', function () {
        const response = authorizeRequest(
            new Request('https://worker.example/api/settings'),
            {},
        );

        expect(response.status).to.equal(401);
    });

    it('does not expose the internal scheduler endpoint', function () {
        const response = authorizeRequest(
            new Request(`https://worker.example${INTERNAL_SCHEDULE_PATH}`),
            { SUB_STORE_FRONTEND_BACKEND_PATH: managementPath },
        );

        expect(response.status).to.equal(404);
    });

    it('does not expose the scheduler behind the management prefix', function () {
        const response = authorizeRequest(
            new Request(
                `https://worker.example${managementPath}${INTERNAL_SCHEDULE_PATH}`,
            ),
            { SUB_STORE_FRONTEND_BACKEND_PATH: managementPath },
        );

        expect(response.status).to.equal(404);
    });
});
