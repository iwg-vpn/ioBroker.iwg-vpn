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

    // removeChildrenIfEmpty(root) {
    //     if (!root || !root.children) {
    //         return;
    //     }
    //     if (root.children.length == 0) {
    //         delete root.children;
    //         return;
    //     }

    //     for (let child of root.children) {
    //         this.removeChildrenIfEmpty(child)
    //     }
    // }

    // getTreeItem(tree, parts) {
    //     if (parts.length == 0) {
    //         return tree
    //     }

    //     let first = parts.shift()
    //     let node = tree.children.find(e => e.friendly_name == first);
    //     if (node) {
    //         // let index = tree.children.findIndex(e => e.friendly_name == first);
    //         return this.getTreeItem(node, parts);
    //     } else {
    //         while (first) {
    //             const child = {
    //                 friendly_name: first,
    //                 children: [],
    //                 id: crypto.randomUUID()
    //             }
    //             tree.children.push(child);
    //             tree = child;
    //             first = parts.shift()
    //         }
    //         return tree;
    //     }
    // }

    // async statesTree() {
    //     let self = this;
    //     let states = (await self.adapter.getObjectView('system', 'state')).rows || [];

    //     // // only writable states
    //     // states = states.filter(s => s.value.common.write);

    //     const tree = {
    //         friendly_name: 'states',
    //         /**
    //         * @type {any[]}
    //         */
    //         children: []
    //     }

    //     for (let s of states) {
    //         let parts = s.id.split('.');
    //         let item = this.getTreeItem(tree, parts);
    //         item.id = s.id;
    //         item.type = s.value.common.type
    //     }

    //     this.removeChildrenIfEmpty(tree);

    //     return tree;
    // }

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
                        // response = await IwgClient.post(`/clients/${IwgClient.id}/accounts`, {});
                        // response = response.data;
                        response = await AlexaHandler.accounts();
                        break;
                    case 'capabilities':
                        if (req.method == 'GET') {
                            // response = await IwgClient.get(`/alexa_capabilities`);
                            // response = response.data;
                            response = await AlexaHandler.capabilities();
                        }
                        break;
                    case 'endpoints':
                        if (req.method == 'GET') {
                            // response = await IwgClient.get(`/clients/${IwgClient.id}/endpoints`);
                            // response = response.data;
                            response = await AlexaHandler.fetchEndpoints();
                        } else if (req.method == 'POST') {
                            let payload = await req.jsonData.promise;
                            // log.silly(`payload: ${JSON.stringify(payload)}`)
                            // response = await IwgClient.post(`/clients/${IwgClient.id}/sync_endpoints`, payload)

                            // if (response.status < 400) {
                            //     response = {
                            //         status: response.status
                            //     };
                            // } else {
                            //     response = null;
                            // }
                            response = await AlexaHandler.postEndpoints(payload);
                        }
                        break;

                    case 'states':
                        if (req.method == 'GET') {
                            if (!id) {
                                // response = await this.statesTree()
                                response = await AlexaHandler.statesTree()
                            }
                            else {
                                const value = id.includes(this.adapter.namespace) ? await this.adapter.getStateAsync(id) : await this.adapter.getForeignStateAsync(id);
                                response = {
                                    address: id,
                                    value: (value || {}).val
                                }
                            }
                        } else if (req.method == 'PUT' && id) {
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
        // res.setHeader("Content-Type", "text/html");
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
                    log.debug('Failed parsing request payload')
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
