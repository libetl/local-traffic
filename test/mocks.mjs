import { mock } from "node:test"

const requestListeners = [];
const watchFileCallbacks = [];
export const buffers = [];
export const responses = [];
export const http2OutboundRequests = [];
export const http2OutboundHeadersResponses = [];
export const http2OutboundPayloadResponses = [];
const Server = class {
    constructor(requestListener) {
        this.requestListener = requestListener;
        requestListeners.unshift(requestListener);
    }
    addListener = mock.fn(() => this)
    on = mock.fn(() => this)
    listen = mock.fn(() => this)
    close = mock.fn((resolve) => resolve())
}

export const argv = ["test-runner", "local-traffic"]
export const cwd = mock.fn(() => "/home/user/fake-dir")
export const createServer = mock.fn((requestListener) => new Server(requestListener))
export const createSecureServer = mock.fn((requestListener) => new Server(requestListener))
export const connect = mock.fn((_1, _2, resolve) => {
    process.nextTick(() => resolve({}, { alpnProtocol: true }))
    return {
        on: (event, callback) => { },
        request: (http2OutboundRequest) => {
            http2OutboundRequests.unshift(http2OutboundRequest)
            return {
                on: (event, callback) => { 
                    if (event === 'response') {
                        callback(http2OutboundHeadersResponses.shift());
                    }
                    if (event === 'data') {
                        callback(http2OutboundPayloadResponses.shift());
                    }
                    if (event === 'end') {
                        callback(Buffer.from([]));
                    }
                },
            };
        }
    }
})
export const env = { HOME: "/home/user" }
export const hrtime = { bigint: mock.fn(() => 40941324141165n) }
export const request = mock.fn(() => ({}))
export const lstat = mock.fn((path, callback) => {
    process.nextTick(() => callback(null, { isDirectory: () => false, isFile: () => true }))
})
export const readFile = mock.fn((path, callback) => {
    const nextValue = buffers.shift();
    if (nextValue === 'ENOENT') {
        const errorNoEntry = new Error();
        errorNoEntry.code = 'ENOENT';
        process.nextTick(() => callback(errorNoEntry, null));
    } else process.nextTick(() => callback(null, nextValue ?? Buffer.from("Hello world")))
})
export const readdir = mock.fn((path, callback) => {
    process.nextTick(() => callback(null, ["file1.txt", "file2.txt"]))
})
export const stdout = { isTTY: true }

let interval = null;
export const watchFile = mock.fn((filename, callback) => {
    watchFileCallbacks.unshift(callback);
});
export const writeFile = mock.fn((filename, content, callback) => process.nextTick(() => callback()))

export const setup = () => {
    if (interval) return;
    interval = setInterval(() => {
        if (buffers[0]?.length === 7 && buffers[0]?.toString() === 'watcher') {
            buffers.shift();
            process.nextTick(() => {
                const callback = watchFileCallbacks.shift();
                callback();
            });
        }
        if (buffers[0]?.toString()?.startsWith('request=')) {
            const request = JSON.parse(buffers.shift().substring(8));
            process.nextTick(() => {
                const requestListener = requestListeners.shift();
                let response = {};
                Object.assign(response, {
                    writeHead: (
                        code,
                        statusMessage,
                        headers,
                    ) => {
                        response.code = code ?? 200;
                        response.statusMessage = statusMessage ?? "";
                        response.headers = headers ?? {};
                    },
                    setHeader: (headerName, headerValue) => {
                        response.headers = response.headers ?? {};
                        response.headers[headerName] = headerValue;
                    },
                    end: (buffer) => {
                        if (response.body) {
                            response.body = Buffer.concat(response.body, buffer);
                        } else response.body = buffer ?? response.body;
                    }
                })
                responses.unshift(response);
                requestListener(request, response);
            });
        }
    }, 1);
}

export const tearDown = () => {
    if (!interval) return;
    clearInterval(interval);
    requestListeners.splice(0, requestListeners.length);
    interval = null;
}
