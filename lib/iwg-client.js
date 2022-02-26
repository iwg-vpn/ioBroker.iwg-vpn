const SERVER = 'iwg-vpn.net';
const PROTOCOL = 'https';
process.env.NODE_ENV = 'production';
const NodeRSA = require('node-rsa');
const { default: axios } = require('axios');
const fs = require('fs');
const jwt = require('jwt-simple');
const childProcess = require("child_process");
const os = require('os');
const { threadId } = require('worker_threads');

let log;
const keysDir = __dirname + '/../keys/';
const wgConfigDir = __dirname + '/../wg-config/';
const wgConfigDirIob = __dirname + '/../wg-config-iob/';
const INITIAL_HEARTBEAT_RATE = 2 * 60 * 1000;
const STOPPED = 'stopped';

class Deferred {
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.reject = reject
            this.resolve = resolve
        })
    }
}

class IwgClient {
    constructor(adapter) {
        log = adapter.log;
        this.settings = {};
        this.adapter = adapter;
        this.wg_quick = null;
        this.stopped = new Deferred();
        this.wgConfigFromServer = {};
    }

    async start() {
        try {
            let isLinux = ['freebsd', 'linux', 'openbsd'].indexOf(process.platform) != -1;

            if (!isLinux) {
                log.error(`The platform ${process.platform} is currently not supported`);
                return;
            }

            try {
                const wg = await this.run('which wg-quick');
                this.wg_quick = wg.replace(os.EOL, '');
            } catch (e) {
                log.error(`Couldn't find wg-quick. please follow the adapter How-To documentation`);
                return;
            }

            try {
                const wg = await this.run('which wg');
                this.wg = wg.replace(os.EOL, '');

            } catch (e) {
                log.error(`Couldn't find wg. Please follow the adapter How-To documentation`);
                return;
            }

            if (isLinux && !fs.existsSync(`/etc/sudoers.d/iobroker_iwg`)) {
                log.error(`The iobroker hasn't got required permissions assigned. Please follow the adapter How-To documentation`);
                return;
            } else { // something to be done for windows?

            }

            await this.generateKeys();

            this.id = await this.getClientId();

            if (this.id) {
                await this.callWithExponentialBackoff(this.register.bind(this));
                if (this.registered) {
                    const respond = await this.createLocalPeer();
                    const localIp = respond.config.assigned_cidrs[0].split('/')[0];
                    this.adapter.setLocalPeerAddress(localIp);

                    await this.publishPeers();

                    this.adapter.setConnectionStatus(true);
                    this.sync();
                    this.updateWgInfo();
                } else {
                    log.error(`Could not register. Suspending...`)
                }
            } else {
                log.error(`Could not get iobroker id. Suspending...`)
            }
        }
        catch (e) {
            log.error(`Ups... something went wrong. ${e}`);
        }
    }

    stop() {
        log.silly(`adapter stopped`);
        this.stopped.resolve(STOPPED);
        this.adapter.setConnectionStatus(false);
        if (this.configFile) {
            this.down();
        }
    }

    /**
     * @param {number} ms
     */
    sleep(ms) {
        log.silly(`sleeping for ${ms}ms`);
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    /**
     * @param {string} cmd
     */
    async run(cmd) {
        return new Promise((resolve, reject) => {
            childProcess.exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                }
                if (stderr) {
                    reject(stderr);
                }
                resolve(stdout);
            });
        });
    }


    /**
     * @param {string} cmd
     */
    async runInShell(cmd, args = [], input = '') {
        return new Promise((resolve, reject) => {
            const result = childProcess.spawnSync(cmd, args, { input: input, shell: true });
            if (result.error || result.status != 0) {
                reject(result);
            } else {
                resolve(result);
            }
        });
    }

    isWarning(e) {
        const message = typeof (e) == 'string' ? e : (e && e.hasOwnProperty('message') && typeof (e.message == 'string') ? e.message : '')
        return message.indexOf('Warning') != -1;
    }

    async down() {
        try {
            const cmd = `sudo ${this.wg_quick} down ${this.configFile}`;
            log.silly('getting interface down');
            await this.run(cmd);
        } catch (e) {
            if (!this.isWarning(e)) {
                log.debug('failed to get WireGuard interface down')
                log.silly(e);
            }
        }
    }

    async up() {
        try {
            const cmd = `sudo ${this.wg_quick} up ${this.configFile}`;
            log.silly('getting interface up');
            await this.run(cmd);
        } catch (e) {
            if (!this.isWarning(e)) {
                log.error('Failed to get WireGuard interface up')
                throw e;
            }
        }
    }

    async restartInterface() {
        await this.down();
        await this.up();
    }

    async applyConfig(wgConfigFromServer) {
        try {
            if (typeof (wgConfigFromServer) == 'string') {
                wgConfigFromServer = JSON.parse(wgConfigFromServer);
            }
        } catch (e) {
            log.error(`Error parsing config ${wgConfigFromServer}. ${e}`);
            return;
        }

        log.silly(`applying config ${JSON.stringify(wgConfigFromServer)}`);

        try {
            // replace placeholder with data
            wgConfigFromServer.local = wgConfigFromServer.local.replace('<private_key>', this.settings.keys.localPeerPrivateKey);

            if (this.wgConfigFromServer.local != wgConfigFromServer.local) {
                log.debug('local peer config changed or started with no config');

                this.configFile = `${wgConfigDir}${wgConfigFromServer.interface}.conf`;

                try {
                    // write to file
                    if (!fs.existsSync(wgConfigDir)) {
                        fs.mkdirSync(wgConfigDir);
                    }

                    log.silly('persisting new config');
                    fs.writeFileSync(this.configFile, wgConfigFromServer.local);
                } catch (err) {
                    log.warning(`Error while writing local peer config file`);
                    log.error(err);
                    log.info(`Giving it another try...`);

                    // write to file
                    if (!fs.existsSync(wgConfigDirIob)) {
                        fs.mkdirSync(wgConfigDirIob);
                    }

                    this.configFile = `${wgConfigDirIob}${wgConfigFromServer.interface}.conf`;

                    log.debug('persisting new config');
                    fs.writeFileSync(this.configFile, wgConfigFromServer.local);
                }

                // apply changes to interface
                await this.restartInterface();

                // store the server wireguard config as latest local own
                this.wgConfigFromServer.local = wgConfigFromServer.local;

                // TODO: update adapters states ?
            }
        } catch (e) {
            log.error(`Error while applying local peer config`);
            log.error(e);
        }

        // PEERS

        try {
            // check whether the local remotes cache corresponds to the server's remotes
            if (JSON.stringify(this.wgConfigFromServer.remotesConfig || {}) != JSON.stringify(wgConfigFromServer.remotes)) {
                log.debug('remotes config changed or started with no config');

                // add names
                const self = this;
                const keys = Object.keys(wgConfigFromServer.remotes);
                keys.forEach(key => wgConfigFromServer.remotes[key].name = wgConfigFromServer.remotes[key].id.replace(`${self.id}-`, ''));

                // set peers' states
                await this.adapter.setPeerStates(wgConfigFromServer.remotes);
                // store the remotes config got from server als latest known one
                this.wgConfigFromServer.remotesConfig = wgConfigFromServer.remotes;
            }
        } catch (e) {
            log.error(`Error while applying PEERS config`);
            log.error(e);
            // reset remote states
            this.adapter.setPeerStates({});
        }

        // cache the rest of the server's config
        this.wgConfigFromServer.assigned_cidrs = wgConfigFromServer.assigned_cidrs;
    }

    /**
     * @param {number} ms
     */
    async stoppedBefore(ms) {
        const stopped = await Promise.race([this.stopped.promise, this.sleep(ms)]);
        return stopped == STOPPED;
    }

    async callWithExponentialBackoff(fn, depth = 0) {
        try {
            return await fn();
        } catch (e) {
            if (depth > 4) {
                throw e;
            }
            if (!(await this.stoppedBefore(2 ** depth * INITIAL_HEARTBEAT_RATE))) {
                return this.callWithExponentialBackoff(fn, depth + 1);
            }
        }
    }

    async sync() {
        let failedTriesCount = 0;
        let nextHeartBeat;
        do {
            let response;
            try {
                // sync client
                response = await this.get(`/clients/${this.id}`);
                let config;
                if (response.status == 200) {
                    log.silly(`successfuly syncked with server`);
                    config = (response.data || {}).config;
                    await this.applyConfig(config);
                } else {
                    log.error(`Got respond with code ${response.status} while syncking with server`);
                }

                this.adapter.setConnectionStatus(true);

                failedTriesCount = 0;
                nextHeartBeat = ((config || {}).meta || {}).next_heartbeat || INITIAL_HEARTBEAT_RATE;
            } catch (e) {
                log.error(e);
                this.adapter.setConnectionStatus(false);
                failedTriesCount = failedTriesCount > 4 ? 5 : failedTriesCount + 1;
                nextHeartBeat = INITIAL_HEARTBEAT_RATE;
            }

            nextHeartBeat = 2 ** failedTriesCount * nextHeartBeat;

        } while (!(await this.stoppedBefore(nextHeartBeat)))
    }

    async updateWgInfo() {
        const infoUpdateInterval = 1 * 60 * 1000;
        do {
            try {

                const info = await this.run(`sudo ${this.wg} show`)
                const lines = info.split(os.EOL);
                const handshake = lines.filter((/** @type {string} */ l) => l.indexOf('handshake') != -1)[0];

                if (handshake) {
                    const time = (handshake.split(':')[1] || '').trim();
                    log.silly(`latest handshake: ${time}`)
                    this.adapter.setLatestHandshake(time);
                }

                const transfer = lines.filter((/** @type {string} */ l) => l.indexOf('transfer') != -1)[0];
                if (transfer) {
                    const received = ((transfer.split(':')[1] || '').split(' received')[0] || '').trim();
                    log.silly(`received: ${received}`);
                    this.adapter.setTransferReceived(received);
                    const sent = (((transfer.split(':')[1] || '').split(',')[1] || '').split(' sent')[0] || '').trim();
                    log.silly(`sent: ${sent}`);
                    this.adapter.setTransferSent(sent);
                }

            } catch (e) {
                log.silly(`error while updating wg info`);
                log.silly(e);
            }
        } while (!(await this.stoppedBefore(infoUpdateInterval)))
    }

    async getClientId() {
        const adapter = this.adapter;
        return new Promise((resolve) => {
            adapter.getForeignObject('system.meta.uuid', (err, uuidObj) => {
                if (uuidObj && uuidObj.native && uuidObj.native.uuid) {
                    adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
                        if (obj) {
                            log.info('Set id to: ' + uuidObj.native.uuid);
                            resolve(uuidObj.native.uuid);
                        } else {
                            log.error('Could not get system.adapter namespace');
                            resolve(null);
                        }
                    });
                } else {
                    log.error('Could not get system.meta.uuid');
                    resolve(null);
                }
            });
        });
    }

    generateToken() {
        if (!this.token) {
            let payload = {
                iss: this.id
            };
            this.token = jwt.encode(payload, this.settings.keys.private, 'RS256');
        }

        return this.token;
    }

    async generateKeys() {
        const self = this;

        return new Promise((resolve) => {
            if (!fs.existsSync(keysDir + 'public.pem')) {
                log.debug(`no keys found. generating...`);
                if (!fs.existsSync(keysDir)) {
                    fs.mkdirSync(keysDir);
                }
                const rsa = new NodeRSA();
                rsa.generateKeyPair(2048);
                self.settings.keys = {
                    publicPem: rsa.exportKey('pkcs8-public-pem') + '\n',
                    private: rsa.exportKey('pkcs1-private-pem') + '\n'
                };
                log.debug(`persisting generated keys...`);
                fs.writeFileSync(keysDir + 'public.pem', rsa.exportKey('pkcs8-public-pem') + '\n');
                fs.writeFileSync(keysDir + 'private.pem', rsa.exportKey('pkcs1-private-pem') + '\n');
            } else {
                log.debug(`keys found. importing...`);
                self.settings.keys = {
                    publicPem: fs.readFileSync(keysDir + 'public.pem', 'utf-8'),
                    private: fs.readFileSync(keysDir + 'private.pem', 'utf-8')
                };
            }

            resolve(0);
        })
    }


    /**
     * @param {string} ip
     */
    isValidIP(ip) {
        return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip);
    }

    /**
     * @param {string} key
     */
    async isValidKey(key) {
        try {
            const cmd = `sudo ${this.wg} pubkey`;
            await this.runInShell(cmd, [], key || '');
            return true;
        } catch {
            return false;
        }
    }

    async validateConfig(remotes, nats) {
        const overlap = nats.filter(nat => remotes.some(remote => remote.ip == nat.src)).length > 0;
        if (overlap) {
            throw new Error(`PEERS configuration overlaps with NAT configuration`);
        }

        const uniqueRemoteIps = [...new Set(remotes.map(r => r.ip))]
        if (uniqueRemoteIps.length != remotes.length) {
            throw new Error(`PEERS configuration contains non-unique IP addresses`);
        }

        const uniqueRemoteKeys = [...new Set(remotes.map(r => r.publicKey))]
        if (uniqueRemoteKeys.length != remotes.length) {
            throw new Error(`PEERS configuration contains non-unique public keys`);
        }

        const self = this;

        await remotes.reduce(async (memo, remote) => {
            await memo;
            if (!(await self.isValidKey(remote.publicKey))) {
                throw new Error(`Invalid public key ${remote.publicKey}`)
            }
        }, undefined);

        const hosts = this.getHosts().map(h => h.value);

        nats.forEach(nat => {
            if (!self.isValidIP(nat.dst)) {
                throw new Error(`Invalid IP address ${nat.dst}`);
            }

            if (hosts.includes(nat.dst)) {
                throw new Error(`Destination IP ${nat.dst} must not be from VPN address space`);
            }
        })

        const uniqueNats = [...new Set(nats.map(n => n.src))]
        if (uniqueNats.length != nats.length) {
            throw new Error(`NAT configuration contains non-unique IP addresses`);
        }
    }

    activePeers() {
        return ((this.adapter.config.params || {}).remotes || []).filter(lr => lr.isActive);
    }

    activeNats() {
        return ((this.adapter.config.params || {}).nats || []).filter(n => n.isActive);
    }

    async publishPeers() {
        // take only active peers
        let activePeers = this.activePeers();

        try {
            await this.validateConfig(activePeers, this.activeNats())
        }
        catch (e) {
            if (e instanceof Error) {
                log.error(e.message);
            }
            log.error(`Skipped publishing PEERS to server due to invalid config`);
            return;
        }

        try {
            const payload = {
                remotes: activePeers.map(peer => {
                    return {
                        name: peer.name,
                        address: peer.ip,
                        public_key: peer.publicKey
                    }
                })
            }

            // send peers to server   
            log.silly(`publishing peers configuration...`);
            const response = await this.post(`/clients/${this.id}/sync_remotes`, payload);
            if (response.status == 200) {
                log.debug(`successfuly published PEERS to server`);
                log.silly(`got response: ${JSON.stringify(response.data)}`)
            } else {
                log.error(`Got respond with code ${response.status} while publishing PEERS to server`);
                // set state showing error
            }

            // TODO: set state with remote config

        } catch (e) {
            log.error(`Error while publishing PEERS`);
            throw e;
        }
    }

    async createLocalPeer() {
        try {
            if (!fs.existsSync(`${keysDir}privatekey`)) {
                log.silly(`generating keys for the local peer...`);
                await this.run(`wg genkey | tee ${keysDir}privatekey | wg pubkey > ${keysDir}publickey`);
            }
            const publicKey = fs.readFileSync(`${keysDir}publickey`, 'utf-8').replace(os.EOL, '');
            this.settings.keys.localPeerPrivateKey = fs.readFileSync(`${keysDir}privatekey`, 'utf-8').replace(os.EOL, '');
            const activeNats = this.activeNats();

            await this.validateConfig(this.activePeers(), activeNats);

            log.silly(`creating a local peer...`);
            const response = await this.post(`/clients/${this.id}/local_peer`, { public_key: publicKey, nats: activeNats });
            if (response.status == 201) {
                log.silly(`successfuly created a local peer; config: ${JSON.stringify(response.data)}`);
                return response.data;
            } else {
                log.error(`Got respond with code ${response.status} while creating a local peer`);
            }

        } catch (e) {
            log.error(`Error while creating a local peer`);
            throw e;
        }
    }

    async register() {
        let payload = {
            client_id: this.id,
            public_key: this.settings.keys.publicPem,
            version: this.adapter.common.installedVersion,
        };

        log.debug('registering client at ' + SERVER);
        let response;
        try {
            // register or update client
            response = await this.post('/clients', payload);
            if (response.status == 201) {
                log.info(`Successfuly registered client`);
                this.registered = true;
            } else {
                log.error(`Got respond with code ${response.status} while registering client`);
            }
        } catch (e) {
            log.error(e);
            throw e;
        }
    }

    /**
     * @param {string} url
     */
    async post(url, payload) {
        const absoluteUrl = await this.composeAbsoluteUrl(url);
        const body = JSON.stringify(payload);
        log.silly(`POST ${absoluteUrl}; body: ${body}`)
        return axios.post(absoluteUrl, body, { headers: this.headers() });
    }

    /**
     * @param {string} url
     */
    async get(url) {
        const absoluteUrl = await this.composeAbsoluteUrl(url);
        log.silly(`GET ${absoluteUrl}`)
        return axios.get(absoluteUrl, { headers: this.headers() });
    }

    headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.generateToken()
        }
    }

    /**
     * @param {string} path
     */
    async composeAbsoluteUrl(path) {
        return `${PROTOCOL}://${SERVER}/api/v1${path}`;
    }

    getHosts() {

        /**
         * @param {number} proper_address
         */
        function long2ip(proper_address) {
            let output = '';
            if (!isNaN(proper_address) && (proper_address >= 0 || proper_address <= 4294967295)) {
                output = Math.floor(proper_address / Math.pow(256, 3)) + '.' +
                    Math.floor((proper_address % Math.pow(256, 3)) / Math.pow(256, 2)) + '.' +
                    Math.floor(((proper_address % Math.pow(256, 3)) % Math.pow(256, 2)) / Math.pow(256, 1)) + '.' +
                    Math.floor((((proper_address % Math.pow(256, 3)) % Math.pow(256, 2)) % Math.pow(256, 1)) / Math.pow(256, 0));
            }
            return output;
        }

        /**
         * @param {string} ip
         */
        function ip2long(ip) {
            const o = ip.split('.').map(s => parseInt(s))
            return (16777216 * o[0]) + (65536 * o[1]) + (256 * o[2]) + o[3]
        }

        /**
         * @param {string } cidr
         */
        function cidrToHosts(cidr) {
            let hosts = [];
            const parts = cidr.split('/');
            const start = ip2long(parts[0]);
            const end = Math.pow(2, 32 - parseInt(parts[1])) + start - 1;
            for (let i = start + 1; i <= end; i++) {
                const ip = long2ip(i);
                hosts.push({ label: ip, value: ip });
            }
            return hosts;
        }

        let hosts = [];

        if (this.wgConfigFromServer) {
            (this.wgConfigFromServer.assigned_cidrs || []).forEach((/** @type {string} */ cidr) => hosts = hosts.concat(cidrToHosts(cidr)));
        }

        return hosts;
    }
}

module.exports = IwgClient;