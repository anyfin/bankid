'use strict';

const path = require('path');
const fs = require('fs');
const soap = require('soap');


/*
 * TODO:
 * - callback for methodAndCollect's
 * - proper error parsing
 * - return more complete response, not only userInfo
 * - minimal documentation
 */
class BankId {
	constructor(options = {}) {
		this.options = Object.assign({}, {
			refreshInterval: 1000,
			production: false,
			// defaults for test environment
			pfx: path.resolve(__dirname, '../cert/', 'FPTestcert2_20150818_102329.pfx'),
			passphrase: 'qwerty123',
			// certificate is provided by package by default
			ca: undefined,
		}, options);

		if (this.options.production) {
			if (!options.pfx || !options.passphrase) {
				throw Error('BankId requires the pfx and passphrase in production mode');
			}
		}

		if (this.options.ca === undefined) {
			this.options.ca = this.options.production
				? path.resolve(__dirname, '../cert/', 'prod.ca')
				: path.resolve(__dirname, '../cert/', 'test.ca');
		}
	}

	authenticate(pno, callback) {
		return new Promise((resolve, reject) => {
			this.getClient().then(client => {
				client.Authenticate({
					personalNumber: pno
				}, (err, res) => {
					err = this._parseError(err);
					if (callback) callback(err, res);

					if (err) reject(err);
					else resolve(res);
				});
			}, reject);
		});
	}

	sign(pno, message, callback) {
		return new Promise((resolve, reject) => {
			this.getClient().then(client => {
				client.Sign({
					personalNumber: pno,
					userVisibleData: new Buffer(message).toString('base64'),
				}, (err, res) => {
					err = this._parseError(err);
					if (callback) callback(err, res);

					if (err) reject(err);
					else resolve(res);
				});
			}, reject);
		});
	}

	collect(orderRef, callback) {
		return new Promise((resolve, reject) => {
			this.getClient().then(client => {
				client.Collect(orderRef, (err, res) => {
					err = this._parseError(err);
					if (callback) callback(err, res);
					
					if (err) reject(err);
					else resolve(res);
				});
			}, reject);
		});
	}

	authenticateAndCollect(pno) {
		return this._methodAndCollect(this.authenticate.bind(this), pno);
	}

	signAndCollect(pno, message) {
		return this._methodAndCollect(this.sign.bind(this), pno, message);
	}

	_methodAndCollect(method, ...args) {
		return new Promise((resolve, reject) => {
			method(...args)
			.then(({ orderRef }) => {
				const timer = setInterval(() => {
					this.collect(orderRef)
					.then(res => {
						if (res.progressStatus === 'COMPLETE') {
							clearInterval(timer);
							resolve(res.userInfo);
						}
					})
					.catch(err => {
						clearInterval(timer);
						reject(err);
					});
				}, this.options.refreshInterval);
			}, reject);
		});
	}

	getClient() {
		return new Promise((resolve, reject) => {
			if (this.client === undefined) {
				this._createClient().then(client => {
					this.client = client;
					resolve(client);
				}, reject);
			}
			else {
				resolve(this.client);
			}
		});
	}

	_createClient() {
		const opts = this.options;

		const ca = Buffer.isBuffer(opts.ca) ? opts.ca : fs.readFileSync(opts.ca, 'utf-8');
		const pfx = Buffer.isBuffer(opts.pfx) ? opts.pfx : fs.readFileSync(opts.pfx);
		const passphrase = opts.passphrase;

		const wsdlUrl = opts.production
			? 'https://appapi.bankid.com/rp/v4?wsdl'
			: 'https://appapi.test.bankid.com/rp/v4?wsdl';
		const wsdlOptions = { pfx, passphrase, ca };

		return new Promise((resolve, reject) => {
			soap.createClient(wsdlUrl, { wsdl_options: wsdlOptions }, (err, client) => {
				if (err) {
					reject(err);
				} else {
					client.setSecurity(new soap.ClientSSLSecurityPFX(pfx, passphrase, { ca }));
					resolve(client);
				}
			});
		});
	}

	_parseError(err) {
		if (err) {
			const match = err.toString().match(/^Error: soap:Server: (.*)$/);
			return match ? match[1] : err.toString();
		} else {
			return undefined;
		}
	}
}

module.exports = BankId;