const fs = require('fs')
const path = require('path')
const BankId = require('bankid')

export default async function auth(req, res){
  try{
    const dir = path.resolve('YOUR_CERTIFICATE_PATH')
    let seconds = 0
    const { orderRef } = req.body
    const client = new BankId.BankIdClient(
      {
        production: true,
        pfx: fs.readFileSync(dir),
        passphrase: process.env.PASSPHRASE
		  }
    );
    const timer = setInterval(async () => {
      seconds++
      const done = () => clearInterval(timer)
      if(seconds === 30){ //refresh rate of QR
        done()
        res.status(200).json({data: {}})
      }
      else{
        try{
          const collect = await client.collect({
            orderRef
          })
          if(collect.status === 'complete'){
            done()
            res.status(200).json({data: collect.completionData})
          }
          else if(collect.status === 'failed'){
            throw new Error(collect.hintCode)
          }
        }
        catch(err){
          done()
          res.status(500).json({ err: err.message })
        }
      }
    }, 1000);
  }
  catch(err){
    res.status(500).json({ err: err.message })
  }
}