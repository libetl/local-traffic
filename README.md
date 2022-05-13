# 🖧 local-traffic

That is a secure http/2 (or insecure http1.1) reverse-proxy installed on your machine

- without any library,
- without startup time
- without boring steps
- just a tiny 9.5kb file.

## pre-requisite

node.js >= 8

## how to start in less than one minute

```bash
npx local-traffic
```

(sudo prefix only for MacOS / linux)

## how to use it

1. Change that mapping in the `.local-traffic.json` file: 

```json
{
    "mapping": {
      "/npm": "https://www.npmjs.com/",
      "/my-static-webapp": "file:///home/user/projects/my-static-webapp",
      "": "https://github.com/"
  },
}
```
> "" mapping must always come last
2. Go to [https://localhost/prettier](https://localhost/prettier) with your browser
3. Go to [https://localhost/npm](https://localhost/npm) with your browser
3. Go to [https://localhost/my-static-webapp](https://localhost/my-static-webapp/index.html) with your browser
   (given your project name is my-static-webapp, but I am not 100% sure)
4. Your server now proxies the mapping that you have configured

## usage

```bash
npx local-traffic [location-of-the-local-traffic-config-file]
```
> When not specified, the location of the config file will be `$HOME/.local-traffic.json`

## how to change mappings to local / non-local

1. Open `.local-traffic.json`
2. Edit the matches (keys) and target hosts (values).
3. No need to restart the server after editing.

## all the options

- "mapping": ({[path: string]: string}) routing rules (required)
- "ssl" : SSL options
  * "ssl.cert" : (string) Certificate (PEM format)
  * "ssl.key" : (string) Private Key (PEM format)
- "port" : (number) port number
- "replaceResponseBodyUrls": (boolean) replace every matching string from the mapping in the response body.
- "dontUseHttp2Downstream": (boolean) force calling downstream services in http1.1 only (to save some time)
- "simpleLogs": (boolean) disable colored logs for text terminals
- "websocket": (boolean) true to activate websocket connections proxying via sockets
