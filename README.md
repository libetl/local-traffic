# 🖧 local-traffic

That is a secure http/2 (or insecure http1.1) reverse-proxy installed on your machine

- with 0 transitive dependency
- with 1 install step
- with a startup time of a few milliseconds
- with one 29kb index.js file

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
    "/my-non-existing-webapp/": "file:///home/user/random/404.html",
    "/welcome/": "data:text/html,<a href=\"https://ac.me/acme.js\">See my hobby project</a>",
    "/(see-this-example|yet-another-example)": "http://example.com/$$1",
    "/config/": "config://",
    "/logs/": "logs://",
    "/recorder/": "recorder://",
    "/jquery-local/jquery.js": {
      "replaceBody": "https://ac.me/acme.js",
      "downstreamUrl": "file:///home/user/projects/zepto/dist/zepto.js"
    },
    "/local-traffic-worker.js": "worker://",
    "/proxified-api/": "https://some-cors-restricted-domain.com/some-restricted-api/",
    "": "https://github.com/"
  }
}
```

> if you need to deactivate a mapping entry, move it below the "" key

2. Go to [http://localhost:8080/prettier](http://localhost:8080/prettier) with your browser
3. Go to [http://localhost:8080/npm/](http://localhost:8080/npm) with your browser
4. Go to [http://localhost:8080/my-static-webapp/index.html](http://localhost:8080/my-static-webapp/index.html) to test your webapp
5. Go to [http://localhost:8080/my-non-existing-webapp/admin/permissions](http://localhost:8080/my-non-existing-webapp/admin/permissions) to test your 404 page (>= 0.1.1)
6. Go to [http://localhost:8080/see-this-example](http://localhost:8080/see-this-example) or to [http://localhost:8080/yet-another-example](http://localhost:8080/yet-another-example) with your browser. Starting 0.0.89 and above, it supports regular expressions, and it is able to match them against the destination through string interpolation. Start with a double dollar sign (`$$`) followed by the index of the value in the [match array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/match#return_value)
7. Go to [http://localhost:8080/welcome/](http://localhost:8080/welcome/) with your browser (data urls work with version >= 0.0.95)
8. Go to [http://localhost:8080/logs/](http://localhost:8080/logs/) to watch the request logs
9. Go to [http://localhost:8080/config/](http://localhost:8080/config/) to change the config in a web editor
10. You can use the [http://localhost:8080/recorder/](recorder) to turn your proxy into a mock server. There is a user interface and also an API (documented [here](#recorder-api))
11. From the web config editor, create a SSL keypair and start working with a self signed SSL certificate right away
12. Your page will use /jquery-local/jquery.js instead of the CDN asset, and will serve the file from your hard drive
13. Use the /local-traffic-worker.js service worker to walk around the CORS restrictions when your api does a request to some-cors-restricted-domain.com (>= 0.1.4)

## usage

### from your terminal, using the command line

```bash
npx local-traffic [location-of-the-local-traffic-config-file]
```

> When not specified, the location of the config file will be `$HOME/.local-traffic.json`

### from a node.js application (>= 0.0.72)

```bash
 node -e 'require("local-traffic").start({ /* configuration goes here */ })'
```

### from a web container (>= 0.1.18)

1. Add `local-traffic` to the dependencies
2. Use the notation `require('local-traffic').start({ /* configuration goes here */ })'`
3. Disable web security to benefit from cross origin adequate config (`disableWebSecurity: true`)
4. Downgrade downstream http to 1.1 only (`dontUseHttp2Downstream: true`)
5. Don't forget to use a CORS proxy server : use the `crossOriginUrlPattern` parameter to specify it
(example : `"https://corsproxy.io/?url=${href}"`)
6. If you want to use local domain names in addition to remote domain names, add them to the `crossOriginWhitelist`

## how to change mappings to local / non-local

1. Open `.local-traffic.json` while running it, or use the config web editor
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
- `logAccessInTerminal`: (`boolean` | 'with-mapping') write an access log in the terminal on each call (>= 0.1.2 : 'with-mapping' will log the key used to find the target)
- `websocket`: (`boolean`) true to activate websocket connections proxying via sockets. Required for logs UI.
- `disableWebSecurity`: (`boolean`) true for easygoing values in cross origin requests or content security policy headers
- `connectTimeout`: (`number`) max time before aborting the connection (defaults to 3000ms)
- `socketTimeout`: (`number`) max time waiting for a response (defaults to 3000ms)
- `unwantedHeaderNamesInMocks`: (`string[]`) header names that won't get added to the mock request matchers
- `crossOriginUrlPattern`: (`string`) change url to target a cors proxy, from a webcontainer (>= 0.1.18)
- `crossOriginWhitelist` (`string[]`) domain names used in a webcontainer that should not go through cors proxy (>= 0.1.18)

## config API

(>= 0.1.1)
The configuration can be manipulated programmatically with an API.
It can be used if someone needs to automatically switch the routes or the options.
It can be used for canary deployment strategy (to switch between odd domain and even domain)

### post, put

Argument : the config itself

Updates the config, returns the new config once the update is complete

### get, head

Retrieves the current configuration.
use `Accept: application/json` to use the API mode.

```bash
$ curl https://localhost:8443/config/ -XGET -k -H'Accept: application/json'
{"mapping":{"/config/":"config://","":"https://github.com/"},"port":443,"replaceRequestBodyUrls":true,"replaceResponseBodyUrls":true}
```

## recorder API

(>= 0.0.86)
The recorder can be used programmatically with an API.
This can be used if someone needs to automatically record mocks during instance provisioning
(when the machine boots up using a cloud provider for example)

The API always matches the route targetting `recorder://`.

### post, put

Arguments :
| parameter     | Type                     | Description                  | Defaults|
| ------------- | ------------------------ | ---------------------------- | --------|
| mode          | "proxy" or "mock"        | server mode                  | "proxy" |
| strict        | boolean                  | errors when no mock is found | false   |
| autoRecord    | boolean                  | adds mocks from server       | false   |
| mocks         | {uniqueHash,response}[]  | mocks definition             | []      |

The recorder webapp can take care of the mocks by itself,
so `autoRecord` is only necessary when using local-traffic headless or without human
intervention

### delete

The mock config will be reset to empty : 
- `autoRecord` will be set to false
- `mocks` will be purged

### get

Retrieves the current mock configuration.
use `Accept: application/json` to use the API mode.

```bash
$ curl https://localhost:8443/recorder/ -XGET -k -H'Accept: application/json'
{"mocks":[],"strict":false,"autoRecord":false,"mode":"proxy"}
```
