import { DurableObject } from 'cloudflare:workers';
import { DOStorageAdapter } from './storage';
import {
    attachPersistentStore,
    runWithInitializationStorage,
} from './legacy-globals';
import { registerQuickJSRuntime } from './quickjs-runtime';
import createCloudflareRouter from './router';
import { registerHttpServerFactory } from '@/runtime/http-server';
import { authorizeRequest } from './request-auth';
import { authorizeShareRequest } from './share-auth';

registerQuickJSRuntime();
registerHttpServerFactory(createCloudflareRouter);

const DURABLE_OBJECT_NAME = 'default';
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export class SubStoreDO extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.storage = new DOStorageAdapter(ctx.storage);
        this.requestQueue = Promise.resolve();
        this.ready = ctx.blockConcurrencyWhile(async () => {
            const { default: $ } = await import('@/core/app');
            $.workerEnv = env;
            this.$ = $;
            attachPersistentStore($);

            await runWithInitializationStorage(this.storage, async () => {
                const [
                    { default: migrate },
                    { default: serve },
                    { syncArtifacts },
                    { consumeShareToken },
                    { SETTINGS_KEY },
                    { AGE_PUBLIC_KEY },
                ] = await Promise.all([
                    import('@/utils/migration'),
                    import('@/restful'),
                    import('@/restful/sync'),
                    import('@/restful/token'),
                    import('@/constants'),
                    import('@/utils/age'),
                ]);
                migrate();
                this.app = serve();
                this.syncArtifacts = syncArtifacts;
                this.consumeShareToken = consumeShareToken;
                this.settingsKey = SETTINGS_KEY;
                this.agePublicKey = AGE_PUBLIC_KEY;
            });
        });
    }

    fetch(request) {
        return this.enqueue(() => this.handleRequest(request));
    }

    runScheduled() {
        return this.enqueue(() => this.handleScheduled()).then(() => undefined);
    }

    enqueue(run) {
        const response = this.requestQueue.then(run, run);
        this.requestQueue = response.then(
            () => undefined,
            () => undefined,
        );
        return response;
    }

    async handleRequest(request) {
        await this.ready;
        const headers = Object.fromEntries(request.headers);
        const contentLength = Number(request.headers.get('content-length'));
        if (
            Number.isFinite(contentLength) &&
            contentLength > MAX_REQUEST_BODY_BYTES
        ) {
            return new Response('Request body too large', { status: 413 });
        }
        const body = ['GET', 'HEAD'].includes(request.method)
            ? undefined
            : await request.text();
        if (
            body !== undefined &&
            new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES
        ) {
            return new Response('Request body too large', { status: 413 });
        }
        const legacyRequest = {
            method: request.method,
            url: request.url,
            headers,
            body,
            socket: {
                remoteAddress: request.headers.get('cf-connecting-ip'),
            },
        };
        const response = await runWithInitializationStorage(
            this.storage,
            async () => {
                const shareFailure = authorizeShareRequest({
                    request: legacyRequest,
                    consumeShareToken: this.consumeShareToken,
                    readSettings: (key) => this.$.read(key),
                    settingsKey: this.settingsKey,
                    agePublicKey: this.agePublicKey,
                });
                if (shareFailure) return shareFailure;
                return this.app.handle(legacyRequest);
            },
        );
        const status = response.statusCode || response.status || 200;
        const responseHeaders =
            typeof response.getHeaders === 'function'
                ? response.getHeaders()
                : response.headers;
        const hasBody =
            request.method !== 'HEAD' && ![204, 205, 304].includes(status);
        return new Response(hasBody ? response.body : null, {
            status,
            headers: responseHeaders,
        });
    }

    async handleScheduled() {
        await this.ready;
        await runWithInitializationStorage(this.storage, () =>
            this.syncArtifacts({ skipCronArtifacts: true }),
        );
        return new Response(null, { status: 204 });
    }
}

export default {
    async fetch(request, env) {
        const authorized = authorizeRequest(request, env);
        if (authorized instanceof Response) return authorized;
        try {
            return await env.SUB_STORE.getByName(DURABLE_OBJECT_NAME).fetch(
                authorized,
            );
        } catch (error) {
            console.error('[Cloudflare] Durable Object request failed', error);
            throw error;
        }
    },
    async scheduled(controller, env, ctx) {
        const stub = env.SUB_STORE.getByName(DURABLE_OBJECT_NAME);
        ctx.waitUntil(stub.runScheduled());
    },
};
