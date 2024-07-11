import('node:fs/promises')
    .then(({ readFile }) => readFile(process.argv[2]))
    .then(async code => await import('node:zlib').then(({ gzip }) =>
        new Promise(resolve => gzip(Buffer.from(code),
            (_, data) => resolve(`#!/usr/bin/env node\nrequire('util').promisify((require('zlib')).gunzip)(Buffer.from("${data.toString("base64")}","base64")).then(c => eval(c.toString("utf8")))`)))))
    .then(console.log)
