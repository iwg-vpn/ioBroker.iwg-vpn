const http = require("http");
const path = require("path");
const fs = require('fs').promises;
const Deferred = require(path.join(__dirname, 'deferred'));
const nodeCrypto = require('crypto');
const HttpClient = require("./http-client");
const FileSystemHelper = require('./file-system-helper');
const AlexaClient = require("./alx-client");
const AdapterProvider = require('./adapter-provider');

const API_VERSION = process.env.IWG_API_VERSION;

let log;
class HttpServer {
    constructor() {
        log = AdapterProvider.get().log;
        this.server = null;
        this.serverPublicKey = null;
        this.whiteListedStates = null;
    }

    async statesWhiteList() {
        try {
            if (this.whiteListedStates == null) {
                const fileName = FileSystemHelper.absolutePath('white_listed_states.conf');
                if (FileSystemHelper.exists(fileName)) {
                    this.whiteListedStates = (await FileSystemHelper.read(fileName)).toString().replace(/\r\n/g, '\n').split('\n');
                } else {
                    this.whiteListedStates = []
                }
            }
        } catch (e) {
            log.error(e)
        }
        return this.whiteListedStates;
    }

    async wellKnownPublicKey() {
        if (!this.serverPublicKey) {
            let response = await HttpClient.get(HttpClient.composeAbsoluteUrl(`/.well-known/public_key`, API_VERSION));
            this.serverPublicKey = decodeURIComponent(response.data.public_key);
        }

        return this.serverPublicKey;
    }

    async isTrustworth(message, sig) {

        function verifySignature(message, signature, publicKey) {
            const verifier = nodeCrypto.createVerify('RSA-SHA256');
            verifier.update(message);
            return verifier.verify(publicKey, signature, 'base64');
        }

        let pub = await this.wellKnownPublicKey();

        let trustworthy = verifySignature(message, sig, pub);

        if (!trustworthy) {
            let trustworth = nodeCrypto.verify(
                'rsa-sha256',
                Buffer.from(message),
                { key: pub },
                Buffer.from(sig, 'base64')
            );

            if (!trustworth) {
                return false;
            }    
        }

        const time = new Date(message)
        const seconds = ((new Date()).getTime() - time.getTime()) / 1000
        log.silly(`clock skew in seconds: ${seconds}`)
        // return seconds < 3;

        return true;
    }

    async processApiCall(req, res) {
        let response = null;
        let id;
        let responseCode = 200;
        const adapter = AdapterProvider.get();
        try {
            let uri = req.url.replace(`/api/${API_VERSION}`, '');
            let [resource, resId, ...rest] = uri ? ((uri.match('^[^?]*') || [])[0] || '').split('/').slice(1) : [];
            id = resId;

            if (resource) {

                switch (resource) {
                    case 'accounts':
                        response = await AlexaClient.accounts();
                        break;
                    case 'endpoints':
                        if (req.method === 'GET') {
                            response = await AlexaClient.fetchEndpoints();
                        } 
                        break;

                    case 'states':
                        if (req.method === 'GET') {
                            if (!id) {
                                response = {
                                    address: null,
                                    value: null
                                }
                            } else {
                                const value = id.includes(adapter.namespace) ? await adapter.getStateAsync(id) : await adapter.getForeignStateAsync(id);
                                response = {
                                    address: id,
                                    value: (value || {}).val
                                }
                            }
                        } else if (['PUT', 'POST'].includes(req.method) && id) {
                            let whiteListedStates = await this.statesWhiteList();
                            if (!whiteListedStates?.includes(id)) {
                                const sig = req.headers['x-iwg-sig'];
                                const message = req.headers['x-iwg-ts'];

                                if (!sig || !message || !(await this.isTrustworth(message, sig))) {
                                    responseCode = 403;
                                    log.silly(`blocked a request trying to set state ${id}`)
                                    throw new Error('not a trustworthy api call')
                                }
                            }

                            let ack = false;
                            let newValue = null;

                            // first, inspect the query params
                            const params = uri.split('?');
                            if (params.length > 1) {
                                const keyValuePairs = params[1].split('&');
                                for (let keyValuePair of keyValuePairs) {
                                    const key = keyValuePair.split('=')[0];
                                    if (key === 'value') {
                                        newValue = keyValuePair.split('=')[1];
                                    } else if (key === 'ack') {
                                        ack = !!(keyValuePair.split('=')[1]);
                                    }
                                }
                            }
                            // if no value provided as query parameter, examine the payload
                            if (!newValue) {
                                let payload = (await req.jsonData.promise) || {};
                                newValue = payload.value ? payload.value : JSON.stringify(payload);
                                ack = payload.ack ? payload.ack : false;
                            }

                            if (newValue) {
                                // try to convert string to number if needed
                                try {
                                    const value = id.startsWith(adapter.namespace) ? await adapter.getObjectAsync(id) : await adapter.getForeignObjectAsync(id);
                                    const type = value.common.type;
                                    if (type === 'number') {
                                        const newValueAsNumber = parseInt(newValue)
                                        if (!isNaN(newValueAsNumber)) {
                                            newValue = newValueAsNumber
                                        }
                                    } else if (type === 'boolean') {
                                        newValue = newValue?.toLowerCase?.() === 'true';
                                    }
                                } catch {
                                    // nop
                                }

                                log.silly(`setting ${id} to ${newValue} with ack=${ack}`)

                                let setter, getter;
                                if (id.includes(adapter.namespace)) {
                                    setter = adapter.setStateAsync;
                                    getter = adapter.getStateAsync;
                                } else {
                                    setter = adapter.setForeignStateAsync;
                                    getter = adapter.getForeignStateAsync;
                                }

                                await setter(id, newValue, ack);
                                const value = await getter(id);

                                let valueToReturn = (value || {}).val;

                                // in case it's a stringified object
                                try {
                                    valueToReturn = JSON.parse(valueToReturn)
                                } catch {
                                    // nop
                                }

                                response = {
                                    address: id,
                                    value: valueToReturn
                                }
                            } else {
                                log.warn(`no value provided while setting ${id}`)
                            }
                        }
                        break;

                    case 'objects':
                        if (req.method === 'GET') {
                            const value = id.startsWith(adapter.namespace) ? await adapter.getObjectAsync(id) : await adapter.getForeignObjectAsync(id);
                            response = {
                                address: id,
                                value: value
                            }
                        }
                        break;

                    default:
                        response = {
                            address: id,
                            value: null
                        }
                }
            }
        } catch (e) {
            log.error(e);
        }

        res.setHeader('Content-Type', 'application/json');

        if (!response) {
            if (responseCode === 403) {
                response = { result: 'Forbidden' }
            } else {
                responseCode = 400;
                response = {
                    address: id,
                    value: null
                }
            }
            res.writeHead(responseCode);
        } else {
            res.writeHead(responseCode);
        }

        return res.end(JSON.stringify(response))
    }

    async serveStatic(res, fileName) {
        try {
            const content = await fs.readFile(path.join(__dirname, `/../www/${fileName}`));

            if (fileName.endsWith('.js')) {
                res.setHeader('Content-Type', 'text/javascript');
            } else if (fileName.endsWith('.css')) {
                res.setHeader('Content-Type', 'text/css');
            } else {
                res.setHeader('Content-Type', 'text/html');
            }
            res.writeHead(200);
            return res.end(content);
        } catch (e) {
            return this.notFound(res);
        }
    }

    async processStaticHtml(req, res) {
        res.setHeader('Content-Type', 'text/html');
        return this.serveStatic(req, res);
    }

    async processStaticJs(req, res) {
        res.setHeader('Content-Type: text/javascript');
        return this.serveStatic(req, res);
    }

    async processStaticCss(req, res) {
        res.setHeader('Content-Type: text/css');
        return this.serveStatic(req, res);
    }

    notFound(res) {
        res.writeHead(404);
        res.end(`<html><body><h1>Not Found</h1></body></html>`);
    }

    async requestProcessor(req, res) {
        if (req.method === 'POST') {
            req.jsonData = new Deferred();
            let data = '';
            req.on('data', chunk => {
                data += chunk;
            })
            req.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    log.silly(`got request payload: ${data}`);
                    req.jsonData.resolve(jsonData)
                } catch (e) {
                    log.debug(`Failed parsing request payload: ${data}`)
                    req.jsonData.resolve({})
                }
                // res.end();
            })
        }


        if (req.url.includes(`/api/${API_VERSION}/`)) {
            return await this.processApiCall(req, res);
        } else {
            const uri = req.url;
            let fileName = uri ? (uri.match('^[^?]*') || [])[0] || '' : ''
            if (fileName === '' || fileName.endsWith('/')) {
                fileName += 'index.html'
            }
            return await this.serveStatic(res, fileName);
        }
    }

    async start() {
        const host = '0.0.0.0';
        const port = 51822;
        this.server = http.createServer(this.requestProcessor.bind(this));
        this.server.listen(port, host, () => {
            log.debug(`HTTP server is listening on http://${host}:${port}`);
        });
        this.server.on("close", function () { log.silly("HTTP server closed"); });
    }

    stop() {
        if (this.server) {
            this.server.close();
        }
    }
}

module.exports = HttpServer;
