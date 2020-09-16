# 🖧 local-egencia

Egencia [reverse-proxy](https://github.expedia.biz/Egencia/reverse-proxy) :

- without java libs,
- without spring boot,
- just a tiny 4kb file.

## pre-requisite

node.js >= 8

## how to start in less than one minute

```bash
git clone --single-branch --branch release git@github.expedia.biz:lbenychou/local-egencia.git
sudo ./local-egencia/localEgencia.js

```

(sudo prefix only for MacOS / linux)

## how to use it

1. Go to [https://localhost/home](https://localhost/home) with your browser
2. If you need to login, just login.

No need to have a `local.egencia.com` for domain name.
It is working fine without it.

## how to change mappings to local / non-local

1. Open `config.json` in your `local-egencia` directory
2. Edit the matches (keys) and target hosts (values).
3. No need to restart the server after editing.

`config.json` already has a few entries to help you.
The matches can be regular expressions.
