/*! SPDX-License-Identifier: GPL-2.0
 *
 * Copyright (C) 2015-2020 Jason A. Donenfeld <Jason@zx2c4.com>. All Rights Reserved.
 */

var nodeCrypto = require('crypto');

class KeyGenerator {
    constructor() {
    }

    gf(init) {
        let r = new Float64Array(16);
        if (init) {
            for (let i = 0; i < init.length; ++i) {
                r[i] = init[i];
            }
        }
        return r;
    }

    pack(o, n) {
        let b, m = this.gf(), t = this.gf();
        for (let i = 0; i < 16; ++i) {
            t[i] = n[i];
        }
        this.carry(t);
        this.carry(t);
        this.carry(t);
        for (let j = 0; j < 2; ++j) {
            m[0] = t[0] - 0xffed;
            for (let i = 1; i < 15; ++i) {
                m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
                m[i - 1] &= 0xffff;
            }
            m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
            b = (m[15] >> 16) & 1;
            m[14] &= 0xffff;
            this.cswap(t, m, 1 - b);
        }
        for (let i = 0; i < 16; ++i) {
            o[2 * i] = t[i] & 0xff;
            o[2 * i + 1] = t[i] >> 8;
        }
    }

    carry(o) {
        let c;
        for (let i = 0; i < 16; ++i) {
            o[(i + 1) % 16] += (i < 15 ? 1 : 38) * Math.floor(o[i] / 65536);
            o[i] &= 0xffff;
        }
    }

    cswap(p, q, b) {
        let t, c = ~(b - 1);
        for (let i = 0; i < 16; ++i) {
            t = c & (p[i] ^ q[i]);
            p[i] ^= t;
            q[i] ^= t;
        }
    }

    add(o, a, b) {
        for (let i = 0; i < 16; ++i)
            o[i] = (a[i] + b[i]) | 0;
    }

    subtract(o, a, b) {
        for (let i = 0; i < 16; ++i)
            o[i] = (a[i] - b[i]) | 0;
    }

    multmod(o, a, b) {
        let t = new Float64Array(31);
        for (let i = 0; i < 16; ++i) {
            for (let j = 0; j < 16; ++j) {
                t[i + j] += a[i] * b[j];
            }
        }
        for (let i = 0; i < 15; ++i) {
            t[i] += 38 * t[i + 16];
        }
        for (let i = 0; i < 16; ++i) {
            o[i] = t[i];
        }
        this.carry(o);
        this.carry(o);
    }

    invert(o, i) {
        let c = this.gf();
        for (let a = 0; a < 16; ++a) {
            c[a] = i[a];
        }
        for (let a = 253; a >= 0; --a) {
            this.multmod(c, c, c);
            if (a !== 2 && a !== 4) {
                this.multmod(c, c, i);
            }
        }
        for (let a = 0; a < 16; ++a) {
            o[a] = c[a];
        }
    }

    clamp(z) {
        z[31] = (z[31] & 127) | 64;
        z[0] &= 248;
    }

    generatePublicKey(privateKey) {
        let r, z = new Uint8Array(32);
        let a = this.gf([1]),
            b = this.gf([9]),
            c = this.gf(),
            d = this.gf([1]),
            e = this.gf(),
            f = this.gf(),
            _121665 = this.gf([0xdb41, 1]),
            _9 = this.gf([9]);
        for (let i = 0; i < 32; ++i) {
            z[i] = privateKey[i];
        }
        this.clamp(z);
        for (let i = 254; i >= 0; --i) {
            r = (z[i >>> 3] >>> (i & 7)) & 1;
            this.cswap(a, b, r);
            this.cswap(c, d, r);
            this.add(e, a, c);
            this.subtract(a, a, c);
            this.add(c, b, d);
            this.subtract(b, b, d);
            this.multmod(d, e, e);
            this.multmod(f, a, a);
            this.multmod(a, c, a);
            this.multmod(c, b, e);
            this.add(e, a, c);
            this.subtract(a, a, c);
            this.multmod(b, a, a);
            this.subtract(c, d, f);
            this.multmod(a, c, _121665);
            this.add(a, a, d);
            this.multmod(c, c, a);
            this.multmod(a, d, f);
            this.multmod(d, b, _9);
            this.multmod(b, e, e);
            this.cswap(a, b, r);
            this.cswap(c, d, r);
        }
        this.invert(c, c);
        this.multmod(a, a, c);
        this.pack(z, a);
        return z;
    }

    generatePresharedKey() {
        let privateKey = new Uint8Array(32);
        nodeCrypto.randomFillSync(privateKey);
        return privateKey;
    }

    generatePrivateKey() {
        const privateKey = this.generatePresharedKey();
        this.clamp(privateKey);
        return privateKey;
    }

    encodeBase64(dest, src) {
        let input = Uint8Array.from([(src[0] >> 2) & 63, ((src[0] << 4) | (src[1] >> 4)) & 63, ((src[1] << 2) | (src[2] >> 6)) & 63, src[2] & 63]);
        for (let i = 0; i < 4; ++i) {
            dest[i] = input[i] + 65 +
                (((25 - input[i]) >> 8) & 6) -
                (((51 - input[i]) >> 8) & 75) -
                (((61 - input[i]) >> 8) & 15) +
                (((62 - input[i]) >> 8) & 3);
        }
    }

    keyToBase64(key) {
        let i, base64 = new Uint8Array(44);
        for (i = 0; i < 32 / 3; ++i) {
            this.encodeBase64(base64.subarray(i * 4), key.subarray(i * 3));
        }
        this.encodeBase64(base64.subarray(i * 4), Uint8Array.from([key[i * 3 + 0], key[i * 3 + 1], 0]));
        base64[43] = 61;
        return String.fromCharCode.apply(null, [].slice.call(base64));
    }

    generateKeypair() {
        const privateKey = this.generatePrivateKey();
        const publicKey = this.generatePublicKey(privateKey);
        return {
            publicKey: this.keyToBase64(publicKey),
            privateKey: this.keyToBase64(privateKey)
        };
    }
}

module.exports = KeyGenerator;