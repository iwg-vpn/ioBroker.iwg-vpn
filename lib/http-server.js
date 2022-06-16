const http = require("http");
const path = require("path");
const fs = require('fs').promises;
const AlexaHandler = require("./alexa-handler");
const Deferred = require(path.join(__dirname, 'deferred'));

let log;
class HttpServer {
    constructor(adapter) {
        this.adapter = adapter;
        log = adapter.log;
        this.server = null;
    }

    async processApiCall(req, res) {
        let response = null;
        let id;
        try {
            let uri = req.url.replace('/api/v1', '');
            let [resource, resId, ...rest] = uri ? ((uri.match('^[^?]*') || [])[0] || '').split('/').slice(1) : [];
            id = resId;
            if (resource) {
                switch (resource) {
                    case 'accounts':
                        response = await AlexaHandler.accounts();
                        break;
                    case 'capabilities':
                        if (req.method == 'GET') {
                            response = await AlexaHandler.capabilities();
                        }
                        break;
                    case 'endpoints':
                        if (req.method == 'GET') {
                            response = await AlexaHandler.fetchEndpoints();
                        } else if (req.method == 'POST') {
                            let payload = await req.jsonData.promise;
                            response = await AlexaHandler.postEndpoints(payload);
                        }
                        break;

                    case 'states':
                        if (req.method == 'GET') {
                            if (!id) {
                                response = await AlexaHandler.statesTree()
                            }
                            else {
                                const value = id.includes(this.adapter.namespace) ? await this.adapter.getStateAsync(id) : await this.adapter.getForeignStateAsync(id);
                                response = {
                                    address: id,
                                    value: (value || {}).val
                                }
                            }
                        } else if (['PUT', 'POST'].includes(req.method) && id) {
                            let ack = false;
                            let newValue = null;    

                            // first, inspect the query params
                            const params = uri.split('?');
                            if (params.length > 1) {
                                const keyValuePairs = params[1].split('&');
                                for(let keyValuePair of keyValuePairs) {
                                    const key = keyValuePair.split('=')[0];    
                                    if (key == 'value') {
                                        newValue = keyValuePair.split('=')[1];
                                    } else if (key == 'ack') {
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
                                log.silly(`setting ${id} to ${newValue} with ack=${ack}`)
                                id.includes(this.adapter.namespace) ? await this.adapter.setStateAsync(id, newValue, ack) : await this.adapter.setForeignStateAsync(id, newValue, ack);
                                const value = id.includes(this.adapter.namespace) ? await this.adapter.getStateAsync(id) : await this.adapter.getForeignStateAsync(id);
                                
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
                        if (req.method == 'GET') {
                            const value = id.startsWith(this.adapter.namespace) ? await this.adapter.getObjectAsync(id) : await this.adapter.getForeignObjectAsync(id);
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
            response = {
                address: id,
                value: null
            }
            res.writeHead(400);
        } else {
            res.writeHead(200);
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
        return;
    }

    async requestProcessor(req, res) {
        if (req.method == 'POST') {
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


        if (req.url.includes('/api/v1/')) {
            return await this.processApiCall(req, res);
        } else {
            const uri = req.url;
            let fileName = uri ? (uri.match('^[^?]*') || [])[0] || '' : ''
            if (fileName == '' || fileName.endsWith('/')) {
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
