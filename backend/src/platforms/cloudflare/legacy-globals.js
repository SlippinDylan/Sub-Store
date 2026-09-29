import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'buffer';
import { TrackedStorageAdapter } from './tracked-storage.js';

const requestContext = new AsyncLocalStorage();
let attachedApp;

export const $httpClient = {};

for (const method of [
    'get',
    'post',
    'put',
    'delete',
    'head',
    'options',
    'patch',
]) {
    $httpClient[method] = (options, callback) => {
        if (options.proxy || options.node) {
            callback(
                new Error(
                    'Cloudflare Workers does not support outbound proxy selection',
                ),
            );
            return;
        }
        if (
            options.insecure === true ||
            options.strictSSL === false ||
            options.rejectUnauthorized === false
        ) {
            callback(
                new Error(
                    'Cloudflare Workers cannot disable TLS certificate verification',
                ),
            );
            return;
        }
        const controller = new AbortController();
        const timeout = Number(options.timeout);
        const timeoutId =
            Number.isFinite(timeout) && timeout > 0
                ? setTimeout(() => controller.abort(), timeout)
                : undefined;
        const url = new URL(options.url);
        const headers = new Headers(options.headers || {});
        if ((url.username || url.password) && !headers.has('authorization')) {
            const username = decodeURIComponent(url.username);
            const password = decodeURIComponent(url.password);
            headers.set(
                'authorization',
                `Basic ${Buffer.from(`${username}:${password}`).toString(
                    'base64',
                )}`,
            );
        }
        url.username = '';
        url.password = '';
        fetch(url.toString(), {
            method: method.toUpperCase(),
            headers,
            body: ['get', 'head'].includes(method) ? undefined : options.body,
            redirect: 'follow',
            signal: controller.signal,
        })
            .then(async (response) => {
                const body =
                    options.encoding === null
                        ? await response.arrayBuffer()
                        : await response.text();
                callback(
                    null,
                    {
                        status: response.status,
                        statusCode: response.status,
                        headers: Object.fromEntries(response.headers),
                    },
                    body,
                );
            })
            .catch((error) => callback(error))
            .finally(() => {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
            });
    };
}

function context() {
    const activeContext = requestContext.getStore();
    if (activeContext) return activeContext;
    if (!attachedApp) return null;
    throw new Error('Persistent storage accessed outside storage context');
}

function storage() {
    const activeContext = context();
    if (!activeContext) return null;
    if (!activeContext.storage) {
        throw new Error('Missing storage adapter in storage context');
    }
    return activeContext.storage;
}

function flushImplicitWrites() {
    const activeStorage = storage();
    if (!activeStorage) return;
    for (const key of activeStorage.flushImplicitWrites()) {
        attachedApp.warn(`Implicit persistent mutation: ${key}; auto-saved`);
    }
}

export const $persistentStore = {
    read(key) {
        const store = storage();
        if (!store) return null;
        if (key === 'sub-store') {
            flushImplicitWrites();
            return JSON.stringify(store.loadData());
        }
        return store.getRoot(key);
    },

    write(value, key) {
        const store = storage();
        if (!store) return false;
        if (key === 'sub-store') {
            const data = JSON.parse(value || '{}');
            store.replaceData(data);
        } else if (value == null) {
            store.deleteRoot(key);
        } else {
            store.putRoot(key, value);
        }
        return true;
    },
};

export const $request = new Proxy(
    {},
    {
        get(target, property) {
            return requestContext.getStore()?.request?.[property];
        },
    },
);

export function $done(value) {
    const activeContext = context();
    if (!activeContext || typeof activeContext.resolve !== 'function') {
        throw new Error('$done called outside a Worker request');
    }
    try {
        flushImplicitWrites();
        activeContext.storage.commit();
        activeContext.resolve(value?.response || value);
    } catch (error) {
        activeContext.reject(error);
    }
}

export function attachPersistentStore(app) {
    attachedApp = app;
    app.read = (key) => {
        app.log(`READ ${key}`);
        if (key.includes('#')) return $persistentStore.read(key.substr(1));
        return storage().getData(key);
    };
    app.write = (value, key) => {
        app.log(`SET ${key}`);
        if (key.includes('#')) {
            return $persistentStore.write(value, key.substr(1));
        }
        storage().putData(key, value);
        return true;
    };
    app.delete = (key) => {
        app.log(`DELETE ${key}`);
        if (key.includes('#')) {
            return $persistentStore.write(null, key.substr(1));
        }
        storage().deleteData(key);
        return true;
    };

    const legacyCache = new Proxy(Object.create(null), {
        get(target, property) {
            if (typeof property === 'symbol') return target[property];
            return storage().getData(property);
        },
        set(target, property, value) {
            storage().putData(property, value);
            return true;
        },
        deleteProperty(target, property) {
            storage().deleteData(property);
            return true;
        },
        ownKeys() {
            return Reflect.ownKeys(storage().loadData());
        },
        getOwnPropertyDescriptor(target, property) {
            const value = storage().getData(property);
            return value === undefined
                ? undefined
                : {
                      configurable: true,
                      enumerable: true,
                      writable: true,
                      value,
                  };
        },
    });
    Object.defineProperty(app, 'cache', {
        configurable: true,
        enumerable: true,
        get() {
            return legacyCache;
        },
        set(value) {
            storage().replaceData(value || {});
        },
    });
    app.persistCache = () => {
        flushImplicitWrites();
        return true;
    };
}

function trackedStorage(adapter) {
    return new TrackedStorageAdapter(adapter);
}

export function runWithInitializationStorage(adapter, callback) {
    const activeContext = {
        storage: trackedStorage(adapter),
    };
    return requestContext.run(activeContext, async () => {
        let result;
        try {
            result = await callback();
        } catch (error) {
            activeContext.storage.discard();
            throw error;
        }
        flushImplicitWrites();
        activeContext.storage.commit();
        return result;
    });
}

export function runWithLegacyGlobals(request, adapter, callback) {
    return new Promise((resolve, reject) => {
        const context = {
            request,
            resolve,
            reject,
            storage: trackedStorage(adapter),
        };
        requestContext.run(context, () => {
            try {
                callback();
            } catch (error) {
                context.storage.discard();
                reject(error);
            }
        });
    });
}
