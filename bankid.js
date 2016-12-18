const path = require('path');
const fs = require('fs');
const soap = require('soap');

const certificates = {
	testing: `
-----BEGIN CERTIFICATE----- 
MIID8zCCAtugAwIBAgIRAODr4WfulmxifqSx8UEMbyIwDQYJKoZIhvcNAQEFBQAw eTEkMCIGA1UECgwbRmluYW5zaWVsbCBJRC1UZWtuaWsgQklEIEFCMRowGAYDVQQL DBFJbmZyYXN0cnVjdHVyZSBDQTE1MDMGA1UEAwwsQmFua0lEIFNTTCBSb290IENl cnRpZmljYXRpb24gQXV0aG9yaXR5IFRFU1QwHhcNMDgxMjA0MTMyNTU1WhcNMTkw NjAxMTIxODAwWjB5MSQwIgYDVQQKDBtGaW5hbnNpZWxsIElELVRla25payBCSUQg QUIxGjAYBgNVBAsMEUluZnJhc3RydWN0dXJlIENBMTUwMwYDVQQDDCxCYW5rSUQg U1NMIFJvb3QgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkgVEVTVDCCASIwDQYJKoZI hvcNAQEBBQADggEPADCCAQoCggEBAOZh4Y7AkqrGb4LL/HCnqx0AmCdaHXKmJqbt NyIE3ppEnWYR6hGrZcSKRAYkU8ShS0Sf647Bj4tXiVQYg1msIvYgZ8h4QJqkqMYY 2nwJC2cDbtc3TL6ppXQVmIiS6wZewV1GL2xKUEPbKgDPiSgFyh3W1d/QihUwnwoa CGQ/crivftaNTnp4ZqQod9k35WfBy8xdB7cLHFeznfHoP1ZLOHza9bprT0F8YzEa u5CoCMxWPe0sY9aQC8oO3gKyohJrxnxTlDY2cMLXTCiUWIYh+ubybZ3Hqw1YFEmE 4IyiGyT9+LUChFhM0p53eR3GRUU7laxFVbVLuVdbIV0ZRL+0Eb8CAwEAAaN2MHQw DwYDVR0TAQH/BAUwAwEB/zARBgNVHSAECjAIMAYGBCoDBAUwDgYDVR0PAQH/BAQD AgEGMB0GA1UdDgQWBBSlaUGnPvmNu9R9LsDgulauQCwrvTAfBgNVHSMEGDAWgBSl aUGnPvmNu9R9LsDgulauQCwrvTANBgkqhkiG9w0BAQUFAAOCAQEAY1zWz1oV3ZMC 78uhGYA+j6Zktps9IXzIw3v1T3wtYclUoJI594w7vmTMqFY9z2mnms+gKTxCO/70 MpCNMgKSLj2bGsrMWHCvnDWpmYY5ZkDP2GWB6aqy+ehRmlYjUbPhjD44Xfjh/Stq 1yXCUfesLUHZDcBxpDspOwldWl7rhkE7QPj5hdSP85l04oIcnYiMyOPTt+4LNYN+ ncb0a/ZkJcUL7Q9NGJfmEhAmHcCpK8j1coSh36D8JMeSblVTBEWpnBMP5zXKAkzf OzZLGyy9RnV51NhRMRnQtDOFCZ9vQuuyCE/TZeOp4IgZctEvt2Aab23fx5jWBbzC EtEmq/VqaQ==
-----END CERTIFICATE-----
	`,
	production: `
-----BEGIN CERTIFICATE-----
MIID6jCCAtKgAwIBAgIQSvZNAy61UF6qO2zWqvN/3zANBgkqhkiG9w0BAQUFADB0 MSQwIgYDVQQKDBtGaW5hbnNpZWxsIElELVRla25payBCSUQgQUIxGjAYBgNVBAsM EUluZnJhc3RydWN0dXJlIENBMTAwLgYDVQQDDCdCYW5rSUQgU1NMIFJvb3QgQ2Vy dGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMDgxMjE5MDg1OTAxWhcNMTkwNjAxMjE0 NTAwWjB0MSQwIgYDVQQKDBtGaW5hbnNpZWxsIElELVRla25payBCSUQgQUIxGjAY BgNVBAsMEUluZnJhc3RydWN0dXJlIENBMTAwLgYDVQQDDCdCYW5rSUQgU1NMIFJv b3QgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwggEiMA0GCSqGSIb3DQEBAQUAA4IB DwAwggEKAoIBAQCzqv7Rn43VFyTGicb+qjSGNeJga6GWQkMEXn9NvqCfknpaz4kf RbNHoQvtmw7CsiL83hMNU5y0EI6wC45Whn8ZXJ5/eqj1zBSu7QqKctEbMjWf6sf2 VUyE7lns6FxRFAgbhM2RS5LnWCfRsSgjKLXbJk7S2O/qVWdlxU1fAYfjbja1xhQm jArtvCYv9D2f8MBgH9sOsabVdLEKtiXj9NpBiXIi+c9DUpzvY1qnY02dsSudVwm3 IwJlEljLfjcBQDtJlm/7TbKsnqvW8s+NT6JBputUZT8Mqsv63meEbhxcq6vNcNKZ SgeHZDmr9lY2hmmVK9TcgfWHHkymUAWTGRQzAgMBAAGjeDB2MA8GA1UdEwEB/wQF MAMBAf8wEwYDVR0gBAwwCjAIBgYqhXBOAQQwDgYDVR0PAQH/BAQDAgEGMB0GA1Ud DgQWBBS2GCMB5GeakO2/WOqKJJXGAop6tTAfBgNVHSMEGDAWgBS2GCMB5GeakO2/ WOqKJJXGAop6tTANBgkqhkiG9w0BAQUFAAOCAQEAe4vukBbEjzsYC8Mv1xLcUQVD gYTgnqvP8Lr8yABfNfhh+iIoFK7QvVD3Z+bIBnGEGutB5K78UTadKINittSKA4T4 3Uy/p/blqew8Sqhv0I5MVlW71++HiPth4xwHAoxfe4oyTQaJRgls1CCsCBnuT9IF 6nGUNziC46RqIlhiY7zDzROtBWjqJzq+QvO07s73m+GPk8kZVwQrtyFT2IuYMH23 od/sRe2W5GClo2d62SBrzywYJZAaBNY9yl6weMdqWRqJz0mYZHrvLCQ1xrq4nvpL bMDfs1wD3vctSXLBFfBU9qw+CYTBN4UJ7BHQw1r2KGeAjm5grkL7Z7lQzTWSqw==
-----END CERTIFICATE-----
	`,
};

module.exports = class BankId {
	constructor({} = {}) {

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

	authenticate(pno, callback) {
		return new Promise((resolve, reject) => {
			this.getClient().then(client => {
				client.Authenticate({ personalNumber: pno }, (err, res) => {
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
					if (callback) callback(err, res);

					if (err) reject(err);
					else resolve(res);
				});
			}, reject);
		});
	}

	authenticateAndCollect(pno, refreshInterval=1000) {
		return new Promise((resolve, reject) => {
			this.authenticate(pno)
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
				}, refreshInterval);
			}, reject);
		});
	}

	_createClient() {
		const pfx = fs.readFileSync(path.resolve(__dirname, 'FPTestcert2_20150818_102329.pfx'));
		const passphrase = 'qwerty123';
		const ca = certificates.testing;

		const wsdlUrl = 'https://appapi.test.bankid.com/rp/v4?wsdl';
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
}