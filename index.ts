import { createServer, request as httpsRequest, RequestOptions } from 'https'
import { URL } from 'url';
import { readFileSync, watchFile } from 'fs'
import { resolve } from 'path';
import { IncomingMessage, ServerResponse, request as httpRequest } from 'http';

const filename = resolve(__dirname, 'config.json')
let config:
    {
        mapping: { [subPath: string]: string },
        ssl: { cert: string, key: string },
        port: number,
    } = JSON.parse(readFileSync(filename).toString())

watchFile(filename, () => {
    config = JSON.parse(readFileSync(filename).toString())
    console.log('mapping is reloaded')
});

const envs: () => { [prefix: string]: URL } = () => ({
    ...Object.assign({},
        ...Object.entries(config.mapping)
            .map(([key, value]) =>
                ({ [key]: new URL(value.replace(/\/$/, '')) })))
})

createServer(config.ssl,
    async (request: IncomingMessage, response: ServerResponse) => {
        const url = new URL(`https://${request.headers.host}${request.url}`)
        const path = url.href.substring(url.origin.length)
        const [key, target] = Object.entries(envs()).find(([key]) => path.match(RegExp(key)))!
        if (!target) {
            response.statusCode = 302
            response.setHeader('location', !envs()[''] ? 'https://www.google.com':envs()[''].href)
            return
        }
        const targetHost = target.host.replace(RegExp(/\/+$/), '')
        const targetPrefix = target.href.substring('https://'.length + target.host.length)
        const fullPath = `${targetPrefix}${
            path.replace(RegExp(key.replace(/\/$/, '')), '')}`.replace(/^\/*/, '/')
        const targetUrl = new URL(`https://${targetHost}${fullPath}`)

        const headers = {
            ...
            [...Object.entries(request.headers)]
                .reduce((acc: any, [key, value]) => {
                    acc[key] = (acc[key] || '') +
                        (!Array.isArray(value) ? [value] : value)
                            .map(oneValue => oneValue.replace(url.hostname, targetHost))
                            .join(', ')
                    return acc;
                }, {}),
            host: targetHost,
            origin: target.href,
            referer: targetUrl,
        }
        const config: RequestOptions & { decompress: boolean } = {
            hostname: target.hostname,
            path: fullPath,
            port: target.port,
            protocol: target.protocol,
            rejectUnauthorized: false,
            method: request.method,
            headers,
            decompress: false,
        }
        const responseFromDownstream: IncomingMessage = await new Promise(resolve => {
            const requestInProgress = target.protocol === 'https:'
            ? httpsRequest(config, resolve)
            : httpRequest(config, resolve)
            request.on('data', chunk => requestInProgress.write(chunk));
            request.on('end', () => requestInProgress.end());
        })
        const newUrl = !responseFromDownstream.headers['location'] ? null :
            new URL(
                responseFromDownstream.headers['location'].startsWith('/') ?
                    `${target.href}${responseFromDownstream.headers['location']
                        .replace(/^\/+/, '')}` :
                    responseFromDownstream.headers['location'])
        const newPath = !newUrl ? null : newUrl.href.substring(newUrl.origin.length)
        const newTarget = url.origin
        const newTargetUrl = !newUrl ? null : `${newTarget}${newPath}`
        const payload = await new Promise(resolve => {
            let partialBody = Buffer.alloc(0);
            responseFromDownstream.on('data', chunk =>
                partialBody = Buffer.concat([partialBody, chunk]));
            responseFromDownstream.on('end', () => { resolve(partialBody); });
        });

        const responseHeaders = {
            ...
            Object.entries(responseFromDownstream.headers)
                .reduce((acc: any, [key, value]: [string, string | string[]]) => {

                    const allSubdomains =
                        targetHost.split('').map((_, i) =>
                            targetHost.substring(i).startsWith('.')
                            && targetHost.substring(i))
                            .filter(subdomain => subdomain) as string[];

                    const transformedValue =
                        [targetHost].concat(allSubdomains)
                            .reduce((acc1, subDomain) =>
                                (!Array.isArray(acc1) ? [acc1] : acc1 as string[])
                                    .map(oneElement =>
                                        oneElement.replace(`Domain=${subDomain}`,
                                            `Domain=${url.hostname}`)),
                                value)

                    acc[key] = (acc[key] || []).concat(transformedValue);
                    return acc;
                }, {}),
            ...(newTargetUrl
                ? { location: [newTargetUrl] }
                : {})
        }

        response.writeHead(responseFromDownstream.statusCode,
            responseFromDownstream.statusMessage,
            responseHeaders);
        if (payload) response.end(payload);
        else response.end()
    }).listen(config.port)

console.log(`proxy listening on port ${config.port}`)
