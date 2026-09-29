#!/usr/bin/env node
const { build } = require('esbuild');
const { builtinModules } = require('module');
const objectHasOwnPolyfill = require.resolve('core-js/actual/object/has-own');
const cloudflareStaticPeggy = require('./cloudflare-peggy-plugin');
const cloudflareOutfile = 'dist/sub-store.cloudflare.js';

// Match the upstream browser bundler, including its Buffer polyfill exception.
const builtinModuleNames = new Set(
    builtinModules.map((name) => name.replace(/^node:/, '')),
);
const nodeBuiltinExternalPlugin = {
    name: 'node-builtin-external',
    setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
            if (
                args.path !== 'buffer' &&
                builtinModuleNames.has(args.path.replace(/^node:/, ''))
            ) {
                return { path: args.path, external: true };
            }
        });
        build.onEnd((result) => {
            const allowed = new Set([
                'async_hooks',
                'cloudflare:workers',
                'node:async_hooks',
                'dgram',
                'fs',
                'net',
                'path',
                'stream/promises',
                'tls',
            ]);
            const externalBuiltins = new Set(
                Object.values(result.metafile?.outputs || {}).flatMap(
                    (output) =>
                        (output.imports || [])
                            .filter((item) => item.external)
                            .map((item) => item.path),
                ),
            );
            const unsupported = [...externalBuiltins].filter(
                (specifier) => !allowed.has(specifier),
            );
            if (unsupported.length > 0) {
                throw new Error(
                    `Unsupported external imports in Cloudflare bundle: ${unsupported.join(
                        ', ',
                    )}`,
                );
            }
        });
    },
};

build({
    entryPoints: ['src/platforms/cloudflare/index.js'],
    bundle: true,
    minify: true,
    sourcemap: true,
    platform: 'browser',
    format: 'esm',
    outfile: cloudflareOutfile,
    external: ['cloudflare:workers'],
    inject: [
        objectHasOwnPolyfill,
        'src/platforms/cloudflare/legacy-globals.js',
    ],
    loader: { '.wasm': 'copy' },
    plugins: [cloudflareStaticPeggy, nodeBuiltinExternalPlugin],
    metafile: true,
    define: {
        'globalThis.__SUB_STORE_RUNTIME__': JSON.stringify('cloudflare-worker'),
    },
    logOverride: { 'direct-eval': 'silent' },
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
