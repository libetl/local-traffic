import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { dirname, resolve, relative } from "node:path";
import typescript from "typescript";
import {
  readFile as realReadFile,
  writeFile as writeRealFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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

const useTemporaryFile = true;
// /private/var to stay compatible with the inconsistent MacOS file system.
const temporaryDirectory = tmpdir().replace(/^\/var\//, "/private/var/");
const temporaryFileLocation = `${temporaryDirectory}/local-traffic.mjs`;
const projectDirectory = new URL(dirname(import.meta.url)).pathname.replace(
  /(.*)\/local-traffic.*/,
  "$1/local-traffic",
);
const fromTemporaryDirectoryToProject = useTemporaryFile
  ? relative(temporaryDirectory, projectDirectory)
  : `file://${projectDirectory}`;

const localTraffic = await (async () => {
  const source = (
    await realReadFile(resolve(projectDirectory, "index.ts"))
  ).toString();
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2020,
    },
  }).outputText;
  const javascriptWithMocks = javascript
    .replace(
      /from "(http|http2|https|fs|os|process|console)"/g,
      `from "${fromTemporaryDirectoryToProject}/test/mocks.mjs"`,
    )
    .replace(/3000/g, "3")
    .replace(/5000/g, "5");

  if (useTemporaryFile)
    await writeRealFile(temporaryFileLocation, javascriptWithMocks);

  const base64Module = useTemporaryFile
    ? temporaryFileLocation
    : `data:text/javascript;base64,${Buffer.from(javascriptWithMocks).toString(
      "base64url",
    )}`;
  return await import(base64Module);
})();

const {
  start,
  load,
  errorListener,
  quickStatus,
  recorderHandler,
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
        "/recorder/": "recorder://",
        "/local-traffic-worker.js": "worker://",
      },
      connectTimeout: 3,
      socketTimeout: 3,
      port: 8080,
      replaceRequestBodyUrls: false,
      replaceResponseBodyUrls: false,
      dontUseHttp2Downstream: false,
      dontTranslateLocationHeader: false,
      simpleLogs: false,
      logAccessInTerminal: false,
      websocket: true,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
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
        "/recorder/": "recorder://",
        "/local-traffic-worker.js": "worker://",
      },
      connectTimeout: 3,
      socketTimeout: 3,
      port: 8080,
      replaceRequestBodyUrls: false,
      replaceResponseBodyUrls: false,
      dontUseHttp2Downstream: false,
      dontTranslateLocationHeader: false,
      simpleLogs: false,
      logAccessInTerminal: false,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
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
        "/recorder/": "recorder://",
        "/local-traffic-worker.js": "worker://",
      },
      connectTimeout: 3,
      socketTimeout: 3,
      port: 8080,
      replaceRequestBodyUrls: false,
      replaceResponseBodyUrls: false,
      dontUseHttp2Downstream: false,
      dontTranslateLocationHeader: false,
      simpleLogs: false,
      logAccessInTerminal: false,
      websocket: true,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
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
      connectTimeout: 3,
      socketTimeout: 3,
      port: 8080,
      replaceRequestBodyUrls: false,
      replaceResponseBodyUrls: false,
      dontUseHttp2Downstream: false,
      dontTranslateLocationHeader: false,
      simpleLogs: false,
      logAccessInTerminal: false,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
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
        connectTimeout: 3,
        socketTimeout: 3,
        port: 443,
        replaceRequestBodyUrls: true,
        replaceResponseBodyUrls: true,
        dontUseHttp2Downstream: true,
        dontTranslateLocationHeader: true,
        simpleLogs: true,
        logAccessInTerminal: true,
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
      connectTimeout: 3,
      socketTimeout: 3,
      port: 443,
      replaceRequestBodyUrls: true,
      replaceResponseBodyUrls: true,
      dontUseHttp2Downstream: true,
      dontTranslateLocationHeader: true,
      simpleLogs: true,
      logAccessInTerminal: true,
      websocket: false,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
      disableWebSecurity: true,
    });
  });

  it("should interpret a folder within a replaceBody block as needing a wildcard mask", async () => {
    buffers.push(
      JSON.stringify({
        mapping: {
          "/static-webapp": {
            replaceBody: "https://mycdn.org/js/my-js-dir/",
            downstreamUrl: "file://home/User/i/am/a/folder",
          },
          "/home/": "https://localhost:12345/home/",
          "": "https://acme.com",
        },
        ssl: {
          key: "key",
          cert: "cert",
        },
        connectTimeout: 3,
        socketTimeout: 3,
        port: 443,
        replaceRequestBodyUrls: true,
        replaceResponseBodyUrls: true,
        dontUseHttp2Downstream: true,
        dontTranslateLocationHeader: true,
        simpleLogs: true,
        logAccessInTerminal: true,
        websocket: false,
        disableWebSecurity: true,
      }),
    );
    const config = await load();

    assert.equal(readFile.mock.callCount(), 1);

    assert.deepEqual(config, {
      mapping: {
        "/static-webapp/(.*)": {
          downstreamUrl: "file://home/User/i/am/a/folder/$$1",
          replaceBody: "https://mycdn.org/js/my-js-dir/$$1",
        },
        "/home/": "https://localhost:12345/home/",
        "": "https://acme.com",
      },
      ssl: {
        key: "key",
        cert: "cert",
      },
      connectTimeout: 3,
      socketTimeout: 3,
      port: 443,
      replaceRequestBodyUrls: true,
      replaceResponseBodyUrls: true,
      dontUseHttp2Downstream: true,
      dontTranslateLocationHeader: true,
      simpleLogs: true,
      logAccessInTerminal: true,
      websocket: false,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
      disableWebSecurity: true,
    });
  });

  it("should interpret a folder as needing a wildcard mask", async () => {
    buffers.push(
      JSON.stringify({
        mapping: {
          "/static-webapp": "file://home/User/i/am/a/folder",
          "/home/": "https://localhost:12345/home/",
          "": "https://acme.com",
        },
        ssl: {
          key: "key",
          cert: "cert",
        },
        connectTimeout: 3,
        socketTimeout: 3,
        port: 443,
        replaceRequestBodyUrls: true,
        replaceResponseBodyUrls: true,
        dontUseHttp2Downstream: true,
        dontTranslateLocationHeader: true,
        simpleLogs: true,
        logAccessInTerminal: true,
        websocket: false,
        disableWebSecurity: true,
      }),
    );
    const config = await load();

    assert.equal(readFile.mock.callCount(), 1);

    assert.deepEqual(config, {
      mapping: {
        "/static-webapp/(.*)": "file://home/User/i/am/a/folder/$$1",
        "/home/": "https://localhost:12345/home/",
        "": "https://acme.com",
      },
      ssl: {
        key: "key",
        cert: "cert",
      },
      connectTimeout: 3,
      socketTimeout: 3,
      port: 443,
      replaceRequestBodyUrls: true,
      replaceResponseBodyUrls: true,
      dontUseHttp2Downstream: true,
      dontTranslateLocationHeader: true,
      simpleLogs: true,
      logAccessInTerminal: true,
      websocket: false,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
      disableWebSecurity: true,
    });
  });

  it("should interpret a file without extension as not needing a wildcard mask", async () => {
    buffers.push(
      JSON.stringify({
        mapping: {
          "/static-webapp": "file://home/User/i/am/not/a/folder",
          "/home/": "https://localhost:12345/home/",
          "": "https://acme.com",
        },
        ssl: {
          key: "key",
          cert: "cert",
        },
        connectTimeout: 3,
        socketTimeout: 3,
        port: 443,
        replaceRequestBodyUrls: true,
        replaceResponseBodyUrls: true,
        dontUseHttp2Downstream: true,
        dontTranslateLocationHeader: true,
        simpleLogs: true,
        logAccessInTerminal: true,
        websocket: false,
        disableWebSecurity: true,
      }),
    );
    const config = await load();

    assert.equal(readFile.mock.callCount(), 1);

    assert.deepEqual(config, {
      mapping: {
        "/static-webapp": "file://home/User/i/am/not/a/folder",
        "/home/": "https://localhost:12345/home/",
        "": "https://acme.com",
      },
      ssl: {
        key: "key",
        cert: "cert",
      },
      connectTimeout: 3,
      socketTimeout: 3,
      port: 443,
      replaceRequestBodyUrls: true,
      replaceResponseBodyUrls: true,
      dontUseHttp2Downstream: true,
      dontTranslateLocationHeader: true,
      simpleLogs: true,
      logAccessInTerminal: true,
      websocket: false,
      unwantedHeaderNamesInMocks: [],
      crossOrigin: {
        urlPattern: "${href}",
        whitelist: [],
        credentials: [],
        serverSide: false,
      },
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
          "content-length": "83",
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

  it("should alterate the config when the request is a POST to config api", async () => {
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
    const newConfig = JSON.stringify({
      mapping: {
        "/config/": "config://",
        "/logs/": "logs://",
        "/donate/": "https://www.mysite.org/donate/",
        "/my-new-route": "https://www.my-new-route.com/",
        "/my-website/": "file:///User/me/projects/i/am/a/folder/",
        "": "https://acme.info",
      },
      port: 8080,
      replaceRequestBodyUrls: true,
      simpleLogs: false,
    });

    // new file content
    buffers.unshift(Buffer.from(newConfig));
    // http request
    buffers.unshift(
      `request=${JSON.stringify({
        method: "POST",
        headers: {
          "content-length": "261",
          "Content-Type": "application/json",
          host: "localhost",
        },
        url: "/config/",
        body: newConfig,
      })}`,
    );
    http2OutboundHeadersResponses.unshift({
      [":status"]: 200,
      ["content-length"]: 12,
    });

    await new Promise(resolve => setTimeout(resolve, 20));

    const response = responses.shift();
    assert.equal(response.code, 200);
    // some configuration values should be inferred
    // even if not saved to the file
    assert.equal(
      response.body.toString("ascii"),
      JSON.stringify({
        mapping: {
          "/config/": "config://",
          "/logs/": "logs://",
          "/donate/": "https://www.mysite.org/donate/",
          "/my-new-route": "https://www.my-new-route.com/",
          "/my-website/(.*)": "file:///User/me/projects/i/am/a/folder/$$1",
          "": "https://acme.info",
        },
        port: 8080,
        replaceRequestBodyUrls: true,
        replaceResponseBodyUrls: false,
        dontUseHttp2Downstream: false,
        dontTranslateLocationHeader: false,
        logAccessInTerminal: false,
        simpleLogs: false,
        websocket: true,
        disableWebSecurity: false,
        connectTimeout: 3,
        socketTimeout: 3,
        unwantedHeaderNamesInMocks: [],
        crossOrigin: {
          urlPattern: "${href}",
          whitelist: [],
          credentials: [],
          serverSide: false,
        },
      }),
    );
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

    await new Promise(resolve => setTimeout(resolve, 30));

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

  it("Data url should use replace response body urls feature", async () => {
    await start({
      port: 8080,
      simpleLogs: false,
      replaceResponseBodyUrls: true,
      mapping: {
        "/test.html":
          "data:text/html,Hello, this is the value you've been looking for: https://acme.com/data-service/v1/companies/59884/data/27/values",
        "/other-data-service/v1/companies/59884/data/27/values": {
          replaceBody:
            "https://acme.com/data-service/v1/companies/59884/data/27/values",
          downstreamUrl: "file:///Users/me/Projects/tmp/data-service/27.json",
        },
        "": "https://www.acme.com",
      },
    });

    buffers.unshift(
      `request=${JSON.stringify({
        method: "GET",
        headers: {
          host: "localhost",
        },
        url: "/test.html",
      })}`,
    );
    await new Promise(resolve => setTimeout(resolve, 30));

    const response = responses.shift();
    assert.equal(response.code, 200);
    assert.equal(
      response.body.toString("utf8"),
      "Hello, this is the value you've been looking for: http://localhost:8080/other-data-service/v1/companies/59884/data/27/values",
    );
  });
});

describe("Internal features of the server", () => {
  describe("Finding downstream URLs in mapping", () => {
    it("should match a standard route with string interpolation", () => {
      const { key, target, path, url } = determineMapping(
        {
          headers: {
            host: "localhost",
          },
          url: "/github-profile/mdbell/",
        },
        {
          port: 443,
          ssl: true,
          mapping: {
            "/github-profile/(.*)/": "https://github.com/$$1/",
          },
        },
      );
      assert.equal(key, "/github-profile/(.*)/");
      assert.equal(path, "/github-profile/mdbell/");
      assert.equal(url.href, "https://localhost/github-profile/mdbell/");
      assert.equal(target.href, "https://github.com/mdbell/");
    });
  });

  describe("Replacing body from responses", () => {
    it("should replace any simple url that is referenced in the mapping", () => {
      const result = replaceTextUsingMapping(
        "<a href='https://www.this-is-a-remote-link.org/where-you-at/just-tell-me.html'>go to my other site</a>",
        {
          direction: "INBOUND",
          proxyHostnameAndPort: "localhost:443",
          ssl: true,
          mapping: {
            "/where-you-at/":
              "https://www.this-is-a-remote-link.org/where-you-at/",
          },
        },
      );
      assert(
        result.includes(
          "<a href='https://localhost:443/where-you-at/just-tell-me.html'>",
        ),
      );
    });

    it("should use the first mapping in the keys order for replacement", () => {
      const result = replaceTextUsingMapping(
        "<a href='https://www.this-is-a-remote-link.org/where-you-at/just-tell-me.html'>go to my other site</a>",
        {
          direction: "INBOUND",
          proxyHostnameAndPort: "localhost:443",
          ssl: true,
          mapping: {
            "/where-you-at/":
              "https://www.this-is-a-remote-link.org/where-you-at/",
            "/where-you-not-at/":
              "https://www.this-is-a-remote-link.org/where-you-at/",
          },
        },
      );
      assert(
        result.includes(
          "<a href='https://localhost:443/where-you-at/just-tell-me.html'>",
        ),
      );
    });

    it("should use the regular expressions to match urls", () => {
      const result = replaceTextUsingMapping(
        "<a href='https://www.this-is-a-remote-link.org/where-you-at/just-tell-me.html'>go to my other site</a>",
        {
          direction: "INBOUND",
          proxyHostnameAndPort: "localhost:443",
          ssl: true,
          mapping: {
            "/where-(.*)-at/":
              "https://www.this-is-a-remote-link.org/where-$$1-at/",
          },
        },
      );
      assert(
        result.includes(
          "<a href='https://localhost:443/where-you-at/just-tell-me.html'>",
        ),
      );
    });

    it("should be able to read the replaceBody regular expressions to match urls", () => {
      const result = replaceTextUsingMapping(
        "<a href='https://some-cdn.js/js/big-project/v15.1/big-module.js'>go to my other site</a>",
        {
          direction: "INBOUND",
          proxyHostnameAndPort: "localhost:443",
          ssl: true,
          mapping: {
            "/the-entire-cdn-on-my-hard-drive/(.*)": {
              replaceBody: "https://some-cdn.js/$$1",
              downstreamUrl: "file:///Users/me/my-big-directory/$$1",
            },
          },
        },
      );
      assert(
        result.includes(
          "<a href='https://localhost:443/the-entire-cdn-on-my-hard-drive/js/big-project/v15.1/big-module.js'>",
        ),
      );
    });

    it("should be able to read the replaceBody even when multiple regular expressions are being used", () => {
      const result = replaceTextUsingMapping(
        "<a href='https://some-cdn.js/js/big-package/v15.1/big-module.js'>go to my other site</a>",
        {
          direction: "INBOUND",
          proxyHostnameAndPort: "localhost:443",
          ssl: true,
          mapping: {
            "/the-entire-cdn-on-my-hard-drive/js/([a-z-]+)/v([0-9.]+)/([A-Z0-9a-z_-]+).js":
            {
              replaceBody: "https://some-cdn.js/js/$$1/v$$2/$$3.js",
              downstreamUrl:
                "file:///Users/me/my-big-directory/js/$$1/v$$2/$$3.js",
            },
          },
        },
      );
      assert(
        result.includes(
          "<a href='https://localhost:443/the-entire-cdn-on-my-hard-drive/js/big-package/v15.1/big-module.js'>",
        ),
      );
    });
  });

  it("should ignore mapping containing invalid regular expressions matchers", () => {
    const result = replaceTextUsingMapping(
      "<a href='https://some-cdn.js/js/big-package/v15.1/big-module.js'>go to my other site</a>",
      {
        direction: "INBOUND",
        proxyHostnameAndPort: "localhost:443",
        ssl: true,
        mapping: {
          // there are two right-paren instead of one, so we cannot build a successful pattern here
          "/the-entire-cdn-on-my-hard-drive/js/([a-z-]+))/v([0-9.]+)/([A-Z0-9a-z_-]+).js":
          {
            replaceBody: "https://some-cdn.js/js/$$1/v$$2/$$3.js",
            downstreamUrl:
              "file:///Users/me/my-big-directory/js/$$1/v$$2/$$3.js",
          },
        },
      },
    );
    assert(
      result.includes(
        "<a href='https://some-cdn.js/js/big-package/v15.1/big-module.js'>",
      ),
    );
  });
});

describe("Websocket feature", () => {
  it("should send a payload of 123278 bytes with the payload length set to 0x1E18E", () => {
    const samplePayload = Array(123278)
      .fill(0)
      .map(_ => "abcdefghijklmnopqrstuvwxyz".charAt(Math.random() * 26))
      .join("");
    const buffer = createWebsocketBufferFrom(samplePayload, true);
    const hexPayloadLengthBuffer = Buffer.allocUnsafe(10);
    buffer.copy(hexPayloadLengthBuffer, 0, 0, 10);
    const hexPayloadLength = hexPayloadLengthBuffer.toString("hex");
    assert.equal(hexPayloadLength, "81ff000000000001e18e");
  });
});

describe("Recorder switches logic", () => {
  it("should disable auto-record when switching back to proxy mode", async () => {
    const state = {
      config: {
        port: 1337,
        mapping: {},
      },
      mockConfig: {
        autoRecord: true,
      },
      log: () => { },
    };
    recorderHandler(state, Buffer.from('{"mode":"proxy"}'), false);

    await new Promise(resolve => setTimeout(resolve, 5));

    assert.equal(state.mode, "proxy");
    assert.equal(state.mockConfig.autoRecord, false);
  });

  it("should allow to keep auto-record when switching back to proxy mode", async () => {
    const state = {
      config: {
        port: 1337,
        mapping: {},
      },
      mockConfig: {
        autoRecord: true,
      },
      log: () => { },
    };
    recorderHandler(
      state,
      Buffer.from('{"autoRecord":true,"mode":"proxy"}'),
      false,
    );

    await new Promise(resolve => setTimeout(resolve, 5));

    assert.equal(state.mode, "proxy");
    assert.equal(state.mockConfig.autoRecord, true);
  });
});

describe("Mock server matcher", () => {
  it("should work when there is an exact match", async () => {
    let body = "";
    await serve(
      {
        config: {
          port: 1337,
          mapping: {},
        },
        mockConfig: {
          autoRecord: true,
          strict: true,
          mocks: new Map([
            [
              Buffer.from(
                JSON.stringify({
                  method: "GET",
                  url: "/",
                  headers: { host: "example.com" },
                  body: "",
                }),
              ).toString("base64"),
              Buffer.from(
                JSON.stringify({
                  body: Buffer.from("matched a mock").toString("base64"),
                }),
              ).toString("base64"),
            ],
          ]),
        },
        logsListeners: [],
        mode: "mock",
        log: () => { },
        notifyLogsListeners: () => { },
      },
      {
        method: "GET",
        url: "/",
        headers: {
          host: "example.com",
        },
        readableLength: 0,
      },
      {
        writeHead: () => { },
        end: payload => {
          body = payload.toString("ascii");
        },
      },
    );
    assert.equal(body, "matched a mock");
  });

  it("should match when the request has more headers than the mock", async () => {
    let body = "";
    await serve(
      {
        config: {
          port: 1337,
          mapping: {},
        },
        mockConfig: {
          autoRecord: true,
          strict: true,
          mocks: new Map([
            [
              Buffer.from(
                JSON.stringify({
                  method: "GET",
                  url: "/",
                  headers: { host: "example.com" },
                  body: "",
                }),
              ).toString("base64"),
              Buffer.from(
                JSON.stringify({
                  body: Buffer.from("matched a mock").toString("base64"),
                }),
              ).toString("base64"),
            ],
          ]),
        },
        logsListeners: [],
        mode: "mock",
        log: () => { },
        notifyLogsListeners: () => { },
      },
      {
        method: "GET",
        url: "/",
        headers: {
          "X-My-Header": "My-Value",
          host: "example.com",
        },
        readableLength: 0,
      },
      {
        writeHead: () => { },
        end: payload => {
          body = payload.toString("ascii");
        },
      },
    );
    assert.equal(body, "matched a mock");
  });

  it("should match when the request uses a header that is different but unwanted", async () => {
    let body = "";
    await serve(
      {
        config: {
          port: 1337,
          mapping: {},
          unwantedHeaderNamesInMocks: ["X-My-Excluded-Header"],
        },
        mockConfig: {
          autoRecord: true,
          strict: true,
          mocks: new Map([
            [
              Buffer.from(
                JSON.stringify({
                  method: "GET",
                  url: "/",
                  headers: {
                    host: "example.com",
                    "X-My-Excluded-Header": "Value-1",
                  },
                  body: "",
                }),
              ).toString("base64"),
              Buffer.from(
                JSON.stringify({
                  body: Buffer.from("matched a mock").toString("base64"),
                }),
              ).toString("base64"),
            ],
          ]),
        },
        logsListeners: [],
        mode: "mock",
        log: () => { },
        notifyLogsListeners: () => { },
      },
      {
        method: "GET",
        url: "/",
        headers: {
          "X-My-Excluded-Header": "Value-2",
          host: "example.com",
        },
        readableLength: 0,
      },
      {
        writeHead: () => { },
        end: payload => {
          body = payload.toString("ascii");
        },
      },
    );
    assert.equal(body, "matched a mock");
  });

  it("should match when the most accurate mock when more than one mock match the request", async () => {
    let body = "";
    await serve(
      {
        config: {
          port: 1337,
          mapping: {},
        },
        mockConfig: {
          autoRecord: true,
          strict: true,
          mocks: new Map([
            [
              Buffer.from(
                JSON.stringify({
                  method: "GET",
                  url: "/",
                  headers: {
                    host: "example.com",
                    "X-My-Header1": "My-Value1",
                    "X-My-Header2": "My-Value2",
                    "X-My-Header3": "My-Value3",
                  },
                  body: "",
                }),
              ).toString("base64"),
              Buffer.from(
                JSON.stringify({
                  body: Buffer.from("matched mock#1").toString("base64"),
                }),
              ).toString("base64"),
            ],
            [
              Buffer.from(
                JSON.stringify({
                  method: "GET",
                  url: "/",
                  headers: {
                    host: "example.com",
                    "X-My-Header1": "My-Value1",
                    "X-My-Header2": "My-Value2",
                    "X-My-Header3": "My-Value3",
                    "X-My-Header4": "My-Value5",
                  },
                  body: "",
                }),
              ).toString("base64"),
              Buffer.from(
                JSON.stringify({
                  body: Buffer.from("matched mock#2").toString("base64"),
                }),
              ).toString("base64"),
            ],
            [
              Buffer.from(
                JSON.stringify({
                  method: "GET",
                  url: "/",
                  headers: {
                    host: "example.com",
                    "X-My-Header1": "My-Value1",
                    "X-My-Header2": "My-Value2",
                    "X-My-Header3": "My-Value3",
                  },
                  body: "",
                }),
              ).toString("base64"),
              Buffer.from(
                JSON.stringify({
                  body: Buffer.from("matched mock#3").toString("base64"),
                }),
              ).toString("base64"),
            ],
          ]),
        },
        logsListeners: [],
        mode: "mock",
        log: () => { },
        notifyLogsListeners: () => { },
      },
      {
        method: "GET",
        url: "/",
        headers: {
          host: "example.com",
          "X-My-Header1": "My-Value1",
          "X-My-Header2": "My-Value2",
          "X-My-Header3": "My-Value3",
          "X-My-Header4": "My-Value4",
        },
        readableLength: 0,
      },
      {
        writeHead: () => { },
        end: payload => {
          body = payload.toString("ascii");
        },
      },
    );
    assert.equal(body, "matched mock#3");
  });

  it("should not match when the mock has more headers than the request", async () => {
    let body = "";
    await serve(
      {
        config: {
          port: 1337,
          mapping: {},
        },
        mockConfig: {
          autoRecord: true,
          strict: true,
          mocks: new Map([
            [
              Buffer.from(
                JSON.stringify({
                  method: "GET",
                  url: "/",
                  headers: {
                    host: "example.com",
                    "X-My-Header": "My-Value",
                  },
                  body: "",
                }),
              ).toString("base64"),
              Buffer.from(
                JSON.stringify({
                  body: Buffer.from("matched a mock").toString("base64"),
                }),
              ).toString("base64"),
            ],
          ]),
        },
        logsListeners: [],
        mode: "mock",
        log: () => { },
        notifyLogsListeners: () => { },
      },
      {
        method: "GET",
        url: "/",
        headers: {
          host: "example.com",
        },
        readableLength: 0,
      },
      {
        writeHead: () => { },
        end: payload => {
          body = payload.toString("ascii");
        },
      },
    );
    assert.match(body, /No corresponding mock found in the server\./);
  });
});
