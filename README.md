# 🖧 local-traffic

That is a secure http/2 (or insecure http1.1) reverse-proxy installed on your machine

- with 0 transitive dependency
- with 1 install step
- with a startup time of a few milliseconds
- with one 36kb index.js file

How simple is that ?

## pre-requisite

node.js >= 8

## how to start in less than one minute

```bash
npx local-traffic
```

> sudo prefix only required for Linux, when port number < 1024

## how to use it

1. Change the mapping object in the `.local-traffic.json` file:

```json
{
  "mapping": {
    "/npm/": "https://www.npmjs.com/",
    "/my-static-webapp/": "file:///home/user/projects/my-static-webapp/",
    "/config/": "config://",
    "/logs/": "logs://",
    "/jquery-local/jquery.js": {
      "replaceBody": "https://mycdn.net/jquery/jquery-3.6.4.js",
      "downstreamUrl": "file:///home/user/projects/zepto/dist/zepto.js"
    },
    "": "https://github.com/"
  }
}
```

> if you need to deactivate a mapping entry, move it below the "" key

2. Go to [http://localhost:8080/prettier](http://localhost:8080/prettier) with your browser
3. Go to [http://localhost:8080/npm/](http://localhost:8080/npm) with your browser
4. Go to [http://localhost:8080/my-static-webapp/index.html](http://localhost:8080/my-static-webapp/index.html) with your browser (given your project name is my-static-webapp, but I am not 100% sure)
5. Go to [http://localhost:8080/logs/](http://localhost:8080/logs/) to watch the request logs
6. Go to [http://localhost:8080/config/](http://localhost:8080/config/) to change the config in a web editor
7. From the web config editor, create a SSL keypair and start working with a self signed SSL certificate right away
8. Your page will use /jquery-local/jquery.js instead of the CDN asset, and will serve the file from your hard drive
9. Your server now proxies the mapping that you have configured

## usage

### from command line

```bash
npx local-traffic [location-of-the-local-traffic-config-file]
```

> When not specified, the location of the config file will be `$HOME/.local-traffic.json`

### from node.js application (>= 0.0.69)

```bash
 node -e 'const { start } = require("local-traffic"); start({ /* configuration goes here */ })'
 ```

## how to change mappings to local / non-local

1. Open `.local-traffic.json` while running it
2. Edit the mapping keys and downstream urls
3. See the status update in the terminal, that's it.

## all the options

All boolean settings default to false when unspecified.

- `mapping`: (`{[path: string]: string | {replaceBody: string ; downstreamUrl: string}`) routing rules (required)
- `ssl` : SSL options (can be generated from the config web editor if you don't know how to set them)
  - `ssl.cert` : (`string`) Certificate (PEM format)
  - `ssl.key` : (`string`) Private Key (PEM format)
- `port` : (`number`) port number
- `replaceRequestBodyUrls`: (`boolean`) replace every matching string from the mapping in the request body.
- `replaceResponseBodyUrls`: (`boolean`) replace every matching string from the mapping in the response body.
- `dontTranslateLocationHeader`: (`boolean`) when getting a response location header, in case `replaceResponseBodyUrls` does not change the URL, change the origin to the proxy anyway
- `dontUseHttp2Downstream`: (`boolean`) force calling downstream services in http1.1 only (to save some time)
- `simpleLogs`: (`boolean`) disable colored logs for text terminals
- `websocket`: (`boolean`) true to activate websocket connections proxying via sockets. Required for logs UI.
- `disableWebSecurity`: (`boolean`) true for easygoing values in cross origin requests or content security policy headers
