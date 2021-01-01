import {
  ClientHttp2Session,
  createServer,
  createSecureServer,
  connect,
  Http2Session,
  Http2ServerRequest,
  Http2ServerResponse,
  Http2Stream,
  OutgoingHttpHeaders,
  SecureClientSessionOptions,
  SecureServerOptions,
} from "http2";
import { request as httpRequest, IncomingMessage, ClientRequest } from "http";
import { request as httpsRequest, RequestOptions } from "https";
import { URL } from "url";
import { watchFile, readFile, writeFile } from "fs";
import {
  gzip,
  gunzip,
  inflate,
  deflate,
  brotliCompress,
  brotliDecompress,
} from "zlib";
import { resolve, normalize } from "path";

interface LocalConfiguration {
  mapping: { [subPath: string]: string };
  ssl?: SecureServerOptions;
  port: number;
  replaceResponseBodyUrls: boolean;
  dontUseHttp2Downstream: boolean;
}

const userHomeConfigFile = resolve(process.env.HOME, ".local-traffic.json");
const filename = resolve(
  __dirname,
  process.argv.slice(-1)[0].endsWith(".json")
    ? process.argv.slice(-1)[0]
    : userHomeConfigFile
);
const defaultConfig: LocalConfiguration = {
  mapping: {},
  port: 8080,
  replaceResponseBodyUrls: false,
  dontUseHttp2Downstream: false,
};

let config: LocalConfiguration;
const load = async (writeIfMissing: boolean = true) =>
  new Promise((resolve) =>
    readFile(filename, (error, data) => {
      if (error && !writeIfMissing) {
        console.log(`${filename} has not been loaded. Using default config`);
      }
      config = Object.assign(
        defaultConfig,
        JSON.parse((data || "{}").toString())
      );
      console.log("mapping is loaded");
      if (
        error &&
        error.code === "ENOENT" &&
        writeIfMissing &&
        filename === userHomeConfigFile
      ) {
        writeFile(filename, JSON.stringify(defaultConfig), (fileWriteErr) => {
          if (fileWriteErr) console.log(`${filename} could not be written`);
          else console.log(`I have created a config file in '${filename}'`);
          resolve(config);
        });
      } else resolve(config);
    })
  );

watchFile(filename, async () => await load(false));

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
  const clientRequest = function () {
    return {
      error: null as Error,
      data: null as string | Buffer,
      hasRun: false,
      run: function () {
        return this.hasRun
          ? Promise.resolve()
          : new Promise((promiseResolve) =>
              readFile(
                resolve(
                  "/",
                  url.hostname,
                  ...url.pathname
                    .replace(/[?#].*$/, "")
                    .replace(/^\/+/, "")
                    .split("/")
                ),
                (error, data) => {
                  this.hasRun = true;
                  this.error = error;
                  this.data = data;
                  promiseResolve(void 0);
                }
              )
            );
      },
      events: {} as { [name: string]: (...any: any) => any },
      on: function (name: string, action: (...any: any) => any) {
        this.events[name] = action;
        this.run().then(() => {
          if (name === "response")
            this.events["response"]({ Server: "local" }, 0);
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

const errorPage = (
  thrown: Error,
  requestedURL: URL,
  downstreamURL: URL,
  phase: string
) => `<!doctype html>
<html lang="en">
<head>
<title>&#x1F4A3; local-traffic error | ${thrown.message}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@latest/dist/css/bootstrap.min.css" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/jquery@latest/dist/jquery.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@latest/dist/js/bootstrap.bundle.min.js"></script>
</head>
<body><div class="container"><h1>&#x1F4A3; local-traffic error</h1>
<br/>
<p>An error happened while trying to proxy a remote exchange</p>
<div class="alert alert-warning" role="alert">
  &#x24D8;&nbsp;This is not an error from the downstream service.
</div>
<div class="alert alert-danger" role="alert">
<pre><code>${thrown.stack || `<i>${thrown.name} : ${thrown.message}</i>`}${
  (thrown as any).errno ? `<br/>(code : ${(thrown as any).errno})` : ""
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
      <td>${downstreamURL}</td>
    </tr>
  </tbody>
</table>
</div></body></html>`;

load()
  .then(() =>
    (config.ssl
      ? createSecureServer.bind(null, { ...config.ssl, allowHTTP1: true })
      : createServer)(
      async (
        inboundRequest: Http2ServerRequest,
        inboundResponse: Http2ServerResponse
      ) => {
        const proxyHostname =
          inboundRequest.headers[":authority"] || inboundRequest.headers.host;
        const url = new URL(`https://${proxyHostname}${inboundRequest.url}`);
        const path = url.href.substring(url.origin.length);
        const [key, target] = Object.entries(envs()).find(([key]) =>
          path.match(RegExp(key))
        )!;
        if (!target) {
          inboundResponse.statusCode = 302;
          inboundResponse.setHeader(
            "location",
            (envs()[""] || new URL("https://www.google.com")).href
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
        const targetUrl = new URL(
          `${target.protocol}//${targetHost}${fullPath}`
        );
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
                          errorPage(thrown, url, targetUrl, "connection")
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
        if (!http2IsSupported && error) error = null;

        const outboundHeaders: OutgoingHttpHeaders = {
          ...[...Object.entries(inboundRequest.headers)].reduce(
            (acc: any, [key, value]) => {
              acc[key] =
                (acc[key] || "") +
                (!Array.isArray(value) ? [value] : value)
                  .map((oneValue) => oneValue.replace(url.hostname, targetHost))
                  .join(", ");
              return acc;
            },
            {}
          ),
          origin: target.href,
          referer: targetUrl.toString(),
          host: undefined, // host header is forbidden in http/2,
          ":authority": targetHost,
          ":method": inboundRequest.method,
          ":path": fullPath,
          ":scheme": target.protocol.replace(":", ""),
        };

        const outboundExchange =
          outboundRequest &&
          !error &&
          outboundRequest.request(outboundHeaders, {
            endStream: !inboundRequest.stream.readableLength,
          });

        outboundExchange &&
          ((outboundExchange as unknown) as Http2Stream).on(
            "error",
            (thrown: Error) => {
              const httpVersionSupported = (thrown as any).errno === -505;
              error = Buffer.from(
                errorPage(
                  thrown,
                  url,
                  targetUrl,
                  "streaming" +
                    (httpVersionSupported
                      ? " (error -505 usually means that the downstream service " +
                        "does not support this http version)"
                      : "")
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
                    !h.startsWith(":") &&
                    h.toLowerCase() !== "transfer-encoding"
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
              error = Buffer.from(errorPage(thrown, url, targetUrl, "request"));
              resolve(null as IncomingMessage);
            });
            inboundRequest.on("data", (chunk) =>
              outboundHttp1Request.write(chunk)
            );
            inboundRequest.on("end", () => outboundHttp1Request.end());
          }));

        if (error) {
          inboundResponse.writeHead(
            502,
            undefined, // statusMessage is discarded in http/2
            {
              "content-type": "text/html",
              "content-length": error.length,
            }
          );
          inboundResponse.write(error);
          inboundResponse.end();
          return;
        }

        if (inboundRequest.stream.readableLength && outboundExchange) {
          outboundExchange.setEncoding("utf8");
          inboundRequest.stream.on("data", (chunk) =>
            outboundExchange.write(chunk)
          );
          inboundRequest.stream.on("end", () => outboundExchange.end());
        }

        const {
          outboundResponseHeaders,
          outboundResponseFlags,
        } = await new Promise((resolve) =>
          outboundExchange
            ? outboundExchange.on("response", (headers, flags) => {
                resolve({
                  outboundResponseHeaders: headers,
                  outboundResponseFlags: flags,
                });
              })
            : !outboundExchange && outboundHttp1Response
            ? resolve({
                outboundResponseHeaders: outboundHttp1Response.headers,
                outboundResponseFlags: 0,
              })
            : resolve({
                outboundResponseHeaders: {},
                outboundResponseFlags: 0,
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
        const payloadSource = outboundExchange || outboundHttp1Response;
        const payload =
          error ||
          (await new Promise((resolve) => {
            let partialBody = Buffer.alloc(0);
            if (!payloadSource) {
              resolve(partialBody);
              return;
            }
            (payloadSource as any).on(
              "data",
              (chunk) =>
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

            return (outboundResponseHeaders["content-encoding"] || "")
              .split(",")
              .reduce((buffer, formatNotTrimed) => {
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
              }, Promise.resolve(payloadBuffer))
              .then((uncompressedBuffer) =>
                !config.replaceResponseBodyUrls
                  ? uncompressedBuffer.toString()
                  : Object.entries(config.mapping)
                      .reduce(
                        (inProgress, [path, mapping]) =>
                          !path.match(/^[-a-zA-Z0-9()@:%_\+.~#?&//=]*$/)
                            ? inProgress
                            : inProgress.replace(
                                new RegExp(
                                  mapping
                                    .replace(/^file:\/\//, "")
                                    .replace(/[*+?^${}()|[\]\\]/g, ""),
                                  "ig"
                                ),
                                `https://${proxyHostname}${path.replace(
                                  /\/+$/,
                                  ""
                                )}/`
                              ),
                        uncompressedBuffer.toString()
                      )
                      .split(`${proxyHostname}/:`)
                      .join(`${proxyHostname}:`)
              )
              .then((updatedBody) =>
                (outboundResponseHeaders["content-encoding"] || "")
                  .split(",")
                  .reduce((buffer, formatNotTrimed) => {
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

        const responseHeaders = {
          ...Object.entries({
            ...outboundResponseHeaders,
            ...(config.replaceResponseBodyUrls
              ? { ["content-length"]: `${payload.byteLength}` }
              : {}),
          })
            .filter(
              ([h]) =>
                !h.startsWith(":") && h.toLowerCase() !== "transfer-encoding"
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
              const transformedValue = [targetHost]
                .concat(allSubdomains)
                .reduce(
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

        inboundResponse.writeHead(
          outboundResponseHeaders[":status"] ||
            outboundHttp1Response.statusCode,
          !outboundHttp1Response
            ? undefined
            : outboundHttp1Response.statusMessage, // statusMessage is discarded in http/2
          responseHeaders
        );
        if (payload) inboundResponse.end(payload);
        else inboundResponse.end();
      }
    ).listen(config.port)
  )
  .then(() => console.log(`proxy listening on port ${config.port}`));
