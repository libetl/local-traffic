import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { dirname, resolve } from 'node:path';
import typescript from 'typescript';
import { readFile as realReadFile } from 'node:fs/promises';
import { buffers, createServer, createSecureServer, http2OutboundHeadersResponses, http2OutboundPayloadResponses, readFile, tearDown, writeFile, setup, responses } from './mocks.mjs';

const localTraffic = await (async () => {
    const source = (await realReadFile(resolve(new URL(dirname(import.meta.url)).pathname, '..', 'index.ts'))).toString();
    const javascript = typescript.transpileModule(source, {
        compilerOptions: {
            module: "ES2020"
        }
    }).outputText;
    const javascriptWithMocks = javascript.replace(/from "(http|http2|https|fs|process)"/g, `from "${dirname(import.meta.url)}/mocks.mjs"`)
    const base64Module = `data:text/javascript;base64,${Buffer.from(javascriptWithMocks).toString('base64url')}`;
    return await import(base64Module);
})();

const {
    start,
    load,
    errorListener,
    quickStatus,
    websocketServe,
    createWebsocketBufferFrom,
    readWebsocketBuffer,
    acknowledgeWebsocket,
    replaceBody,
    replaceTextUsingMapping,
    send,
    determineMapping,
    serve,
    update,
} = localTraffic;

describe('config load', async () => {

    beforeEach(() => {
        readFile.mock.resetCalls()
        writeFile.mock.resetCalls()
    })

    it('should write a default config if the json file does not exist', async () => {
        buffers.push('ENOENT');

        const config = await load();

        assert.equal(readFile.mock.callCount(), 1);
        assert.equal(writeFile.mock.callCount(), 1);

        assert.deepEqual(config, {
            mapping: {
                "/config/": "config://",
                "/logs/": "logs://",
            },
            port: 8080,
            replaceRequestBodyUrls: false,
            replaceResponseBodyUrls: false,
            dontUseHttp2Downstream: false,
            dontTranslateLocationHeader: false,
            simpleLogs: false,
            websocket: true,
            disableWebSecurity: false,
        })
    })

    it('should not write a default config even if the json file does not exist, after the first time', async () => {
        buffers.push('ENOENT');

        const config = await load(false);

        assert.equal(readFile.mock.callCount(), 1);
        assert.equal(writeFile.mock.callCount(), 0);

        assert.deepEqual(config, {
            mapping: {
                "/config/": "config://",
                "/logs/": "logs://",
            },
            port: 8080,
            replaceRequestBodyUrls: false,
            replaceResponseBodyUrls: false,
            dontUseHttp2Downstream: false,
            dontTranslateLocationHeader: false,
            simpleLogs: false,
            websocket: true,
            disableWebSecurity: false,
        })
    })

    it('should load the default config if the json file is invalid', async () => {
        const config = await load();

        assert.equal(readFile.mock.callCount(), 1);

        assert.deepEqual(config, {
            mapping: {
                "/config/": "config://",
                "/logs/": "logs://",
            },
            port: 8080,
            replaceRequestBodyUrls: false,
            replaceResponseBodyUrls: false,
            dontUseHttp2Downstream: false,
            dontTranslateLocationHeader: false,
            simpleLogs: false,
            websocket: true,
            disableWebSecurity: false,
        })
    })

    it('should load the mapping provided in the file', async () => {
        buffers.push(JSON.stringify({ mapping: { "/home/": "https://localhost:12345/home/", "": "https://acme.com" } }))
        const config = await load();

        assert.equal(readFile.mock.callCount(), 1);

        assert.deepEqual(config, {
            mapping: {
                "/home/": "https://localhost:12345/home/",
                "": "https://acme.com"
            },
            port: 8080,
            replaceRequestBodyUrls: false,
            replaceResponseBodyUrls: false,
            dontUseHttp2Downstream: false,
            dontTranslateLocationHeader: false,
            simpleLogs: false,
            websocket: true,
            disableWebSecurity: false,
        })
    })

    it('should load any options provided in the file', async () => {
        buffers.push(JSON.stringify({
            mapping: { "/home/": "https://localhost:12345/home/", "": "https://acme.com" },
            ssl: {
                key: "key",
                cert: "cert"
            },
            port: 443,
            replaceRequestBodyUrls: true,
            replaceResponseBodyUrls: true,
            dontUseHttp2Downstream: true,
            dontTranslateLocationHeader: true,
            simpleLogs: true,
            websocket: false,
            disableWebSecurity: true,
        }))
        const config = await load();

        assert.equal(readFile.mock.callCount(), 1);

        assert.deepEqual(config, {
            mapping: { "/home/": "https://localhost:12345/home/", "": "https://acme.com" },
            ssl: {
                key: "key",
                cert: "cert"
            },
            port: 443,
            replaceRequestBodyUrls: true,
            replaceResponseBodyUrls: true,
            dontUseHttp2Downstream: true,
            dontTranslateLocationHeader: true,
            simpleLogs: true,
            websocket: false,
            disableWebSecurity: true,
        })
    })
});

describe('server starter', async () => {

    before(() => setup())
    after(() => tearDown())

    beforeEach(() => {
        createServer.mock.resetCalls();
        createSecureServer.mock.resetCalls();
    })

    it('should invoke createServer for insecure servers', async () => {
        await start({
            mapping: {
                "/config/": "config://",
                "/logs/": "logs://",
            },
            port: 8080,
            simpleLogs: false,
        })

        assert.equal(createServer.mock.callCount(), 1);
        assert.equal(createSecureServer.mock.callCount(), 0);
    })

    it('should invoke createSecureServer for secure servers', async () => {
        await start({
            mapping: {
                "/config/": "config://",
                "/logs/": "logs://",
            },
            ssl: {
                key: "key",
                cert: "cert",
            },
            port: 443,
            simpleLogs: false,
        })

        assert.equal(createServer.mock.callCount(), 0);
        assert.equal(createSecureServer.mock.callCount(), 1);
    })

    it('should be rerun when the watcher detects changes with the ssl certificate', async () => {
        await start({
            mapping: {
                "/config/": "config://",
                "/logs/": "logs://",
            },
            port: 8080,
            simpleLogs: false,
        })

        assert.equal(createServer.mock.callCount(), 1);
        assert.equal(createSecureServer.mock.callCount(), 0);

        buffers.unshift(JSON.stringify({
            ssl: {
                key: "key",
                cert: "cert",
            }
        }))

        buffers.unshift('watcher');

        await new Promise(resolve => setTimeout(resolve, 2));

        assert.equal(createServer.mock.callCount(), 1);
        assert.equal(createSecureServer.mock.callCount(), 1);

    })

    it('should be rerun when the watcher detects changes with the port number', async () => {
        await start({
            mapping: {
                "/config/": "config://",
                "/logs/": "logs://",
            },
            port: 8080,
            simpleLogs: false,
        })

        assert.equal(createServer.mock.callCount(), 1);
        assert.equal(createSecureServer.mock.callCount(), 0);

        buffers.unshift(JSON.stringify({ port: 9080 }))
        buffers.unshift('watcher');

        await new Promise(resolve => setTimeout(resolve, 2));

        assert.equal(createServer.mock.callCount(), 2);
        assert.equal(createSecureServer.mock.callCount(), 0);
    })


    describe('server cruise', async () => {

        before(() => setup())
        after(() => tearDown())

        it('should handle a simple request without mapping', async () => {
            await start({
                mapping: {
                    "/config/": "config://",
                    "/logs/": "logs://",
                },
                port: 8080,
                simpleLogs: false,
            })

            buffers.unshift(`request=${JSON.stringify({
                method: 'GET',
                headers: {
                    host: 'localhost'
                },
                url: '/foo/bar'
            })}`);

            await new Promise(resolve => setTimeout(resolve, 2));

            const response = responses.shift();
            assert.equal(response.code, 502);
            assert.match(response.body.toString(), /An error happened while trying to proxy a remote exchange/);
            assert.match(response.body.toString(), /No mapping found in config file/);
        });

        it('should handle a simple http/2 request with a default mapping', async () => {
            await start({
                mapping: {
                    "/config/": "config://",
                    "/logs/": "logs://",
                    "": "https://acme.info",
                },
                port: 8080,
                simpleLogs: false,
            })

            buffers.unshift(`request=${JSON.stringify({
                method: 'GET',
                headers: {
                    host: 'localhost'
                },
                url: '/foo/bar'
            })}`);
            http2OutboundHeadersResponses.unshift({
                [':status']: 200,
                ["content-length"]: 12
            });
            http2OutboundPayloadResponses.unshift(Buffer.from("Hello World !"));

            await new Promise(resolve => setTimeout(resolve, 2));

            const response = responses.shift();
            assert.equal(response.code, 200);
            assert.match(response.body.toString(), /Hello World !/);
        });

        it('should render the config page when the request matches the path', async () => {
            await start({
                mapping: {
                    "/config/": "config://",
                    "/logs/": "logs://",
                    "": "https://acme.info",
                },
                port: 8080,
                simpleLogs: false,
            })

            buffers.unshift(`request=${JSON.stringify({
                method: 'GET',
                headers: {
                    host: 'localhost'
                },
                url: '/config/'
            })}`);

            await new Promise(resolve => setTimeout(resolve, 2));

            const response = responses.shift();
            assert.equal(response.code, 200);
            assert.match(response.body.toString(), /local-traffic config/);
        });

        it('should render the logs page when the request matches the path', async () => {
            await start({
                mapping: {
                    "/config/": "config://",
                    "/logs/": "logs://",
                    "": "https://acme.info",
                },
                port: 8080,
                simpleLogs: false,
            })

            buffers.unshift(`request=${JSON.stringify({
                method: 'GET',
                headers: {
                    host: 'localhost'
                },
                url: '/logs/'
            })}`);

            await new Promise(resolve => setTimeout(resolve, 2));

            const response = responses.shift();
            assert.equal(response.code, 200);
            assert.match(response.body.toString(), /local-traffic logs/);
        });
    });
});