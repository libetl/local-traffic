import {
  ClientHttp2Session,
  createSecureServer,
  connect,
  Http2Session,
  Http2ServerRequest,
  Http2ServerResponse,
  OutgoingHttpHeaders,
  SecureClientSessionOptions,
  SecureServerOptions,
  ClientHttp2Stream,
  IncomingHttpStatusHeader,
} from "http2";
import {
  request as httpRequest,
  IncomingMessage,
  ClientRequest,
  IncomingHttpHeaders,
  createServer,
  ServerResponse,
  Server,
} from "http";
import { request as httpsRequest, RequestOptions } from "https";
import { URL } from "url";
import {
  watchFile,
  readdir,
  readFile,
  writeFile,
  lstat,
  StatWatcher,
} from "fs";
import {
  gzip,
  gunzip,
  inflate,
  deflate,
  brotliCompress,
  brotliDecompress,
} from "zlib";
import { resolve, normalize } from "path";
import { createHash, randomBytes } from "crypto";
import { hrtime, env, cwd, argv, stdout } from "process";
import type { Duplex, Readable } from "stream";

type ErrorWithErrno = NodeJS.ErrnoException;

enum LogLevel {
  ERROR = 124,
  INFO = 93,
  WARNING = 172,
}

enum EMOJIS {
  INBOUND = "↘️ ",
  PORT = "☎️ ",
  OUTBOUND = "↗️ ",
  RULES = "🔗",
  REWRITE = "✒️ ",
  RESTART = "🔄",
  WEBSOCKET = "☄️ ",
  COLORED = "✨",
  SHIELD = "🛡️ ",
  NO = "⛔",
  ERROR_1 = "❌",
  ERROR_2 = "⛈️ ",
  ERROR_3 = "☢️ ",
  ERROR_4 = "⁉️ ",
  ERROR_5 = "⚡",
  ERROR_6 = "☠️ ",
}

enum REPLACEMENT_DIRECTION {
  INBOUND = "INBOUND",
  OUTBOUND = "OUTBOUND",
}

interface WebsocketListener {
  stream: Duplex;
  wantsMask: boolean;
}

interface PartialRead {
  payloadLength: number;
  mask: number[];
  body: string;
}

interface LocalConfiguration {
  mapping?: Mapping;
  ssl?: SecureServerOptions;
  port?: number;
  replaceRequestBodyUrls?: boolean;
  replaceResponseBodyUrls?: boolean;
  dontUseHttp2Downstream?: boolean;
  dontTranslateLocationHeader?: boolean;
  simpleLogs?: boolean;
  websocket?: boolean;
  disableWebSecurity?: boolean;
}

type Mapping = {
  [subPath: string]: string | { replaceBody: string; downstreamUrl: string };
};

interface State {
  config: LocalConfiguration;
  server: Server;
  logsListeners: WebsocketListener[];
  configListeners: WebsocketListener[];
  configFileWatcher: StatWatcher;
  log: (text: string, level?: LogLevel, emoji?: string) => void;
  notifyConfigListeners: (data: Record<string, unknown>) => void;
  notifyLogsListeners: (data: Record<string, unknown>) => void;
  quickStatus: () => void;
}

const userHomeConfigFile = resolve(env.HOME, ".local-traffic.json");
const filename = resolve(
  cwd(),
  argv.slice(-1)[0].endsWith(".json") ? argv.slice(-1)[0] : userHomeConfigFile,
);
const defaultConfig: LocalConfiguration = {
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
};

const getCurrentTime = (simpleLogs?: boolean) => {
  const date = new Date();
  return `${simpleLogs ? "" : "\u001b[36m"}${`${date.getHours()}`.padStart(
    2,
    "0",
  )}${
    simpleLogs ? ":" : "\u001b[33m:\u001b[36m"
  }${`${date.getMinutes()}`.padStart(2, "0")}${
    simpleLogs ? ":" : "\u001b[33m:\u001b[36m"
  }${`${date.getSeconds()}`.padStart(2, "0")}${simpleLogs ? "" : "\u001b[0m"}`;
};
const levelToString = (level: LogLevel) =>
  level === LogLevel.ERROR
    ? "error"
    : level === LogLevel.WARNING
    ? "warning"
    : "info";
const log = function (
  state: Partial<State>,
  text: string,
  level?: LogLevel,
  emoji?: string,
) {
  const simpleLog =
    state?.config?.simpleLogs || state?.logsListeners?.length
      ? text
          .replace(/⎸/g, "|")
          .replace(/⎹/g, "|")
          .replace(/\u001b\[[^m]*m/g, "")
          .replace(new RegExp(EMOJIS.INBOUND, "g"), "inbound:")
          .replace(new RegExp(EMOJIS.PORT, "g"), "port:")
          .replace(new RegExp(EMOJIS.OUTBOUND, "g"), "outbound:")
          .replace(new RegExp(EMOJIS.RULES, "g"), "rules:")
          .replace(new RegExp(EMOJIS.NO, "g"), "")
          .replace(new RegExp(EMOJIS.REWRITE, "g"), "+rewrite")
          .replace(new RegExp(EMOJIS.WEBSOCKET, "g"), "websocket")
          .replace(new RegExp(EMOJIS.SHIELD, "g"), "web-security")
          .replace(/\|+/g, "|")
      : text;

  console.log(
    `${getCurrentTime(state?.config?.simpleLogs)} ${
      state?.config?.simpleLogs
        ? simpleLog
        : level
        ? `\u001b[48;5;${level}m⎸    ${
            !stdout.isTTY ? "" : emoji || ""
          }  ${text.padEnd(40)} ⎹\u001b[0m`
        : text
    }`,
  );
  state?.notifyLogsListeners?.({
    event: simpleLog,
    level: levelToString(level),
  });
};

const createWebsocketBufferFrom = (
  text: string,
  wantsMask: boolean,
): Buffer => {
  const mask = Array(4)
    .fill(0)
    .map(() => (wantsMask ? Math.floor(Math.random() * (2 << 7)) : 0));
  const maskedTextBits = [...text.substring(0, 2 << 15)].map(
    (c, i) => c.charCodeAt(0) ^ mask[i & 3],
  );
  const length = Math.min((2 << 15) - 1, text.length);
  const header =
    text.length < (2 << 6) - 2
      ? Buffer.from(
          Uint8Array.from([(1 << 7) + 1, (wantsMask ? 1 << 7 : 0) + length])
            .buffer,
        )
      : Buffer.concat([
          Buffer.from(
            Uint8Array.from([
              (1 << 7) + 1,
              ((1 << 7) - 2) | (wantsMask ? 1 << 7 : 0),
            ]).buffer,
          ),
          Buffer.from(Uint8Array.from([length >> 8]).buffer),
          Buffer.from(Uint8Array.from([length & ((1 << 8) - 1)]).buffer),
        ]);
  const maskingKey = Buffer.from(Int8Array.from(mask).buffer);
  const payload = Buffer.from(Int8Array.from(maskedTextBits).buffer);
  return Buffer.concat(
    wantsMask ? [header, maskingKey, payload] : [header, payload],
  );
};

const readWebsocketBuffer = (
  buffer: Buffer,
  partialRead: PartialRead,
): PartialRead => {
  if (!partialRead && (buffer.readUInt8(0) & 1) === 0)
    return { payloadLength: 0, mask: [0, 0, 0, 0], body: "" };
  const headerSecondByte = partialRead ? 0 : buffer.readUInt8(1);
  const hasMask = headerSecondByte >> 7;
  const payloadLengthFirstByte = headerSecondByte & ((1 << 7) - 1);
  const payloadLength = partialRead
    ? partialRead.payloadLength
    : payloadLengthFirstByte !== (1 << 7) - 1
    ? payloadLengthFirstByte
    : buffer.readUInt8(2) << (8 + buffer.readUInt8(3));
  const mask = partialRead
    ? partialRead.mask
    : !hasMask
    ? [0, 0, 0, 0]
    : Array(4)
        .fill(0)
        .map((_, i) => buffer.readUInt8(i + 4));
  const payloadStart = partialRead ? 0 : hasMask ? 8 : 4;
  const body = Array(buffer.length - payloadStart)
    .fill(0)
    .map((_, i) =>
      String.fromCharCode(buffer.readUInt8(i + payloadStart) ^ mask[i & 3]),
    )
    .join("");
  return { payloadLength, mask, body: (partialRead?.body ?? "").concat(body) };
};

const acknowledgeWebsocket = (socket: Duplex, key: string) => {
  const shasum = createHash("sha1");
  shasum.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  const accept = shasum.digest("base64");
  socket.allowHalfOpen = true;
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      `date: ${new Date().toUTCString()}\r\n` +
      "connection: upgrade\r\n" +
      "upgrade: websocket\r\n" +
      "server: local\r\n" +
      `sec-websocket-accept: ${accept}\r\n` +
      "\r\n",
  );
};

const notifyConfigListeners = function (
  this: State,
  data: Record<string, unknown>,
) {
  return notifyListeners(this, data, this.configListeners);
};
const notifyLogsListeners = function (
  this: State,
  data: Record<string, unknown>,
) {
  return notifyListeners(this, data, this.logsListeners);
};
const notifyListeners = (
  state: State,
  data: Record<string, unknown>,
  listeners: WebsocketListener[],
) => {
  if (!listeners.length) return;
  const text = JSON.stringify(data);
  const wantsMask = new Set(listeners.map(listener => listener.wantsMask));
  const bufferWithoutMask =
    wantsMask.has(false) && createWebsocketBufferFrom(text, false);
  const bufferWithMask =
    wantsMask.has(true) && createWebsocketBufferFrom(text, true);
  const streamError = (listener: WebsocketListener) => {
    if (!listener.stream.errored) return;
    listener.stream.destroy();
  };
  listeners.forEach(listener => {
    if (listener.stream.closed || listener.stream.errored) return;
    listener.wantsMask
      ? listener.stream.write(bufferWithMask, "ascii", () =>
          streamError(listener),
        )
      : listener.stream.write(bufferWithoutMask, "ascii", () =>
          streamError(listener),
        );
  });
};

const quickStatus = function (this: State) {
  this.log(
    `\u001b[48;5;52m⎸${EMOJIS.PORT} ${this.config.port
      .toString()
      .padStart(5)} \u001b[48;5;53m⎸${EMOJIS.OUTBOUND} ${
      this.config.dontUseHttp2Downstream ? "H1.1" : "H/2 "
    }${this.config.replaceRequestBodyUrls ? EMOJIS.REWRITE : "  "}⎹⎸${
      EMOJIS.INBOUND
    } ${this.config.ssl ? "H/2 " : "H1.1"}${
      this.config.replaceResponseBodyUrls ? EMOJIS.REWRITE : "  "
    }⎹\u001b[48;5;54m\u001b[48;5;55m⎸${EMOJIS.RULES}${Object.keys(
      this.config.mapping,
    )
      .length.toString()
      .padStart(3)}⎹\u001b[48;5;56m⎸${
      this.config.websocket ? EMOJIS.WEBSOCKET : EMOJIS.NO
    }⎹\u001b[48;5;57m⎸${
      !this.config.simpleLogs ? EMOJIS.COLORED : EMOJIS.NO
    }⎹\u001b[48;5;93m⎸${
      this.config.disableWebSecurity ? EMOJIS.NO : EMOJIS.SHIELD
    }⎹\u001b[0m`,
  );
  this.notifyConfigListeners(this.config as Record<string, unknown>);
};

const load = async (firstTime: boolean = true): Promise<LocalConfiguration> =>
  new Promise<LocalConfiguration>(resolve =>
    readFile(filename, (error, data) => {
      if (error && !firstTime) {
        log(
          null,
          "config error. Using default value",
          LogLevel.ERROR,
          EMOJIS.ERROR_1,
        );
      }
      let config: LocalConfiguration = null;
      try {
        config = Object.assign(
          {},
          defaultConfig,
          JSON.parse((data || "{}").toString()),
        );
      } catch (e) {
        log(
          { config },
          "config syntax incorrect, aborting",
          LogLevel.ERROR,
          EMOJIS.ERROR_2,
        );
        config = config ?? { ...defaultConfig };
        resolve(config);
        return;
      }
      if (!config.mapping[""]) {
        log(
          { config },
          'default mapping "" not provided.',
          LogLevel.WARNING,
          EMOJIS.ERROR_3,
        );
      }
      if (
        error &&
        error.code === "ENOENT" &&
        firstTime &&
        filename === userHomeConfigFile
      ) {
        writeFile(
          filename,
          JSON.stringify(defaultConfig, null, 2),
          fileWriteErr => {
            if (fileWriteErr)
              log(
                null,
                "config file NOT created",
                LogLevel.ERROR,
                EMOJIS.ERROR_4,
              );
            else
              log(null, "config file created", LogLevel.INFO, EMOJIS.COLORED);
            resolve(config);
          },
        );
      } else resolve(config);
    }),
  );

const onWatch = async function (state: State): Promise<Partial<State>> {
  const previousConfig = state.config;
  const config = await load(false);
  if (isNaN(config.port) || config.port > 65535 || config.port < 0) {
    state.log(
      "port number invalid. Not refreshing",
      LogLevel.ERROR,
      EMOJIS.PORT,
    );
    return {};
  }
  if (typeof config.mapping !== "object") {
    state.log(
      "mapping should be an object. Aborting",
      LogLevel.ERROR,
      EMOJIS.ERROR_5,
    );
    return {};
  }
  if (config.replaceRequestBodyUrls !== previousConfig.replaceRequestBodyUrls) {
    state.log(
      `request body url ${
        !config.replaceRequestBodyUrls ? "NO " : ""
      }rewriting`,
      LogLevel.INFO,
      EMOJIS.REWRITE,
    );
  }
  if (
    config.replaceResponseBodyUrls !== previousConfig.replaceResponseBodyUrls
  ) {
    state.log(
      `response body url ${
        !config.replaceResponseBodyUrls ? "NO " : ""
      }rewriting`,
      LogLevel.INFO,
      EMOJIS.REWRITE,
    );
  }
  if (
    config.dontTranslateLocationHeader !==
    previousConfig.dontTranslateLocationHeader
  ) {
    state.log(
      `response location header ${
        config.dontTranslateLocationHeader ? "NO " : ""
      }translation`,
      LogLevel.INFO,
      EMOJIS.REWRITE,
    );
  }
  if (config.dontUseHttp2Downstream !== previousConfig.dontUseHttp2Downstream) {
    state.log(
      `http/2 ${config.dontUseHttp2Downstream ? "de" : ""}activated downstream`,
      LogLevel.INFO,
      EMOJIS.OUTBOUND,
    );
  }
  if (config.disableWebSecurity !== previousConfig.disableWebSecurity) {
    state.log(
      `web security ${config.disableWebSecurity ? "de" : ""}activated`,
      LogLevel.INFO,
      EMOJIS.SHIELD,
    );
  }
  if (config.websocket !== previousConfig.websocket) {
    state.log(
      `websocket ${!config.websocket ? "de" : ""}activated`,
      LogLevel.INFO,
      EMOJIS.WEBSOCKET,
    );
  }
  if (config.simpleLogs !== previousConfig.simpleLogs) {
    state.log(
      `simple logs ${!config.simpleLogs ? "off" : "on"}`,
      LogLevel.INFO,
      EMOJIS.COLORED,
    );
  }
  if (
    Object.keys(config.mapping).join("\n") !==
    Object.keys(previousConfig.mapping).join("\n")
  ) {
    state.log(
      `${Object.keys(config.mapping)
        .length.toString()
        .padStart(5)} loaded mapping rules`,
      LogLevel.INFO,
      EMOJIS.RULES,
    );
  }
  if (config.port !== previousConfig.port) {
    state.log(
      `port changed from ${previousConfig.port} to ${config.port}`,
      LogLevel.INFO,
      EMOJIS.PORT,
    );
  }
  if (config.ssl && !previousConfig.ssl) {
    state.log(`ssl configuration added`, LogLevel.INFO, EMOJIS.INBOUND);
  }
  if (!config.ssl && previousConfig.ssl) {
    state.log(`ssl configuration removed`, LogLevel.INFO, EMOJIS.INBOUND);
  }
  if (
    config.port !== previousConfig.port ||
    JSON.stringify(config.ssl) !== JSON.stringify(previousConfig.ssl)
  ) {
    state.log(`restarting server`, LogLevel.INFO, EMOJIS.RESTART);
    quickStatus.apply({ ...state, config });
    return { config, server: null };
  }
  quickStatus.apply({ ...state, config });
  return { config };
};

const unixNorm = (path: string) =>
  path == "" ? "" : normalize(path).replace(/\\/g, "/");

const cdn = "https://cdn.jsdelivr.net/npm/";

const header = (
  icon: number,
  category: string,
  pageTitle: string,
) => `<!doctype html>
<html lang="en">
<head>
<title>&#x${icon.toString(16)}; local-traffic ${category} | ${pageTitle}</title>
<link href="${cdn}bootstrap/dist/css/bootstrap.min.css" rel="stylesheet"/>
<script src="${cdn}jquery/dist/jquery.min.js"></script>
<script src="${cdn}bootstrap/dist/js/bootstrap.bundle.min.js"></script>
</head>
<body><div class="container"><h1>&#x${icon.toString(
  16,
)}; local-traffic ${category}</h1>
<br/>`;

const fileRequest = (url: URL): ClientHttp2Session => {
  const file = resolve(
    "/",
    url.hostname,
    ...url.pathname
      .replace(/[?#].*$/, "")
      .replace(/^\/+/, "")
      .split("/"),
  );
  return {
    error: null as Error,
    data: null as string | Buffer,
    hasRun: false,
    run: function () {
      return this.hasRun
        ? Promise.resolve()
        : new Promise(promiseResolve =>
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
                    file =>
                      new Promise(innerResolve =>
                        lstat(resolve(url.pathname, file), (err, stats) =>
                          innerResolve([file, stats, err]),
                        ),
                      ),
                  ),
                ).then(filesWithTypes => {
                  const entries = filesWithTypes
                    .filter(entry => !entry[2] && entry[1].isDirectory())
                    .concat(
                      filesWithTypes.filter(
                        entry => !entry[2] && entry[1].isFile(),
                      ),
                    );
                  this.data = `${header(
                    0x1f4c2,
                    "directory",
                    url.href,
                  )}<p>Directory content of <i>${url.href.replace(
                    /\//g,
                    "&#x002F;",
                  )}</i></p><ul class="list-group"><li class="list-group-item">&#x1F4C1;<a href="${
                    url.pathname.endsWith("/") ? ".." : "."
                  }">&lt;parent&gt;</a></li>${entries
                    .filter(entry => !entry[2])
                    .map(entry => {
                      const type = entry[1].isDirectory() ? 0x1f4c1 : 0x1f4c4;
                      return `<li class="list-group-item">&#x${type.toString(
                        16,
                      )};<a href="${
                        url.pathname.endsWith("/")
                          ? ""
                          : `${url.pathname.split("/").slice(-1)[0]}/`
                      }${entry[0]}">${entry[0]}</a></li>`;
                    })
                    .join("\n")}</li></ul></body></html>`;
                  promiseResolve(void 0);
                });
              });
            }),
          );
    },
    events: {} as { [name: string]: (...any: any) => any },
    on: function (name: string, action: (...any: any) => any) {
      this.events[name] = action;
      this.run().then(() => {
        if (name === "response")
          this.events["response"](
            file.endsWith(".svg")
              ? {
                  Server: "local",
                  "Content-Type": "image/svg+xml",
                }
              : { Server: "local" },
            0,
          );
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
  } as unknown as ClientHttp2Session;
};

const staticPage = (data: string): ClientHttp2Session =>
  ({
    error: null as Error,
    data: null as string | Buffer,
    run: function () {
      return new Promise(resolve => {
        this.data = data;
        resolve(void 0);
      });
    },
    events: {} as { [name: string]: (...any: any) => any },
    on: function (name: string, action: (...any: any) => any) {
      this.events[name] = action;
      this.run().then(() => {
        if (name === "response")
          this.events["response"](
            {
              Server: "local",
              "Content-Type": "text/html",
            },
            0,
          );
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
  } as unknown as ClientHttp2Session);

const logsPage = (proxyHostnameAndPort: string, ssl: boolean) =>
  staticPage(`${header(0x1f4fa, "logs", "")}
<nav class="navbar navbar-expand-lg navbar-dark bg-primary nav-fill">
  <div class="container-fluid">
    <ul class="navbar-nav">
      <li class="nav-item">
        <a class="nav-link active" aria-current="page" href="javascript:show(0)">Access</a>
      </li>
      <li class="nav-item">
        <a class="nav-link" href="javascript:show(1)">Proxy</a>
      </li>
    </ul>
    <span class="navbar-text">
      Limit : <select id="limit" onchange="javascript:cleanup()"><option value="-1">0 (clear)</option><option value="10">10</option>
        <option value="50">50</option><option value="100">100</option><option value="200">200</option>
        <option selected="selected" value="500">500</option><option value="0">Infinity (discouraged)</option>
      </select> rows
    </span>
  </div>
</nav>
<table id="table-access" class="table table-striped" style="display: block; width: 100%; overflow-y: auto">
  <thead>
    <tr>
      <th scope="col">...</th>
      <th scope="col">Date</th>
      <th scope="col">Level</th>
      <th scope="col">Protocol</th>
      <th scope="col">Method</th>
      <th scope="col">Status</th>
      <th scope="col">Duration</th>
      <th scope="col">Upstream Path</th>
      <th scope="col">Downstream Path</th>
    </tr>
  </thead>
  <tbody id="access">
  </tbody>
</table>
<table id="table-proxy" class="table table-striped" style="display: none; width: 100%; overflow-y: auto">
  <thead>
    <tr>
      <th scope="col">Date</th>
      <th scope="col">Level</th>
      <th scope="col">Message</th>
    </tr>
  </thead>
  <tbody id="proxy">
  </tbody>
</table>
<script type="text/javascript">
    function start() {
      document.getElementById('table-access').style.height =
        (document.documentElement.clientHeight - 150) + 'px';
      const socket = new WebSocket("ws${
        ssl ? "s" : ""
      }://${proxyHostnameAndPort}/local-traffic-logs");
      socket.onmessage = function(event) {
        let data = event.data
        let uniqueHash;
        try {
          const { uniqueHash: uniqueHash1, ...data1 } = JSON.parse(event.data);
          data = data1;
          uniqueHash = uniqueHash1;
        } catch(e) { }
        const time = new Date().toISOString().split('T')[1].replace('Z', '');
        const replay = uniqueHash ? '<button data-uniquehash="' + uniqueHash + '" onclick="javascript:replay(event)" ' +
          'type="button" class="btn btn-primary"' +
          (uniqueHash === 'N/A' ? ' disabled="disabled"' : '') + '>&#x1F501;</button>' : '';
        if(data.statusCode && uniqueHash) {
          const color = Math.floor(data.statusCode / 100) === 1 ? "info" :
            Math.floor(data.statusCode / 100) === 2 ? "success" :
            Math.floor(data.statusCode / 100) === 3 ? "dark" :
            Math.floor(data.statusCode / 100) === 4 ? "warning" :
            Math.floor(data.statusCode / 100) === 5 ? "danger" :
            "secondary";
          const statusCodeColumn = document.querySelector("#event-" + data.randomId + " .statusCode");
          if (statusCodeColumn)
            statusCodeColumn.innerHTML = '<span class="badge bg-' + color + '">' + data.statusCode + '</span>';

          const durationColumn = document.querySelector("#event-" + data.randomId + " .duration");
          if (durationColumn) {
            const duration = data.duration > 10000 ? Math.floor(data.duration / 1000) + 's' :
              data.duration + 'ms';
            durationColumn.innerHTML = duration;
          }

          const protocolColumn = document.querySelector("#event-" + data.randomId + " .protocol");
          if (protocolColumn) {
            protocolColumn.innerHTML = data.protocol;
          }

          const replayColumn = document.querySelector("#event-" + data.randomId + " .replay");
          if (replayColumn) {
            replayColumn.innerHTML = replay;
          }
        } else if (uniqueHash) {
            document.getElementById("access")
              .insertAdjacentHTML('afterbegin', '<tr id="event-' + data.randomId + '">' +
                  '<td scope="col" class="replay">' + replay + '</td>' +
                  '<td scope="col">' + time + '</td>' +
                  '<td scope="col">' + (data.level || 'info')+ '</td>' + 
                  '<td scope="col" class="protocol">' + data.protocol + '</td>' + 
                  '<td scope="col">' + data.method + '</td>' + 
                  '<td scope="col" class="statusCode"><span class="badge bg-secondary">...</span></td>' +
                  '<td scope="col" class="duration">&#x23F1;</td>' +
                  '<td scope="col">' + data.upstreamPath + '</td>' + 
                  '<td scope="col">' + data.downstreamPath + '</td>' + 
                  '</tr>');
          } else if(data.event) {
          document.getElementById("proxy")
            .insertAdjacentHTML('afterbegin', '<tr><td scope="col">' + time + '</td>' +
                '<td scope="col">' + (data.level || 'info')+ '</td>' + 
                '<td scope="col">' + data.event + '</td></tr>');
        }
        cleanup();
      };
      socket.onerror = function(error) {
        console.log(\`[error] \${error}\`);
        setTimeout(start, 5000);
      };
    };
    function show(id) {
      [...document.querySelectorAll('table')].forEach((table, index) => {
        table.style.display = index === id ? 'block': 'none'
      });
      [...document.querySelectorAll('.navbar-nav .nav-item .nav-link')].forEach((link, index) => {
        if (index === id) { link.classList.add('active') } else link.classList.remove('active');
      });
    }
    function cleanup() {
      const currentLimit = parseInt(document.getElementById('limit').value)
      for (let table of ['access', 'proxy']) {
        while (currentLimit && document.getElementById(table).childNodes.length && 
        document.getElementById(table).childNodes.length > currentLimit) {
          [...document.getElementById(table).childNodes].slice(-1)[0].remove();
        }
      }
    }
    function replay(event) {
      const uniqueHash = event.target.dataset.uniquehash;
      const { method, url, headers, body } = JSON.parse(atob(uniqueHash));
      fetch(url, {
        method,
        headers,
        body: !body.data || !body.data.length 
          ? undefined
          : new TextDecoder().decode(new Int8Array(body.data))
      });
    }
    window.addEventListener("DOMContentLoaded", start);
</script>
</body></html>`);

const configPage = (proxyHostnameAndPort: string, config: LocalConfiguration) =>
  staticPage(`${header(0x1f39b, "config", "")}
    <link href="${cdn}jsoneditor/dist/jsoneditor.min.css" rel="stylesheet" type="text/css">
    <script src="${cdn}jsoneditor/dist/jsoneditor.min.js"></script>
    <script src="${cdn}node-forge/dist/forge.min.js"></script>
    <div id="ssl-modal" class="modal" tabindex="-1" role="dialog">
      <div class="modal-dialog" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">SSL keypair generation in progress</h5>
          </div>
          <div class="modal-body">
            <p>Wait a few seconds or move your mouse to improve the entropy.</p>
          </div>
        </div>
      </div>
    </div>
    <div id="jsoneditor" style="width: 400px; height: 400px;"></div>
    <script>
    // create the editor
    const container = document.getElementById("jsoneditor")
    const options = {mode: "code", allowSchemaSuggestions: true, schema: {
      type: "object",
      properties: {
        ${Object.entries({ ...defaultConfig, ssl: { cert: "", key: "" } })
          .map(
            ([property, exampleValue]) =>
              `${property}: {type: "${
                typeof exampleValue === "number"
                  ? "integer"
                  : typeof exampleValue === "string"
                  ? "string"
                  : typeof exampleValue === "boolean"
                  ? "boolean"
                  : "object"
              }"}`,
          )
          .join(",\n          ")}
      },
      required: [],
      additionalProperties: false
    }}

    function save() {
      socket.send(JSON.stringify(editor.get()));
    }

    function generateSslCertificate() {
      const sslModal = new bootstrap.Modal(document.getElementById('ssl-modal'), {});
      sslModal.show()
      setTimeout(function() {
        const keypair = forge.pki.rsa.generateKeyPair(2048);
        const certificate = forge.pki.createCertificate();
        const now = new Date();
        const fiveYears = new Date(new Date(now).setFullYear(now.getFullYear() + 5));
        Object.assign(certificate, {
          publicKey: keypair.publicKey,
          serialNumber: "01",
          validity: {
            notBefore: now,
            notAfter: fiveYears,
          },
        });
        certificate.sign(keypair.privateKey, forge.md.sha256.create());
        const key = forge.pki.privateKeyToPem(keypair.privateKey);
        const cert = forge.pki.certificateToPem(certificate);
        const existingConfig = editor.get();
        editor.set({ ...existingConfig, ssl: { key, cert },
          port: parseInt(("" + existingConfig.port).replace(/(80|[0-9])80$/, '443'))
        });
        sslModal.hide();
      }, 100);
    }

    const editor = new JSONEditor(container, options);
    let socket;
    const initialJson = ${JSON.stringify(config)}
    editor.set(initialJson)
    editor.validate();
    editor.aceEditor.commands.addCommand({
      name: 'save',
      bindKey: {win: 'Ctrl-S',  mac: 'Command-S'},
      exec: save,
    });

    window.addEventListener("DOMContentLoaded", function() {
      document.getElementById('jsoneditor').style.height =
        (document.documentElement.clientHeight - 150) + 'px';
      document.getElementById('jsoneditor').style.width =
        parseInt(window.getComputedStyle(
          document.querySelector('.container')).maxWidth) + 'px';
      const sslButton = document.createElement('button');
      sslButton.addEventListener("click", generateSslCertificate);
      sslButton.type="button";
      sslButton.classList.add("btn");
      sslButton.classList.add("btn-primary");
      sslButton.innerHTML="&#x1F512;";
      document.querySelector('.jsoneditor-menu')
              .appendChild(sslButton);
      const saveButton = document.createElement('button');
      saveButton.addEventListener("click", save);
      saveButton.type="button";
      saveButton.classList.add("btn");
      saveButton.classList.add("btn-primary");
      saveButton.innerHTML="&#x1F4BE;";
      document.querySelector('.jsoneditor-menu')
              .appendChild(saveButton);
      socket = new WebSocket("ws${
        config.ssl ? "s" : ""
      }://${proxyHostnameAndPort}/local-traffic-config");
      socket.onmessage = function(event) {
        editor.set(JSON.parse(event.data))
        editor.validate()
      }
    });
    </script>
  </body></html>`);

const errorPage = (
  thrown: Error,
  phase: string,
  requestedURL: URL,
  downstreamURL?: URL,
) => `${header(0x1f4a3, "error", thrown.message)}
<p>An error happened while trying to proxy a remote exchange</p>
<div class="alert alert-warning" role="alert">
  &#x24D8;&nbsp;This is not an error from the downstream service.
</div>
<div class="alert alert-danger" role="alert">
<pre><code>${thrown.stack || `<i>${thrown.name} : ${thrown.message}</i>`}${
  (thrown as ErrorWithErrno).errno
    ? `<br/>(code : ${(thrown as ErrorWithErrno).errno})`
    : ""
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

const replaceBody = async (
  payloadBuffer: Buffer,
  headers: Record<string, number | string | string[]>,
  parameters: {
    mapping: Mapping;
    proxyHostnameAndPort: string;
    proxyHostname: string;
    key: string;
    direction: REPLACEMENT_DIRECTION;
    ssl: boolean;
    port: number;
  },
) =>
  (headers["content-encoding"]?.toString() ?? "")
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
          ? (input: Buffer, callback: (err?: Error, data?: Buffer) => void) => {
              callback(null, input);
            }
          : null;
      if (method === null) {
        throw new Error(`${format} compression not supported by the proxy`);
      }

      const openedBuffer = await buffer;
      return await new Promise<Buffer>((resolve, reject) =>
        method(openedBuffer, (err_1, data_1) => {
          if (err_1) {
            reject(err_1);
          }
          resolve(data_1);
        }),
      );
    }, Promise.resolve(payloadBuffer))
    .then((uncompressedBuffer: Buffer) => {
      const fileTooBig = uncompressedBuffer.length > 1e7;
      const fileHasSpecialChars = () =>
        /[^\x00-\x7F]/.test(uncompressedBuffer.toString());
      const contentTypeCanBeProcessed = [
        "text/html",
        "application/javascript",
        "application/json",
      ].some(allowedContentType =>
        (headers["content-type"] ?? "").toString().includes(allowedContentType),
      );
      const willReplace =
        !fileTooBig && (contentTypeCanBeProcessed || !fileHasSpecialChars());
      return !willReplace
        ? uncompressedBuffer
        : replaceTextUsingMapping(uncompressedBuffer.toString(), {
            direction: parameters.direction,
            proxyHostnameAndPort: parameters.proxyHostnameAndPort,
            ssl: parameters.ssl,
            mapping: parameters.mapping,
          }).replace(
            /\?protocol=wss?%3A&hostname=[^&]+&port=[0-9]+&pathname=/g,
            `?protocol=ws${parameters.ssl ? "s" : ""}%3A&hostname=${
              parameters.proxyHostname
            }&port=${parameters.port}&pathname=${encodeURIComponent(
              parameters.key.replace(/\/+$/, ""),
            )}`,
          );
    })
    .then((updatedBody: Buffer | string) =>
      (headers["content-encoding"]?.toString() ?? "")
        .split(",")
        .reverse()
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
                  callback: (err?: Error, data?: Buffer) => void,
                ) => {
                  callback(null, input);
                }
              : null;
          if (method === null)
            throw new Error(`${format} compression not supported by the proxy`);

          return buffer.then(
            data =>
              new Promise<Buffer>(resolve =>
                method(data, (err, data) => {
                  if (err) throw err;
                  resolve(data);
                }),
              ),
          );
        }, Promise.resolve(Buffer.from(updatedBody))),
    );

const replaceTextUsingMapping = (
  text: string,
  {
    direction,
    proxyHostnameAndPort,
    ssl,
    mapping,
  }: {
    direction: REPLACEMENT_DIRECTION;
    proxyHostnameAndPort: string;
    ssl: boolean;
    mapping: Mapping;
  },
) =>
  Object.entries(mapping)
    .map(([key, value]) => [
      key,
      typeof value === "string" ? value : value.replaceBody,
    ])
    .reduce((inProgress, [path, value]) => {
      return value.startsWith("logs:") ||
        value.startsWith("config:") ||
        (path !== "" && !path.match(/^[-a-zA-Z0-9()@:%_\+.~#?&//=]*$/))
        ? inProgress
        : direction === REPLACEMENT_DIRECTION.INBOUND
        ? inProgress.replace(
            new RegExp(
              value
                .replace(/^(file|logs):\/\//, "")
                .replace(/[*+?^${}()|[\]\\]/g, "")
                .replace(/^https/, "https?") + "/*",
              "ig",
            ),
            `http${ssl ? "s" : ""}://${proxyHostnameAndPort}${path.replace(
              /\/+$/,
              "",
            )}/`,
          )
        : inProgress
            .split(
              `http${ssl ? "s" : ""}://${proxyHostnameAndPort}${path.replace(
                /\/+$/,
                "",
              )}`,
            )
            .join(value);
    }, text)
    .split(`${proxyHostnameAndPort}/:`)
    .join(`${proxyHostnameAndPort}:`);

const send = (
  code: number,
  inboundResponse: Http2ServerResponse | ServerResponse,
  errorBuffer: Buffer,
) => {
  inboundResponse.writeHead(
    code,
    undefined, // statusMessage is discarded in http/2
    {
      "content-type": "text/html",
      "content-length": errorBuffer.length,
    },
  );
  inboundResponse.end(errorBuffer);
};

const determineMapping = (
  inboundRequest: Http2ServerRequest | IncomingMessage,
  parameters: {
    ssl?: SecureServerOptions | boolean;
    port?: number;
    mapping?: Mapping;
  },
): {
  proxyHostname: string;
  proxyHostnameAndPort: string;
  url: URL;
  path: string;
  key: string;
  target: URL;
} => {
  const proxyHostname = (
    inboundRequest.headers[":authority"]?.toString() ??
    inboundRequest.headers.host ??
    "localhost"
  ).replace(/:.*/, "");
  const proxyHostnameAndPort =
    (inboundRequest.headers[":authority"] as string) ||
    `${inboundRequest.headers.host}${
      inboundRequest.headers.host.match(/:[0-9]+$/)
        ? ""
        : parameters.port === 80 && !parameters.ssl
        ? ""
        : parameters.port === 443 && parameters.ssl
        ? ""
        : `:${parameters.port ?? 8080}`
    }`;
  const url = new URL(
    `http${parameters.ssl ? "s" : ""}://${proxyHostnameAndPort}${
      inboundRequest.url
    }`,
  );
  const path = url.href.substring(url.origin.length);

  const mappings: Record<string, URL> = {
    ...Object.assign(
      {},
      ...Object.entries(parameters.mapping).map(([key, value]) => ({
        [key]: new URL(
          unixNorm(typeof value === "string" ? value : value.downstreamUrl),
        ),
      })),
    ),
  };

  const [key, target] =
    Object.entries(mappings).find(([key]) =>
      path.match(RegExp(key.replace(/^\//, "^/"))),
    ) ?? [];
  return { proxyHostname, proxyHostnameAndPort, url, path, key, target };
};

const websocketServe = function (
  state: State,
  request: IncomingMessage,
  upstreamSocket: Duplex,
): Partial<State> {
  if (!state.config.websocket) {
    upstreamSocket.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n`);
    return {};
  }

  const {
    key,
    target: targetWithForcedPrefix,
    path,
  } = determineMapping(request, state.config);

  if (path === "/local-traffic-logs") {
    acknowledgeWebsocket(upstreamSocket, request.headers["sec-websocket-key"]);
    return {
      logsListeners: state.logsListeners.concat({
        stream: upstreamSocket,
        wantsMask: !(request.headers["user-agent"]?.toString() ?? "").includes(
          "Chrome",
        ),
      }),
    };
  }

  if (path === "/local-traffic-config") {
    acknowledgeWebsocket(upstreamSocket, request.headers["sec-websocket-key"]);
    let partialRead = null;
    upstreamSocket.on("data", buffer => {
      const read = readWebsocketBuffer(buffer, partialRead);
      if (partialRead === null && read.body.length < read.payloadLength) {
        partialRead = read;
      } else if (
        read.body.length >= read.payloadLength &&
        read.body.length === 0
      ) {
        return;
      } else if (read.body.length >= read.payloadLength) {
        partialRead = null;
        let newConfig: LocalConfiguration;
        try {
          newConfig = JSON.parse(read.body);
        } catch (e) {
          state.log(
            "config file NOT read, try again later",
            LogLevel.WARNING,
            EMOJIS.ERROR_4,
          );
          return;
        }
        update(state, { pendingConfigSave: newConfig });
      }
    });
    return {
      configListeners: state.configListeners.concat({
        stream: upstreamSocket,
        wantsMask: !(request.headers["user-agent"]?.toString() ?? "").includes(
          "Chrome",
        ),
      }),
    };
  }

  const target = new URL(
    `${targetWithForcedPrefix.protocol}//${targetWithForcedPrefix.host}${
      request.url.endsWith("/_next/webpack-hmr")
        ? request.url
        : request.url
            .replace(new RegExp(`^${key}`, "g"), "")
            .replace(/^\/*/, "/")
    }`,
  );
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

  const downstreamRequest =
    target.protocol === "https:"
      ? httpsRequest(downstreamRequestOptions)
      : httpRequest(downstreamRequestOptions);
  downstreamRequest.end();
  downstreamRequest.on("error", error => {
    state.log(
      `websocket request has errored ${
        (error as ErrorWithErrno).errno
          ? `(${(error as ErrorWithErrno).errno})`
          : ""
      }`,
      LogLevel.WARNING,
      EMOJIS.WEBSOCKET,
    );
  });
  downstreamRequest.on("upgrade", (response, downstreamSocket) => {
    const upgradeResponse = `HTTP/${response.httpVersion} ${
      response.statusCode
    } ${response.statusMessage}\r\n${Object.entries(response.headers)
      .flatMap(([key, value]) =>
        (!Array.isArray(value) ? [value] : value).map(oneValue => [
          key,
          oneValue,
        ]),
      )
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("")}\r\n`;
    upstreamSocket.write(upgradeResponse);
    upstreamSocket.allowHalfOpen = true;
    downstreamSocket.allowHalfOpen = true;
    downstreamSocket.on("data", data => upstreamSocket.write(data));
    upstreamSocket.on("data", data => downstreamSocket.write(data));
    downstreamSocket.on("error", error => {
      state.log(
        `downstream socket has errored ${
          (error as ErrorWithErrno).errno
            ? `(${(error as ErrorWithErrno).errno})`
            : ""
        }`,
        LogLevel.WARNING,
        EMOJIS.WEBSOCKET,
      );
    });
    upstreamSocket.on("error", error => {
      state.log(
        `upstream socket has errored ${
          (error as ErrorWithErrno).errno
            ? `(${(error as ErrorWithErrno).errno})`
            : ""
        }`,
        LogLevel.WARNING,
        EMOJIS.WEBSOCKET,
      );
    });
  });
};

const serve = async function (
  state: State,
  inboundRequest: Http2ServerRequest | IncomingMessage,
  inboundResponse: Http2ServerResponse | ServerResponse,
) {
  // phase: mapping
  if (!inboundRequest.headers.host && !inboundRequest.headers[":authority"]) {
    send(
      400,
      inboundResponse,
      Buffer.from(
        errorPage(
          new Error(`client must supply a 'host' header`),
          "proxy",
          new URL(
            `http${state.config.ssl ? "s" : ""}://unknowndomain${
              inboundRequest.url
            }`,
          ),
        ),
      ),
    );
    return;
  }
  const { proxyHostname, proxyHostnameAndPort, url, path, key, target } =
    determineMapping(inboundRequest, state.config);

  if (!target) {
    send(
      502,
      inboundResponse,
      Buffer.from(
        errorPage(
          new Error(`No mapping found in config file ${filename}`),
          "proxy",
          url,
        ),
      ),
    );
    return;
  }
  const targetHost = target.host.replace(RegExp(/\/+$/), "");
  const targetPrefix = target.href.substring(
    "https://".length + target.host.length,
  );
  const fullPath = `${targetPrefix}${unixNorm(
    path.replace(RegExp(unixNorm(key)), ""),
  )}`.replace(/^\/*/, "/");
  const targetUrl = new URL(`${target.protocol}//${targetHost}${fullPath}`);

  let http2IsSupported = !state.config.dontUseHttp2Downstream;
  const randomId = randomBytes(20).toString("hex");
  state.notifyLogsListeners({
    level: "info",
    protocol: http2IsSupported ? "HTTP/2" : "HTTP1.1",
    method: inboundRequest.method,
    upstreamPath: path,
    downstreamPath: targetUrl.href,
    randomId,
    uniqueHash: "N/A",
  });

  // phase: connection
  const startTime = hrtime.bigint();
  let error: Buffer = null;
  const outboundRequest: ClientHttp2Session =
    target.protocol === "file:"
      ? fileRequest(targetUrl)
      : target.protocol === "logs:"
      ? logsPage(proxyHostnameAndPort, !!state.config.ssl)
      : target.protocol === "config:"
      ? configPage(proxyHostnameAndPort, state.config)
      : !http2IsSupported
      ? null
      : await Promise.race([
          new Promise<ClientHttp2Session>(resolve => {
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
              },
            );
            (result as unknown as Http2Session).on("error", (thrown: Error) => {
              error =
                http2IsSupported &&
                Buffer.from(errorPage(thrown, "connection", url, targetUrl));
            });
          }),
          new Promise<ClientHttp2Session>(resolve =>
            setTimeout(() => {
              http2IsSupported = false;
              resolve(null);
            }, 3000),
          ),
        ]);
  if (!(error instanceof Buffer)) error = null;

  const http1WithRequestBody = (inboundRequest as IncomingMessage)
    ?.readableLength;
  const http2WithRequestBody = (inboundRequest as Http2ServerRequest)?.stream
    ?.readableLength;

  let requestBody: Buffer | null = null;
  const bufferedRequestBody =
    state.config.replaceRequestBodyUrls || state.logsListeners.length;
  const requestBodyExpected = !(
    ((state.config.ssl && http2WithRequestBody === 0) ||
      (!state.config.ssl && http1WithRequestBody === 0)) &&
    (inboundRequest.headers["content-length"] === "0" ||
      inboundRequest.headers["content-length"] === undefined)
  );
  if (bufferedRequestBody) {
    // this is optional,
    // I don't want to buffer request bodies if
    // none of the options are activated
    const requestBodyReadable: Readable =
      (inboundRequest as Http2ServerRequest)?.stream ??
      (inboundRequest as IncomingMessage);

    let requestBodyBuffer: Buffer = Buffer.from([]);
    await Promise.race([
      new Promise(resolve => setTimeout(resolve, 10000)),
      new Promise(resolve => {
        if (!requestBodyExpected) {
          resolve(void 0);
          return;
        }
        requestBodyReadable.on("data", chunk => {
          requestBodyBuffer = Buffer.concat([requestBodyBuffer, chunk]);
        });
        requestBodyReadable.on("end", resolve);
        requestBodyReadable.on("error", resolve);
      }),
    ]);
    if (requestBodyExpected && !requestBodyBuffer.length)
      state.log(
        `body replacement error ${path.slice(-17)}`,
        LogLevel.WARNING,
        EMOJIS.ERROR_4,
      );
    requestBody = !state.config.replaceRequestBodyUrls
      ? requestBodyBuffer
      : await replaceBody(requestBodyBuffer, inboundRequest.headers, {
          proxyHostnameAndPort,
          proxyHostname,
          key,
          mapping: state.config.mapping,
          port: state.config.port,
          ssl: !!state.config.ssl,
          direction: REPLACEMENT_DIRECTION.OUTBOUND,
        });
  }

  const outboundHeaders: OutgoingHttpHeaders = {
    ...[...Object.entries(inboundRequest.headers)]
      // host, connection and keep-alive are forbidden in http/2
      .filter(
        ([key]) =>
          !["host", "connection", "keep-alive"].includes(key.toLowerCase()),
      )
      .reduce((acc: any, [key, value]) => {
        acc[key] =
          (acc[key] || "") +
          (!Array.isArray(value) ? [value] : value)
            .map(oneValue => oneValue.replace(url.hostname, targetHost))
            .join(", ");
        return acc;
      }, {}),
    origin: target.href,
    referer: targetUrl.toString(),
    "content-length":
      requestBody?.length ?? inboundRequest.headers["content-length"] ?? 0,
    ":authority": targetHost,
    ":method": inboundRequest.method,
    ":path": fullPath,
    ":scheme": target.protocol.replace(":", ""),
  };

  const outboundExchange =
    outboundRequest &&
    !error &&
    outboundRequest.request(outboundHeaders, {
      endStream: state.config.ssl
        ? !(http2WithRequestBody ?? true)
        : !http1WithRequestBody,
    });

  outboundExchange?.on("error", (thrown: Error) => {
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
        targetUrl,
      ),
    );
  });

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
              !h.startsWith(":") && h.toLowerCase() !== "transfer-encoding",
          )
          .map(([key, value]) => ({ [key]: value })),
      ),
      host: target.hostname,
    },
  };
  const outboundHttp1Response: IncomingMessage =
    !error &&
    !http2IsSupported &&
    !["file:", "logs:", "config:"].includes(target.protocol) &&
    (await new Promise(resolve => {
      const outboundHttp1Request: ClientRequest =
        target.protocol === "https:"
          ? httpsRequest(http1RequestOptions, resolve)
          : httpRequest(http1RequestOptions, resolve);

      outboundHttp1Request.on("error", thrown => {
        error = Buffer.from(errorPage(thrown, "request", url, targetUrl));
        resolve(null as IncomingMessage);
      });
      if (bufferedRequestBody) {
        outboundHttp1Request.write(requestBody);
        outboundHttp1Request.end();
      }

      if (!bufferedRequestBody) {
        inboundRequest.on("data", chunk => outboundHttp1Request.write(chunk));
        inboundRequest.on("end", () => outboundHttp1Request.end());
      }
    }));
  // intriguingly, error is reset to "false" at this point, even if it was null
  if (error) {
    send(502, inboundResponse, error);
    return;
  } else error = null;

  // phase : request body
  if (http2WithRequestBody && outboundExchange && !bufferedRequestBody) {
    (inboundRequest as Http2ServerRequest).stream.on("data", chunk => {
      outboundExchange.write(chunk);
    });
    (inboundRequest as Http2ServerRequest).stream.on("end", () =>
      outboundExchange.end(),
    );
  } else if (http1WithRequestBody && outboundExchange && !bufferedRequestBody) {
    (inboundRequest as IncomingMessage).on("data", chunk => {
      outboundExchange.write(chunk);
    });
    (inboundRequest as IncomingMessage).on("end", () => outboundExchange.end());
  } else if (outboundExchange && bufferedRequestBody && requestBodyExpected) {
    outboundExchange.write(requestBody);
    outboundExchange.end();
  }

  // phase : response headers
  const { outboundResponseHeaders } = await new Promise<{
    outboundResponseHeaders: IncomingHttpHeaders & IncomingHttpStatusHeader;
  }>(resolve =>
    outboundExchange
      ? outboundExchange.on("response", headers => {
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
        }),
  );

  let redirectUrl = null;
  try {
    if (outboundResponseHeaders["location"])
      redirectUrl = new URL(
        outboundResponseHeaders["location"].startsWith("/")
          ? `${target.href}${outboundResponseHeaders["location"].replace(
              /^\/+/,
              ``,
            )}`
          : outboundResponseHeaders["location"]
              .replace(/^file:\/+/, "file:///")
              .replace(/^(http)(s?):\/+/, "$1$2://"),
      );
  } catch (e) {
    state.log(
      `location replacement error ${(
        outboundResponseHeaders["location"] ?? ""
      ).slice(-13)}`,
      LogLevel.WARNING,
      EMOJIS.ERROR_4,
    );
  }

  const replacedRedirectUrl =
    !state.config.replaceResponseBodyUrls || !redirectUrl
      ? redirectUrl
      : new URL(
          replaceTextUsingMapping(redirectUrl.href, {
            direction: REPLACEMENT_DIRECTION.INBOUND,
            proxyHostnameAndPort,
            ssl: !!state.config.ssl,
            mapping: state.config.mapping,
          }).replace(/^(config:|logs:|file:)\/+/, ""),
        );
  const translatedReplacedRedirectUrl = !redirectUrl
    ? redirectUrl
    : replacedRedirectUrl.origin !== redirectUrl.origin ||
      state.config.dontTranslateLocationHeader
    ? replacedRedirectUrl
    : `${url.origin}${replacedRedirectUrl.href.substring(
        replacedRedirectUrl.origin.length,
      )}`;

  // phase : response body
  const payloadSource = outboundExchange || outboundHttp1Response;
  const payload: Buffer =
    error ??
    (await new Promise(resolve => {
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
          ])),
      );
      (payloadSource as any).on("end", () => {
        resolve(partialBody);
      });
    }).then((payloadBuffer: Buffer) => {
      if (!state.config.replaceResponseBodyUrls) return payloadBuffer;
      if (!payloadBuffer.length) return payloadBuffer;
      if (target.protocol === "config:") return payloadBuffer;

      return replaceBody(payloadBuffer, outboundResponseHeaders, {
        proxyHostnameAndPort,
        proxyHostname,
        key,
        direction: REPLACEMENT_DIRECTION.INBOUND,
        mapping: state.config.mapping,
        port: state.config.port,
        ssl: !!state.config.ssl,
      }).catch((e: Error) => {
        send(
          502,
          inboundResponse,
          Buffer.from(errorPage(e, "stream", url, targetUrl)),
        );
        return Buffer.from("");
      });
    }));

  // phase : inbound response
  const responseHeaders = {
    ...Object.entries({
      ...outboundResponseHeaders,
      ...(state.config.replaceResponseBodyUrls
        ? { ["content-length"]: `${payload.byteLength}` }
        : {}),
      ...(state.config.disableWebSecurity
        ? {
            ["content-security-policy"]: "report only",
            ["access-control-allow-headers"]: "*",
            ["access-control-allow-method"]: "*",
            ["access-control-allow-origin"]: "*",
          }
        : {}),
    })
      .filter(
        ([h]) =>
          !h.startsWith(":") &&
          h.toLowerCase() !== "transfer-encoding" &&
          h.toLowerCase() !== "connection" &&
          h.toLowerCase() !== "keep-alive",
      )
      .reduce((acc: any, [key, value]: [string, string | string[]]) => {
        const allSubdomains = targetHost
          .split("")
          .map(
            (_, i) =>
              targetHost.substring(i).startsWith(".") &&
              targetHost.substring(i),
          )
          .filter(subdomain => subdomain) as string[];
        const transformedValue = [targetHost].concat(allSubdomains).reduce(
          (acc1, subDomain) =>
            (!Array.isArray(acc1) ? [acc1] : (acc1 as string[])).map(
              oneElement => {
                return typeof oneElement === "string"
                  ? oneElement.replace(
                      `Domain=${subDomain}`,
                      `Domain=${url.hostname}`,
                    )
                  : oneElement;
              },
            ),
          value,
        );

        acc[key] = (acc[key] || []).concat(transformedValue);
        return acc;
      }, {}),
    ...(translatedReplacedRedirectUrl
      ? { location: [translatedReplacedRedirectUrl] }
      : {}),
  };
  try {
    Object.entries(responseHeaders).forEach(
      ([headerName, headerValue]) =>
        headerValue &&
        inboundResponse.setHeader(headerName, headerValue as string),
    );
  } catch (e) {
    // ERR_HTTP2_HEADERS_SENT
  }
  const statusCode =
    outboundResponseHeaders[":status"] ||
    outboundHttp1Response.statusCode ||
    200;
  inboundResponse.writeHead(
    statusCode,
    state.config.ssl
      ? undefined // statusMessage is discarded in http/2
      : outboundHttp1Response.statusMessage || "Status read from http/2",
    responseHeaders,
  );
  if (payload) inboundResponse.end(payload);
  else inboundResponse.end();
  const endTime = hrtime.bigint();

  state.notifyLogsListeners({
    randomId,
    statusCode,
    protocol: http2IsSupported ? "HTTP/2" : "HTTP1.1",
    duration: Math.floor(Number(endTime - startTime) / 1000000),
    uniqueHash: Buffer.from(
      JSON.stringify({
        method: inboundRequest.method,
        url: inboundRequest.url,
        headers: Object.assign(
          {},
          ...Object.entries(inboundRequest.headers)
            .filter(([headerName]) => !headerName.startsWith(":"))
            .map(([key, value]) => ({ [key]: value })),
        ),
        body: requestBody?.toJSON(),
      }),
    ).toString("base64"),
  });
};

const errorListener = (state: State, err: Error) => {
  if ((err as ErrorWithErrno).code === "EACCES")
    state.log(`permission denied for this port`, LogLevel.ERROR, EMOJIS.NO);
  if ((err as ErrorWithErrno).code === "EADDRINUSE")
    state.log(
      `port is already used. NOT started`,
      LogLevel.ERROR,
      EMOJIS.ERROR_6,
    );
};

const start = (config: LocalConfiguration): Promise<State> =>
  update({ config: { ...defaultConfig, ...config } }, {});

const update = async (
  currentState: Partial<State>,
  newState: Partial<State & { pendingConfigSave: LocalConfiguration }>,
): Promise<State> => {
  if (Object.keys(newState ?? {}).length === 0 && currentState.server) return;
  if (newState.pendingConfigSave) {
    writeFile(
      filename,
      JSON.stringify(newState.pendingConfigSave, null, 2),
      fileWriteErr => {
        if (fileWriteErr)
          currentState.log?.(
            "config file NOT saved",
            LogLevel.ERROR,
            EMOJIS.ERROR_4,
          );
        else
          currentState.log?.(
            "config file saved... will reload",
            LogLevel.INFO,
            EMOJIS.COLORED,
          );
      },
    );
    return;
  }

  if (newState.configListeners === null) {
    await Promise.all(
      currentState.configListeners.map(
        listener => new Promise(resolve => listener.stream.end(resolve)),
      ),
    );
  }
  if (newState.logsListeners === null) {
    await Promise.all(
      currentState.logsListeners.map(
        listener => new Promise(resolve => listener.stream.end(resolve)),
      ),
    );
  }

  if (newState.server === null) {
    const stopped = await Promise.race([
      new Promise(resolve => currentState.server.close(resolve)).then(
        () => true,
      ),
      new Promise(resolve => setTimeout(resolve, 5000)).then(() => false),
    ]);
    if (!stopped) {
      currentState.log(
        `error during restart (websockets ?)`,
        LogLevel.WARNING,
        EMOJIS.RESTART,
      );
    }
  }

  (currentState.configListeners ?? [])
    .concat(currentState.logsListeners ?? [])
    .filter(l => l.stream.errored || l.stream.closed)
    .forEach(l => l.stream.destroy());

  const config = newState.config ?? currentState.config;
  const configListeners = (
    newState.configListeners === null
      ? []
      : newState.configListeners ?? currentState.configListeners ?? []
  ).filter(l => !l.stream.errored && !l.stream.closed);
  const logsListeners = (
    newState.logsListeners === null
      ? []
      : newState.logsListeners ?? currentState.logsListeners ?? []
  ).filter(l => !l.stream.errored && !l.stream.closed);

  const state: State = currentState as State;
  Object.assign(state, {
    config,
    logsListeners,
    configListeners,
    configFileWatcher:
      state.configFileWatcher ??
      watchFile(filename, async () => update(state, await onWatch(state))),
    log: log.bind(state, state),
    notifyConfigListeners: notifyConfigListeners.bind(state),
    notifyLogsListeners: notifyLogsListeners.bind(state),
    quickStatus: quickStatus.bind(state),
    server:
      newState.server === null || !state.server
        ? (
            (config.ssl
              ? createSecureServer.bind(null, {
                  ...config.ssl,
                  allowHTTP1: true,
                })
              : createServer)(
              (
                request: Http2ServerRequest | IncomingMessage,
                response: Http2ServerResponse | ServerResponse,
              ) => serve(state, request, response),
            ) as Server
          )
            .addListener("error", (error: Error) => errorListener(state, error))
            .addListener("listening", () => state.quickStatus())
            .on("upgrade", (request, socket) =>
              update(state, websocketServe(state, request, socket)),
            )
            .listen(config.port)
        : state.server,
  });
  return state;
};

const mainProgram =
  argv.filter(
    arg =>
      !["ts-node", "node", "npx", "npm", "exec"].some(
        pattern =>
          arg.includes(pattern) &&
          !arg.match(/npm-cache/) &&
          !arg.match(/_npx/),
      ),
  )[0] ?? "";

const runAsMainProgram =
  mainProgram.toLowerCase().replace(/[-_]/g, "").includes("localtraffic") &&
  !mainProgram.match(/(.|-)?(test|spec)\.m?[jt]sx?$/);

if (runAsMainProgram) {
  load().then(start);
}

export {
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
};
