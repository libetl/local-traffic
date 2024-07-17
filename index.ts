import {
  type ClientHttp2Session,
  type Http2Session,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type OutgoingHttpHeaders,
  type SecureClientSessionOptions,
  type SecureServerOptions,
  type ClientHttp2Stream,
  type IncomingHttpStatusHeader,
  createSecureServer,
  connect,
} from "http2";
import {
  type IncomingMessage,
  type ClientRequest,
  type IncomingHttpHeaders,
  type ServerResponse,
  type Server,
  request as httpRequest,
  createServer,
} from "http";
import { type RequestOptions, request as httpsRequest } from "https";
import { URL } from "url";
import {
  type StatWatcher,
  type Stats,
  watchFile,
  readdir,
  readFile,
  writeFile,
  lstat,
} from "fs";
import {
  gzip,
  gunzip,
  inflate,
  deflate,
  brotliCompress,
  brotliDecompress,
} from "zlib";
import { resolve, normalize, sep } from "path";
import { createHash, randomBytes } from "crypto";
import { argv, cwd, exit, hrtime, stdout } from "process";
import { homedir, tmpdir } from "os";
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
  MOCKS = "🌐",
  STRICT_MOCKS = "🕸️",
  AUTO_RECORD = "📼",
  REWRITE = "✒️ ",
  LOGS = "📝",
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

type WebsocketLogsListener = WebsocketListener & {
  wantsResponseMessage?: boolean;
};

interface PartialRead {
  payloadLength: number;
  mask: number[];
  body: string;
}

interface LocalConfiguration {
  mapping?: Mapping;
  ssl?: SecureServerOptions;
  port?: number;
  unwantedHeaderNamesInMocks?: string[];
  replaceRequestBodyUrls?: boolean;
  replaceResponseBodyUrls?: boolean;
  dontUseHttp2Downstream?: boolean;
  dontTranslateLocationHeader?: boolean;
  logAccessInTerminal?: boolean | "with-mapping";
  simpleLogs?: boolean;
  websocket?: boolean;
  disableWebSecurity?: boolean;
  connectTimeout?: number;
  socketTimeout?: number;
}

type Mapping = {
  [subPath: string]: string | { replaceBody: string; downstreamUrl: string };
};

type Mocks = Map<string, string>;
type MockResponseObject = {
  body: string;
  headers: IncomingHttpHeaders & IncomingHttpStatusHeader;
  status: number;
};

type RequestStruct = {
  method: string;
  url: string;
  headers: any;
  body: string;
};

enum ServerMode {
  PROXY = "proxy",
  MOCK = "mock",
}

type LogElement = { color: number; text: string; length?: number };

interface MockConfig {
  mocks: Mocks;
  strict: boolean;
  autoRecord: boolean;
}

interface State {
  config: LocalConfiguration;
  server: Server | null;
  logsListeners: WebsocketLogsListener[];
  configListeners: WebsocketLogsListener[];
  configFileWatcher: StatWatcher | null;
  mode: ServerMode;
  mockConfig: MockConfig;
  log: (logs: LogElement[][]) => Promise<void>;
  notifyConfigListeners: (data: Record<string, unknown>) => void;
  notifyLogsListeners: (data: Record<string, unknown>) => void;
  buildQuickStatus: () => LogElement[];
  quickStatus: (otherLogElements?: LogElement[][]) => Promise<void>;
}

const mainProgram =
  argv
    .map(arg => arg.trim())
    .filter(
      arg =>
        arg &&
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
const filename = !runAsMainProgram
  ? `${tmpdir()}${sep}local-traffic-temporary-config-${randomBytes(6).toString("hex")}.json`
  : resolve(
      cwd(),
      argv.slice(-1)[0].endsWith(".json")
        ? argv.slice(-1)[0]
        : resolve(homedir(), ".local-traffic.json"),
    );
const crashTest = argv.some(arg => arg === "--crash-test");
const screenWidth = 64;
const instantTime = (): bigint => {
  return (
    hrtime.bigint?.() ??
    (() => {
      const time = hrtime();
      return (time[0] * 1000 + time[1] / 1000000) as unknown as bigint;
    })()
  );
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
const levelToString = (level?: number) =>
  level === LogLevel.ERROR
    ? "error"
    : level === LogLevel.WARNING
      ? "warning"
      : "info";
const log = async function (
  state: Partial<State> | null,
  logs: LogElement[][],
) {
  const simpleTexts = logs.map(logLine =>
    logLine
      .map(e =>
        e.text
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
          .replace(new RegExp(EMOJIS.MOCKS, "g"), "mocks")
          .replace(new RegExp(EMOJIS.STRICT_MOCKS, "g"), "mocks (strict)")
          .replace(new RegExp(EMOJIS.AUTO_RECORD, "g"), "auto record")
          .replace(new RegExp(EMOJIS.LOGS, "g"), "logs")
          .replace(new RegExp(EMOJIS.RESTART, "g"), "restart")
          .replace(new RegExp(EMOJIS.COLORED, "g"), "colored")
          .replace(/\|+/g, "|"),
      )
      .join(" | "),
  );
  if (state?.config?.simpleLogs)
    for (let simpleText of simpleTexts)
      stdout.write(
        `${getCurrentTime(state?.config?.simpleLogs)} | ${simpleText}\n`,
      );
  else {
    for (let element of logs) {
      const renderedColors = element.filter(e => e?.text?.length);
      const logTexts = renderedColors.map(
        e => `\u001b[48;5;${e.color}m${e.text}`,
      );
      stdout.write(
        `${getCurrentTime(state?.config?.simpleLogs)}${renderedColors
          .map(
            e =>
              `\u001b[48;5;${e.color}m${"".padEnd((e.length ?? screenWidth) + 1)}`,
          )
          .join("▐")}\u001b[0m\n`,
      );

      await new Promise(resolve =>
        stdout.moveCursor(-1000, -1, () => resolve(void 0)),
      );
      let offset = 9;
      for (let i = 0; i < logTexts.length; i++) {
        await new Promise(resolve =>
          stdout.moveCursor(-1000, 0, () =>
            stdout.moveCursor(offset, 0, () => resolve(void 0)),
          ),
        );
        stdout.write(logTexts[i]);
        offset += (element[i].length ?? screenWidth) + 2;
      }
      stdout.write("\u001b[0m\n");
      for (let simpleText of simpleTexts)
        state?.notifyLogsListeners?.({
          event: simpleText,
          level: levelToString(element?.[0]?.color ?? LogLevel.INFO),
        });
    }
  }
};

const createWebsocketBufferFrom = (
  text: string,
  wantsMask: boolean,
): Buffer => {
  const mask = Array(4)
    .fill(0)
    .map(() => (wantsMask ? Math.floor(Math.random() * (2 << 7)) : 0));
  const maskedTextBits = text
    .split("")
    .map((c, i) => c.charCodeAt(0) ^ mask[i & 3]);
  const length = text.length;
  const magicHeader = (1 << 7) + 1;
  const maskHeader = wantsMask ? 1 << 7 : 0;
  const header =
    text.length < (2 << 6) - 2
      ? Buffer.from(Uint8Array.from([magicHeader, maskHeader + length]).buffer)
      : text.length < (2 << 15) - 1
        ? Buffer.concat([
            Buffer.from(
              Uint8Array.from([magicHeader, ((1 << 7) - 2) | maskHeader])
                .buffer,
            ),
            Buffer.from(Uint8Array.from([length >> 8]).buffer),
            Buffer.from(Uint8Array.from([length & ((1 << 8) - 1)]).buffer),
          ])
        : Buffer.concat([
            Buffer.from(
              Uint8Array.from([magicHeader, ((1 << 7) - 1) | maskHeader])
                .buffer,
            ),
            Buffer.concat(
              (
                Number(length)
                  .toString(16)
                  .padStart(16, "0")
                  .match(/.{2}/g) ?? ["0"]
              )
                .map(e => parseInt(e, 16))
                .map(number => Buffer.from(Uint8Array.from([number]).buffer)),
            ),
          ]);
  const maskingKey = Buffer.from(Int8Array.from(mask).buffer);
  const payload = Buffer.from(Int8Array.from(maskedTextBits).buffer);
  return Buffer.concat(
    wantsMask ? [header, maskingKey, payload] : [header, payload],
  );
};

const readWebsocketBuffer = (
  buffer: Buffer,
  partialRead: PartialRead | null,
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
  return notifyListeners(data, this.configListeners);
};
const notifyLogsListeners = function (
  this: State,
  data: Record<string, unknown>,
) {
  const { response, ...dataWithoutResponseBody } = data;
  return Promise.all([
    notifyListeners(
      data,
      this.logsListeners.filter(l => l.wantsResponseMessage),
    ),
    notifyListeners(
      dataWithoutResponseBody,
      this.logsListeners.filter(l => !l.wantsResponseMessage),
    ),
  ]);
};
const notifyListeners = (
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

const buildQuickStatus = function (this: State) {
  return [
    {
      color: 52,
      text: `${EMOJIS.PORT} ${(this.config.port ?? "").toString()}`,
      length: 11,
    },
    {
      color: 53,
      text: `${EMOJIS.OUTBOUND} ${
        this.config.dontUseHttp2Downstream ? "H1.1" : "H/2 "
      }${this.config.replaceRequestBodyUrls ? EMOJIS.REWRITE : "  "}`,
      length: 11,
    },
    {
      color: 54,
      text: `${EMOJIS.INBOUND} ${this.config.ssl ? "H/2 " : "H1.1"}${
        this.config.replaceResponseBodyUrls ? EMOJIS.REWRITE : "  "
      }`,
      length: 11,
    },
    {
      color: 55,
      text: `${
        this.mode === ServerMode.PROXY && this.mockConfig.autoRecord
          ? `${EMOJIS.AUTO_RECORD}${this.mockConfig.mocks.size
              .toString()
              .padStart(3)}`
          : this.mode === ServerMode.PROXY
            ? `${EMOJIS.RULES}${Object.keys(this.config.mapping ?? {})
                .length.toString()
                .padStart(3)}`
            : `${
                this.mockConfig.strict ? EMOJIS.STRICT_MOCKS : EMOJIS.MOCKS
              }${this.mockConfig.mocks.size.toString().padStart(3)}`
      }`,
      length: 7,
    },
    {
      color: 56,
      text: `${this.config.websocket ? EMOJIS.WEBSOCKET : EMOJIS.NO}`,
      length: 4,
    },
    {
      color: 57,
      text: `${!this.config.simpleLogs ? EMOJIS.COLORED : EMOJIS.NO}`,
      length: 4,
    },
    {
      color: 93,
      text: `${this.config.disableWebSecurity ? EMOJIS.NO : EMOJIS.SHIELD}`,
      length: 4,
    },
  ];
};

const quickStatus = async function (
  this: State,
  otherLogElements?: LogElement[][],
) {
  this.log([...(otherLogElements ?? []), this.buildQuickStatus()]).then(() =>
    this.notifyConfigListeners(this.config as Record<string, unknown>),
  );
};

const errorPage = (
  thrown: Error,
  serverMode: ServerMode,
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
      <td>server mode</td>
      <td>${serverMode}</td>
    </tr>
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

const logsView = (
  proxyHostnameAndPort: string,
  config: LocalConfiguration,
  options: { captureResponseBody: boolean },
) =>
  `<table id="table-access" class="table table-striped" style="display: block; width: 100%; overflow-y: auto">
  <thead>
    <tr>
      <th scope="col"${
        options.captureResponseBody === true ? ' style="min-width: 120px"' : ""
      }>...</th>
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
<div class="alert alert-warning" role="alert"
style="display:none;left:20%;right:20%;top:20%;position:absolute;z-index:1;"
id="websocket-disconnected">
<p>&#x24D8;&nbsp;Websocket connection is not available at this moment.</p>
<ul><li>Is local-traffic running ?</li><li>Are websockets enabled ?</li>
<li>Are you running a network protection tool that disallows websockets ?</li></ul>
</div>
<script type="text/javascript">
    let socket = null;
    function start() {
      document.getElementById('table-access').style.height =
        (document.documentElement.clientHeight - 150) + 'px';
      if (socket !== null) return;
      socket = new WebSocket("ws${
        config.ssl ? "s" : ""
      }://${proxyHostnameAndPort}/local-traffic-logs${
        options.captureResponseBody ? "?wantsResponseMessage=true" : ""
      }");
      socket.onopen = function(event) {
        document.getElementById('websocket-disconnected').style.display = 'none';
        document.getElementById('table-access').style.filter = null;
        (document.getElementsByTagName('nav')[0]||{style:{}}).style.filter = null;
        (document.getElementsByTagName('form')[0]||{style:{}}).style.filter = null;
      }
      socket.onmessage = function(event) {
        let data = event.data
        let uniqueHash;
        try {
          const { uniqueHash: uniqueHash1, ...data1 } = JSON.parse(event.data);
          data = data1;
          uniqueHash = uniqueHash1;
        } catch(e) { }
        if (document.getElementById('mock-mode')?.checked) return;
        if (${options.captureResponseBody === true} && 
          data?.downstreamPath?.startsWith('recorder://') &&
          !data?.upstreamPath?.endsWith('?forceLogInRecorderPage=true'))
          return;
        const time = new Date().toISOString().split('T')[1].replace('Z', '');
        const actions = getActionsHtmlText(uniqueHash, data.response);
        if(data.statusCode && uniqueHash) {
          const color = getColorFromStatusCode(data.statusCode);
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
            replayColumn.innerHTML = actions;
          }
        } else if (uniqueHash) {
          addNewRequest(data.randomId, actions, time, data.level, data.protocol, data.method, 
            '<span class="badge bg-secondary">...</span>', '&#x23F1;',
            data.upstreamPath, data.downstreamPath);
        } else if(data.event) {
          document.getElementById("proxy")
            .insertAdjacentHTML('afterbegin', '<tr><td scope="col">' + time + '</td>' +
                '<td scope="col">' + (data.level || 'info')+ '</td>' + 
                '<td scope="col">' + data.event + '</td></tr>');
        }
        cleanup();
      };
      socket.onerror = function(error) {
        socket = null;
        setTimeout(start, 1000);
        if (error.target.readyState === 3) {
          document.getElementById('websocket-disconnected').style.display = 'block';
          document.getElementById('table-access').style.filter = 'blur(8px)';
          (document.getElementsByTagName('nav')[0]||{style:{}}).style.filter = 'blur(8px)';
          (document.getElementsByTagName('form')[0]||{style:{}}).style.filter = 'blur(8px)';
          return;
        }
        throw new Error(\`[error] \${JSON.stringify(error)}\`);
      };
      socket.onclose = function(error) {
        socket = null;
        setTimeout(start, 1000);
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
    function remove(event) {
      event.target.closest('tr').remove();
      if (window.updateState) window.updateState();
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
        body: !body || !body.length ? undefined : atob(body)
      });
    }
    function getActionsHtmlText(uniqueHash, response) {
      const edit = ${options.captureResponseBody === true} && uniqueHash
      ? '<button data-response="' + (response ?? "") +
      '" data-uniquehash="' + uniqueHash + 
      '" data-bs-toggle="modal" data-bs-target="#edit-request" type="button" ' +
        'class="btn btn-primary">&#x1F4DD;</button>'
      : ''
      const remove = ${options.captureResponseBody === true} && uniqueHash
      ? '<button onclick="javascript:remove(event)" type="button" ' +
        'class="btn btn-primary">&#x274C;</button>'
      : ''
      const replay = ${
        options.captureResponseBody === false
      } && uniqueHash ? '<button data-response="' + 
        btoa(JSON.stringify(response ?? {})) +
        '" data-uniquehash="' + uniqueHash + '" onclick="javascript:replay(event)" ' +
        'type="button" class="btn btn-primary">&#x1F501;</button>' : '';
      return edit + replay + remove
    }
    function addNewRequest(
      randomId, actions, time, level, protocol, method, 
      statusCode, duration, upstreamPath, downstreamPath
    ) {
      document.getElementById("access")
      .insertAdjacentHTML('afterbegin', '<tr id="event-' + randomId + '">' +
      '<td scope="col" class="replay">' + actions + '</td>' +
      '<td scope="col">' + time + '</td>' +
      '<td scope="col">' + (level || 'info')+ '</td>' + 
      '<td scope="col" class="protocol">' + protocol + '</td>' + 
      '<td scope="col" class="method">' + method + '</td>' + 
      '<td scope="col" class="statusCode">' + statusCode + '</td>' +
      '<td scope="col" class="duration text-end">' + duration + '</td>' +
      '<td scope="col" class="upstream-path">' + upstreamPath + '</td>' + 
      '<td scope="col">' + 
      ((downstreamPath??'').startsWith('data:') ? 'data:...' : downstreamPath) + 
      '</td>' + 
      '</tr>');
    }
    function getColorFromStatusCode(statusCode) {
      return Math.floor(statusCode / 100) === 1 ? "info" :
        Math.floor(statusCode / 100) === 2 ? "success" :
        Math.floor(statusCode / 100) === 3 ? "dark" :
        Math.floor(statusCode / 100) === 4 ? "warning" :
        Math.floor(statusCode / 100) === 5 ? "danger" :
        "secondary";
    }
    window.addEventListener("DOMContentLoaded", start);
</script>`;

const logsPage = (proxyHostnameAndPort: string, state: State) =>
  staticResponse(`${header(0x1f4fa, "logs", "")}
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
${logsView(proxyHostnameAndPort, state.config, { captureResponseBody: false })}
</body></html>`);

const configPage = (
  proxyHostnameAndPort: string,
  state: State,
  request: Http2ServerRequest | IncomingMessage,
  mappingAttributes: {
    requestBody: Buffer;
    target: URL;
    url: URL;
  },
) => {
  if (["POST", "PUT"].includes(request.method)) {
    let newConfig: LocalConfiguration;
    try {
      newConfig = JSON.parse(
        mappingAttributes?.requestBody?.toString("ascii") ?? "{}",
      );
    } catch (e) {
      setTimeout(
        () =>
          state.log([
            [
              {
                text: `${EMOJIS.ERROR_4} config update could not be read`,
                color: LogLevel.WARNING,
              },
            ],
          ]),
        1,
      );
      return staticResponse(
        `{"error":"config update could not be read","stack":"${e.stack
          ?.replace?.(/"/g, '\\"')
          .replace(/[\s]+/g, " ")}"}`,
        {
          headers: { contentType: "application/json; charset=utf-8" },
        },
      );
    }
    return staticResponse(
      new Promise(resolve => {
        state.configFileWatcher?.once?.("change", () => {
          setTimeout(() => {
            // state.config has mutated (maybe) in function 'update'
            resolve(Buffer.from(JSON.stringify(state.config)));
          }, 10);
        });
        update(state, { pendingConfigSave: newConfig });
      }),
      {
        headers: { contentType: "application/json; charset=utf-8" },
      },
    );
  }
  if (
    ["GET", "HEAD"].includes(request.method) &&
    request.headers?.["accept"]?.includes("application/json")
  ) {
    return staticResponse(JSON.stringify(state.config), {
      headers: { contentType: "application/json; charset=utf-8" },
    });
  }
  return staticResponse(`${header(0x1f39b, "config", "")}
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
            <p>Wait a few seconds or move your mouse to increase the entropy.</p>
          </div>
        </div>
      </div>
    </div>
    <div id="jsoneditor" style="width: 400px; height: 400px;"></div>
    <script>
    let socket = null;
    const container = document.getElementById("jsoneditor")
    const options = {mode: "code", allowSchemaSuggestions: true, schema: {
      type: "object",
      properties: {
        ${Object.entries({ ...defaultConfig, ssl: { cert: "", key: "" } })
          .map(
            ([property, exampleValue]) =>
              `${property}:${
                property === "unwantedHeaderNamesInMocks"
                  ? '{type:"array","items":{"type":"string"}}'
                  : property === "logAccessInTerminal"
                    ? '{"oneOf":[{type:"boolean"},{enum:["with-mapping"]}]}'
                    : typeof exampleValue === "number"
                      ? '{type:"integer"}'
                      : typeof exampleValue === "string"
                        ? '{type:"string"}'
                        : typeof exampleValue === "boolean"
                          ? '{type:"boolean"}'
                          : '{type:"object"}'
              }`,
          )
          .join(",\n          ")}
      },
      required: [],
      additionalProperties: false
    }}

    function save() {
      if (!socket || socket.readyState !== 1) {
        fetch(window.location.href, {
          method: 'POST',
          headers: {
            'Accept': 'application/json'
          },
          body: JSON.stringify(editor.get())
        })
      } else socket.send(JSON.stringify(editor.get()));
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
    const initialJson = ${JSON.stringify(state.config)}
    editor.set(initialJson)
    editor.validate();
    editor.aceEditor.commands.addCommand({
      name: 'save',
      bindKey: {win: 'Ctrl-S',  mac: 'Command-S'},
      exec: save,
    });
    function startSocket() {
      if (socket != null) return;
      socket = new WebSocket("ws${
        state.config.ssl ? "s" : ""
      }://${proxyHostnameAndPort}/local-traffic-config");
      socket.onmessage = function(event) {
        editor.set(JSON.parse(event.data))
        editor.validate()
      }
      socket.onerror = function(error) {
        socket = null;
        setTimeout(startSocket, 1000);
        if (error.target.readyState === 3) {
          return;
        }
        throw new Error(\`[error] \${JSON.stringify(error)}\`);
      };
      socket.onclose = function(error) {
        socket = null;
        setTimeout(startSocket, 1000);
      };
    }
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
      startSocket();
    });
    </script>
  </body></html>`);
};

const recorderHandler = (
  state: State,
  buffer: Buffer,
  requestMethodIsDelete: boolean,
) => {
  let mocksUpdate: Partial<
    Omit<MockConfig, "mocks"> & {
      mocks: { uniqueHash: string; response: string }[];
      mode: ServerMode;
    }
  > = {};
  try {
    mocksUpdate = JSON.parse(buffer.toString("ascii"));
  } catch (e) {}
  if (
    typeof mocksUpdate !== "object" ||
    Object.keys(mocksUpdate).filter(
      key => !["strict", "mode", "mocks", "autoRecord"].includes(key),
    ).length ||
    (!Array.isArray(mocksUpdate.mocks) && mocksUpdate.mocks !== undefined)
  ) {
    state.log([
      [
        {
          text: `${EMOJIS.MOCKS} invalid mocks update received`,
          color: LogLevel.WARNING,
        },
      ],
    ]);
    return;
  }
  const {
    mocks: mocksArray,
    mode: newMode,
    strict: strictMode,
    autoRecord: autoRecordUpdate,
  } = mocksUpdate;
  const mocks: Mocks | null = !mocksArray
    ? null
    : new Map<string, string>(
        mocksArray.map(({ response, uniqueHash }) => [
          cleanEntropy(state.config, uniqueHash),
          response,
        ]),
      );
  const modeHasBeenChangedToProxy =
    newMode !== state.mode && newMode === ServerMode.PROXY;
  const autoRecord =
    modeHasBeenChangedToProxy && autoRecordUpdate !== true
      ? false
      : autoRecordUpdate ?? state.mockConfig.autoRecord;
  const autoRecordModeHasBeenChanged =
    autoRecord !== undefined && autoRecord != state.mockConfig.autoRecord;
  const mocksConfigHasBeenChanged =
    (newMode !== state.mode && newMode === ServerMode.MOCK) ||
    (mocks !== null && state.mockConfig.mocks.size !== mocks.size);
  const strict = strictMode ?? state.mockConfig.strict;
  const mode = newMode ?? state.mode;
  const strictModeHasBeenChanged = !!strict !== !!state.mockConfig.strict;
  const mocksHaveBeenPurged = requestMethodIsDelete;
  if (mocksHaveBeenPurged)
    update(state, {
      mode,
      mockConfig: {
        autoRecord: false,
        strict,
        mocks: new Map<string, string>(),
      },
    });
  else
    update(state, {
      mode,
      mockConfig: {
        strict,
        autoRecord,
        mocks: mocks ?? state.mockConfig.mocks,
      },
    });

  setTimeout(
    () =>
      state.log(
        [
          modeHasBeenChangedToProxy
            ? [
                {
                  text: `${EMOJIS.RULES} ${Object.keys(
                    state.config.mapping ?? {},
                  )
                    .length.toString()
                    .padStart(5)} loaded mapping rules`,
                  color: LogLevel.INFO,
                },
              ]
            : null,
          mocksConfigHasBeenChanged
            ? [
                {
                  text: `${strict ? EMOJIS.STRICT_MOCKS : EMOJIS.MOCKS} ${(
                    mocks ?? state.mockConfig.mocks
                  ).size
                    .toString()
                    .padStart(5)} loaded mocks`,
                  color: LogLevel.INFO,
                },
              ]
            : null,
          strictModeHasBeenChanged
            ? [
                {
                  text: `${
                    strict ? EMOJIS.STRICT_MOCKS : EMOJIS.MOCKS
                  } mocks strict mode : ${strict ?? state.mockConfig.strict}`,
                  color: LogLevel.INFO,
                },
              ]
            : null,
          autoRecordModeHasBeenChanged
            ? [
                {
                  text: `${
                    mode === ServerMode.PROXY
                      ? EMOJIS.AUTO_RECORD
                      : strict
                        ? EMOJIS.STRICT_MOCKS
                        : EMOJIS.MOCKS
                  } mocks auto-record : ${autoRecord}`,
                  color: LogLevel.INFO,
                },
              ]
            : null,
          modeHasBeenChangedToProxy ||
          mocksConfigHasBeenChanged ||
          autoRecordModeHasBeenChanged ||
          strictModeHasBeenChanged ||
          mocksHaveBeenPurged
            ? state.buildQuickStatus()
            : null,
        ].filter(e => e),
      ),
    1,
  );
};

const dataPage = (
  proxyHostnameAndPort: string,
  state: State,
  _request: Http2ServerRequest | IncomingMessage,
  mappingAttributes?: {
    target: URL;
    key: string;
    proxyHostname: string;
  },
): ClientHttp2Session => {
  const [, contentType, encoding, value] =
    /^data:([^;,]*)?;?([^,]*)?,(.*)$/.exec(
      mappingAttributes?.target.href ?? "data:,",
    ) ?? ["", "", "", ""];
  const decodedValue = decodeURIComponent(value);
  const rawText =
    encoding === "base64"
      ? Buffer.from(decodedValue, "base64url").toString("binary")
      : decodedValue;
  return staticResponse(
    !state.config.replaceResponseBodyUrls
      ? rawText
      : replaceBody(
          Buffer.from(rawText),
          {
            "content-type": contentType ? contentType : "text/plain",
          },
          {
            mapping: state.config.mapping ?? {},
            proxyHostnameAndPort,
            proxyHostname: mappingAttributes?.proxyHostname ?? "localhost",
            key: mappingAttributes?.key ?? "",
            direction: REPLACEMENT_DIRECTION.INBOUND,
            ssl: !!state.config.ssl,
            port: state.config.port ?? defaultConfig?.port,
          },
        ),
    {
      headers: { "content-type": contentType },
    },
  );
};

const recorderPage = (
  proxyHostnameAndPort: string,
  state: State,
  request: Http2ServerRequest | IncomingMessage,
) => {
  if (request.url?.endsWith("?forceLogInRecorderPage=true")) {
    return staticResponse(`{"ping":"pong"}`, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (
    request.method === "GET" &&
    request.headers?.["accept"]?.includes("application/json")
  ) {
    return staticResponse(
      JSON.stringify({
        ...state.mockConfig,
        mode: state.mode,
        mocks: [...state.mockConfig.mocks.entries()].map(
          ([uniqueHash, response]) => ({ uniqueHash, response }),
        ),
      }),
      {
        headers: { contentType: "application/json; charset=utf-8" },
      },
    );
  }
  if (["PUT", "POST", "DELETE"].includes(request.method ?? "")) {
    return staticResponse(`{"status": "acknowledged"}`, {
      headers: { contentType: "application/json; charset=utf-8" },
      onOutboundWrite: buffer =>
        recorderHandler(state, buffer, request.method === "DELETE"),
    });
  }
  return staticResponse(`${header(0x23fa, "recorder", "")}
<link href="${cdn}jsoneditor/dist/jsoneditor.min.css" rel="stylesheet" type="text/css">
<script src="${cdn}jsoneditor/dist/jsoneditor.min.js"></script>
<script src="${cdn}pako/dist/pako.min.js"></script>
<form>
  <div id="commands"${
    state.mockConfig.autoRecord ? ' style="filter:blur(8px)"' : ""
  }>
    <span>Mode : </span>
    <div class="btn-group" role="group" aria-label="Server Mode">
      <input type="radio" class="btn-check" name="server-mode" id="record-mode" autocomplete="off"${
        state.mode === ServerMode.PROXY ? " checked" : ""
      }>
      <label class="btn btn-outline-primary" for="record-mode">&#9210; Record</label>
      <input type="radio" class="btn-check" name="server-mode" id="mock-mode" autocomplete="off"${
        state.mode === ServerMode.MOCK ? " checked" : ""
      }>
      <label class="btn btn-outline-primary" for="mock-mode">&#x1F310; Mock</label>
    </div>
    <span>Actions : </span>
    <button type="button" class="btn btn-light" id="add-mock">&#x2795; Mock from dummy request</button>
    <button type="button" class="btn btn-light" id="upload-mocks">&#x1F4E5; Upload mocks</button>
    <button type="button" class="btn btn-light" id="download-mocks">&#x1F4E6; Download mocks</button>
    <button type="button" class="btn btn-light" id="delete-mocks">&#x1F5D1; Delete mocks</button>
  </div>
  <div class="row">
    <div class="col-lg" style="max-width: 200px">
      <div class="form-check form-switch" id="strict-mock-mode-form-control">
        <input class="form-check-input" type="checkbox" id="strict-mock-mode"${
          state.mockConfig.strict ? ' checked="checked"' : ""
        }>
        <label class="form-check-label" for="strict-mock-mode">Strict mock mode</label>
      </div>
    </div>
    <div class="col-lg" style="max-width: 200px">
      <div class="form-check form-switch">
        <input class="form-check-input" type="checkbox" id="auto-record-mode"${
          state.mockConfig.autoRecord ? ' checked="checked"' : ""
        }>
        <label class="form-check-label" for="auto-record-mode">Auto record mode</label>
      </div>
    </div>
    <div class="col-lg">&nbsp;</div>
  </div>
  <input type="hidden" id="limit" value="0"/>
  <div class="modal fade" id="edit-request" tabindex="-1" 
   aria-labelledby="edit-request-label" aria-hidden="true">
    <div class="modal-dialog" style="max-width: 900px">
      <div class="modal-content">
        <div class="modal-header">
          <h1 class="modal-title fs-5" id="edit-request-label">Edit request to /</h1>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">
          <div class="container">
            <div class="row">
              <div class="col-lg">
                <h2>Request :</h2>
                <div id="uniqueHash-editor" style="width: 400px; height: 400px;"></div>
              </div>
              <div class="col-lg">
                <h2>Response : </h2>
                <div id="response-editor" style="width: 400px; height: 400px;"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          <button type="button" class="btn btn-primary" onclick="javascript:saveRequest()">Save changes</button>
        </div>
      </div>
    </div>
  </div>
  <script>
const xmlOrJsonPrologsInBase64 = [
  "eyJ","PD94bWw=","PCFET0NUWVBF","PCFkb2N0eXBl","PGh0bWw","PEhUTUw","H4sIAAAAAAAA", "W3tc"
];
function getMocksData () {
  return JSON.stringify(
    [...document.querySelectorAll('button[data-uniqueHash]')].map(button => ({
      response: button.attributes['data-response']?.value,
      uniqueHash: button.attributes['data-uniqueHash']?.value}))
   )
}
function updateState () {
  fetch("http${state.config.ssl ? "s" : ""}://${proxyHostnameAndPort}${
    Object.entries(state.config.mapping ?? {}).find(([_, value]) =>
      value?.toString()?.startsWith("recorder:"),
    )?.[0] ?? "/recorder/"
  }", {
     method: 'PUT',
     headers: { 'Content-Type': 'application/json' },
     body: '{"strict":' + document.getElementById('strict-mock-mode').checked +
           ',"autoRecord":' + document.getElementById('auto-record-mode').checked +
           ',"mode":"' + 
           (document.getElementById('mock-mode').checked ? "mock" : "proxy") + '"' +
          ',"mocks":' + getMocksData() + '}'
   })
}
function loadMocks(mocksHashes) {
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  let mocks = [];
  try {
    mocks = mocksHashes.map(mock => ({...mock, 
      request: JSON.parse(atob(mock.uniqueHash)),
      response: JSON.parse(atob(mock.response))
    }));
  } catch(e) { }
  mocks.forEach(mock => {
    const randomId = window.crypto.randomUUID();
    const actions = getActionsHtmlText(mock.uniqueHash, mock.response);
    addNewRequest(randomId, actions, time, 'info', 'HTTP/2', mock.request.method, 
    '<span class="badge bg-' + 
        getColorFromStatusCode(mock.response.status) + '">' + 
        mock.response.status + 
        '</span>', 
        '0ms', mock.request.url, 
        'N/A');
  });
}
document.getElementById('add-mock').addEventListener('click', () => {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.onload = function() { iframe.parentNode.removeChild(iframe); };
  iframe.src = "http${state.config.ssl ? "s" : ""}://${proxyHostnameAndPort}${
    Object.entries(state.config.mapping ?? {}).find(([_, value]) =>
      value?.toString()?.startsWith("recorder:"),
    )?.[0] ?? "/recorder/"
  }?forceLogInRecorderPage=true";
  document.body.appendChild(iframe);
});
document.getElementById('upload-mocks').addEventListener('click', () => {
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  const fileInput = document.createElement('input');
  fileInput.type = "file";
  fileInput.multiple = "multiple";
  fileInput.onchange = function() {
    const fileReader = new FileReader();
    [...fileInput.files].reduce((promise, file) =>
      promise.then(result => new Promise(resolve => {
        fileReader.readAsText(file);
        fileReader.onload = function(){
          resolve(result.concat(fileReader.result));
        };
      })), Promise.resolve([]))
    .then(files => files.flatMap(file => JSON.parse(file)))
    .catch(e => [])
    .then(mocks => loadMocks(mocks))
    .then(() => updateState());
  }
  fileInput.click();
});
document.getElementById('download-mocks').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([getMocksData()], {
    type: "application/json",
  }));
  link.download = "mocks-" + new Date().toISOString() + ".json";
  link.click();
  URL.revokeObjectURL(link.href);
})
document.getElementById('delete-mocks').addEventListener('click', () => {
  document.getElementById('limit').value = -1;
  cleanup();
  updateState();
  document.getElementById('limit').value = 0;
})
document.getElementById('record-mode').addEventListener('change', () => {
  document.getElementById('limit').value = 0;
  cleanup();
  updateState();
})
document.getElementById('mock-mode').addEventListener('change', () => {
  updateState();
})
document.getElementById('auto-record-mode').addEventListener('change', (e) => { 
  updateState();
  document.getElementById('table-access').style.filter = 
    document.getElementById('auto-record-mode').checked ? 'blur(8px)' : 'blur(0px)';
  document.getElementById('commands').style.filter = 
      document.getElementById('auto-record-mode').checked ? 'blur(8px)' : 'blur(0px)';
  document.getElementById('alert-about-auto-record-mode').style.display = 
    document.getElementById('auto-record-mode').checked ? 'block' : 'none';
  document.getElementById('strict-mock-mode-form-control').style.filter = 
    document.getElementById('auto-record-mode').checked ? 'blur(8px)' : 'blur(0px)';
    
})
document.getElementById('strict-mock-mode').addEventListener('change', (e) => { 
  updateState();
})
function saveRequest () {
  $('#edit-request').modal("hide");
  
  const requestBeingEdited = window.requestBeingEdited;
  let request = uniqueHashEditor.get();
  let response = responseEditor.get();
  if (typeof request.body === "object") {
    request.body = JSON.stringify(request.body);
  }
  if (typeof response.body === "object") {
    response.body = JSON.stringify(response.body);
  }
  const oldRequest = JSON.parse(atob(requestBeingEdited.attributes['data-uniqueHash'].value));
  const oldResponse = JSON.parse(atob(requestBeingEdited.attributes['data-response'].value));
  const requestProlog = requestBeingEdited.attributes['data-requestProlog']?.value;
  const responseProlog = requestBeingEdited.attributes['data-responseProlog']?.value;
  const requestPrologHasChanged = request.body.substring(0, 10) !== oldRequest.body.substring(0, 10);
  const responsePrologHasChanged = response.body.substring(0, 10) !== response.body.substring(0, 10);
  if (requestProlog === "H4sIAAAAAAAA" && !requestPrologHasChanged) {
    request.body =
      btoa([...pako.gzip(request.body)].map(e => String.fromCharCode(e)).join(""));
  } else if ((requestProlog === null || !request.body.startsWith(requestProlog ?? "")) && 
      request.body.substring(0, 10) !== oldRequest.body.substring(0, 10)) {
    request.body = btoa(request.body);
  }
  if (responseProlog === "H4sIAAAAAAAA" && !responsePrologHasChanged) {
    response.body =
      btoa([...pako.gzip(response.body)].map(e => String.fromCharCode(e)).join(""));
  } else if ((responseProlog === null || !response.body.startsWith(responseProlog ?? "")) && 
      response.body.substring(0, 10) !== oldResponse.body.substring(0, 10)) {
    response.body = btoa(response.body);
  }
  request = btoa(JSON.stringify(request));
  response = btoa(JSON.stringify(response));
  requestBeingEdited.setAttribute('data-uniqueHash', request);
  requestBeingEdited.setAttribute('data-response', response);
  const row = requestBeingEdited.closest('tr');
  row.querySelector("td.method").innerHTML = uniqueHashEditor.get().method;
  row.querySelector("td.upstream-path").innerHTML = uniqueHashEditor.get().url;
  window.requestBeingEdited = undefined;
  updateState();
}
document.getElementById('edit-request').addEventListener('show.bs.modal', event => {
  const request = JSON.parse(atob(event.relatedTarget.attributes['data-uniqueHash'].value));
  const response = JSON.parse(atob(event.relatedTarget.attributes['data-response'].value));
  const requestProlog = xmlOrJsonPrologsInBase64.find(prolog => request.body?.startsWith(prolog));
  const responseProlog = xmlOrJsonPrologsInBase64.find(prolog => response.body?.startsWith(prolog));
  if (requestProlog) {
    event.relatedTarget.setAttribute('data-requestProlog', requestProlog);
    request.body = request.body.startsWith("H4sIAAAAAAAA") 
    ? pako.ungzip(new Uint8Array(atob(request.body).split("").map(e => e.charCodeAt(0))), {to: "string"})
    : atob(request.body);
    request.body = request.body.startsWith("{\\"") || request.body.startsWith("[{\\"")
      ? JSON.parse(request.body) : request.body;
  }
  if (responseProlog) {
    event.relatedTarget.setAttribute('data-responseProlog', responseProlog);
    response.body = response.body.startsWith("H4sIAAAAAAAA") 
    ? pako.ungzip(new Uint8Array(atob(response.body).split("").map(e => e.charCodeAt(0))), {to: "string"})
    : atob(response.body);
    response.body = response.body.startsWith("{\\"") || response.body.startsWith("[{\\"")
      ? JSON.parse(response.body) : response.body;
  }
  window.requestBeingEdited = event.relatedTarget;
  window.uniqueHashEditor.set(request);
  window.responseEditor.set(response);
  document.getElementById('edit-request-label').innerText = "Edit request to " + request.url;
})

setTimeout(() => {
  loadMocks(${JSON.stringify(
    [...state.mockConfig.mocks.entries()].map(([uniqueHash, response]) => ({
      uniqueHash,
      response,
    })),
  )});
  window.uniqueHashEditor = new JSONEditor(document.getElementById("uniqueHash-editor"), {
    mode: "code", allowSchemaSuggestions: true, schema: {
      type: "object",
      properties: {
        method: {type: "string"},
        url: {type: "string"},
        body: {oneOf: [{type:"string"},{type:"object"},{type:"array"}]},
        headers: {type: "object"},
      },
    required: [],
    additionalProperties: false
  }});
  window.responseEditor = new JSONEditor(document.getElementById("response-editor"), {
    mode: "code", allowSchemaSuggestions: true, schema: {
      type: "object",
      properties: {
        body: {oneOf: [{type:"string"},{type:"object"},{type:"array"}]},
        headers: {type: "object"},
        status: {type: "integer"}
    },
    required: [],
    additionalProperties: false
  }});
  ${
    state.mockConfig.autoRecord
      ? ";document.getElementById('strict-mock-mode-form-control')" +
        ".style.filter='blur(8px)';" +
        ";document.getElementById('table-access').style.filter='blur(8px)';"
      : ""
  }
  document.forms[0].reset();
}, 10)
</script>
</form>
<div class="alert alert-warning" role="alert"
     style="display:${
       state.mockConfig.autoRecord ? "block" : "none"
     };left:20%;right:20%;position:absolute;z-index:1;" id="alert-about-auto-record-mode">
  &#x24D8;&nbsp;Auto-record mode and recorder webapp are known to be mutually exclusive.
  <br/><br/>Changing the mocks on both sides is somehow hard to sort out.
  <br/>This is triggering concurrent modifications in the mock config.
  <hr/>
  Here is what you can do :
  <ul>
    <li>If you want to record mocks using a frontend app, turn off the auto-record mode.</li>
    <li>If you want to record mocks with the recorder API only, close this app.</li>
  </ul>
</div>
${logsView(proxyHostnameAndPort, state.config, { captureResponseBody: true })}
</body>
</html>`);
};

const filePage = (
  _proxyHostnameAndPort: string,
  _state: State,
  _request: Http2ServerRequest | IncomingMessage,
  mappingAttributes: { target: URL },
): ClientHttp2Session => {
  const url = mappingAttributes?.target;
  const file = resolve(
    "/",
    url.hostname,
    ...url.pathname
      .replace(/[?#].*$/, "")
      .replace(/^\/+/, "")
      .split("/")
      .map(decodeURIComponent),
  );
  return {
    alpnProtocol: "file",
    error: null as unknown as Error,
    data: null as unknown as string | Buffer,
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
                      new Promise<
                        [string, Stats, NodeJS.ErrnoException | null]
                      >(innerResolve =>
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
    write: function () {
      return this;
    },
  } as unknown as ClientHttp2Session;
};

const http2Page = async (
  _proxyHostnameAndPort: string,
  state: State,
  mappingAttributes: { target: URL; url: URL },
): Promise<ClientHttp2Session | null> => {
  let error: Buffer | null = null;
  let http2IsSupported =
    mappingAttributes?.target?.protocol === "https:" &&
    !state.config.dontUseHttp2Downstream;
  const http2Connection = !http2IsSupported
    ? null
    : state.mode !== ServerMode.PROXY && state?.mockConfig?.strict
      ? null
      : await Promise.race([
          new Promise<ClientHttp2Session | null>(resolve => {
            const result = connect(
              mappingAttributes.target,
              {
                timeout: state.config.connectTimeout,
                sessionTimeout: state.config.socketTimeout,
                rejectUnauthorized: false,
                protocol: mappingAttributes.target.protocol,
              } as SecureClientSessionOptions,
              (_, socketPath) => {
                http2IsSupported =
                  http2IsSupported && !!(socketPath as any).alpnProtocol;
                resolve(!http2IsSupported ? null : result);
              },
            );
            (result as unknown as Http2Session).on("error", (thrown: Error) => {
              error = !http2IsSupported
                ? null
                : Buffer.from(
                    errorPage(
                      thrown,
                      state.mode,
                      "connection",
                      mappingAttributes.url,
                      mappingAttributes.target,
                    ),
                  );
            });
          }),
          new Promise<ClientHttp2Session | null>(resolve =>
            setTimeout(() => {
              http2IsSupported = false;
              resolve(null);
            }, state.config.connectTimeout),
          ),
        ]);
  if (error) throw error;
  return http2IsSupported ? http2Connection : (null as any);
};

const http1Page = async (
  target: URL,
  url: URL,
  targetUrl: URL,
  fullPath: string,
  inboundRequest: IncomingMessage | Http2ServerRequest,
  outboundHeaders: OutgoingHttpHeaders,
  requestBody: Buffer,
  bufferedRequestBody: boolean,
  mode: ServerMode,
): Promise<ClientHttp2Session> => {
  const http1RequestOptions: RequestOptions = {
    hostname: target.hostname,
    path: fullPath,
    port: target.port ? target.port : target.protocol === "https:" ? 443 : 80,
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
  let error: Buffer | null = null;
  const outboundHttp1Response: IncomingMessage | null = error
    ? null
    : [...specialProtocols].includes(target.protocol)
      ? null
      : await new Promise(resolve => {
          const outboundHttp1Request: ClientRequest =
            target.protocol === "https:"
              ? httpsRequest(http1RequestOptions, resolve)
              : httpRequest(http1RequestOptions, resolve);

          outboundHttp1Request.on("error", thrown => {
            error = Buffer.from(
              errorPage(thrown, mode, "request", url, targetUrl),
            );
            resolve(null);
          });
          if (bufferedRequestBody) {
            outboundHttp1Request.write(requestBody);
            outboundHttp1Request.end();
          }

          if (!bufferedRequestBody) {
            inboundRequest.on("data", chunk =>
              outboundHttp1Request.write(chunk),
            );
            inboundRequest.on("end", () => outboundHttp1Request.end());
          }
        });
  if (error) throw error;
  return {
    alpnProtocol: "HTTP1.1",
    error: null as unknown as Error,
    data: null as unknown as MockResponseObject,
    hasRun: false,
    events: {} as { [name: string]: (...any: any) => any },
    on: function (name: string, action: (...any: any) => any) {
      if (name === "response")
        return action?.({
          ...outboundHttp1Response.headers,
          [":status"]: outboundHttp1Response.statusCode,
          [":statusmessage"]: outboundHttp1Response.statusMessage,
        });
      return outboundHttp1Response.on(name, action);
    },
    end: function () {
      return this;
    },
    request: function () {
      return this;
    },
    write: function () {
      return this;
    },
  } as unknown as ClientHttp2Session;
};

const workerPage = (proxyHostnameAndPort: string, state: State) => {
  return staticResponse(
    `
const mapping = ${JSON.stringify(
      Object.entries(state.config.mapping)
        .filter(key => key && key.length > 1)
        .map(([key, value]) => {
          if (typeof value === "string" && value.startsWith("data:"))
            return [key, "data:text/plain,..."];
          let match: RegExpMatchArray | null =
            key.match(RegExp(key.replace(/^\//, "^/"))) ?? null;
          const replacedReplaceBody = (
            typeof value === "string" ? value : value.replaceBody
          )?.replace(
            /\$\$(\d+)/g,
            (_, index) => match?.[parseInt(index)] ?? "",
          );
          let replacementCounter = 0;
          return [
            key.replace(/\([^)]+\)/g, () => `$${++replacementCounter}`),
            replacedReplaceBody,
          ];
        }),
    )}
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function (event) {
  const resolvedUrl = mapping.reduce((url, [to, from]) => 
    url.replace(new RegExp(from, "ig"), to), event.request.url);
  if (resolvedUrl === event.request.url) return;
  event.respondWith(fetch(new URL(resolvedUrl, "${state.config.ssl ? "https://" : "http://"}${proxyHostnameAndPort}").href),{
      method: event.request.method, 
      headers: event.request.headers,
      body: event.request.body,
      mode: event.request.mode,
      credentials: event.request.credentials,
      cache: event.request.cache,
      redirect: event.request.redirect,
      referrer: event.request.referrer,
      referrerPolicy: event.request.referrerPolicy,
      integrity: event.request.integrity,
      keepalive: event.request.keepalive,
      signal: event.request.signal,
      destination: event.request.destination,
})
});`,
    {
      headers: {
        "content-type": "text/javascript; charset=utf8",
        "Service-Worker-Allowed": "/",
      },
    },
  );
};

const specialPageMapping: Record<
  string,
  (
    proxyHostnameAndPort: string,
    state: State,
    request: Http2ServerRequest | IncomingMessage,
    mappingAttributes: {
      target: URL;
      url: URL;
      proxyHostname: string;
      key: string;
      requestBody: Buffer;
    },
  ) => ClientHttp2Session
> = {
  logs: logsPage,
  config: configPage,
  recorder: recorderPage,
  file: filePage,
  data: dataPage,
  worker: workerPage,
};

const specialPages = Object.keys(specialPageMapping);
const specialProtocols = specialPages.map(page => `${page}:`);
const defaultConfig: Required<Omit<LocalConfiguration, "ssl">> &
  Pick<LocalConfiguration, "ssl"> = {
  mapping: Object.assign(
    {},
    ...specialPages
      .filter(page => page !== "data" && page !== "file")
      .map(page => ({
        [page === "worker" ? "/local-traffic-worker.js" : `/${page}/`]:
          `${page}://`,
      })),
  ),
  port: 8080,
  replaceRequestBodyUrls: false,
  replaceResponseBodyUrls: false,
  dontUseHttp2Downstream: false,
  dontTranslateLocationHeader: false,
  logAccessInTerminal: false,
  simpleLogs: false,
  websocket: true,
  disableWebSecurity: false,
  connectTimeout: 3000,
  socketTimeout: 3000,
  unwantedHeaderNamesInMocks: [],
};
const load = async (
  firstTime: boolean = true,
): Promise<LocalConfiguration | null> =>
  new Promise<LocalConfiguration>(resolve =>
    readFile(filename, (error, data) => {
      if (error) {
        log(null, [
          [
            {
              text: `${EMOJIS.ERROR_1} config error. Using previous value`,
              color: LogLevel.ERROR,
            },
          ],
        ]).then(() => resolve({ ...defaultConfig }));
        if (error.code !== "ENOENT") return;
      }
      let config: LocalConfiguration | null = null;
      try {
        config = Object.assign(
          {},
          defaultConfig,
          JSON.parse((data ?? "{}").toString()),
        );
      } catch (e) {
        config = config ?? { ...defaultConfig };
        return log({ config: undefined }, [
          [
            {
              text: `${EMOJIS.ERROR_2} config syntax incorrect, ignoring`,
              color: LogLevel.ERROR,
            },
          ],
        ]).then(() => resolve(config));
      }
      if (error?.code === "ENOENT" && firstTime) {
        writeFile(
          filename,
          JSON.stringify(defaultConfig, null, 2),
          fileWriteErr => {
            return (
              fileWriteErr
                ? log(null, [
                    [
                      {
                        text: `${EMOJIS.ERROR_4} config file NOT created`,
                        color: LogLevel.ERROR,
                      },
                    ],
                  ])
                : log(null, [
                    [
                      {
                        text: `${EMOJIS.COLORED} config file created`,
                        color: LogLevel.INFO,
                      },
                    ],
                  ])
            ).then(() => resolve(config!));
          },
        );
      } else resolve(config!);
    }),
  ).then(async (readConfig: LocalConfiguration) =>
    !readConfig
      ? readConfig
      : await Promise.all(
          Object.entries(readConfig.mapping).map(
            ([key, mapping]) =>
              new Promise<[keyof Mapping, typeof mapping]>(resolve => {
                const replaceBody =
                  typeof mapping === "string" ? null : mapping.replaceBody;
                const downstreamUrl =
                  typeof mapping === "string" ? mapping : mapping.downstreamUrl;
                if (!downstreamUrl.startsWith("file:") || key.endsWith("(.*)"))
                  return resolve([key, mapping]);
                const matchersCount = downstreamUrl
                  .split("")
                  .map((c, i) => c + downstreamUrl.charAt(i + 1))
                  .filter(m => m === "$$").length;
                return lstat(
                  new URL(downstreamUrl.replace(/\$\$[0-9]+/g, "")).pathname,
                  (e, stats) => {
                    if (e) return resolve([key, mapping]);
                    const isDirectory = stats.isDirectory();
                    const replacedKey = isDirectory
                      ? `${key?.replace(/\/*$/g, "")}/(.*)`
                      : key;
                    const replacedReplaceBody = isDirectory
                      ? `${replaceBody?.replace(/\/*$/g, "")}/$$${matchersCount + 1}`
                      : replaceBody;
                    const replacedDownstreamUrl = isDirectory
                      ? `${downstreamUrl.replace(/\/*$/g, "")}${sep}$$${matchersCount + 1}`
                      : downstreamUrl;
                    return resolve(
                      !replaceBody
                        ? [replacedKey, replacedDownstreamUrl]
                        : [
                            replacedKey,
                            {
                              replaceBody: replacedReplaceBody,
                              downstreamUrl: replacedDownstreamUrl,
                            },
                          ],
                    );
                  },
                );
              }),
          ),
        ).then(interpretedMapping => ({
          ...readConfig,
          mapping: Object.fromEntries(interpretedMapping),
        })),
  );

const onWatch = async function (state: State): Promise<Partial<State>> {
  const previousConfig = state.config;
  const config = await load(false);
  const logElements: LogElement[] = [];
  if (!config) return {};
  if (
    isNaN(config?.port ?? NaN) ||
    (config?.port ?? -1) > 65535 ||
    (config?.port ?? -1) < 0
  ) {
    await state.log([
      [
        {
          text: `${EMOJIS.PORT} port number invalid. Not refreshing`,
          color: LogLevel.ERROR,
        },
      ],
    ]);
    return {};
  }
  if (!config?.mapping?.[""]) {
    logElements.push({
      text: `${EMOJIS.ERROR_3} default mapping "" not provided.`,
      color: LogLevel.WARNING,
    });
  }
  if (typeof config.mapping !== "object") {
    state.log([
      [
        {
          text: `${EMOJIS.ERROR_5} mapping should be an object. Aborting`,
          color: LogLevel.ERROR,
        },
      ],
    ]);
    return {};
  }
  if (config.replaceRequestBodyUrls !== previousConfig.replaceRequestBodyUrls) {
    logElements.push({
      text: `${EMOJIS.REWRITE} request body url ${
        !config.replaceRequestBodyUrls ? "NO " : ""
      }rewriting`,
      color: LogLevel.INFO,
    });
  }
  if (
    config.replaceResponseBodyUrls !== previousConfig.replaceResponseBodyUrls
  ) {
    logElements.push({
      text: `${EMOJIS.REWRITE} response body url ${
        !config.replaceResponseBodyUrls ? "NO " : ""
      }rewriting`,
      color: LogLevel.INFO,
    });
  }
  if (
    config.dontTranslateLocationHeader !==
    previousConfig.dontTranslateLocationHeader
  ) {
    logElements.push({
      text: `${EMOJIS.REWRITE} response location header ${
        config.dontTranslateLocationHeader ? "NO " : ""
      }translation`,
      color: LogLevel.INFO,
    });
  }
  if (config.dontUseHttp2Downstream !== previousConfig.dontUseHttp2Downstream) {
    logElements.push({
      text: `${EMOJIS.OUTBOUND} http/2 ${config.dontUseHttp2Downstream ? "de" : ""}activated downstream`,
      color: LogLevel.INFO,
    });
  }
  if (config.disableWebSecurity !== previousConfig.disableWebSecurity) {
    logElements.push({
      text: `${EMOJIS.SHIELD} web security ${config.disableWebSecurity ? "de" : ""}activated`,
      color: LogLevel.INFO,
    });
  }
  if (config.websocket !== previousConfig.websocket) {
    logElements.push({
      text: `${EMOJIS.WEBSOCKET} websocket ${!config.websocket ? "de" : ""}activated`,
      color: LogLevel.INFO,
    });
  }
  if (config.logAccessInTerminal !== previousConfig.logAccessInTerminal) {
    logElements.push({
      text: `${EMOJIS.LOGS} access terminal logging ${
        config.logAccessInTerminal === true
          ? "on"
          : config.logAccessInTerminal === "with-mapping"
            ? ": show both path and mapping"
            : "off"
      }`,
      color: LogLevel.INFO,
    });
  }
  if (config.simpleLogs !== previousConfig.simpleLogs) {
    logElements.push({
      text: `${EMOJIS.COLORED} simple logs ${!config.simpleLogs ? "off" : "on"}`,
      color: LogLevel.INFO,
    });
  }
  if (
    Object.keys(config.mapping).join("\n") !==
    Object.keys(previousConfig.mapping ?? {}).join("\n")
  ) {
    logElements.push({
      text: `${EMOJIS.RULES} ${Object.keys(config.mapping)
        .length.toString()
        .padStart(5)} loaded mapping rules`,
      color: LogLevel.INFO,
    });
  }
  if (config.port !== previousConfig.port) {
    logElements.push({
      text: `${EMOJIS.PORT} port changed from ${previousConfig.port} to ${config.port}`,
      color: LogLevel.INFO,
    });
  }
  if (config.ssl && !previousConfig.ssl) {
    logElements.push({
      text: `${EMOJIS.INBOUND} ssl configuration added`,
      color: LogLevel.INFO,
    });
  }
  if (!config.ssl && previousConfig.ssl) {
    logElements.push({
      text: `${EMOJIS.INBOUND} ssl configuration removed`,
      color: LogLevel.INFO,
    });
  }
  const shouldRestartServer =
    config.port !== previousConfig.port ||
    JSON.stringify(config.ssl) !== JSON.stringify(previousConfig.ssl);

  if (shouldRestartServer) {
    logElements.push({
      text: `${EMOJIS.RESTART} restarting server`,
      color: LogLevel.INFO,
    });
  }
  setTimeout(() => {
    quickStatus.apply({ ...state, config }, [logElements.map(line => [line])]);
  }, 1);
  return { config, server: shouldRestartServer ? null : undefined };
};

const unixNorm = (path: string) =>
  path == "" ? "" : normalize(path).replace(/\\/g, "/");

const cdn = "https://cdn.jsdelivr.net/npm/";
const disallowedHttp2HeaderNames = [
  "host",
  "connection",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "upgrade-insecure-requests",
  "proxy-connection",
];

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

const mockRequest = ({
  response,
}: {
  response: string;
}): ClientHttp2Session => {
  return {
    alpnProtocol: "mock",
    error: null as unknown as Error,
    data: null as unknown as MockResponseObject,
    hasRun: false,
    run: function () {
      return this.hasRun
        ? Promise.resolve()
        : new Promise(promiseResolve => {
            try {
              this.data = JSON.parse(
                Buffer.from(response, "base64").toString("utf-8"),
              );
            } catch (e) {
              this.data = {};
            }
            promiseResolve(void 0);
          });
    },
    events: {} as { [name: string]: (...any: any) => any },
    on: function (name: string, action: (...any: any) => any) {
      this.events[name] = action;
      this.run().then(() => {
        if (name === "response")
          this.events["response"](
            {
              ...this.data.headers,
              "X-LocalTraffic-Mock": "1",
            },
            this.data.status,
          );
        if (name === "data" && this.data) {
          this.events["data"](Buffer.from(this.data.body ?? "", "base64"));
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
    write: function () {
      return this;
    },
  } as unknown as ClientHttp2Session;
};

const staticResponse = (
  data: string | Promise<Buffer>,
  options?: {
    headers?: Record<string, string>;
    onOutboundWrite?: (buffer: Buffer) => void;
  },
): ClientHttp2Session =>
  ({
    alpnProtocol: "static",
    error: null as unknown as Error,
    data: null as unknown as string | Buffer,
    outboundData: null as unknown as Buffer,
    run: function () {
      return typeof data === "string"
        ? new Promise(resolve => {
            this.data = data;
            resolve(void 0);
          })
        : (data as Promise<Buffer>).then(text => {
            this.data = text.toString("utf8");
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
              ...(options?.headers ?? {}),
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
    write: function (payload?: Buffer) {
      this.outboundData = payload;
      if (payload instanceof Buffer) options?.onOutboundWrite?.(payload);
      return this;
    },
    end: function () {
      return this;
    },
    request: function () {
      return this;
    },
  }) as unknown as ClientHttp2Session;

const replaceBody = async (
  payloadBuffer: Buffer,
  headers: {
    "content-encoding"?: string;
    "content-type"?: string;
  },
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
      const method = (
        format === "gzip" || format === "x-gzip"
          ? gunzip
          : format === "deflate"
            ? inflate
            : format === "br"
              ? brotliDecompress
              : format === "identity" || format === ""
                ? (
                    input: Buffer,
                    callback: (err: Error | null, data?: Buffer) => void,
                  ) => {
                    callback(null, input);
                  }
                : null
      ) as (
        input: Buffer,
        callback: (error: Error | null, data: Buffer) => void,
      ) => void | null;
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
        /[^\x00-\xFF]/.test(uncompressedBuffer.toString());
      const contentTypeCanBeProcessed = [
        "text/html",
        "application/javascript",
        "application/json",
      ].some(allowedContentType =>
        (headers["content-type"] ?? "").toString().includes(allowedContentType),
      );
      const willReplace =
        !fileTooBig && (contentTypeCanBeProcessed || !fileHasSpecialChars());
      const workerRoute = Object.entries(parameters.mapping).filter(([_, v]) =>
        v?.toString()?.startsWith("worker://"),
      )[0];
      return !willReplace
        ? uncompressedBuffer
        : replaceTextUsingMapping(uncompressedBuffer.toString(), {
            direction: parameters.direction,
            proxyHostnameAndPort: parameters.proxyHostnameAndPort,
            ssl: parameters.ssl,
            mapping: parameters.mapping,
          })
            .replace(
              /\?protocol=wss?%3A&hostname=[^&]+&port=[0-9]+&pathname=/g,
              `?protocol=ws${parameters.ssl ? "s" : ""}%3A&hostname=${
                parameters.proxyHostname
              }&port=${parameters.port}&pathname=${encodeURIComponent(
                parameters.key.replace(/\/+$/, ""),
              )}`,
            )
            .replace(/<\/head>/, () => {
              if (
                parameters.direction !== REPLACEMENT_DIRECTION.INBOUND ||
                !(headers["content-type"] ?? "")
                  .toString()
                  .includes("text/html") ||
                !workerRoute
              )
                return "</head>";
              return `<script type="text/javascript">navigator.serviceWorker.register("${workerRoute[0]}",{scope:"/"});</script></head>`;
            });
    })
    .then((updatedBody: Buffer | string) =>
      (headers["content-encoding"]?.toString() ?? "")
        .split(",")
        .reverse()
        .reduce(
          (buffer: Promise<Buffer>, formatNotTrimed: string) => {
            const format = formatNotTrimed.trim().toLowerCase();
            const method = (
              format === "gzip" || format === "x-gzip"
                ? gzip
                : format === "deflate"
                  ? deflate
                  : format === "br"
                    ? brotliCompress
                    : format === "identity" || format === ""
                      ? (
                          input: Buffer,
                          callback: (err: Error | null, data?: Buffer) => void,
                        ) => {
                          callback(null, input);
                        }
                      : null
            ) as (
              input: Buffer,
              callback: (error: Error | null, data: Buffer) => void,
            ) => void | null;
            if (method === null)
              throw new Error(
                `${format} compression not supported by the proxy`,
              );

            return buffer.then(
              data =>
                new Promise<Buffer>(resolve =>
                  method(data, (err, data) => {
                    if (err) throw err;
                    resolve(data);
                  }),
                ),
            );
          },
          Promise.resolve(Buffer.from(updatedBody)),
        ),
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
      const pathRegexes = path
        .split("")
        .filter(e => ["(", ")"].includes(e))
        .join("")
        .match(/^(\(\))*$/)
        ? path
            .split("(")
            .flatMap(e => e.split(")"))
            .filter((_, i) => i % 2 === 1)
        : [];
      let replacementCounter = 0;
      return specialProtocols.some(protocol => value.startsWith(protocol)) ||
        (path !== "" &&
          !(
            path.match(/^[-a-zA-Z0-9()@:%_\+.~#?&//=]*$/) || pathRegexes.length
          ))
        ? inProgress
        : direction === REPLACEMENT_DIRECTION.INBOUND
          ? inProgress.replace(
              new RegExp(
                value
                  .replace(new RegExp(`^(${specialPages.join("|")}):\/\/`), "")
                  .replace(
                    /\$\$(\d+)/g,
                    (_, index) =>
                      "(" + (pathRegexes![parseInt(index) - 1] ?? "") + ")",
                  )
                  .replace(/\.\*/g, "[-a-zA-Z0-9()@:%_+.~#?&//=]*")
                  .replace(pathRegexes.length ? "" : /[*+?^${}()|[\]\\]/g, "")
                  .replace(/^https/, "https?") +
                  (pathRegexes.length ? "" : "/*"),
                "ig",
              ),
              `http${ssl ? "s" : ""}://${proxyHostnameAndPort}${path
                .replace(/\([^)]+\)/g, () => `$${++replacementCounter}`)
                .replace(/\/+$/, "/")
                .replace(/^(?![^/])$/, "/")}`,
            )
          : inProgress
              .split(
                `http${ssl ? "s" : ""}://${proxyHostnameAndPort}${path
                  .replace(/\/+$/, "")
                  .replace(/^(?![^/])$/, "/")}`,
              )
              .join(value);
    }, text)
    .split(`${proxyHostnameAndPort}/:`)
    .join(`${proxyHostnameAndPort}:`);

const cleanEntropy = (
  config: LocalConfiguration,
  requestObject: string | RequestStruct,
) => {
  try {
    const request =
      typeof requestObject === "object"
        ? requestObject
        : JSON.parse(Buffer.from(requestObject, "base64").toString("utf-8"));
    [
      "access-control-max-age",
      "authorization",
      "cache-control",
      "cookie",
      "date",
      "dnt",
      "expires",
      "if-modified-since",
      "if-unmodified-since",
      "keep-alive",
      "last-modified",
      // cache header not helpful here
      "pragma",
      "proxy-authenticate",
      "proxy-authorization",
      "referer",
      // referer is more of a nuisance than a true discriminant
      "retry-after",
      "signed-headers",
      "server-timing",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "sec-fetch-dest",
      // disable check on action triggering the request
      "sec-fetch-mode",
      // disable check on action triggering the request
      "sec-fetch-site",
      // disable check on same-origin domain
      "sec-fetch-user",
      // disable check on persona triggering the request
      "upgrade-insecure-requests",
      // disable unwanted security check
      "user-agent",
      // no user agent comparison
      ...(Array.isArray(config.unwantedHeaderNamesInMocks)
        ? config.unwantedHeaderNamesInMocks
        : []),
    ].forEach(header => {
      delete request?.headers?.[header];
    });
    request.headers = Object.keys(request.headers)
      .sort()
      .reduce((obj, key) => {
        obj[key] = request.headers[key];
        return obj;
      }, {});
    return Buffer.from(JSON.stringify(request), "utf-8").toString("base64");
  } catch (e) {
    // this cannot fail when a request object is passed as parameter
    return requestObject as string;
  }
};

const send = (
  code: number,
  inboundResponse: Http2ServerResponse | ServerResponse,
  errorBuffer: Buffer,
) => {
  inboundResponse.writeHead(code, {
    "content-type": "text/html",
    "content-length": errorBuffer.length,
  });
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
  target: URL | null;
} => {
  const proxyHostname = (
    inboundRequest.headers[":authority"]?.toString() ??
    inboundRequest.headers.host ??
    "localhost"
  ).replace(/:.*/, "");
  const proxyHostnameAndPort =
    (inboundRequest.headers[":authority"] as string) ||
    `${inboundRequest.headers.host}${
      (inboundRequest.headers.host ?? "").match(/:[0-9]+$/)
        ? ""
        : parameters.port === 80 && !parameters.ssl
          ? ""
          : parameters.port === 443 && parameters.ssl
            ? ""
            : `:${parameters.port ?? 8080}`
    }`;
  const url = new URL(
    `http${parameters.ssl ? "s" : ""}://${proxyHostnameAndPort}${
      inboundRequest.url ?? ""
    }`,
  );
  const path = url.href.substring(url.origin.length);

  const mappings: Record<string, URL> = {
    ...Object.assign(
      {},
      ...Object.entries(parameters.mapping ?? {}).map(([key, entry]) => {
        const value =
          typeof entry === "string" ? entry : entry?.downstreamUrl ?? "";
        const matchedKey =
          typeof entry === "string" ? key : entry?.replaceBody ?? "";
        const url = new URL(
          value?.startsWith?.("data:") ? value : unixNorm(value),
        );
        return {
          [matchedKey]: url,
          [key]: url,
        };
      }),
    ),
  };

  let match: RegExpMatchArray | null = null;
  const [key, rawTarget] = Object.entries(mappings).find(
    ([key]) => (match = path.match(RegExp(key.replace(/^\//, "^/"))) ?? null),
  ) ?? ["/"];

  const target =
    !match || !rawTarget
      ? null
      : new URL(
          rawTarget.href.replace(
            /\$\$(\d+)/g,
            (_, index) => match![parseInt(index)] ?? "",
          ),
        );
  return { proxyHostname, proxyHostnameAndPort, url, path, key, target };
};

const websocketServe = function (
  state: State,
  request: IncomingMessage,
  upstreamSocket: Duplex,
): Partial<State> {
  upstreamSocket.on("error", () => {
    state.log([
      [
        {
          text: `${EMOJIS.WEBSOCKET} websocket connection reset`,
          color: LogLevel.WARNING,
        },
      ],
    ]);
  });

  if (!state.config.websocket) {
    upstreamSocket.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n`);
    return {};
  }

  const {
    key,
    target: targetWithForcedPrefix,
    path,
    url,
  } = determineMapping(request, state.config);

  if (path.startsWith("/local-traffic-logs")) {
    acknowledgeWebsocket(
      upstreamSocket,
      request.headers["sec-websocket-key"] ?? "",
    );
    return {
      logsListeners: state.logsListeners.concat({
        stream: upstreamSocket,
        wantsMask: !(request.headers["user-agent"]?.toString() ?? "").includes(
          "Chrome",
        ),
        wantsResponseMessage: [...url.searchParams.entries()].some(
          ([key, value]) => key === "wantsResponseMessage" && value === "true",
        ),
      }),
    };
  }

  if (path === "/local-traffic-config") {
    acknowledgeWebsocket(
      upstreamSocket,
      request.headers["sec-websocket-key"] ?? "",
    );
    let partialRead: PartialRead | null = null;
    upstreamSocket.on("data", buffer => {
      const read = readWebsocketBuffer(buffer, partialRead);
      if (partialRead === null && read.body.length < read.payloadLength) {
        partialRead = read;
      } else if (
        read.body.length >= read.payloadLength &&
        read.body.length === 0
      ) {
        return {};
      } else if (read.body.length >= read.payloadLength) {
        partialRead = null;
        let newConfig: LocalConfiguration;
        try {
          newConfig = JSON.parse(read.body);
        } catch (e) {
          state.log([
            [
              {
                text: `${EMOJIS.ERROR_4} config file NOT read, try again later`,
                color: LogLevel.WARNING,
              },
            ],
          ]);
          return {};
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
    `${targetWithForcedPrefix?.protocol ?? "https"}//${targetWithForcedPrefix?.host ?? "localhost"}${request.url
      ?.replace(new RegExp(`^${key}`, "g"), targetWithForcedPrefix.pathname)
      ?.replace(/^\/*/, "/")}`,
  );
  const downstreamRequestOptions: RequestOptions = {
    hostname: target.hostname,
    path: target.pathname,
    port: target.port,
    protocol: target.protocol,
    rejectUnauthorized: false,
    method: request.method,
    headers: {
      ...request.headers,
      host: target.hostname,
      origin: target.origin,
    },
    host: target.hostname,
  };

  const downstreamRequest =
    target.protocol === "https:"
      ? httpsRequest(downstreamRequestOptions)
      : httpRequest(downstreamRequestOptions);
  downstreamRequest.end();
  downstreamRequest.on("error", error => {
    state.log([
      [
        {
          text: `${EMOJIS.WEBSOCKET} websocket request has errored ${
            (error as ErrorWithErrno).errno
              ? `(${(error as ErrorWithErrno).errno})`
              : ""
          }`,
          color: LogLevel.WARNING,
        },
      ],
    ]);
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
      state.log([
        [
          {
            text: `${EMOJIS.WEBSOCKET} downstream socket has errored ${
              (error as ErrorWithErrno).errno
                ? `(${(error as ErrorWithErrno).errno})`
                : ""
            }`,
            color: LogLevel.WARNING,
          },
        ],
      ]);
    });
    upstreamSocket.on("error", error => {
      state.log([
        [
          {
            text: `${EMOJIS.WEBSOCKET} upstream socket has errored ${
              (error as ErrorWithErrno).errno
                ? `(${(error as ErrorWithErrno).errno})`
                : ""
            }`,
            color: LogLevel.WARNING,
          },
        ],
      ]);
    });
  });
  return {};
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
          state.mode,
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
  const {
    proxyHostname,
    proxyHostnameAndPort,
    url,
    path,
    key,
    target: targetFromProxy,
  } = determineMapping(inboundRequest, state.config);
  const target =
    targetFromProxy ??
    (state.mode === ServerMode.MOCK
      ? new URL(`http${state.config.ssl ? "s" : ""}://${proxyHostnameAndPort}/`)
      : null);

  if (!target) {
    send(
      502,
      inboundResponse,
      Buffer.from(
        errorPage(
          new Error(`No mapping found in config file ${filename}`),
          state.mode,
          "proxy",
          url,
        ),
      ),
    );
    return;
  }
  const protocolSlashes = target.protocol === "data:" ? "" : "//";
  const targetHost = target.host.replace(RegExp(/\/+$/), "");
  const targetPrefix = target.href.substring(
    `${target.protocol}${protocolSlashes}`.length + target.host.length,
  );
  const fullPath =
    target.protocol === "file:" || target.protocol === "data:"
      ? targetPrefix
      : `${targetPrefix}${unixNorm(
          path.replace(RegExp(unixNorm(key)), ""),
        )}`.replace(/^\/*/, target.protocol === "data:" ? "" : "/");
  const targetUrl = new URL(
    `${target.protocol}${protocolSlashes}${targetHost}${fullPath}`,
  );
  const targetUsesSpecialProtocol = specialProtocols.some(
    protocol => target.protocol === protocol,
  );

  const randomId = randomBytes(20).toString("hex");
  let requestBody: Buffer | null = null;
  const bufferedRequestBody =
    state.config.replaceRequestBodyUrls || !!state.logsListeners.length;
  // sounds ridiculous, but yes, I need to wait until the HTTP/2 stream gets read
  if (state.config.ssl) await new Promise(resolve => setTimeout(resolve, 1));
  const hasImmediateOrDeferredRequestBody =
    parseInt(inboundRequest.headers["content-length"] ?? "0") > 0;
  const http1WithRequestBody =
    !!(inboundRequest as IncomingMessage)?.readableLength ||
    hasImmediateOrDeferredRequestBody;
  const http2WithRequestBody =
    !!(inboundRequest as Http2ServerRequest)?.stream &&
    hasImmediateOrDeferredRequestBody;
  const serverSentEvents =
    !!inboundRequest.headers?.accept?.includes("text/event-stream");
  const requestBodyExpected = !(
    ((state.config.ssl && http2WithRequestBody === false) ||
      (!state.config.ssl && http1WithRequestBody === false)) &&
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
      new Promise(resolve => setTimeout(resolve, state.config.connectTimeout)),
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
      await state.log([
        [
          {
            text: `${EMOJIS.ERROR_4} body replacement error ${path.slice(-17)}`,
            color: LogLevel.WARNING,
          },
        ],
      ]);
    requestBody = !state.config.replaceRequestBodyUrls
      ? requestBodyBuffer
      : await replaceBody(requestBodyBuffer, inboundRequest.headers, {
          proxyHostnameAndPort,
          proxyHostname,
          key,
          mapping: state.config.mapping ?? {},
          port: state.config.port ?? defaultConfig.port,
          ssl: !!state.config.ssl,
          direction: REPLACEMENT_DIRECTION.OUTBOUND,
        });
  }
  const atLeastOneLoggerWantsResponseBody = state.logsListeners.some(
    listener => listener.wantsResponseMessage,
  );
  const autoRecordModeEnabled =
    state.mockConfig.autoRecord && state.mode === ServerMode.PROXY;
  const uniqueHash = cleanEntropy(state.config, {
    method: inboundRequest.method ?? "GET",
    url: inboundRequest.url ?? "",
    headers: Object.assign(
      {},
      ...Object.entries(inboundRequest.headers)
        .filter(([headerName]) => !headerName.startsWith(":"))
        .map(([key, value]) => ({ [key]: value })),
    ),
    body:
      state.mode === ServerMode.MOCK ||
      atLeastOneLoggerWantsResponseBody ||
      autoRecordModeEnabled
        ? requestBody?.toString("base64") ?? ""
        : "",
  });

  if (
    state.config.logAccessInTerminal &&
    !targetUrl.pathname.startsWith("/:/")
  ) {
    const requestMethodLength = (inboundRequest.method?.length ?? 3) + 2;
    const keyToDisplay =
      state.config.logAccessInTerminal === "with-mapping" ? key ?? "" : "";
    const keyLength = keyToDisplay.length
      ? Math.min(screenWidth - requestMethodLength - 2, keyToDisplay.length + 2)
      : 0;
    const requestLength = Math.max(
      2,
      screenWidth - requestMethodLength - keyLength,
    );
    await state.log([
      [
        {
          color:
            {
              GET: 22,
              POST: 52,
              PUT: 94,
              DELETE: 244,
              OPTIONS: 19,
              PATCH: 162,
              HEAD: 53,
              TRACE: 6,
              CONNECT: 2,
            }[inboundRequest.method ?? ""] ?? 0,
          text: (inboundRequest.method ?? "GET").toString(),
          length: requestMethodLength - 2,
        },
        {
          color: 32,
          text: keyToDisplay.substring(0, keyLength - 2),
          length: keyLength - 2,
        },
        {
          color: 8,
          text: targetUrl.pathname
            .toString()
            .padStart(requestLength)
            .substring(0, requestLength),
          length: requestLength,
        },
      ],
    ]);
  }

  const shouldMock =
    state.mode === ServerMode.MOCK && !targetUsesSpecialProtocol;

  const foundMock = !shouldMock
    ? null
    : state.mockConfig.mocks.get(uniqueHash) ??
      Array.from(state.mockConfig.mocks.entries())
        .filter(([hash]) => {
          const requestObject: RequestStruct = JSON.parse(
            Buffer.from(uniqueHash, "base64").toString("ascii"),
          );
          const mockRequestObject: RequestStruct = JSON.parse(
            Buffer.from(hash, "base64").toString("ascii"),
          );
          return (
            mockRequestObject.method === requestObject.method &&
            mockRequestObject.url === requestObject.url &&
            (!mockRequestObject.body ||
              mockRequestObject.body === requestObject.body) &&
            Object.entries(mockRequestObject.headers ?? {}).every(
              ([name, value]) =>
                !value ||
                state.config?.unwantedHeaderNamesInMocks?.includes?.(name) ||
                requestObject.headers?.[name] === value,
            )
          );
        })
        .sort(([hash1], [hash2]) => {
          const match2RequestObject: RequestStruct = JSON.parse(
            Buffer.from(hash2, "base64").toString("ascii"),
          );
          const match1RequestObject: RequestStruct = JSON.parse(
            Buffer.from(hash1, "base64").toString("ascii"),
          );
          const match2HasBody = match2RequestObject.body ? 1 : 0;
          const match1HasBody = match1RequestObject.body ? 1 : 0;
          return (
            Object.keys(match2RequestObject.headers ?? {}).length +
            match2HasBody -
            Object.keys(match1RequestObject.headers ?? {}).length -
            match1HasBody
          );
        })[0]?.[1];

  if (shouldMock && !foundMock && state.mockConfig.strict) {
    send(
      502,
      inboundResponse,
      Buffer.from(
        errorPage(
          new Error(`No corresponding mock found in the server. 
          Try switching back to the proxy mode`),
          state.mode,
          "mock",
          url,
        ),
      ),
    );
    return;
  }

  // phase: connection
  let error: Buffer | null = null;
  const startTime = instantTime();
  const outboundHeaders: OutgoingHttpHeaders = {
    ...[...Object.entries(inboundRequest.headers)]
      // host, connection and keep-alive are forbidden in http/2
      .filter(
        ([key]) => !disallowedHttp2HeaderNames.includes(key.toLowerCase()),
      )
      .reduce((acc: any, [key, value]) => {
        acc[key] =
          (acc[key] || "") +
          (!Array.isArray(value) ? [value] : value)
            .map(oneValue => oneValue?.replace(url.hostname, targetHost))
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
  const outboundRequest: ClientHttp2Session | null =
    shouldMock && foundMock
      ? mockRequest({ response: foundMock })
      : targetUsesSpecialProtocol
        ? specialPageMapping[target.protocol.replace(/:$/, "")](
            proxyHostnameAndPort,
            state,
            inboundRequest,
            { target: targetUrl, url, proxyHostname, key, requestBody },
          )
        : await http2Page(proxyHostnameAndPort, state, {
            target: targetUrl,
            url,
          })
            .then(session => {
              if (session) return session;
              return http1Page(
                target,
                url,
                targetUrl,
                fullPath,
                inboundRequest,
                outboundHeaders,
                requestBody,
                bufferedRequestBody,
                state.mode,
              );
            })
            .catch(e => {
              error = e;
              return null;
            });

  const protocol = outboundRequest?.alpnProtocol?.startsWith?.("h2")
    ? "HTTP/2"
    : outboundRequest?.alpnProtocol ?? "HTTP1.1";
  state.notifyLogsListeners({
    level: "info",
    protocol,
    method: inboundRequest.method,
    upstreamPath: path,
    downstreamPath: targetUrl.href,
    randomId,
    uniqueHash,
  });
  if (!((error as any) instanceof Buffer)) error = null;

  const outboundExchange =
    !error &&
    outboundRequest?.request(outboundHeaders, {
      endStream: state.config.ssl
        ? !(http2WithRequestBody ?? true)
        : !http1WithRequestBody,
    });

  typeof outboundExchange === "object" &&
    outboundExchange?.on?.("error", (thrown: Error) => {
      const httpVersionSupported = (thrown as ErrorWithErrno).errno === -505;
      error = Buffer.from(
        errorPage(
          thrown,
          state.mode,
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
  } else if (
    outboundExchange &&
    bufferedRequestBody &&
    requestBodyExpected &&
    !outboundExchange.writableEnded
  ) {
    outboundExchange.write(requestBody);
    outboundExchange.end();
  }

  // phase : response headers
  const { outboundResponseHeaders } = await new Promise<{
    outboundResponseHeaders: IncomingHttpHeaders & IncomingHttpStatusHeader;
  }>(
    resolve =>
      outboundExchange?.on?.("response", headers => {
        resolve({
          outboundResponseHeaders: headers,
        });
      }) ?? resolve({ outboundResponseHeaders: {} }),
  );

  let redirectUrl: URL | null = null;
  try {
    if (outboundResponseHeaders["location"])
      redirectUrl = new URL(
        outboundResponseHeaders["location"].startsWith("/")
          ? `${target.origin}${outboundResponseHeaders["location"].replace(
              /^\/+/,
              `/`,
            )}`
          : outboundResponseHeaders["location"]
              .replace(/^file:\/+/, "file:///")
              .replace(/^(http)(s?):\/+/, "$1$2://"),
      );
  } catch (e) {
    await state.log([
      [
        {
          text: `${EMOJIS.ERROR_4} location replacement error ${(
            outboundResponseHeaders["location"] ?? ""
          ).slice(-13)}`,
          color: LogLevel.WARNING,
        },
      ],
    ]);
  }

  const replacedRedirectUrl =
    !state.config.replaceResponseBodyUrls || !redirectUrl
      ? redirectUrl
      : new URL(
          replaceTextUsingMapping(redirectUrl.href, {
            direction: REPLACEMENT_DIRECTION.INBOUND,
            proxyHostnameAndPort,
            ssl: !!state.config.ssl,
            mapping: state.config.mapping ?? {},
          }).replace(new RegExp(`^(${specialProtocols.join("|")})\/+`), ""),
        );
  const translatedReplacedRedirectUrl = !redirectUrl
    ? redirectUrl
    : replacedRedirectUrl?.origin !== redirectUrl.origin ||
        state.config.dontTranslateLocationHeader
      ? replacedRedirectUrl
      : `${url.origin}${replacedRedirectUrl.href.substring(
          replacedRedirectUrl.origin.length,
        )}`;

  // phase : response body
  const payload: Buffer =
    error ??
    (await new Promise<Buffer>(resolve => {
      let partialBody = Buffer.alloc(0);
      if (!outboundExchange) {
        resolve(partialBody);
        return;
      }
      (outboundExchange as ClientHttp2Stream | Duplex)?.on?.(
        "data",
        (chunk: Buffer | string) => {
          partialBody = Buffer.concat([
            partialBody,
            typeof chunk === "string"
              ? Buffer.from(chunk as string)
              : (chunk as Buffer),
          ]);
          if (serverSentEvents) resolve(partialBody);
        },
      );
      outboundExchange?.on?.("end", () => {
        resolve(partialBody);
      });
    }).then((payloadBuffer: Buffer) => {
      if (!state.config.replaceResponseBodyUrls) return payloadBuffer;
      if (!payloadBuffer.length) return payloadBuffer;
      if (specialProtocols.some(protocol => target.protocol === protocol))
        return payloadBuffer;

      return replaceBody(payloadBuffer, outboundResponseHeaders, {
        proxyHostnameAndPort,
        proxyHostname,
        key,
        direction: REPLACEMENT_DIRECTION.INBOUND,
        mapping: state.config.mapping ?? {},
        port: state.config.port ?? defaultConfig.port,
        ssl: !!state.config.ssl,
      }).catch((e: Error) => {
        send(
          502,
          inboundResponse,
          Buffer.from(errorPage(e, state.mode, "stream", url, targetUrl)),
        );
        return Buffer.from("");
      });
    }));

  // phase : inbound response
  const responseHeaders = {
    ...Object.entries({
      ...outboundResponseHeaders,
      ...(state.config.replaceResponseBodyUrls && !serverSentEvents
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
      ...(serverSentEvents
        ? {
            ["cache-control"]: "no-cache",
            ["x-accel-buffering"]: "no",
          }
        : {}),
    })
      .filter(
        ([h]) =>
          !h.startsWith(":") &&
          !disallowedHttp2HeaderNames.includes(h.toLowerCase()),
      )
      .reduce(
        (acc: any, [key, value]: [string, string | number | string[]]) => {
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
            value as string | string[],
          );

          acc[key] = (acc[key] || []).concat(transformedValue);
          return acc;
        },
        {},
      ),
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
  const statusCode = outboundResponseHeaders[":status"] ?? 200;
  try {
    if (state.config.ssl) {
      inboundResponse.writeHead(statusCode, responseHeaders);
    } else {
      inboundResponse.writeHead(
        statusCode,
        protocol === "HTTP/2"
          ? ""
          : outboundResponseHeaders[":statusmessage"]?.toString() ?? "",
        responseHeaders,
      );
    }
  } catch (e) {}
  if (serverSentEvents) {
    inboundResponse.write(payload);
    (outboundExchange as ClientHttp2Stream | Duplex)?.on?.(
      "data",
      (chunk: Buffer | string) => inboundResponse.write(chunk),
    );
  } else if (payload) inboundResponse.end(payload);
  else inboundResponse.end();
  const endTime = instantTime();

  const response =
    atLeastOneLoggerWantsResponseBody || autoRecordModeEnabled
      ? Buffer.from(
          JSON.stringify({
            body: payload?.toString("base64"),
            headers: outboundResponseHeaders,
            status: statusCode,
          }),
        ).toString("base64")
      : "";

  state.notifyLogsListeners({
    randomId,
    statusCode,
    protocol,
    duration: Math.floor(Number(endTime - startTime) / 1000000),
    uniqueHash,
    response,
  });

  // not using quick status if logAccessInTerminal is enabled
  if (
    autoRecordModeEnabled &&
    !state.config.logAccessInTerminal &&
    !targetUsesSpecialProtocol
  ) {
    state.mockConfig.mocks.set(uniqueHash, response);
    stdout.moveCursor(0, -1, () => stdout.clearLine(-1, state.quickStatus));
  }
};

const errorListener = (state: State, err: Error) => {
  if ((err as ErrorWithErrno).code === "EACCES")
    setTimeout(
      () =>
        state.log([
          [
            {
              text: `${EMOJIS.NO} permission denied for this port`,
              color: LogLevel.ERROR,
            },
          ],
        ]),
      10,
    );
  if ((err as ErrorWithErrno).code === "EADDRINUSE")
    setTimeout(
      () =>
        state.log([
          [
            {
              text: `${EMOJIS.ERROR_6} port is already used. NOT started`,
              color: LogLevel.ERROR,
            },
          ],
        ]),
      10,
    );
};

const start = (config: LocalConfiguration): Promise<State> =>
  update({ config: { ...defaultConfig, ...config } }, { server: null });

const update = async (
  currentState: Partial<State>,
  newState: Partial<State & { pendingConfigSave: LocalConfiguration }>,
): Promise<State> => {
  if (Object.keys(newState ?? {}).length === 0 && currentState.server)
    return newState as State;
  if (newState?.pendingConfigSave) {
    writeFile(
      filename,
      JSON.stringify(newState.pendingConfigSave, null, 2),
      fileWriteErr => {
        if (fileWriteErr)
          currentState.log?.([
            [
              {
                text: `${EMOJIS.ERROR_4} config file NOT saved`,
                color: LogLevel.ERROR,
              },
            ],
          ]);
        else
          currentState.log?.([
            [
              {
                text: `${EMOJIS.COLORED} config file saved... will reload`,
                color: LogLevel.INFO,
              },
            ],
          ]);
      },
    );
    return currentState as State;
  }

  if (newState?.configListeners === null) {
    await Promise.all(
      (currentState.configListeners ?? []).map(
        listener => new Promise(resolve => listener.stream.end(resolve)),
      ),
    );
  }
  if (newState?.logsListeners === null) {
    await Promise.all(
      (currentState.configListeners ?? []).map(
        listener => new Promise(resolve => listener.stream.end(resolve)),
      ),
    );
  }

  if (newState?.server === null && currentState.server) {
    const stopped = await Promise.race([
      new Promise(resolve => currentState.server?.close(resolve)).then(
        () => true,
      ),
      new Promise(resolve => setTimeout(resolve, 5000)).then(() => false),
    ]);
    if (!stopped) {
      await currentState.log?.([
        [
          {
            text: `${EMOJIS.RESTART} error during restart (websockets ?)`,
            color: LogLevel.WARNING,
          },
        ],
      ]);
    }
  }

  (currentState.configListeners ?? [])
    .concat(currentState.logsListeners ?? [])
    .filter(l => l.stream.errored || l.stream.closed)
    .forEach(l => l.stream.destroy());

  const config = newState?.config ?? currentState.config;
  const mode = newState?.mode ?? currentState.mode ?? ServerMode.PROXY;
  const autoRecord =
    newState?.mockConfig?.autoRecord ??
    currentState.mockConfig?.autoRecord ??
    false;
  const strict =
    newState?.mockConfig?.strict ?? currentState.mockConfig?.strict ?? false;
  const mocks =
    newState?.mockConfig?.mocks ??
    currentState.mockConfig?.mocks ??
    new Map<string, string>();
  const configListeners = (
    newState?.configListeners === null
      ? []
      : newState?.configListeners ?? currentState.configListeners ?? []
  ).filter(l => !l.stream.errored && !l.stream.closed);
  const logsListeners = (
    newState?.logsListeners === null
      ? []
      : newState?.logsListeners ?? currentState.logsListeners ?? []
  ).filter(l => !l.stream.errored && !l.stream.closed);

  const state: State = currentState as State;
  Object.assign(state, {
    config,
    logsListeners,
    configListeners,
    mode,
    mockConfig: {
      mocks,
      strict,
      autoRecord,
    },
    configFileWatcher:
      state.configFileWatcher === undefined
        ? watchFile(filename, async (stats: Stats) => {
            update(
              state,
              stats.isFile() ? await onWatch(state) : { server: null },
            );
          })
        : state.configFileWatcher,
    log: log.bind(state, state),
    notifyConfigListeners: notifyConfigListeners.bind(state),
    notifyLogsListeners: notifyLogsListeners.bind(state),
    buildQuickStatus: buildQuickStatus.bind(state),
    quickStatus: quickStatus.bind(state),
    server:
      newState?.server === null && !((newState?.config?.port ?? 0) < 0)
        ? (
            (config?.ssl
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
            .on("upgrade", (request, socket) =>
              update(state, websocketServe(state, request, socket)),
            )
            .listen(config?.port)
        : !newState?.server
          ? null
          : state.server,
  });
  return state;
};

if (crashTest) {
  const port = Math.floor(40151 + Math.random() * 9000);
  const makeRequest = (
    state: State,
    resolve: ({
      state,
      response,
      error,
    }: {
      state: State;
      response?: IncomingMessage;
      error?: Error;
    }) => void,
  ) =>
    httpRequest(
      {
        hostname: "localhost",
        port,
        path: "/config/",
        method: "GET",
        headers: {
          Accept: "text/html",
        },
        timeout: 500,
      },
      response => resolve({ response, state }),
    )
      .on("error", error => resolve({ error, state }))
      .end();

  update(
    { config: { ...defaultConfig, port }, configFileWatcher: null },
    { server: null },
  )
    .then<{ state: State; response: IncomingMessage }>(
      state =>
        new Promise(resolve =>
          setTimeout(makeRequest.bind(null, state, resolve), 1000),
        ),
    )
    .then(({ state, response }) =>
      response.statusCode !== 200
        ? Promise.reject("Crash test has failed")
        : update(state, { config: { port: -1 }, server: null }),
    )
    .then(
      state =>
        new Promise<{ state: State; error: ErrorWithErrno }>(resolve =>
          setTimeout(makeRequest.bind(null, state, resolve), 1000),
        ),
    )
    .then(({ error }) =>
      error?.code !== "ECONNREFUSED"
        ? Promise.reject("Server should have stopped")
        : log({ config: { simpleLogs: true } }, [
            [
              {
                text: `${EMOJIS.COLORED} Crash test successful`,
                color: LogLevel.INFO,
              },
            ],
          ]),
    )
    .then(() => exit(0))
    .catch(() => exit(1));
}

if (!crashTest && runAsMainProgram) {
  load()
    .then(start)
    .then(state => state.quickStatus());
}

export {
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
  cleanEntropy,
  send,
  determineMapping,
  serve,
  update,
};
