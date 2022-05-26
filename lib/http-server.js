const http = require("http");
const path = require("path");
const fs = require('fs').promises;

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
            if (resource && id) {
                switch (resource) {
                    case 'states':
                        if (req.method == 'GET') {
                            const value = id.includes(this.adapter.namespace) ? await this.adapter.getStateAsync(id) : await this.adapter.getForeignStateAsync(id);
                            response = {
                                address: id,
                                value: (value || {}).val
                            }
                        } else if (req.method == 'POST') {
                            const params = uri.split('?');
                            if (params.length > 1) {
                                const keyValue = params[1].split('=');
                                if (keyValue.length > 1) {
                                    const newValue = keyValue[1];
                                    id.includes(this.adapter.namespace) ? await this.adapter.setStateAsync(id, newValue, false) : await this.adapter.setForeignStateAsync(id, newValue, false);
                                    const value = id.includes(this.adapter.namespace) ? await this.adapter.getStateAsync(id) : await this.adapter.getForeignStateAsync(id);
                                    response = {
                                        address: id,
                                        value: (value || {}).val
                                    }

                                }
                            }
                        }
                        break;
                    case 'objects':
                        if (req.method == 'GET') {
                            const value = id.startsWith(this.adapter.namespace) ? await this.adapter.getObjectAsync(id) : await this.adapter.getForeignObjectAsync(id);
                            // const value = await this.adapter.getForeignObjectAsync(id);
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

    async deliverStatic(res, fileName) {
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
        return this.deliverStatic(req, res);
    }

    async processStaticJs(req, res) {
        res.setHeader('Content-Type: text/javascript');
        return this.deliverStatic(req, res);
    }

    async processStaticCss(req, res) {
        res.setHeader('Content-Type: text/css');
        return this.deliverStatic(req, res);
    }

    notFound(res) {
        // res.setHeader("Content-Type", "text/html");
        res.writeHead(404);
        res.end(`<html><body><h1>Not Found</h1></body></html>`);
        return;
    }

    async requestProcessor(req, res) {
        if (req.url.includes('/api/v1/')) {
            return await this.processApiCall(req, res);
        } else {
            const uri = req.url;
            // let fileName = uri ? ((uri.match('^[^?]*') || [])[0] || '').split('/').slice(1)[0] : ''
            let fileName = uri ? (uri.match('^[^?]*') || [])[0] || '' : ''
            if (fileName == '' || fileName.endsWith('/')) {
                fileName += 'index.html'
            }
            return await this.deliverStatic(res, fileName);
        }
    }

    async start() {
        const host = '0.0.0.0';
        const port = 51822;
        this.server = http.createServer(this.requestProcessor.bind(this));
        this.server.listen(port, host, () => {
            log.debug(`HTTP server is listening on http://${host}:${port}`);
        });
        this.server.on("close", function() { log.silly("HTTP server closed"); });
    }

    stop() {
        if (this.server) {
            this.server.close();
        }
    }
}

module.exports = HttpServer;