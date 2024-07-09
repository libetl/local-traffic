import { mock } from "node:test";

const requestListeners = [];
const watchFileCallbacks = [];
const watchOnceFileCallbacks = [];
export const buffers = [];
export const responses = [];
export const http2OutboundRequests = [];
export const http2OutboundHeadersResponses = [];
export const http2OutboundPayloadResponses = [];
export const http1OutboundResponses = [];
const Server = class {
  constructor(requestListener) {
    this.requestListener = requestListener;
    requestListeners.unshift(requestListener);
  }
  addListener = mock.fn(() => this);
  on = mock.fn(() => this);
  listen = mock.fn(() => this);
  close = mock.fn(resolve => resolve());
};

export const argv = ["test-runner", "local-traffic"];
export const cwd = mock.fn(() => "/home/user/fake-dir");
export const exit = mock.fn(() => {});
export const homedir = mock.fn(() => "/home/user");
export const createServer = mock.fn(
  requestListener => new Server(requestListener),
);
export const createSecureServer = mock.fn(
  requestListener => new Server(requestListener),
);
export const connect = mock.fn((targetUrl, _2, resolve) => {
  if (!targetUrl?.pathname?.includes("http1"))
    process.nextTick(() => resolve({}, { alpnProtocol: "h2c" }));
  return {
    alpnProtocol: "h2c",
    on: (event, callback) => {},
    request: http2OutboundRequest => {
      http2OutboundRequests.unshift(http2OutboundRequest);
      return {
        write: buffer => {
          http2OutboundRequests[0].buffer = Buffer.concat([
            http2OutboundRequests[0].buffer ?? Buffer.from([]),
            buffer,
          ]);
        },
        end: data => {},
        on: (event, callback) => {
          if (event === "response") {
            callback(http2OutboundHeadersResponses.shift());
          }
          if (event === "data") {
            callback(http2OutboundPayloadResponses.shift());
          }
          if (event === "end") {
            callback(Buffer.from([]));
          }
        },
      };
    },
  };
});
export const env = { HOME: "/home/user" };
export const hrtime = { bigint: mock.fn(() => 40941324141165n) };
export const request = mock.fn((http1Request, resolve) => {
  process.nextTick(() => {
    const response = http1OutboundResponses.shift();
    resolve({
      headers: response.headers,
      on: (type, listener) => {
        if (type === "data") {
          process.nextTick(() => listener(Buffer.from(response.body)));
        }
        if (type === "end") {
          process.nextTick(() => listener(Buffer.from([])));
        }
      },
    });
  });
  return { write: () => {}, end: () => {}, on: () => {} };
});
export const lstat = mock.fn((path, callback) => {
  process.nextTick(() =>
    callback(null, {
      isDirectory: () => path.includes("i/am/a/folder"),
      isFile: () => true,
    }),
  );
});
export const readFile = mock.fn((path, callback) => {
  const nextValue = buffers.shift();
  if (nextValue === "ENOENT") {
    const errorNoEntry = new Error();
    errorNoEntry.code = "ENOENT";
    process.nextTick(() => callback(errorNoEntry, null));
  } else
    process.nextTick(() =>
      callback(null, nextValue ?? Buffer.from("Hello world")),
    );
});
export const readdir = mock.fn((path, callback) => {
  process.nextTick(() => callback(null, ["file1.txt", "file2.txt"]));
});
export const stdout = {
  isTTY: true,
  moveCursor: (_x, _y, resolve) => {
    resolve();
  },
  write: () => {},
};

let interval = null;
export const watchFile = mock.fn((filename, callback) => {
  watchFileCallbacks.unshift(callback);
  return {
    once: (_, callback) => watchOnceFileCallbacks.unshift(callback),
  };
});
export const writeFile = mock.fn((filename, content, callback) =>
  process.nextTick(() => {
    callback();
    watchFileCallbacks.forEach(callback => callback());
    watchOnceFileCallbacks.forEach(callback => callback());
    watchOnceFileCallbacks.splice(0, watchOnceFileCallbacks.length);
  }),
);

export const setup = () => {
  if (interval) return;
  interval = setInterval(() => {
    if (buffers[0]?.length === 7 && buffers[0]?.toString() === "watcher") {
      buffers.shift();
      process.nextTick(() => {
        const callback = watchFileCallbacks.shift();
        callback();
      });
    }
    if (buffers[0]?.toString()?.startsWith("request=")) {
      const request = JSON.parse(buffers.shift().substring(8));
      request.on = () => {};
      if (request?.url && request?.body && !request.url.includes("http1")) {
        request.stream = {
          readableLength: request.body.length,
          on: (type, listener) => {
            listener(Buffer.from(request.body));
          },
        };
      }
      process.nextTick(() => {
        const requestListener = requestListeners.shift();
        let response = {};
        Object.assign(response, {
          writeHead: (code, statusMessage, headers) => {
            response.code = code ?? 200;
            response.statusMessage =
              typeof statusMessage === "object" ? "" : statusMessage ?? "";
            response.headers =
              typeof statusMessage === "object" ? statusMessage : headers ?? {};
          },
          setHeader: (headerName, headerValue) => {
            response.headers = response.headers ?? {};
            response.headers[headerName] = headerValue;
          },
          end: buffer => {
            if (response.body) {
              response.body = Buffer.concat(response.body, buffer);
            } else response.body = buffer ?? response.body;
          },
        });
        responses.unshift(response);
        requestListener(request, response);
      });
    }
  }, 1);
};

export const tearDown = () => {
  if (!interval) return;
  clearInterval(interval);
  requestListeners.splice(0, requestListeners.length);
  interval = null;
};
