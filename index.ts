import { createServer, request as httpsRequest, RequestOptions } from "https";
import { URL } from "url";
import { watchFile, readFile } from "fs";
import {
  gzip,
  gunzip,
  inflate,
  deflate,
  brotliCompress,
  brotliDecompress,
} from "zlib";
import { resolve, normalize } from "path";
import {
  IncomingMessage,
  ServerResponse,
  request as httpRequest,
  ClientRequest,
} from "http";
import { exit } from "process";

interface LocalConfiguration {
  mapping: { [subPath: string]: string };
  ssl: { cert: string; key: string };
  port: number;
  replaceResponseBodyUrls: boolean;
}

const filename = resolve(
  __dirname,
  process.argv.slice(-1)[0].endsWith(".json")
    ? process.argv.slice(-1)[0]
    : "config.json"
);

let config: LocalConfiguration;
const load = async () =>
  new Promise((resolve) =>
    readFile(filename, (error, data) => {
      if (error) {
        console.log("error while loading the config");
        exit(1);
      }
      config = JSON.parse(data.toString());
      console.log("mapping is loaded");
      resolve(config);
    })
  );

watchFile(filename, async () => await load());

const envs: () => { [prefix: string]: URL } = () => ({
  ...Object.assign(
    {},
    ...Object.entries(config.mapping).map(([key, value]) => ({
      [key]: new URL(normalize(value)),
    }))
  ),
});

const fileRequest = (
  requestOptions: RequestOptions,
  callback?: (res: IncomingMessage) => void
): ClientRequest => {
  const clientRequest = () =>
    (({
      on: () => this,
      end: () => this,
    } as any) as ClientRequest);

  readFile(
    resolve(
      "/",
      requestOptions.hostname,
      requestOptions.path.replace(/[?#].*$/, "")
    ),
    (error, data) => {
      if (!callback) return;

      const dataListeners: ((chunk?: Buffer) => void)[] = [];
      const endListeners: (() => void)[] = [];
      const on = (event: string, listener: (chunk?: Buffer) => void) => {
        if (event === "data") dataListeners.push(listener);
        if (event === "end") endListeners.push(listener);
      };
      const result = error ? JSON.stringify(error) : data;
      callback(({
        headers: {
          Server: "local",
        },
        statusCode: error ? 500 : 200,
        statusMessage: error ? "File system error" : "OK",
        on,
      } as any) as IncomingMessage);
      setImmediate(() => {
        dataListeners.forEach((listener) =>
          listener(
            result instanceof Buffer ? result : Buffer.from(result, "utf8")
          )
        );
        endListeners.forEach((listener) => listener());
      });
    }
  );
  return clientRequest();
};

load()
  .then(() =>
    createServer(
      config.ssl,
      async (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(`https://${request.headers.host}${request.url}`);
        const path = url.href.substring(url.origin.length);
        const [key, target] = Object.entries(envs()).find(([key]) =>
          path.match(RegExp(key))
        )!;
        if (!target) {
          response.statusCode = 302;
          response.setHeader(
            "location",
            !envs()[""] ? "https://www.google.com" : envs()[""].href
          );
          return;
        }
        const targetHost = target.host.replace(RegExp(/\/+$/), "");
        const targetPrefix = target.href.substring(
          "https://".length + target.host.length
        );
        const fullPath = `${targetPrefix}${normalize(
          path.replace(RegExp(normalize(key)), "")
        )}`.replace(/^\/*/, "/");
        const targetUrl = new URL(`https://${targetHost}${fullPath}`);

        const headers = {
          ...[...Object.entries(request.headers)].reduce(
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
          host: targetHost,
          origin: target.href,
          referer: targetUrl,
        };
        const requestOptions: RequestOptions = {
          hostname: target.hostname,
          path: fullPath,
          port: target.port,
          protocol: target.protocol,
          rejectUnauthorized: false,
          method: request.method,
          headers,
        };
        const responseFromDownstream: IncomingMessage = await new Promise(
          (resolve) => {
            const requestInProgress =
              target.protocol === "file:"
                ? fileRequest(requestOptions, resolve)
                : target.protocol === "https:"
                ? httpsRequest(requestOptions, resolve)
                : httpRequest(requestOptions, resolve);
            request.on("data", (chunk) => requestInProgress.write(chunk));
            request.on("end", () => requestInProgress.end());
          }
        );
        const newUrl = !responseFromDownstream.headers["location"]
          ? null
          : new URL(
              responseFromDownstream.headers["location"].startsWith("/")
                ? `${target.href}${responseFromDownstream.headers[
                    "location"
                  ].replace(/^\/+/, ``)}`
                : responseFromDownstream.headers["location"]
            );
        const newPath = !newUrl
          ? null
          : newUrl.href.substring(newUrl.origin.length);
        const newTarget = url.origin;
        const newTargetUrl = !newUrl ? null : `${newTarget}${newPath}`;
        const payload = await new Promise((resolve) => {
          let partialBody = Buffer.alloc(0);
          responseFromDownstream.on(
            "data",
            (chunk) => (partialBody = Buffer.concat([partialBody, chunk]))
          );
          responseFromDownstream.on("end", () => {
            resolve(partialBody);
          });
        }).then((payloadBuffer: Buffer) => {
          if (!config.replaceResponseBodyUrls) return payloadBuffer;

          return (responseFromDownstream.headers["content-encoding"] || "")
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
                              `https://${request.headers.host}${path.replace(
                                /\/+$/,
                                ""
                              )}/`
                            ),
                      uncompressedBuffer.toString()
                    )
                    .split(`${request.headers.host}/:`)
                    .join(`${request.headers.host}:`)
            )
            .then((updatedBody) =>
              (responseFromDownstream.headers["content-encoding"] || "")
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
        });

        const responseHeaders = {
          ...Object.entries({
            ...responseFromDownstream.headers,
            ...(config.replaceResponseBodyUrls
              ? { ["content-length"]: `${payload.byteLength}` }
              : {}),
          }).reduce((acc: any, [key, value]: [string, string | string[]]) => {
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
                  (!Array.isArray(acc1)
                    ? [acc1]
                    : (acc1 as string[])
                  ).map((oneElement) =>
                    oneElement.replace(
                      `Domain=${subDomain}`,
                      `Domain=${url.hostname}`
                    )
                  ),
                value
              );

            acc[key] = (acc[key] || []).concat(transformedValue);
            return acc;
          }, {}),
          ...(newTargetUrl ? { location: [newTargetUrl] } : {}),
        };

        response.writeHead(
          responseFromDownstream.statusCode,
          responseFromDownstream.statusMessage,
          responseHeaders
        );
        if (payload) response.end(payload);
        else response.end();
      }
    ).listen(config.port)
  )
  .then(() => console.log(`proxy listening on port ${config.port}`));
