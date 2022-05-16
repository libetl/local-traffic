import {
  ClientHttp2Session,
  createSecureServer,
  connect,
  Http2Session,
  Http2ServerRequest,
  Http2ServerResponse,
  Http2Stream,
  OutgoingHttpHeaders,
  SecureClientSessionOptions,
  SecureServerOptions,
  ClientHttp2Stream,
} from "http2";
import {
  request as httpRequest,
  IncomingMessage,
  ClientRequest,
  createServer,
  ServerResponse,
  Server,
} from "http";
import { request as httpsRequest, RequestOptions } from "https";
import { URL } from "url";
import { watchFile, readdir, readFile, writeFile, lstat } from "fs";
import {
  gzip,
  gunzip,
  inflate,
  deflate,
  brotliCompress,
  brotliDecompress,
} from "zlib";
import { resolve, normalize } from "path";
import type { Duplex } from "stream";

type ErrorWithErrno = NodeJS.ErrnoException;

enum LogLevel {
  ERROR = 124,
  SUCCESS = 35,
  INFO = 21,
  WARNING = 172,
}

interface LocalConfiguration {
  mapping?: { [subPath: string]: string };
  ssl?: SecureServerOptions;
  port?: number;
  replaceResponseBodyUrls?: boolean;
  dontUseHttp2Downstream?: boolean;
  simpleLogs?: boolean;
  websocket?: boolean;
}

const userHomeConfigFile = resolve(process.env.HOME, ".local-traffic.json");
const filename = resolve(
  process.cwd(),
  process.argv.slice(-1)[0].endsWith(".json")
    ? process.argv.slice(-1)[0]
    : userHomeConfigFile
);
const defaultConfig: LocalConfiguration = {
  mapping: {},
  port: 8080,
  replaceResponseBodyUrls: false,
  dontUseHttp2Downstream: false,
  simpleLogs: false,
  websocket: false,
};

let config: LocalConfiguration;
let server: Server;
const getCurrentTime = (simpleLogs?: boolean) => {
  const date = new Date();
  return `${simpleLogs ? "" : "\u001b[36m"}${`${date.getHours()}`.padStart(
    2,
    "0"
  )}${
    simpleLogs ? ":" : "\u001b[33m:\u001b[36m"
  }${`${date.getMinutes()}`.padStart(2, "0")}${
    simpleLogs ? ":" : "\u001b[33m:\u001b[36m"
  }${`${date.getSeconds()}`.padStart(2, "0")}${simpleLogs ? "" : "\u001b[0m"}`;
};
const log = (text: string, level?: LogLevel, emoji?: string) => {
  console.log(
    `${getCurrentTime(config.simpleLogs)} ${
      config.simpleLogs
        ? text
            .replace(/⎸/g, "|")
            .replace(/⎹/g, "|")
            .replace(/\u001b\[[^m]*m/g, "")
            .replace(/↘️/g, "inbound")
            .replace(/☎️/g, "port")
            .replace(/↗️/g, "outbound")
        : level
        ? `\u001b[48;5;${level}m⎸    ${
            !process.stdout.isTTY ? "" : emoji || ""
          }  ${text.padEnd(36)} ⎹\u001b[0m`
        : text
    }`
  );
};
const load = async (firstTime: boolean = true) =>
  new Promise((resolve) =>
    readFile(filename, (error, data) => {
      if (error && !firstTime) {
        log("config error. Using default value", LogLevel.ERROR, "❌");
      }
      try {
        config = Object.assign(
          {},
          defaultConfig,
          JSON.parse((data || "{}").toString())
        );
      } catch (e) {
        log("config syntax incorrect, aborting", LogLevel.ERROR, "⛈️");
        config = config || { ...defaultConfig };
        resolve(config);
        return;
      }
      if (!config.mapping[""]) {
        log('default mapping "" not provided.', LogLevel.WARNING, "☢️");
      }
      if (
        error &&
        error.code === "ENOENT" &&
        firstTime &&
        filename === userHomeConfigFile
      ) {
        writeFile(filename, JSON.stringify(defaultConfig), (fileWriteErr) => {
          if (fileWriteErr)
            log("config file NOT created", LogLevel.ERROR, "⁉️");
          else log("config file created", LogLevel.SUCCESS, "✨");
          resolve(config);
        });
      } else resolve(config);
    })
  ).then(() => {
    if (firstTime) watchFile(filename, onWatch);
  });

const logProtocols = (thisConfig: LocalConfiguration) => {
  log(
    `\u001b[48;5;5m⎸ ↘️  : ${
      thisConfig.ssl ? "HTTP/2  " : "HTTP 1.1"
    } \u001b[48;5;21m⎸ ☎️  : ${thisConfig.port
      .toString()
      .padStart(5)} \u001b[48;5;31m⎸ ↗️  : ${
      thisConfig.dontUseHttp2Downstream ? "HTTP 1.1" : "HTTP/2  "
    } ⎹\u001b[0m`
  );
};

const onWatch = async () => {
  const previousConfig = { ...config };
  await load(false);
  if (isNaN(config.port) || config.port > 65535 || config.port < 0) {
    config = previousConfig;
    log("port number invalid. Not refreshing", LogLevel.ERROR, "☎️");
    return;
  }
  if (typeof config.mapping !== "object") {
    config = previousConfig;
    log("mapping should be an object. Aborting", LogLevel.ERROR, "⚡");
    return;
  }
  if (
    config.replaceResponseBodyUrls &&
    !previousConfig.replaceResponseBodyUrls
  ) {
    log("response body url replacement", LogLevel.INFO, "✔️");
  }
  if (
    !config.replaceResponseBodyUrls &&
    previousConfig.replaceResponseBodyUrls
  ) {
    log("response body url NO replacement", LogLevel.INFO, "✖️");
  }
  if (
    config.websocket &&
    !previousConfig.websocket
  ) {
    log("websocket activated", LogLevel.INFO, "☄️");
  }
  if (
    !config.websocket &&
    previousConfig.websocket
  ) {
    log("websocket deactivated", LogLevel.INFO, "☄️");
  }
  log(
    `${Object.keys(config.mapping)
      .length.toString()
      .padStart(5)} loaded mapping rules`,
    LogLevel.SUCCESS,
    "↻"
  );
  if (
    config.port !== previousConfig.port ||
    JSON.stringify(config.ssl) !== JSON.stringify(previousConfig.ssl)
  ) {
    await new Promise((resolve) =>
      !server ? resolve(void 0) : server.close(resolve)
    );
    start();
  } else if (
    config.dontUseHttp2Downstream !== previousConfig.dontUseHttp2Downstream
  ) {
    logProtocols(config);
  }
};

const unixNorm = (path: string) =>
  path == "" ? "" : normalize(path).replace(/\\/g, "/");
const envs: () => { [prefix: string]: URL } = () => ({
  ...Object.assign(
    {},
    ...Object.entries(config.mapping).map(([key, value]) => ({
      [key]: new URL(unixNorm(value)),
    }))
  ),
});

const fileRequest = (url: URL): ClientHttp2Session => {
  const file = resolve(
    "/",
    url.hostname,
    ...url.pathname
      .replace(/[?#].*$/, "")
      .replace(/^\/+/, "")
      .split("/")
  );
  const clientRequest = function () {
    return {
      error: null as Error,
      data: null as string | Buffer,
      hasRun: false,
      run: function () {
        return this.hasRun
          ? Promise.resolve()
          : new Promise((promiseResolve) =>
              readFile(file, (error, data) => {
                this.hasRun = true;
                if (!error || error.code !== "EISDIR") {
                  this.error = error;
                  this.data = data;
                  promiseResolve(void 0);
                  return;
                }
                readdir(file, (readDirError, filelist) => {
                  this.error = readDirError;
                  this.data = filelist;
                  if (readDirError) {
                    promiseResolve(void 0);
                    return;
                  }
                  Promise.all(
                    filelist.map(
                      (file) =>
                        new Promise((innerResolve) =>
                          lstat(resolve(url.pathname, file), (err, stats) =>
                            innerResolve([file, stats, err])
                          )
                        )
                    )
                  ).then((filesWithTypes) => {
                    const entries = filesWithTypes
                      .filter((entry) => !entry[2] && entry[1].isDirectory())
                      .concat(
                        filesWithTypes.filter(
                          (entry) => !entry[2] && entry[1].isFile()
                        )
                      );
                    this.data = `${header(0x1f4c2, "directory", url.href)}
                      <p>Directory content of <i>${url.href.replace(
                        /\//g,
                        "&#x002F;"
                      )}</i></p>
                      <ul class="list-group">
                        <li class="list-group-item">&#x1F4C1;<a href="${
                          url.pathname.endsWith("/") ? ".." : "."
                        }">&lt;parent&gt;</a></li>
                        ${entries
                          .filter((entry) => !entry[2])
                          .map((entry) => {
                            const type = entry[1].isDirectory()
                              ? 0x1f4c1
                              : 0x1f4c4;
                            return `<li class="list-group-item">&#x${type.toString(
                              16
                            )};<a href="${
                              url.pathname.endsWith("/")
                                ? ""
                                : `${url.pathname.split("/").slice(-1)[0]}/`
                            }${entry[0]}">${entry[0]}</a></li>`;
                          })
                          .join("\n")}
                        </li>
                      </ul>
                      </body></html>`;
                    promiseResolve(void 0);
                  });
                });
              })
            );
      },
      events: {} as { [name: string]: (...any: any) => any },
      on: function (name: string, action: (...any: any) => any) {
        this.events[name] = action;
        this.run().then(() => {
          if (name === "response")
            this.events["response"]({ Server: "local", 
            'Content-Type': file.endsWith('.svg') ? 'image/svg+xml' : null}, 0);
          if (name === "data" && this.data) {
            this.events["data"](this.data);
            this.events["end"]();
          }
          if (name === "error" && this.error) {
            this.events["error"](this.error);
          }
        });
        return this;
      },
      end: function () {
        return this;
      },
      request: function () {
        return this;
      },
    };
  };

  const newClientRequest = clientRequest();

  return (newClientRequest as any) as ClientHttp2Session;
};

const header = (
  icon: number,
  category: string,
  pageTitle: string
) => `<!doctype html>
<html lang="en">
<head>
<title>&#x${icon.toString(16)}; local-traffic ${category} | ${pageTitle}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@latest/dist/css/bootstrap.min.css" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/jquery@latest/dist/jquery.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@latest/dist/js/bootstrap.bundle.min.js"></script>
</head>
<body><div class="container"><h1>&#x${icon.toString(
  16
)}; local-traffic ${category}</h1>
<br/>`;

const errorPage = (
  thrown: Error,
  phase: string,
  requestedURL: URL,
  downstreamURL?: URL
) => `${header(0x1f4a3, "error", thrown.message)}
<p>An error happened while trying to proxy a remote exchange</p>
<div class="alert alert-warning" role="alert">
  &#x24D8;&nbsp;This is not an error from the downstream service.
</div>
<div class="alert alert-danger" role="alert">
<pre><code>${thrown.stack || `<i>${thrown.name} : ${thrown.message}</i>`}${
  (thrown as ErrorWithErrno).errno ? `<br/>(code : ${(thrown as ErrorWithErrno).errno})` : ""
}</code></pre>
</div>
More information about the request :
<table class="table">
  <tbody>
    <tr>
      <td>phase</td>
      <td>${phase}</td>
    </tr>
    <tr>
      <td>requested URL</td>
      <td>${requestedURL}</td>
    </tr>
    <tr>
      <td>downstream URL</td>
      <td>${downstreamURL || "&lt;no-target-url&gt;"}</td>
    </tr>
  </tbody>
</table>
</div></body></html>`;

const send = (
  code: number,
  inboundResponse: Http2ServerResponse | ServerResponse,
  errorBuffer: Buffer
) => {
  inboundResponse.writeHead(
    code,
    undefined, // statusMessage is discarded in http/2
    {
      "content-type": "text/html",
      "content-length": errorBuffer.length,
    }
  );
  inboundResponse.end(errorBuffer);
};

const determineMapping = (inboundRequest: Http2ServerRequest | IncomingMessage): {
  proxyHostname: string,
  proxyHostnameAndPort: string,
  url: URL,
  path: string,
  key: string,
  target: URL
} => {

  const proxyHostname =
    (inboundRequest.headers[":authority"]?.toString() ??
      inboundRequest.headers.host ?? 'localhost').replace(/:.*/, '');
  const proxyHostnameAndPort =
    inboundRequest.headers[":authority"] as string ||
    `${inboundRequest.headers.host}${inboundRequest.headers.host.match(/:[0-9]+$/)
      ? ""
      : config.port === 80 && !config.ssl
        ? ""
        : config.port === 443 && config.ssl
          ? ""
          : `:${config.port}`
    }`;
  const url = new URL(
    `http${config.ssl ? "s" : ""}://${proxyHostnameAndPort}${inboundRequest.url}`
  );
  const path = url.href.substring(url.origin.length);
  const [key, target] =
    Object.entries(envs()).find(([key]) => path.match(RegExp(key))) || [];
  return { proxyHostname, proxyHostnameAndPort, url, path, key, target };
}

const start = () => {
  server = ((config.ssl
    ? createSecureServer.bind(null, { ...config.ssl, allowHTTP1: true })
    : createServer)(
    async (
      inboundRequest: Http2ServerRequest | IncomingMessage,
      inboundResponse: Http2ServerResponse | ServerResponse
    ) => {
      // phase: mapping
      if (!inboundRequest.headers.host && !inboundRequest.headers[":authority"]) {
        send(
          400,
          inboundResponse,
          Buffer.from(
            errorPage(
              new Error(`client must supply a 'host' header`),
              "proxy",
              new URL(`http${config.ssl ? "s" : ""}://unknowndomain${inboundRequest.url}`)
            )
          )
        );
        return;
      }
      const { proxyHostname, proxyHostnameAndPort, url, path, key, target } =
        determineMapping(inboundRequest);
      if (!target) {
        send(
          502,
          inboundResponse,
          Buffer.from(
            errorPage(
              new Error(`No mapping found in config file ${filename}`),
              "proxy",
              url
            )
          )
        );
        return;
      }
      const targetHost = target.host.replace(RegExp(/\/+$/), "");
      const targetPrefix = target.href.substring(
        "https://".length + target.host.length
      );
      const fullPath = `${targetPrefix}${unixNorm(
        path.replace(RegExp(unixNorm(key)), "")
      )}`.replace(/^\/*/, "/");
      const targetUrl = new URL(`${target.protocol}//${targetHost}${fullPath}`);

      // phase: connection
      let error: Buffer = null;
      let http2IsSupported = !config.dontUseHttp2Downstream;
      const outboundRequest: ClientHttp2Session =
        target.protocol === "file:"
          ? fileRequest(targetUrl)
          : !http2IsSupported
          ? null
          : await Promise.race([
              new Promise<ClientHttp2Session>((resolve) => {
                const result = connect(
                  targetUrl,
                  {
                    rejectUnauthorized: false,
                    protocol: target.protocol,
                  } as SecureClientSessionOptions,
                  (_, socketPath) => {
                    http2IsSupported =
                      http2IsSupported && !!(socketPath as any).alpnProtocol;
                    resolve(!http2IsSupported ? null : result);
                  }
                );
                ((result as unknown) as Http2Session).on(
                  "error",
                  (thrown: Error) => {
                    error =
                      http2IsSupported &&
                      Buffer.from(
                        errorPage(thrown, "connection", url, targetUrl)
                      );
                  }
                );
              }),
              new Promise<ClientHttp2Session>((resolve) =>
                setTimeout(() => {
                  http2IsSupported = false;
                  resolve(null);
                }, 3000)
              ),
            ]);
      if (!(error instanceof Buffer)) error = null;

      const outboundHeaders: OutgoingHttpHeaders = {
        ...[...Object.entries(inboundRequest.headers)]
          // host and connection are forbidden in http/2
          .filter(
            ([key]) => !["host", "connection"].includes(key.toLowerCase())
          )
          .reduce((acc: any, [key, value]) => {
            acc[key] =
              (acc[key] || "") +
              (!Array.isArray(value) ? [value] : value)
                .map((oneValue) => oneValue.replace(url.hostname, targetHost))
                .join(", ");
            return acc;
          }, {}),
        origin: target.href,
        referer: targetUrl.toString(),
        ":authority": targetHost,
        ":method": inboundRequest.method,
        ":path": fullPath,
        ":scheme": target.protocol.replace(":", ""),
      };

      const outboundExchange =
        outboundRequest &&
        !error &&
        outboundRequest.request(outboundHeaders, {
          endStream: config.ssl
            ? !((inboundRequest as Http2ServerRequest)?.stream?.readableLength ?? true)
            : !(inboundRequest as IncomingMessage).readableLength,
        });

      outboundExchange &&
        ((outboundExchange as unknown) as Http2Stream).on(
          "error",
          (thrown: Error) => {
            const httpVersionSupported = (thrown as ErrorWithErrno).errno === -505;
            error = Buffer.from(
              errorPage(
                thrown,
                "stream" +
                  (httpVersionSupported
                    ? " (error -505 usually means that the downstream service " +
                      "does not support this http version)"
                    : ""),
                url,
                targetUrl
              )
            );
          }
        );

      const http1RequestOptions: RequestOptions = {
        hostname: target.hostname,
        path: fullPath,
        port: target.port,
        protocol: target.protocol,
        rejectUnauthorized: false,
        method: inboundRequest.method,
        headers: {
          ...Object.assign(
            {},
            ...Object.entries(outboundHeaders)
              .filter(
                ([h]) =>
                  !h.startsWith(":") && h.toLowerCase() !== "transfer-encoding"
              )
              .map(([key, value]) => ({ [key]: value }))
          ),
          host: target.hostname,
        },
      };
      const outboundHttp1Response: IncomingMessage =
        !error &&
        !http2IsSupported &&
        target.protocol !== "file:" &&
        (await new Promise((resolve) => {
          const outboundHttp1Request: ClientRequest =
            target.protocol === "https:"
              ? httpsRequest(http1RequestOptions, resolve)
              : httpRequest(http1RequestOptions, resolve);

          outboundHttp1Request.on("error", (thrown) => {
            error = Buffer.from(errorPage(thrown, "request", url, targetUrl));
            resolve(null as IncomingMessage);
          });
          inboundRequest.on("data", (chunk) =>
            outboundHttp1Request.write(chunk)
          );
          inboundRequest.on("end", () => outboundHttp1Request.end());
        }));
      // intriguingly, error is reset to "false" at this point, even if it was null
      if (error) {
        send(502, inboundResponse, error);
        return;
      } else error = null;

      // phase : request body
      if (
        config.ssl && // http/2
        (inboundRequest as Http2ServerRequest).stream &&
        (inboundRequest as Http2ServerRequest).stream.readableLength &&
        outboundExchange
      ) {
        (inboundRequest as Http2ServerRequest).stream.on("data", (chunk) =>
          outboundExchange.write(chunk)
        );
        (inboundRequest as Http2ServerRequest).stream.on("end", () =>
          outboundExchange.end()
        );
      }

      if (
        !config.ssl && // http1.1
        (inboundRequest as IncomingMessage).readableLength &&
        outboundExchange
      ) {
        (inboundRequest as IncomingMessage).on("data", (chunk) =>
          outboundExchange.write(chunk)
        );
        (inboundRequest as IncomingMessage).on("end", () =>
          outboundExchange.end()
        );
      }

      // phase : response headers
      const { outboundResponseHeaders } = await new Promise((resolve) =>
        outboundExchange
          ? outboundExchange.on("response", (headers) => {
              resolve({
                outboundResponseHeaders: headers,
              });
            })
          : !outboundExchange && outboundHttp1Response
          ? resolve({
              outboundResponseHeaders: outboundHttp1Response.headers,
            })
          : resolve({
              outboundResponseHeaders: {},
            })
      );

      const newUrl = !outboundResponseHeaders["location"]
        ? null
        : new URL(
            outboundResponseHeaders["location"].startsWith("/")
              ? `${target.href}${outboundResponseHeaders["location"].replace(
                  /^\/+/,
                  ``
                )}`
              : outboundResponseHeaders["location"]
          );
      const newPath = !newUrl
        ? null
        : newUrl.href.substring(newUrl.origin.length);
      const newTarget = url.origin;
      const newTargetUrl = !newUrl ? null : `${newTarget}${newPath}`;

      // phase : response body
      const payloadSource = outboundExchange || outboundHttp1Response;
      const payload =
        error ??
        (await new Promise((resolve) => {
          let partialBody = Buffer.alloc(0);
          if (!payloadSource) {
            resolve(partialBody);
            return;
          }
          (payloadSource as ClientHttp2Stream | Duplex).on(
            "data",
            (chunk: Buffer | string) =>
              (partialBody = Buffer.concat([
                partialBody,
                typeof chunk === "string"
                  ? Buffer.from(chunk as string)
                  : (chunk as Buffer),
              ]))
            );
          (payloadSource as any).on("end", () => {
            resolve(partialBody);
          });
        }).then((payloadBuffer: Buffer) => {
          if (!config.replaceResponseBodyUrls) return payloadBuffer;
          if (!payloadBuffer.length) return payloadBuffer;

          return (outboundResponseHeaders["content-encoding"] || "")
            .split(",")
            .reduce(async (buffer: Promise<Buffer>, formatNotTrimed: string) => {
              const format = formatNotTrimed.trim().toLowerCase();
              const method =
                format === "gzip" || format === "x-gzip"
                  ? gunzip
                  : format === "deflate"
                  ? inflate
                  : format === "br"
                  ? brotliDecompress
                  : format === "identity" || format === ""
                  ? (
                      input: Buffer,
                      callback: (err?: Error, data?: Buffer) => void
                    ) => {
                      callback(null, input);
                    }
                  : null;
              if (method === null) {
                send(
                  502,
                  inboundResponse,
                  Buffer.from(
                    errorPage(
                      new Error(
                        `${format} compression not supported by the proxy`
                      ),
                      "stream",
                      url,
                      targetUrl
                    )
                  )
                );
                return;
              }

              const openedBuffer = await buffer;
              return await new Promise((resolve) => 
                method(openedBuffer, (err_1, data_1) => {
                  if (err_1) {
                    send(
                      502,
                      inboundResponse,
                      Buffer.from(errorPage(err_1, "stream", url, targetUrl))
                    );
                    resolve("");
                    return;
                  }
                  resolve(data_1);
                })
              );
            }, Promise.resolve(payloadBuffer))
            .then((uncompressedBuffer: Buffer) => {
              const fileTooBig = uncompressedBuffer.length > 1E7;
              const fileHasSpecialChars = () => /[^\x00-\x7F]/.test(uncompressedBuffer.toString());
              const contentTypeCanBeProcessed =
              ['text/html', 'application/javascript', 'application/json'].some(allowedContentType =>
                (outboundResponseHeaders["content-type"] ?? "").includes(allowedContentType));
              const willReplace = !fileTooBig && (contentTypeCanBeProcessed || !fileHasSpecialChars());
              return !willReplace ?
              uncompressedBuffer :
              !config.replaceResponseBodyUrls
                ? uncompressedBuffer.toString()
                : Object.entries(config.mapping)
                    .reduce(
                      (inProgress, [path, mapping]) =>
                        path !== '' && !path.match(/^[-a-zA-Z0-9()@:%_\+.~#?&//=]*$/)
                          ? inProgress
                          : inProgress.replace(
                              new RegExp(
                                mapping
                                  .replace(/^file:\/\//, "")
                                  .replace(/[*+?^${}()|[\]\\]/g, "")
                                  .replace(/^https/, 'https?') + '/*',
                                "ig"
                              ),
                              `https://${proxyHostnameAndPort}${path.replace(
                                /\/+$/,
                                ""
                              )}/`
                            ),
                      uncompressedBuffer.toString()
                    )
                    .split(`${proxyHostnameAndPort}/:`)
                    .join(`${proxyHostnameAndPort}:`)
                    .replace(/\?protocol=wss?%3A&hostname=[^&]+&port=[0-9]+&pathname=/g,
                      `?protocol=ws${config.ssl ? 
                        "s" : ""}%3A&hostname=${proxyHostname}&port=${config.port}&pathname=${
                        encodeURIComponent(key.replace(/\/+$/, ''))}`)
            })
            .then((updatedBody: Buffer | string) =>
              (outboundResponseHeaders["content-encoding"] || "")
                .split(",")
                .reduce((buffer: Promise<Buffer>, formatNotTrimed: string) => {
                  const format = formatNotTrimed.trim().toLowerCase();
                  const method =
                    format === "gzip" || format === "x-gzip"
                      ? gzip
                      : format === "deflate"
                      ? deflate
                      : format === "br"
                      ? brotliCompress
                      : format === "identity" || format === ""
                      ? (
                          input: Buffer,
                          callback: (err?: Error, data?: Buffer) => void
                        ) => {
                          callback(null, input);
                        }
                      : null;
                  if (method === null)
                    throw new Error(
                      `${format} compression not supported by the proxy`
                    );

                  return buffer.then(
                    (data) =>
                      new Promise((resolve) =>
                        method(data, (err, data) => {
                          if (err) throw err;
                          resolve(data);
                        })
                      )
                  );
                }, Promise.resolve(Buffer.from(updatedBody)))
            );
        }));

      // phase : inbound response
      const responseHeaders = {
        ...Object.entries({
          ...outboundResponseHeaders,
          ...(config.replaceResponseBodyUrls
            ? { ["content-length"]: `${payload.byteLength}` }
            : {}),
        })
          .filter(
            ([h]) =>
              !h.startsWith(":") &&
              h.toLowerCase() !== "transfer-encoding" &&
              h.toLowerCase() !== "connection"
          )
          .reduce((acc: any, [key, value]: [string, string | string[]]) => {
            const allSubdomains = targetHost
              .split("")
              .map(
                (_, i) =>
                  targetHost.substring(i).startsWith(".") &&
                  targetHost.substring(i)
              )
              .filter((subdomain) => subdomain) as string[];
            const transformedValue = [targetHost].concat(allSubdomains).reduce(
              (acc1, subDomain) =>
                (!Array.isArray(acc1) ? [acc1] : (acc1 as string[])).map(
                  (oneElement) => {
                    return typeof oneElement === "string"
                      ? oneElement.replace(
                          `Domain=${subDomain}`,
                          `Domain=${url.hostname}`
                        )
                      : oneElement;
                  }
                ),
              value
            );

            acc[key] = (acc[key] || []).concat(transformedValue);
            return acc;
          }, {}),
        ...(newTargetUrl ? { location: [newTargetUrl] } : {}),
      };
      try { 
        Object.entries(responseHeaders).forEach(([headerName, headerValue]) => 
          headerValue && inboundResponse.setHeader(headerName, headerValue as string)
        );
      } catch(e) {
        // ERR_HTTP2_HEADERS_SENT
      }
      inboundResponse.writeHead(
        outboundResponseHeaders[":status"] ||
          outboundHttp1Response.statusCode ||
          200,
        config.ssl
          ? undefined // statusMessage is discarded in http/2
          : outboundHttp1Response.statusMessage || "Status read from http/2",
        responseHeaders
      );
      if (payload) inboundResponse.end(payload);
      else inboundResponse.end();
    }
  ) as Server)
    .addListener("error", (err: Error) => {
      if ((err as ErrorWithErrno).code === "EACCES")
        log(`permission denied for this port`, LogLevel.ERROR, "⛔");
      if ((err as ErrorWithErrno).code === "EADDRINUSE")
        log(`port is already used. NOT started`, LogLevel.ERROR, "☠️");
    })
    .addListener("listening", () => {
      logProtocols(config);
    })
    .on("upgrade", (request: IncomingMessage, upstreamSocket: Duplex) => {
      if (!config.websocket) {
        upstreamSocket.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n`)
        return;
      }

      const { key, target: targetWithForcedPrefix } = determineMapping(request);
      const target = new URL(`${targetWithForcedPrefix.protocol}//${
        targetWithForcedPrefix.host}${request.url.endsWith('/_next/webpack-hmr') 
        ? request.url 
        : request.url.replace( new RegExp(`^${key}`, 'g'), '').replace(/^\/*/, '/')}`);
      const downstreamRequestOptions: RequestOptions = {
        hostname: target.hostname,
        path: target.pathname,
        port: target.port,
        protocol: target.protocol,
        rejectUnauthorized: false,
        method: request.method,
        headers: request.headers,
        host: target.hostname,
      };

      const downstreamRequest = target.protocol === "https:"
        ? httpsRequest(downstreamRequestOptions)
        : httpRequest(downstreamRequestOptions);
      downstreamRequest.end();
      downstreamRequest.on('error', (error) => {
        log(`websocket request has errored ${
          (error as ErrorWithErrno).errno ?
          `(${(error as ErrorWithErrno).errno})` : ''}`, LogLevel.WARNING, "☄️")
    });
      downstreamRequest.on('upgrade', (response, downstreamSocket) => {
        const upgradeResponse = `HTTP/${response.httpVersion} ${response.statusCode} ${
          response.statusMessage}\r\n${Object.entries(response.headers)
            .flatMap(([key, value]) => (!Array.isArray(value) ? [value] : value)
              .map(oneValue => [key, oneValue]))
            .map(([key, value]) =>
              `${key}: ${value}\r\n`).join('')}\r\n`;
        upstreamSocket.write(upgradeResponse);
        upstreamSocket.allowHalfOpen = true;
        downstreamSocket.allowHalfOpen = true;
        downstreamSocket.on('data', (data) => upstreamSocket.write(data));
        upstreamSocket.on('data', (data) => downstreamSocket.write(data));
        downstreamSocket.on('error', (error) => {
          log(`downstream socket has errored ${
            (error as ErrorWithErrno).errno ?
            `(${(error as ErrorWithErrno).errno})` : ''}`, LogLevel.WARNING, "☄️")
        })
        upstreamSocket.on('error', (error) => {
          log(`upstream socket has errored ${
            (error as ErrorWithErrno).errno ?
            `(${(error as ErrorWithErrno).errno})` : ''}`, LogLevel.WARNING, "☄️")
        })
      });
    })
    .listen(config.port);
};

load().then(start);
