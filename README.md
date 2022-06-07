![Logo](admin/iwg-vpn.png)
# ioBroker.iwg-vpn

[![NPM version](http://img.shields.io/npm/v/iobroker.iwg-vpn.svg)](https://www.npmjs.com/package/iobroker.iwg-vpn)
[![Downloads](https://img.shields.io/npm/dm/iobroker.iwg-vpn.svg)](https://www.npmjs.com/package/iobroker.iwg-vpn)

[![NPM](https://nodei.co/npm/iobroker.iwg-vpn.png?downloads=true)](https://nodei.co/npm/iobroker.iwg-vpn/)

WireGuard is a registered trademark of Jason A. Donenfeld. (https://www.wireguard.com)

## iwg-vpn adapter for ioBroker

THE adapter for setting up a secure connection from remote devices to the ioBroker and local network leveraging the [WireGuard](https://www.wireguard.com) VPN and controlling local devices via Alexa.

For detailed description please refer to the adapter configuration screen or follow the
link: https://htmlpreview.github.io/?https://github.com/iwg-vpn/iobroker.iwg-vpn/blob/main/howto/read-me.html.

## Prerequisites
* node: >= 14.17.x
* js-controller: >=2.0.0
* admin: >=5.1.0


## Changelog

### v0.10.4
* Change reporting and motion sensor support added

### v0.10.3
* Bug fixes

### v0.10.2
* Config screen enhancements

### v0.10.1
* Control your real and virtual devices via Alexa

### v0.9.2
* Adapter starts own HTTP server to support configuration via QR Codes

### v0.9.1
* Bug fixes

### v0.9.0
* Remote access support for ioBroker windows hosts
* Peer configuration as QR Code to import into a WireGuard App on a mobile peer
* Auto generation of key pairs for configured peers

### v0.0.9
* Adapter review feedback incorporated

### v0.0.8
* Validate your configuration before applying it
* Information about latest handshake and sent/received bytes via the WireGuard network interface

### v0.0.7 

* Support of NAT between VPN and the ioBroker host's local network

### v0.0.5 

* Initial published release


## License
Creative Commons Attribution-NonCommercial (CC BY-NC)

Copyright (c) 2022 iwg-vpn <iwg.vpn@gmail.com>

http://creativecommons.org/licenses/by-nc/4.0/

Short content:
Licensees may copy, distribute, display and perform the work and make derivative works based on it only if they give the author or licensor the credits in the manner specified by these.
Licensees may copy, distribute, display, and perform the work and make derivative works based on it only for noncommercial purposes.
(Free for non-commercial use).