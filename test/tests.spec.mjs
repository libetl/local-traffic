import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { dirname, resolve } from "node:path";
import typescript from "typescript";
import { readFile as realReadFile } from "node:fs/promises";
import {
  gzip,
  gunzip,
  deflate,
  inflate,
  brotliCompress,
  brotliDecompress,
} from "node:zlib";
import {
  buffers,
  createServer,
  createSecureServer,
  http1OutboundResponses,
  http2OutboundRequests,
  http2OutboundHeadersResponses,
  http2OutboundPayloadResponses,
  readFile,
  tearDown,
  writeFile,
  setup,
  responses,
} from "./mocks.mjs";

const localTraffic = await (async () => {
  const source = (
    await realReadFile(
      resolve(new URL(dirname(import.meta.url)).pathname, "..", "index.ts"),
    )
  ).toString();
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2020,
    },
  }).outputText;
  const javascriptWithMocks = javascript
    .replace(
      /from "(http|http2|https|fs|process)"/g,
      `from "${dirname(import.meta.url)}/mocks.mjs"`,
    )
    .replace("3000", "3");
  const base64Module = `data:text/javascript;base64,${Buffer.from(
    javascriptWithMocks,
  ).toString("base64url")}`;
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

describe("config load", async () => {
  beforeEach(() => {
    readFile.mock.resetCalls();
    writeFile.mock.resetCalls();
  });

  it("should write a default config if the json file does not exist", async () => {
    buffers.push("ENOENT");

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
    });
  });

  it("should not write a default config even if the json file does not exist, after the first time", async () => {
    buffers.push("ENOENT");

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
    });
  });

  it("should load the default config if the json file is invalid", async () => {
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
    });
  });

  it("should load the mapping provided in the file", async () => {
    buffers.push(
      JSON.stringify({
        mapping: {
          "/home/": "https://localhost:12345/home/",
          "": "https://acme.com",
        },
      }),
    );
    const config = await load();

    assert.equal(readFile.mock.callCount(), 1);

    assert.deepEqual(config, {
      mapping: {
        "/home/": "https://localhost:12345/home/",
        "": "https://acme.com",
      },
      port: 8080,
      replaceRequestBodyUrls: false,
      replaceResponseBodyUrls: false,
      dontUseHttp2Downstream: false,
      dontTranslateLocationHeader: false,
      simpleLogs: false,
      websocket: true,
      disableWebSecurity: false,
    });
  });

  it("should load any options provided in the file", async () => {
    buffers.push(
      JSON.stringify({
        mapping: {
          "/home/": "https://localhost:12345/home/",
          "": "https://acme.com",
        },
        ssl: {
          key: "key",
          cert: "cert",
        },
        port: 443,
        replaceRequestBodyUrls: true,
        replaceResponseBodyUrls: true,
        dontUseHttp2Downstream: true,
        dontTranslateLocationHeader: true,
        simpleLogs: true,
        websocket: false,
        disableWebSecurity: true,
      }),
    );
    const config = await load();

    assert.equal(readFile.mock.callCount(), 1);

    assert.deepEqual(config, {
      mapping: {
        "/home/": "https://localhost:12345/home/",
        "": "https://acme.com",
      },
      ssl: {
        key: "key",
        cert: "cert",
      },
      port: 443,
      replaceRequestBodyUrls: true,
      replaceResponseBodyUrls: true,
      dontUseHttp2Downstream: true,
      dontTranslateLocationHeader: true,
      simpleLogs: true,
      websocket: false,
      disableWebSecurity: true,
    });
  });
});

describe("server starter", async () => {
  before(() => setup());
  after(() => tearDown());

  beforeEach(() => {
    createServer.mock.resetCalls();
    createSecureServer.mock.resetCalls();
  });

  it("should invoke createServer for insecure servers", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
      },
      port: 8080,
      simpleLogs: false,
    });

    assert.equal(createServer.mock.callCount(), 1);
    assert.equal(createSecureServer.mock.callCount(), 0);
  });

  it("should invoke createSecureServer for secure servers", async () => {
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
    });

    assert.equal(createServer.mock.callCount(), 0);
    assert.equal(createSecureServer.mock.callCount(), 1);
  });

  it("should be rerun when the watcher detects changes with the ssl certificate", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
      },
      port: 8080,
      simpleLogs: false,
    });

    assert.equal(createServer.mock.callCount(), 1);
    assert.equal(createSecureServer.mock.callCount(), 0);

    buffers.unshift(
      JSON.stringify({
        ssl: {
          key: "key",
          cert: "cert",
        },
      }),
    );

    buffers.unshift("watcher");

    await new Promise(resolve => setTimeout(resolve, 2));

    assert.equal(createServer.mock.callCount(), 1);
    assert.equal(createSecureServer.mock.callCount(), 1);
  });

  it("should be rerun when the watcher detects changes with the port number", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
      },
      port: 8080,
      simpleLogs: false,
    });

    assert.equal(createServer.mock.callCount(), 1);
    assert.equal(createSecureServer.mock.callCount(), 0);

    buffers.unshift(JSON.stringify({ port: 9080 }));
    buffers.unshift("watcher");

    await new Promise(resolve => setTimeout(resolve, 2));

    assert.equal(createServer.mock.callCount(), 2);
    assert.equal(createSecureServer.mock.callCount(), 0);
  });
});

describe("server cruise", async () => {
  before(() => setup());
  after(() => tearDown());

  it("should handle a simple request without mapping", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
      },
      port: 8080,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/foo/bar",
      })}`,
    );

    await new Promise(resolve => setTimeout(resolve, 2));

    const response = responses.shift();
    assert.equal(response.code, 502);
    assert.match(
      response.body.toString(),
      /An error happened while trying to proxy a remote exchange/,
    );
    assert.match(response.body.toString(), /No mapping found in config file/);
  });

  it("should handle a simple http/2 request with a default mapping", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "": "https://acme.info",
      },
      port: 8080,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/foo/bar",
      })}`,
    );
    http2OutboundHeadersResponses.unshift({
      [":status"]: 200,
      ["content-length"]: 12,
    });
    http2OutboundPayloadResponses.unshift(Buffer.from("Hello World !"));

    await new Promise(resolve => setTimeout(resolve, 2));

    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.match(response.body.toString(), /Hello World !/);
  });

  it("should fallback from http/2 to http1.1 request with a default mapping", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "": "https://acme.info",
      },
      port: 8080,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/foo/bar/http1",
      })}`,
    );
    http1OutboundResponses.unshift({
      headers: {
        ["content-type"]: "application/text-plain",
        ["content-length"]: 12,
      },
      body: Buffer.from("Hello World !"),
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.match(response.body.toString(), /Hello World !/);
  });

  it("should handle a simple http1.1 request with a default mapping", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "": "https://acme.info",
      },
      port: 8080,
      dontUseHttp2Downstream: true,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/foo/bar/http1",
      })}`,
    );
    http1OutboundResponses.unshift({
      headers: {
        ["content-type"]: "application/text-plain",
        ["content-length"]: 12,
      },
      body: Buffer.from("Hello World !"),
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.match(response.body.toString(), /Hello World !/);
  });

  it("should render the config page when the request matches the path", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "": "https://acme.info",
      },
      port: 8080,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/config/",
      })}`,
    );

    await new Promise(resolve => setTimeout(resolve, 2));

    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.match(response.body.toString(), /local-traffic config/);
  });

  it("should render the logs page when the request matches the path", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "": "https://acme.info",
      },
      port: 8080,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/logs/",
      })}`,
    );

    await new Promise(resolve => setTimeout(resolve, 2));

    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.match(response.body.toString(), /local-traffic logs/);
  });

  it("should translate the URLs found in the request body", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "/donate/": "https://www.mysite.org/donate/",
        "": "https://acme.info",
      },
      port: 8080,
      replaceRequestBodyUrls: true,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/foo/bar",
        body: "Please follow the link at http://localhost:8080/donate/help.html and pay me a drink",
      })}`,
    );
    http2OutboundHeadersResponses.unshift({
      [":status"]: 200,
      ["content-length"]: 12,
    });
    http2OutboundPayloadResponses.unshift(Buffer.from("Hello World !"));

    await new Promise(resolve => setTimeout(resolve, 5));

    const request = http2OutboundRequests.shift();
    const requestBody = request.buffer.toString();
    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.equal(
      requestBody,
      "Please follow the link at https://www.mysite.org/donate//help.html and pay me a drink",
    );
    assert.match(response.body.toString(), /Hello World !/);
  });

  it("should translate the URLs found in the response body", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "/bank-account/":
          "https://www.someinternationalbank.me/customer/accounts-summary/",
        "": "https://acme.info",
      },
      port: 8080,
      replaceResponseBodyUrls: true,
      simpleLogs: false,
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/foo/bar",
      })}`,
    );
    const responseText = `<ul>
          <li><a href="https://www.someinternationalbank.me/customer/accounts-summary/972332738273-home-saving-scheme">Take me to the home saving scheme</a>
          <li><a href="https://www.someinternationalbank.me/customer/accounts-summary/372352235273-current-account">Current account</a></li>
</ul>`;
    const expectedResponseText = responseText.replace(
      /https:\/\/www\.someinternationalbank\.me\/customer\/accounts-summary\//g,
      "http://localhost:8080/bank-account/",
    );
    http2OutboundHeadersResponses.unshift({
      [":status"]: 200,
      ["content-length"]: responseText.length,
    });
    http2OutboundPayloadResponses.unshift(Buffer.from(responseText));

    await new Promise(resolve => setTimeout(resolve, 5));

    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.notEqual(responseText, expectedResponseText);
    assert.equal(response.body.toString(), expectedResponseText);
  });

  it("should keep the body compression during the body rewrite", async () => {
    await start({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "/test/": "https://www.test.info/test/",
        "": "https://acme.info",
      },
      port: 8080,
      replaceResponseBodyUrls: true,
      simpleLogs: false,
    });

    const responseText =
      "Thank you for completing the survey, please go back to the main page at https://www.test.info/test/index.html";
    const compressedResponseText = await new Promise(resolve =>
      deflate(responseText, (_, result) =>
        brotliCompress(result, (_, result2) =>
          gzip(result2, (_, result3) => resolve(result3)),
        ),
      ),
    );
    const expectedResponseText = responseText.replace(
      /https:\/\/www\.test\.info\/test\//g,
      "http://localhost:8080/test/",
    );
    http2OutboundHeadersResponses.unshift({
      [":status"]: 200,
      ["content-length"]: compressedResponseText.byteLength,
      ["content-encoding"]: "GZip, BR, Deflate",
      ["content-type"]: "text/html",
    });
    http2OutboundPayloadResponses.unshift(Buffer.from(compressedResponseText));

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/foo/bar",
      })}`,
    );

    await new Promise(resolve => setTimeout(resolve, 8));

    const response = responses.shift();
    const actualText = await new Promise(resolve =>
      gunzip(response.body, (err1, result) =>
        brotliDecompress(result, (err2, result2) =>
          inflate(result2, (err3, result3) =>
            resolve(err1 ?? err2 ?? err3 ?? result3),
          ),
        ),
      ),
    );
    assert.equal(response.code, 200);
    assert.notEqual(responseText, expectedResponseText);
    assert.equal(actualText, expectedResponseText);
  });
});
