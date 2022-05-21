const fs = require('fs')
const path = require('path')
const BankId = require('bankid')
const requestIp = require('request-ip')

export default async function auth(req, res){
  try{
    const dir = path.resolve('YOUR_CERTIFICATE_PATH')
    const client = new BankId.BankIdClient(
      {
        production: true,
        pfx: fs.readFileSync(dir),
        passphrase: process.env.PASSPHRASE
      }
    )
    const authenticate = await client.authenticate({
      endUserIp: requestIp.getClientIp(req)
    })
    res.status(200).json({ data: authenticate })
  }
  catch(err){
    res.status(500).json({ err: err.message })
  }
}